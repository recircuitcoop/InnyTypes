// The MCP session over the child's private stdio pipes (plan 0018 §3, the port of
// anytype_mcp/session.py): one reader, serialised writes, bounded, and never a silent retry.
//
// * Frames are one JSON object per line, at most MAX_FRAME_BYTES each way. A request over the
//   bound is refused and the session carries on; a reply over it tears the session down,
//   because the stream can no longer be trusted to be in step.
// * At most MAX_PENDING_REQUESTS wait at once; the next is refused, not queued.
// * Every request is bounded by REQUEST_TIMEOUT_MS and is never sent twice: a retried
//   tools/call can change Anytype twice.
// * A child that dies, ends its output, or sends anything the protocol cannot mean (malformed
//   JSON, an id nobody asked for) fails every pending call at once, with a SessionError.
// * No frame, error or string form carries the key: the key is only in the child's
//   environment, which this file never sees.

import {
  SessionBusyError,
  SessionError,
  ToolSurfaceMismatchError,
} from "../../domain/anytype/errors";
import {
  MAX_FRAME_BYTES,
  MAX_PENDING_REQUESTS,
  MCP_PROTOCOL_VERSION,
  REQUEST_TIMEOUT_MS,
} from "../../domain/anytype/pins";
import type { McpSession, McpTool } from "../../ports/anytype";
import type { Cancel, Clock } from "../../ports/clock";
import { verifyToolSurface } from "./tool-surface";

/** The child's stdout, as this session reads it. */
export interface FrameSource {
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  on(event: "end" | "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

/** The child's stdin, as this session writes it. */
export interface FrameSink {
  write(chunk: string): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export interface McpSessionOptions {
  readonly input: FrameSource;
  readonly output: FrameSink;
  readonly clock: Clock;
  /** The committed surface (tool name → signature) the child must list exactly. */
  readonly expected: Readonly<Record<string, string>>;
  readonly maxFrameBytes?: number;
  readonly maxPending?: number;
  readonly requestTimeoutMs?: number;
}

interface Pending {
  readonly method: string;
  readonly resolve: (result: Record<string, unknown>) => void;
  readonly reject: (error: SessionError) => void;
  readonly cancelTimer: Cancel;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export class StdioMcpSession implements McpSession {
  readonly #options: McpSessionOptions;
  readonly #maxFrame: number;
  readonly #maxPending: number;
  readonly #timeout: number;
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;
  #closed = false;
  #buffer: Buffer = Buffer.alloc(0);

  constructor(options: McpSessionOptions) {
    this.#options = options;
    this.#maxFrame = options.maxFrameBytes ?? MAX_FRAME_BYTES;
    this.#maxPending = options.maxPending ?? MAX_PENDING_REQUESTS;
    this.#timeout = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    options.input.on("data", (chunk) => {
      this.#read(chunk);
    });
    options.input.on("end", () => {
      this.#fail("the Anytype MCP child closed its output");
    });
    options.input.on("close", () => {
      this.#fail("the Anytype MCP child closed its output");
    });
    options.input.on("error", (error) => {
      this.#fail(`could not read from the Anytype MCP child: ${error.message}`);
    });
    options.output.on("error", (error) => {
      this.#fail(`could not write to the Anytype MCP child: ${error.message}`);
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  async initialize(): Promise<readonly McpTool[]> {
    await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "innytypes-services", version: "1" },
    });
    this.notify("notifications/initialized");
    const result = await this.request("tools/list");
    const listed = result["tools"];
    if (!Array.isArray(listed) || !listed.every(isObject)) {
      throw new SessionError("the Anytype MCP child answered tools/list without a tool list");
    }
    const tools = listed.map((tool): McpTool => {
      const { name, inputSchema } = tool;
      if (typeof name !== "string" || !isObject(inputSchema)) {
        throw new SessionError("the Anytype MCP child returned an invalid tool definition");
      }
      // The whole definition is kept (description, annotations): the gateway serves it as listed.
      return { ...tool, name, inputSchema };
    });
    try {
      verifyToolSurface(this.#options.expected, tools);
    } catch (error) {
      if (error instanceof ToolSurfaceMismatchError) {
        throw error;
      }
      throw new SessionError((error as Error).message);
    }
    return tools;
  }

  async ping(timeoutMs: number): Promise<void> {
    // Bounded by the session's own timeout as well: a ping never waits longer than any call.
    await this.request("ping", undefined, Math.min(timeoutMs, this.#timeout));
  }

  request(
    method: string,
    params?: Readonly<Record<string, unknown>>,
    timeoutMs: number = this.#timeout,
  ): Promise<Record<string, unknown>> {
    if (this.#closed) {
      return Promise.reject(new SessionError("the Anytype MCP child session is closed"));
    }
    if (this.#pending.size >= this.#maxPending) {
      return Promise.reject(new SessionBusyError("the Anytype MCP child request bound is full"));
    }
    const id = this.#nextId++;
    const message: Record<string, unknown> = { jsonrpc: "2.0", id, method };
    if (params !== undefined) {
      message["params"] = params;
    }
    const frame = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(frame) > this.#maxFrame) {
      return Promise.reject(new SessionError("an MCP request exceeds the child frame limit"));
    }
    return new Promise((resolve, reject) => {
      const cancelTimer = this.#options.clock.after(timeoutMs, () => {
        // Forgotten, not retried: a late answer to it is then an unknown id.
        this.#pending.delete(id);
        reject(new SessionError(`the Anytype MCP child timed out answering ${method}`));
      });
      this.#pending.set(id, { method, resolve, reject, cancelTimer });
      this.#write(frame);
    });
  }

  notify(method: string, params?: Readonly<Record<string, unknown>>): void {
    const message: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) {
      message["params"] = params;
    }
    if (this.#closed) {
      throw new SessionError("the Anytype MCP child session is closed");
    }
    this.#write(`${JSON.stringify(message)}\n`);
  }

  close(reason: string): void {
    this.#fail(reason);
  }

  toString(): string {
    return `StdioMcpSession(${this.#closed ? "closed" : "open"}, ${String(this.#pending.size)} pending)`;
  }

  #write(frame: string): void {
    try {
      this.#options.output.write(frame);
    } catch (error) {
      this.#fail(`could not write to the Anytype MCP child: ${(error as Error).message}`);
    }
  }

  #read(chunk: Buffer): void {
    if (this.#closed) {
      return;
    }
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (let end = this.#buffer.indexOf(10); end !== -1; end = this.#buffer.indexOf(10)) {
      // The frame limit counts the newline, as session.py's readline(max + 1) did.
      if (end + 1 > this.#maxFrame) {
        this.#fail("the Anytype MCP child sent an oversized frame");
        return;
      }
      const frame = this.#buffer.subarray(0, end).toString("utf8");
      this.#buffer = this.#buffer.subarray(end + 1);
      this.#deliver(frame);
      if (this.closed) {
        return;
      }
    }
    if (this.#buffer.length > this.#maxFrame) {
      this.#fail("the Anytype MCP child sent an oversized frame");
    }
  }

  #deliver(frame: string): void {
    let message: unknown;
    try {
      message = JSON.parse(frame);
    } catch {
      this.#fail("the Anytype MCP child sent malformed JSON");
      return;
    }
    if (!isObject(message) || !("id" in message)) {
      return; // a notification, or a frame with nothing to answer: ignored, not fatal
    }
    const id = message["id"];
    if (typeof id !== "number" || !Number.isInteger(id)) {
      this.#fail("the Anytype MCP child sent an invalid response id");
      return;
    }
    const pending = this.#pending.get(id);
    if (pending === undefined) {
      this.#fail("the Anytype MCP child answered an unknown request id");
      return;
    }
    this.#pending.delete(id);
    pending.cancelTimer();
    const error = message["error"];
    if (error !== undefined) {
      const said = isObject(error) ? error["message"] : error;
      const detail = typeof said === "string" ? said : "request refused";
      pending.reject(
        new SessionError(`the Anytype MCP child refused ${pending.method}: ${detail}`),
      );
      return;
    }
    const result = message["result"];
    if (!isObject(result)) {
      pending.reject(
        new SessionError(
          `the Anytype MCP child answered ${pending.method} without an object result`,
        ),
      );
      return;
    }
    pending.resolve(result);
  }

  /** Close the session and fail everything pending with `reason`, once. */
  #fail(reason: string): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const request of pending) {
      request.cancelTimer();
      request.reject(new SessionError(reason));
    }
  }
}
