// Answering what a client says to the loopback MCP endpoint (plan 0018 §4.1 point 3, the
// dispatch half of gateway.py): JSON-RPC over Streamable HTTP, against the one validated MCP
// child the Anytype core service holds.
//
// * initialize, ping and notifications are the endpoint's own and need no child.
// * tools/list and tools/call need the child: while it is unavailable they are answered 503,
//   with a JSON-RPC error a client can read, and no second child is ever started for them.
// * tools/call runs only a tool the child listed when it was validated: the validated set is the
//   whole authorisation model for what a client may run, so an unknown name never reaches it.
// * Every answer is redacted before it leaves. Most of it is written by the child, the one
//   process holding the Anytype key: a tool result, a live tool description and a refusal the
//   child quoted from Anytype all pass through here, so this is the one place the key is
//   removed from everything the endpoint says (plan 0007, key-path).
// * Each tools/call, and each resources/read by its uri, is logged at INFO with its tool name, how long it took and how many bytes
//   the answer that left holds, never its arguments: they are a client's data, and a call
//   that broke the child's session must still be in the log (plan 0019, slice 01). The line
//   is written once the answer is known, so a call that ends this whole process leaves none.
// * API-download-file never reaches the child (plan 0019): its bytes would be destroyed there
//   and a large file would close its session. Once the call is authorised like any other, it
//   is answered from Anytype's REST API (anytype-file-download.ts), and resources/read answers
//   the uri that answer names. A blob written there is the one string not redacted (D5).
// * A write carrying a dataview block passes the dataview shim first (dataview-shim.ts, plan
//   0024; temporary): a type's `source` is forwarded as its `object_id`, and a target that is
//   not a type or a collection is refused here with validation_failed, nothing forwarded. It
//   runs before the unwrap, so a refusal names the block where the client wrote it.
// * A call to a tool whose body the child wraps passes the unwrap shim last (minted-body-shim.ts,
//   plan 0023; temporary): its `body` argument is forwarded flat, so Anytype receives the
//   document and not `{"body": ...}`.
// * The ids a client chose are echoed exactly; a body with no readable id is answered with a
//   null id, never an invented one.

import { MCP_PROTOCOL_VERSION } from "../domain/anytype/pins";
import { DOWNLOAD_TOOL, type FileDownloads, isOwnFileContents } from "./anytype-file-download";
import type { McpSession, McpTool } from "../ports/anytype";
import type { Clock } from "../ports/clock";
import type { Logger } from "../ports/logger";
import type { McpAnswer, McpHandler } from "../ports/mcp-gateway";
import { dataviewShim, type DataviewRefusal } from "./dataview-shim";
import { unwrapMintedBody } from "./minted-body-shim";

/** The validated child as the endpoint serves it: its session and the tools it listed. */
export interface ServedMcp {
  readonly session: McpSession;
  readonly tools: readonly McpTool[];
}

export interface McpDispatchDeps {
  /** The validated child now; null while it is unavailable (no key, starting, down). */
  readonly served: () => ServedMcp | null;
  /** Every credential this process holds, replaced; the registry's redact. */
  readonly redact: (text: string) => string;
  /** Times each tools/call. */
  readonly clock: Clock;
  /** Where each tools/call is logged. */
  readonly logger: Logger;
  /** What answers API-download-file and resources/read, instead of the child. */
  readonly files: FileDownloads;
}

export const CHILD_UNAVAILABLE = "the Anytype MCP child is unavailable";

type Json = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `value` with every string in it, keys included, redacted; but for the `blob` of file
 * contents InnyTypes built from Anytype's bytes, which is left whole (D5). A `blob` the child
 * wrote is redacted like any other string.
 */
function redacted(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === "string") {
    return redact(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redacted(item, redact));
  }
  if (isObject(value)) {
    const own = isOwnFileContents(value);
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redact(key),
        own && key === "blob" ? item : redacted(item, redact),
      ]),
    );
  }
  return value;
}

const result = (id: unknown, value: unknown): Json => ({ jsonrpc: "2.0", id, result: value });
const error = (id: unknown, code: number, message: string): Json => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

/**
 * A dataview InnyTypes refused, answered the way the child answers a refusal Anytype wrote
 * (a tool result whose text is Anytype's error object), so a client reads both alike.
 */
function validationFailed(refusal: DataviewRefusal): Json {
  const message =
    `${refusal.path}.${refusal.member}: ${JSON.stringify(refusal.value)} ${refusal.reason} ` +
    `(refused by InnyTypes, nothing was written)`;
  const text = JSON.stringify({ object: "error", status: 400, code: "validation_failed", message });
  return { content: [{ type: "text", text }], isError: true };
}

/** The MCP handler the gateway hands each admitted body to. */
export function mcpDispatch(deps: McpDispatchDeps): McpHandler {
  return async (body) => {
    const started = deps.clock.now();
    const request = parsed(body);
    const answer = await dispatch(request, deps.served, deps.files);
    const sent =
      answer.body === null
        ? answer
        : { status: answer.status, body: redacted(answer.body, deps.redact) };
    const method = isObject(request) ? request["method"] : undefined;
    if (method === "tools/call" || method === "resources/read") {
      logCall(deps, method, (request as Json)["params"], deps.clock.now() - started, sent);
    }
    return sent;
  };
}

/**
 * One INFO line for a tools/call or a resources/read: its tool name or uri, its duration and
 * its answer's size.
 */
function logCall(
  deps: McpDispatchDeps,
  method: "tools/call" | "resources/read",
  params: unknown,
  ms: number,
  sent: McpAnswer,
): void {
  const field = method === "tools/call" ? "name" : "uri";
  const name = isObject(params) ? params[field] : undefined;
  // Quoted, so a name a client chose cannot break the line. Not cut here: the logger cuts a
  // line after redacting it, and a cut before would leave half a credential behind.
  const shown = typeof name === "string" ? JSON.stringify(name) : `(no ${field})`;
  const bytes = sent.body === null ? 0 : new TextEncoder().encode(JSON.stringify(sent.body)).length;
  deps.logger.info(
    `${method} ${shown} answered ${String(sent.status)} in ${String(ms)} ms, ${String(bytes)} bytes`,
  );
}

/** The body as JSON, or undefined when it is not UTF-8 JSON. */
function parsed(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
  } catch {
    return undefined;
  }
}

async function dispatch(
  request: unknown,
  served: () => ServedMcp | null,
  files: FileDownloads,
): Promise<McpAnswer> {
  if (request === undefined) {
    return { status: 200, body: error(null, -32700, "invalid JSON") };
  }
  if (!isObject(request)) {
    return { status: 200, body: error(null, -32600, "invalid request") };
  }
  const id = request["id"] ?? null;
  const method = request["method"];
  if (typeof method === "string" && method.startsWith("notifications/")) {
    return { status: 202, body: null };
  }
  if (method === "initialize") {
    return {
      status: 200,
      body: result(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        // `resources` because a download answers an embedded resource, readable by its uri.
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "innytypes-anytype", version: "1" },
      }),
    };
  }
  if (method === "ping") {
    return { status: 200, body: result(id, {}) };
  }
  if (method === "resources/list") {
    // Files are read by the uri a download named; none is listed.
    return { status: 200, body: result(id, { resources: [] }) };
  }
  if (method !== "tools/list" && method !== "tools/call" && method !== "resources/read") {
    return { status: 200, body: error(id, -32601, "method not found") };
  }

  const child = served();
  if (child === null || child.session.closed) {
    return { status: 503, body: error(id, -32000, CHILD_UNAVAILABLE) };
  }
  if (method === "tools/list") {
    return { status: 200, body: result(id, { tools: child.tools }) };
  }
  if (method === "resources/read") {
    return readFile(id, request["params"], child, files);
  }
  const params = request["params"];
  if (!isObject(params) || typeof params["name"] !== "string") {
    return { status: 200, body: error(id, -32602, "tools/call requires a tool name") };
  }
  const name = params["name"];
  const tool = child.tools.find((listed) => listed.name === name);
  if (tool === undefined) {
    return { status: 200, body: error(id, -32602, "unknown Anytype tool") };
  }
  if (name === DOWNLOAD_TOOL) {
    // Authorised above like any tool, then answered here: never forwarded to the child.
    return { status: 200, body: result(id, await files.call(params["arguments"])) };
  }
  try {
    // The dataview shim (temporary, plan 0024): its own lookups go to the child directly.
    const shimmed = await dataviewShim(child.session, params);
    if (shimmed.kind === "refused") {
      return { status: 200, body: result(id, validationFailed(shimmed.refusal)) };
    }
    if (shimmed.kind === "failed") {
      return {
        status: 200,
        body: error(id, -32000, `dataview target lookup failed: ${shimmed.message}`),
      };
    }
    // The unwrap shim (temporary, plan 0023), on what the dataview shim forwards. Remove it, its
    // import and minted-body-shim.ts when the @anyproto/anytype-mcp pin (pins.ts) moves and the
    // re-recorded tool_surface.json no longer carries a minted `body` on the five tools; see
    // "Removal" in plan 0023 for the file checklist.
    const unwrapped = unwrapMintedBody(tool, shimmed.params);
    if (unwrapped.kind === "refused") {
      return { status: 200, body: error(id, -32602, unwrapped.message) };
    }
    return {
      status: 200,
      body: result(id, await child.session.request("tools/call", unwrapped.params)),
    };
  } catch (failure) {
    return { status: 200, body: error(id, -32000, (failure as Error).message) };
  }
}

/**
 * resources/read of an anytype-file uri: the same file the download tool answers, by the same
 * code, and only while the validated child lists that tool, the one authorisation model.
 */
async function readFile(
  id: unknown,
  params: unknown,
  child: ServedMcp,
  files: FileDownloads,
): Promise<McpAnswer> {
  if (!child.tools.some((tool) => tool.name === DOWNLOAD_TOOL)) {
    return { status: 200, body: error(id, -32601, "method not found") };
  }
  const uri = isObject(params) ? params["uri"] : undefined;
  const read = typeof uri === "string" ? await files.read(uri) : null;
  if (read === null) {
    return { status: 200, body: error(id, -32602, "resources/read requires an anytype-file uri") };
  }
  if (!read.ok) {
    return { status: 200, body: error(id, -32000, read.message) };
  }
  return { status: 200, body: result(id, { contents: [read.contents] }) };
}
