// The loopback MCP endpoint's listener (plan 0018 §4.1 point 3). The adapter is
// adapters/anytype/gateway.ts on node:http: it owns the socket, the bearer, Host and Origin
// checks and the bounds, and hands each admitted body to a handler that answers it.

/** What a handler answers one admitted body with. A null body is a notification's bare 202. */
export interface McpAnswer {
  readonly status: number;
  readonly body: unknown;
}

/**
 * Answer one request body, received whole and admitted by every check before it. The bytes are
 * handed over undecoded: what they mean, including whether they are text, is the handler's.
 */
export type McpHandler = (body: Uint8Array) => Promise<McpAnswer>;

export interface ServedAddress {
  readonly host: string;
  readonly port: number;
}

export interface McpListener {
  /** The address being served now; null when nothing is. */
  readonly serving: ServedAddress | null;
  /**
   * Serve `host:port`. A running listener is moved bind-before-close: the new address is bound
   * while the old one still serves, and only then is the old one closed. A bind that fails
   * rejects with the address named and leaves everything as it was.
   */
  serveAt(host: string, port: number): Promise<void>;
  /** Stop accepting and release the port. Stopping a stopped listener is not an error. */
  stop(): Promise<void>;
}
