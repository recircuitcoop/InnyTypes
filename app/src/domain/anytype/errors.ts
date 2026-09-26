// The named failures of the Anytype core service (plan 0018 §4.1), the port of the error
// classes of anytype_api.py, anytype_mcp/session.py and anytype_mcp/keys.py.
//
// Named rather than generic because each one has its own fix: start Anytype, create a new key,
// re-record the tool surface. No message here ever carries the key: they name the base URL, the
// method, the status and the file, and every one is redacted again on its way to the log.

/** A call to Anytype's local API did not produce a usable result. */
export class AnytypeApiError extends Error {
  override name = "AnytypeApiError";
}

/** Anytype's local API did not answer: the fix is to start the desktop app. */
export class AnytypeUnreachableError extends AnytypeApiError {
  override name = "AnytypeUnreachableError";
  constructor(readonly apiBaseUrl: string) {
    super(
      `Anytype's local API did not answer at ${apiBaseUrl}; start the Anytype desktop app, ` +
        `or point ANYTYPE_API_BASE_URL at it`,
    );
  }
}

/** Anytype answered with a status that is not a success. The body is never repeated. */
export class AnytypeStatusError extends AnytypeApiError {
  override name = "AnytypeStatusError";
  constructor(
    method: string,
    url: string,
    readonly status: number,
  ) {
    super(`${method} ${url} answered HTTP ${String(status)}`);
  }
}

/** 401: the API is up and the key is not accepted. */
export class AnytypeUnauthorizedError extends AnytypeStatusError {
  override name = "AnytypeUnauthorizedError";
}

/** 404: the API is up, the key works, and that path does not exist. */
export class AnytypeNotFoundError extends AnytypeStatusError {
  override name = "AnytypeNotFoundError";
}

/** 5xx: Anytype itself failed. */
export class AnytypeServerError extends AnytypeStatusError {
  override name = "AnytypeServerError";
}

/** The named error for `status`: the specific one where there is one (anytype_api.py:116). */
export function statusError(method: string, url: string, status: number): AnytypeStatusError {
  if (status === 401) {
    return new AnytypeUnauthorizedError(method, url, status);
  }
  if (status === 404) {
    return new AnytypeNotFoundError(method, url, status);
  }
  if (status >= 500) {
    return new AnytypeServerError(method, url, status);
  }
  return new AnytypeStatusError(method, url, status);
}

/**
 * What an Anytype node fails an input with when Anytype answers 401 (plan 0018 §4.2). The
 * runtime raises its once-only notice on exactly this text, so it is one constant for both.
 */
export const PAIR_AGAIN_MESSAGE = "Anytype refused the key; pair again in Settings";

/** Pairing with Anytype failed; nothing was stored. */
export class PairingError extends Error {
  override name = "PairingError";
}

/** The MCP child failed framing, lifecycle or request handling. */
export class SessionError extends Error {
  override name = "SessionError";
}

/** The bounded set of pending requests is full: the request is refused, not queued. */
export class SessionBusyError extends SessionError {
  override name = "SessionBusyError";
}

/** What differs between the live tool surface and the committed one. */
export interface SurfaceDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

/** The live child lists tools other than the committed, reviewed surface (session.py:27). */
export class ToolSurfaceMismatchError extends SessionError {
  override name = "ToolSurfaceMismatchError";
  constructor(readonly diff: SurfaceDiff) {
    super(
      "the live Anytype MCP tools differ from the committed surface: " +
        `added=[${diff.added.join(", ")}], removed=[${diff.removed.join(", ")}], ` +
        `changed=[${diff.changed.join(", ")}]`,
    );
  }
}

/** Two tool maps (name → signature), compared: added, removed and changed, each sorted. */
export function compareSurfaces(
  expected: Readonly<Record<string, string>>,
  live: Readonly<Record<string, string>>,
): SurfaceDiff {
  const before = Object.keys(expected);
  const after = Object.keys(live);
  return {
    added: after.filter((name) => !(name in expected)).sort(),
    removed: before.filter((name) => !(name in live)).sort(),
    // Only over the names both hold, so an added tool is never also reported as changed.
    changed: after.filter((name) => name in expected && expected[name] !== live[name]).sort(),
  };
}

export function isEmptyDiff(diff: SurfaceDiff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
}
