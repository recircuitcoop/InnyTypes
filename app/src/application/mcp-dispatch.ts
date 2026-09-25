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
// * The ids a client chose are echoed exactly; a body with no readable id is answered with a
//   null id, never an invented one.

import { MCP_PROTOCOL_VERSION } from "../domain/anytype/pins";
import type { McpSession, McpTool } from "../ports/anytype";
import type { McpAnswer, McpHandler } from "../ports/mcp-gateway";

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
}

export const CHILD_UNAVAILABLE = "the Anytype MCP child is unavailable";

type Json = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `value` with every string in it, keys included, redacted. */
function redacted(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === "string") {
    return redact(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redacted(item, redact));
  }
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [redact(key), redacted(item, redact)]),
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

/** The MCP handler the gateway hands each admitted body to. */
export function mcpDispatch(deps: McpDispatchDeps): McpHandler {
  return async (body) => {
    const answer = await dispatch(body, deps.served);
    return answer.body === null
      ? answer
      : { status: answer.status, body: redacted(answer.body, deps.redact) };
  };
}

async function dispatch(body: Uint8Array, served: () => ServedMcp | null): Promise<McpAnswer> {
  let request: unknown;
  try {
    request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
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
        capabilities: { tools: {} },
        serverInfo: { name: "innytypes-anytype", version: "1" },
      }),
    };
  }
  if (method === "ping") {
    return { status: 200, body: result(id, {}) };
  }
  if (method !== "tools/list" && method !== "tools/call") {
    return { status: 200, body: error(id, -32601, "method not found") };
  }

  const child = served();
  if (child === null || child.session.closed) {
    return { status: 503, body: error(id, -32000, CHILD_UNAVAILABLE) };
  }
  if (method === "tools/list") {
    return { status: 200, body: result(id, { tools: child.tools }) };
  }
  const params = request["params"];
  if (!isObject(params) || typeof params["name"] !== "string") {
    return { status: 200, body: error(id, -32602, "tools/call requires a tool name") };
  }
  const name = params["name"];
  if (!child.tools.some((tool) => tool.name === name)) {
    return { status: 200, body: error(id, -32602, "unknown Anytype tool") };
  }
  try {
    return { status: 200, body: result(id, await child.session.request("tools/call", params)) };
  } catch (failure) {
    return { status: 200, body: error(id, -32000, (failure as Error).message) };
  }
}
