// The Anytype core service's ports (plan 0018 §4.1): Anytype's local API, and the MCP child
// with the session over its pipes. The adapters are adapters/anytype/*; a test hands fakes.

/** One MCP tool as the child lists it. */
export interface McpTool {
  readonly name: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

/** The MCP session over the child's stdin and stdout (session.py). */
export interface McpSession {
  /**
   * The handshake: `initialize`, `notifications/initialized`, then `tools/list`, which must
   * match the committed surface exactly (a ToolSurfaceMismatchError otherwise).
   */
  initialize(): Promise<readonly McpTool[]>;
  /** MCP's own liveness question. Resolves only when the child answered, within `timeoutMs`. */
  ping(timeoutMs: number): Promise<void>;
  /** One request, bounded; never retried. A dead child fails it with a SessionError. */
  request(method: string, params?: Readonly<Record<string, unknown>>): Promise<unknown>;
  /** Fail everything pending, and refuse everything after. */
  close(reason: string): void;
  readonly closed: boolean;
}

/** One running MCP child. Signalled only through this live handle. */
export interface McpChild {
  readonly pid: number | null;
  readonly session: McpSession;
  /** The child is gone, whatever the reason. */
  onExit(listener: (code: number | null, signal: string | null) => void): void;
  /** Ask it to stop, then kill it if it has not gone within the adapter's deadline. */
  stop(): Promise<void>;
}

export interface McpChildLauncher {
  /** Spawn the child with exactly `env`; `onStderr` gets each line it prints there. */
  launch(
    env: Readonly<Record<string, string>>,
    onStderr: (pid: number, line: string) => void,
  ): McpChild;
}

/** Anytype's local API, as the service needs it (anytype_api.py, health.py, keys.py). */
export interface AnytypeApi {
  /** True when the API answers at all: a 401 is still "up" (health.py:31-33). */
  reachable(apiKey: string | null): Promise<boolean>;
  /** Ask Anytype to show a four-digit code; the challenge id comes back. */
  startPairing(): Promise<string>;
  /** Exchange the code for a key. */
  completePairing(challengeId: string, code: string): Promise<string>;
}
