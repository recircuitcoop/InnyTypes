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

import type { SecretPaths } from "../channel/messages";

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

/**
 * The variables that tell a first-party Anytype node where the key file is (plan 0018 §4.2,
 * spec 11.1): the runtime names the paths the shell located, so a node never works them out
 * from HOME, and the key itself never passes through a flow, a start frame or the journal.
 * The TS node SDK's `anytypeKey()` reads the same two names.
 */
export const ANYTYPE_KEY_FILE_VARIABLE = "INNYTYPES_ANYTYPE_KEY_FILE";
export const ANYTYPE_KEY_LEGACY_FILE_VARIABLE = "INNYTYPES_ANYTYPE_KEY_LEGACY_FILE";

/** The two variables for a key kept at `file`, with its read-only `legacy` fallback. */
export function anytypeKeyEnvironment(where: {
  readonly file: string;
  readonly legacy?: string;
}): Record<string, string> {
  return {
    [ANYTYPE_KEY_FILE_VARIABLE]: where.file,
    ...(where.legacy === undefined ? {} : { [ANYTYPE_KEY_LEGACY_FILE_VARIABLE]: where.legacy }),
  };
}

/** The first-party node package that reads the key (plan 0018 §4.2). */
export const ANYTYPE_PACKAGE_NAME = "anytype";

/**
 * What one node process is told about the key: the two variables when it is a type of the
 * first-party Anytype package (`firstParty`: found in the folder shipped with the app), and
 * nothing for any other package. Only the key's location is read from `secretFiles`; the proxy
 * token's, if it is there, never reaches a node.
 */
export function anytypeKeyVariables(
  packageName: string,
  firstParty: boolean,
  secretFiles: SecretPaths | undefined,
): Record<string, string> {
  const where = secretFiles?.["anytype-api-key"];
  if (packageName !== ANYTYPE_PACKAGE_NAME || !firstParty || where === undefined) {
    return {};
  }
  return anytypeKeyEnvironment(where);
}

/** A base URL without a trailing slash, so a path joined to it never doubles one. */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
