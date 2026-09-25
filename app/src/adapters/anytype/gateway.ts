// The loopback MCP endpoint on node:http (plan 0018 §4.1 point 3, the port of
// anytype_mcp/gateway.py): Streamable HTTP at /mcp on a numeric loopback address, for clients
// that start on their own and connect with a URL and a bearer token.
//
// It is the only network-facing surface the application has, so most of it is refusal, and
// every refusal happens before the body is read:
//
// * GET, whoever sends it, is answered 405 with GET_REFUSAL; any other method but POST is 405.
// * The path must be /mcp (404), then the bearer from the proxy token file (401), then Host and
//   Origin must name the served address (403). The body has not been touched at this point.
// * Content-Length is required (411) and at most MAX_BODY_BYTES (413), judged from the header.
// * At most MAX_CONCURRENT_REQUESTS are admitted at once; the next is answered 429, not queued.
// * A body is read under two bounds: READ_TIMEOUT_MS for each wait for more bytes (a client that
//   goes silent), and node:http's requestTimeout of RECEIVE_TIMEOUT_MS for the whole request (a
//   client that dribbles). Either ends in 408 and the slot is given back. Neither bounds the
//   child: once the body is in, the handler takes as long as it takes.
//
// A move is bind-before-close: the new address is bound while the old one still serves, the
// swap happens, and only then does the old listener stop accepting. A request the old one had
// already taken in runs to its answer. A bind that fails rejects with the address named and
// changes nothing, and no other address is ever tried.

import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import {
  checkedAddress,
  EndpointError,
  isTrustedHost,
  isTrustedOrigin,
  MCP_PATH,
} from "../../domain/endpoint/address";
import {
  GET_REFUSAL,
  MAX_BODY_BYTES,
  MAX_CONCURRENT_REQUESTS,
  MAX_HEADER_BYTES,
  READ_TIMEOUT_MS,
  RECEIVE_TIMEOUT_MS,
  REFUSALS,
} from "../../domain/endpoint/limits";
import type { Logger } from "../../ports/logger";
import type { McpAnswer, McpHandler, McpListener, ServedAddress } from "../../ports/mcp-gateway";

/** The gateway's bounds. Production uses the constants; only a test shortens them. */
export interface GatewayLimits {
  readonly maxBodyBytes: number;
  readonly maxConcurrent: number;
  readonly readTimeoutMs: number;
  readonly receiveTimeoutMs: number;
}

export const GATEWAY_LIMITS: GatewayLimits = {
  maxBodyBytes: MAX_BODY_BYTES,
  maxConcurrent: MAX_CONCURRENT_REQUESTS,
  readTimeoutMs: READ_TIMEOUT_MS,
  receiveTimeoutMs: RECEIVE_TIMEOUT_MS,
};

export interface GatewayOptions {
  /** The proxy bearer token (the existing mcp_proxy_token file); an empty one is refused. */
  readonly token: string;
  /** Answers each admitted body: the application's MCP dispatch. */
  readonly handle: McpHandler;
  readonly logger: Logger;
  readonly limits?: GatewayLimits;
}

const sha256 = (text: string): Buffer => createHash("sha256").update(text, "utf8").digest();

export class HttpMcpGateway implements McpListener {
  readonly #expected: Buffer;
  readonly #handle: McpHandler;
  readonly #logger: Logger;
  readonly #limits: GatewayLimits;
  #server: http.Server | null = null;
  #address: ServedAddress | null = null;
  #admitted = 0;

  constructor(options: GatewayOptions) {
    if (options.token === "") {
      // An empty token compares equal to an empty Authorization header: no token, no service.
      throw new EndpointError("the MCP proxy bearer token is empty");
    }
    // Compared as digests, so the comparison takes the same time whatever length was sent.
    this.#expected = sha256(`Bearer ${options.token}`);
    this.#handle = options.handle;
    this.#logger = options.logger;
    this.#limits = options.limits ?? GATEWAY_LIMITS;
  }

  get serving(): ServedAddress | null {
    return this.#address;
  }

  async serveAt(host: string, port: number): Promise<void> {
    // Judged by the one rule before anything is bound: a refused address costs nothing.
    const address = checkedAddress(host, port);
    const server = await this.#listen(address);
    // Swapped before the old listener stops, so at the moment it stops accepting the gateway
    // already answers for the new address rather than briefly disowning it.
    const previous = this.#server;
    this.#server = server;
    this.#address = address;
    if (previous !== null) {
      // Stop accepting at once; a request already received finishes on its own connection.
      previous.close();
      previous.closeIdleConnections();
    }
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    this.#address = null;
    if (server === null) {
      return;
    }
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
      server.closeAllConnections();
    });
  }

  /** One bound, serving listener at `address`, or the reason there is none. */
  #listen(address: ServedAddress): Promise<http.Server> {
    const { receiveTimeoutMs } = this.#limits;
    const server = http.createServer(
      {
        requestTimeout: receiveTimeoutMs,
        headersTimeout: receiveTimeoutMs,
        // How often node:http looks for requests past requestTimeout: often enough that the
        // bound is the bound, not the bound plus node's default 30 s sweep.
        connectionsCheckingInterval: Math.max(10, Math.min(1_000, receiveTimeoutMs / 5)),
        maxHeaderSize: MAX_HEADER_BYTES,
        // A missing Host is this gateway's refusal (403, like any Host it does not trust), not
        // node:http's generic 400.
        requireHostHeader: false,
      },
      (request, response) => {
        void this.#serve(request, response);
      },
    );
    return new Promise((resolve, reject) => {
      const refused = (error: NodeJS.ErrnoException) => {
        reject(
          new EndpointError(
            `could not bind the MCP service at ${address.host}:${String(address.port)}: ` +
              (error.code ?? error.message),
          ),
        );
      };
      server.once("error", refused);
      server.listen(address.port, address.host, () => {
        server.off("error", refused);
        server.on("error", (error) => {
          this.#logger.error(`the MCP endpoint's listener failed: ${error.message}`);
        });
        resolve(server);
      });
    });
  }

  async #serve(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    // A client that leaves before its answer is how requests end on a network surface, not a
    // fault to report.
    response.on("error", () => undefined);
    if (request.method === "GET") {
      send(response, 405, { error: GET_REFUSAL });
      return;
    }
    if (request.method !== "POST") {
      send(response, 405, { error: REFUSALS.method }, true);
      return;
    }
    if (request.url !== MCP_PATH) {
      send(response, 404, { error: REFUSALS.notFound }, true);
      return;
    }
    // The bearer first, then Host and Origin: all before a byte of the body is read.
    if (!this.#bearerMatches(request.headers.authorization)) {
      send(response, 401, { error: REFUSALS.bearer }, true);
      return;
    }
    const address = this.#address;
    if (
      address === null ||
      !isTrustedHost(request.headers.host, address.host, address.port) ||
      !isTrustedOrigin(request.headers.origin, address.port)
    ) {
      send(response, 403, { error: REFUSALS.origin }, true);
      return;
    }
    const declared = request.headers["content-length"];
    if (declared === undefined || !/^\d+$/.test(declared)) {
      send(response, 411, { error: REFUSALS.length }, true);
      return;
    }
    const length = Number(declared);
    if (length > this.#limits.maxBodyBytes) {
      // Refused from the declared length, so an oversized body is never read at all.
      send(response, 413, { error: REFUSALS.tooLarge }, true);
      return;
    }
    if (this.#admitted >= this.#limits.maxConcurrent) {
      send(response, 429, { error: REFUSALS.busy }, true);
      return;
    }
    this.#admitted += 1;
    try {
      const body = await this.#readBody(request, length);
      if (body === null) {
        // The announced body never arrived in full: answered rather than dropped, and the
        // connection is finished with, so the slot given back is not held by a silent client.
        send(response, 408, { error: REFUSALS.timedOut }, true);
        return;
      }
      let answer: McpAnswer;
      try {
        answer = await this.#handle(body);
      } catch (error) {
        this.#logger.error(`the MCP endpoint could not answer a request: ${String(error)}`);
        send(response, 500, { error: "internal error" }, true);
        return;
      }
      if (answer.body === null) {
        // A notification: a status and no body at all.
        response.writeHead(answer.status, { "content-length": "0" });
        response.end();
        return;
      }
      send(response, answer.status, answer.body);
    } finally {
      this.#admitted -= 1;
    }
  }

  #bearerMatches(authorization: string | undefined): boolean {
    return timingSafeEqual(sha256(authorization ?? ""), this.#expected);
  }

  /** The body, exactly `length` bytes, or null when it did not arrive within the bounds. */
  #readBody(request: http.IncomingMessage, length: number): Promise<Uint8Array | null> {
    const { readTimeoutMs } = this.#limits;
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let received = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let done = false;
      const finish = (body: Uint8Array | null) => {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timer);
        resolve(body);
      };
      // Rearmed by every chunk: a bound on each wait for more bytes, not on the whole body.
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          finish(null);
        }, readTimeoutMs);
      };
      request.on("data", (chunk: Buffer) => {
        received += chunk.length;
        chunks.push(chunk);
        arm();
      });
      request.on("end", () => {
        finish(received === length ? Buffer.concat(chunks) : null);
      });
      // node:http's requestTimeout answers 408 itself and ends the connection; so does a client
      // that goes away. Either way the body is not coming.
      request.on("close", () => {
        finish(null);
      });
      request.on("error", () => {
        finish(null);
      });
      arm();
    });
  }
}

/** One JSON answer. `close` ends the connection after it, for an answer sent with a body unread. */
function send(
  response: http.ServerResponse,
  status: number,
  payload: unknown,
  close = false,
): void {
  if (response.headersSent || response.destroyed) {
    return;
  }
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
    "cache-control": "no-store",
    ...(close ? { connection: "close" } : {}),
  });
  response.end(body);
}
