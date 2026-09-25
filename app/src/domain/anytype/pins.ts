// The Anytype core service's pins and the MCP session's bounds (plan 0018 §3, §4.1): the port
// of anytype_mcp/config.py:31-40, protocol.py and session.py:14-16.
//
// Two pins, and changing either is a dependency upgrade rather than a tweak:
// * PACKAGE_VERSION is the exact @anyproto/anytype-mcp release the services process spawns. It
//   is kept in step with the root package.json, where the workspace installs it; a test fails
//   the gate when the two disagree.
// * ANYTYPE_VERSION is the `Anytype-Version` header. The server turns Anytype's OpenAPI spec
//   into MCP tools, so the API version it speaks decides which tools exist.
//
// The key is never a constant here: it is read from its owner-only file, and it reaches the
// child only inside OPENAPI_MCP_HEADERS.

export const PACKAGE_NAME = "@anyproto/anytype-mcp";
export const PACKAGE_VERSION = "1.2.10";
export const ANYTYPE_VERSION = "2025-11-08";

/** The MCP protocol version the services process speaks to its child (protocol.py). */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/**
 * Anytype's local API, as the desktop app serves it. `anytype-cli` listens on 31012 instead,
 * which is why ANYTYPE_API_BASE_URL may point elsewhere (config.py:38-40).
 */
export const DEFAULT_API_BASE_URL = "http://127.0.0.1:31009";

/** The exact `name@version` of the child: never a floating tag. */
export const PACKAGE_SPEC = `${PACKAGE_NAME}@${PACKAGE_VERSION}`;

// ── the session's bounds (session.py:14-16) ──────────────────────────────────────────────

/** The largest frame either side may send: one MiB, newline included. */
export const MAX_FRAME_BYTES = 1024 * 1024;
/** How many requests may wait for the child at once; the next is refused, not queued. */
export const MAX_PENDING_REQUESTS = 8;
/** How long any one request may wait for its answer. */
export const REQUEST_TIMEOUT_MS = 60_000;

/** The header map the server expects, before JSON encoding (config.py:88-93). */
export function anytypeHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, "Anytype-Version": ANYTYPE_VERSION };
}

/**
 * The child's whole environment: the two variables the server reads, and nothing inherited
 * (config.py:103-112, without its `os.environ` base). The credential goes in last, so no
 * other value can shadow it. `extra` is what the node runtime itself needs.
 */
export function childEnvironment(
  apiKey: string,
  apiBaseUrl: string,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return {
    ...extra,
    ANYTYPE_API_BASE_URL: apiBaseUrl,
    OPENAPI_MCP_HEADERS: JSON.stringify(anytypeHeaders(apiKey)),
  };
}

/** A base URL without a trailing slash, so a path joined to it never doubles one. */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
