// Is Anytype's local API reachable? The gate before the MCP child starts (plan 0018 §4.1,
// the port of anytype_mcp/health.py).
//
// The MCP child is useless without the desktop app behind it, and that is much clearer said
// here than as a tool call that times out. Any transport failure is a "no", never a throw: an
// absent desktop app is an expected state, not an error.

import { ANYTYPE_VERSION, anytypeHeaders, joinUrl } from "../../domain/anytype/pins";

export type Fetch = typeof fetch;

/** How long the probe waits: the API is on the loopback interface (health.py:22). */
export const PROBE_TIMEOUT_MS = 2_000;

/** The one endpoint probed, which is also the one the client wraps by name. */
export const SPACES_PATH = "/v1/spaces";

/** The headers for `apiKey`, or only the pinned version when there is no key yet. */
export function requestHeaders(apiKey: string | null): Record<string, string> {
  return apiKey === null ? { "Anytype-Version": ANYTYPE_VERSION } : anytypeHeaders(apiKey);
}

/** True when Anytype's API answers below 500 at `apiBaseUrl`: a 401 still proves it is up. */
export async function isApiReachable(
  fetchFn: Fetch,
  apiBaseUrl: string,
  apiKey: string | null,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  try {
    const response = await fetchFn(joinUrl(apiBaseUrl, SPACES_PATH), {
      headers: requestHeaders(apiKey),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // The body is not wanted; reading it releases the connection.
    await response.arrayBuffer().catch(() => undefined);
    return response.status < 500;
  } catch {
    return false;
  }
}
