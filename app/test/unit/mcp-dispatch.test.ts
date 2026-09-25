// What the loopback MCP endpoint answers (plan 0018 §4.1 point 3; WI-0018-19): the whole
// JSON-RPC exchange with every id kept, the validated set as the only tools a client may run,
// 503 while the child is unavailable, and the Anytype key removed from everything said.
// Ported from tests/test_anytype_mcp_gateway.py.
import { describe, expect, it } from "vitest";
import { CHILD_UNAVAILABLE, mcpDispatch, type ServedMcp } from "../../src/application/mcp-dispatch";
import { MCP_PROTOCOL_VERSION } from "../../src/domain/anytype/pins";
import { SessionError } from "../../src/domain/anytype/errors";
import { REDACTED, SecretRegistry } from "../../src/domain/redaction/registry";
import type { McpSession, McpTool } from "../../src/ports/anytype";

const KEY = "dispatch-canary-key-0123456789";
const TOOL: McpTool = { name: "get_object", inputSchema: { type: "object" } };

/** A child session that records what it was asked instead of asking a child. */
class RecordingSession implements McpSession {
  closed = false;
  readonly calls: { method: string; params: unknown }[] = [];
  answer: (params: Readonly<Record<string, unknown>>) => unknown = (params) => ({
    content: [{ type: "text", text: params["name"] }],
  });

  initialize(): Promise<readonly McpTool[]> {
    return Promise.resolve([TOOL]);
  }
  ping(): Promise<void> {
    return Promise.resolve();
  }
  request(method: string, params: Readonly<Record<string, unknown>> = {}): Promise<unknown> {
    this.calls.push({ method, params });
    // An answer that throws becomes the rejection, as a refusal from the child does.
    return new Promise((resolve) => {
      resolve(this.answer(params));
    });
  }
  close(): void {
    this.closed = true;
  }
}

function subject(served: ServedMcp | null, registry = new SecretRegistry()) {
  const handle = mcpDispatch({ served: () => served, redact: (text) => registry.redact(text) });
  return async (payload: unknown) => {
    const bytes =
      payload instanceof Uint8Array ? payload : new TextEncoder().encode(JSON.stringify(payload));
    return handle(bytes);
  };
}

describe("the MCP exchange", () => {
  it("runs initialize, initialized, ping, tools/list and tools/call, keeping every id", async () => {
    const session = new RecordingSession();
    const send = subject({ session, tools: [TOOL] });

    const initialized = await send({ jsonrpc: "2.0", id: "init-a", method: "initialize" });
    expect(initialized).toEqual({
      status: 200,
      body: {
        jsonrpc: "2.0",
        id: "init-a",
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "innytypes-anytype", version: "1" },
        },
      },
    });
    // A notification has no id and is answered with a status and no body at all.
    expect(await send({ jsonrpc: "2.0", method: "notifications/initialized" })).toEqual({
      status: 202,
      body: null,
    });
    expect((await send({ jsonrpc: "2.0", id: 77, method: "ping" })).body).toEqual({
      jsonrpc: "2.0",
      id: 77,
      result: {},
    });
    expect((await send({ jsonrpc: "2.0", id: "list-1", method: "tools/list" })).body).toEqual({
      jsonrpc: "2.0",
      id: "list-1",
      result: { tools: [TOOL] },
    });
    const called = await send({
      jsonrpc: "2.0",
      id: 91,
      method: "tools/call",
      params: { name: "get_object", arguments: { id: "abc" } },
    });
    expect(called.body).toEqual({
      jsonrpc: "2.0",
      id: 91,
      result: { content: [{ type: "text", text: "get_object" }] },
    });
    expect((await send({ jsonrpc: "2.0", id: "x-9", method: "resources/list" })).body).toEqual({
      jsonrpc: "2.0",
      id: "x-9",
      error: { code: -32601, message: "method not found" },
    });
    expect(session.calls).toEqual([
      { method: "tools/call", params: { name: "get_object", arguments: { id: "abc" } } },
    ]);
  });

  it.each([
    [{ name: "delete_everything", arguments: {} }],
    [{ name: "get_objectt" }],
    [{ arguments: {} }],
    [{ name: 7 }],
    ["not-an-object"],
  ])("refuses tools/call %j before the child hears of it", async (params) => {
    const session = new RecordingSession();
    const answer = await subject({ session, tools: [TOOL] })({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params,
    });
    expect(answer.body).toMatchObject({ id: 5, error: { code: -32602 } });
    expect(session.calls).toEqual([]);
  });

  it("answers a body that is not an MCP request as JSON-RPC, with a null id, never an invented one", async () => {
    const session = new RecordingSession();
    const send = subject({ session, tools: [TOOL] });
    expect(await send(new TextEncoder().encode("{not json at all"))).toEqual({
      status: 200,
      body: { jsonrpc: "2.0", id: null, error: { code: -32700, message: "invalid JSON" } },
    });
    expect(await send(Uint8Array.from([0x7b, 0xff, 0x7d]))).toMatchObject({
      body: { id: null, error: { code: -32700 } },
    });
    expect((await send(["jsonrpc", "2.0"])).body).toMatchObject({
      id: null,
      error: { code: -32600 },
    });
    expect(session.calls).toEqual([]);
  });
});

describe("an unavailable child", () => {
  it("is 503 with an MCP error for tools, never a second child, while initialize and ping still answer", async () => {
    const send = subject(null);
    expect(await send({ jsonrpc: "2.0", id: 4, method: "tools/list" })).toEqual({
      status: 503,
      body: { jsonrpc: "2.0", id: 4, error: { code: -32000, message: CHILD_UNAVAILABLE } },
    });
    expect((await send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: TOOL })).status).toBe(
      503,
    );
    expect((await send({ jsonrpc: "2.0", id: 6, method: "ping" })).status).toBe(200);
    expect((await send({ jsonrpc: "2.0", id: 7, method: "initialize" })).status).toBe(200);
  });

  it("is 503 when the session it was handed has closed", async () => {
    const session = new RecordingSession();
    session.closed = true;
    const answer = await subject({ session, tools: [TOOL] })({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_object" },
    });
    expect(answer.status).toBe(503);
    expect(session.calls).toEqual([]);
  });

  it("turns a refusal from the child into an MCP error carrying its message", async () => {
    const session = new RecordingSession();
    session.answer = () => {
      throw new SessionError("the Anytype MCP child timed out answering tools/call");
    };
    const answer = await subject({ session, tools: [TOOL] })({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_object" },
    });
    expect(answer).toEqual({
      status: 200,
      body: {
        jsonrpc: "2.0",
        id: 3,
        error: { code: -32000, message: "the Anytype MCP child timed out answering tools/call" },
      },
    });
  });
});

describe("the Anytype key", () => {
  /** A child whose every answer carries the key: a description, a schema, a result, a refusal. */
  function leaky(error: boolean) {
    const session = new RecordingSession();
    session.answer = () => {
      if (error) {
        throw new SessionError(`the Anytype MCP child refused tools/call: 401 Bearer ${KEY}`);
      }
      return { content: [{ type: "text", text: `401 {"Authorization":"Bearer ${KEY}"}` }] };
    };
    const tools: McpTool[] = [
      {
        name: "get_object",
        description: `Upstream sends Authorization: Bearer ${KEY}`,
        inputSchema: { type: "object", properties: { note: { const: KEY }, [KEY]: {} } },
      } as McpTool,
    ];
    return { session, tools };
  }

  it("reaches no answer: descriptions, schemas, results and refusals are all redacted", async () => {
    const registry = new SecretRegistry();
    registry.protect(KEY); // what the registering secret store does when the key is read
    const said: string[] = [];
    for (const error of [false, true]) {
      const send = subject(leaky(error), registry);
      for (const payload of [
        { jsonrpc: "2.0", id: 1, method: "initialize" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_object" } },
      ]) {
        said.push(JSON.stringify((await send(payload)).body));
      }
    }
    const everything = said.join("\n");
    expect(everything).not.toContain(KEY);
    expect(everything).toContain(REDACTED);
    expect(said[1]).toContain(`"const":"${REDACTED}"`);
    expect(said[5]).toContain(`"code":-32000`);
  });

  it("leaks when the key was never registered: the check above can fail", async () => {
    const answer = await subject(leaky(false))({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(JSON.stringify(answer.body)).toContain(KEY);
  });
});
