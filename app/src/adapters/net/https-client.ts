// The HttpClient over node:https (WI-0018-14): update.py's stream_https and catalogue.py's
// _get, ported. HTTPS only, checked on the URL and on every redirect hop before anything is
// sent; the body counted as it arrives and abandoned one byte past its ceiling; every failure
// a result, never an exception.

import https from "node:https";
import type { HttpClient, HttpGetOptions, HttpGetResult } from "../../ports/http-client";

/** How long a connection may sit silent (versions.py REQUEST_TIMEOUT). */
export const REQUEST_TIMEOUT_MS = 10_000;
/** How many redirects one GET follows before it gives up. */
export const MAX_REDIRECTS = 5;

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export interface HttpsClientOptions {
  /**
   * Certificates to trust instead of the system's. Production leaves it out; the tests pass
   * the certificate of their local server.
   */
  readonly ca?: string;
  readonly timeoutMs?: number;
}

type Hop = { readonly redirect: string | null } | { readonly result: HttpGetResult };

export class HttpsClient implements HttpClient {
  readonly #options: HttpsClientOptions;

  constructor(options: HttpsClientOptions = {}) {
    this.#options = options;
  }

  async get(url: string, options: HttpGetOptions): Promise<HttpGetResult> {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      let target: URL;
      try {
        target = new URL(current);
      } catch {
        return { ok: false, failure: "insecure", detail: `"${current}" is not an HTTPS URL` };
      }
      if (target.protocol !== "https:") {
        return {
          ok: false,
          failure: "insecure",
          detail: `${current} is not HTTPS; nothing is fetched in the clear`,
        };
      }
      const answer = await this.#once(target, options.maxBytes);
      if ("result" in answer) {
        return answer.result;
      }
      if (answer.redirect === null) {
        return { ok: false, failure: "status", detail: `${current} redirected to nowhere` };
      }
      current = new URL(answer.redirect, target).href;
    }
    return {
      ok: false,
      failure: "status",
      detail: `${url} redirected more than ${String(MAX_REDIRECTS)} times`,
    };
  }

  /** One request, no redirect followed. */
  #once(target: URL, maxBytes: number): Promise<Hop> {
    const where = target.href;
    return new Promise<Hop>((resolve) => {
      // A promise settles once: whichever of end, error, timeout or the ceiling comes first.
      const fail = (failure: "status" | "transport" | "oversize", detail: string): void => {
        resolve({ result: { ok: false, failure, detail } });
      };
      const oversize = (): void => {
        fail("oversize", `${where} passed ${String(maxBytes)} bytes and was abandoned`);
      };

      const request = https.get(
        target,
        {
          timeout: this.#options.timeoutMs ?? REQUEST_TIMEOUT_MS,
          // Counted bytes are the bytes on the wire: no compressed body to inflate past them.
          headers: { "accept-encoding": "identity" },
          ...(this.#options.ca === undefined ? {} : { ca: this.#options.ca }),
        },
        (response) => {
          const status = response.statusCode ?? 0;
          if (REDIRECTS.has(status)) {
            response.resume();
            resolve({ redirect: response.headers.location ?? null });
            return;
          }
          if (status < 200 || status >= 300) {
            response.resume();
            fail("status", `${where} answered ${String(status)}`);
            return;
          }
          const declared = Number(response.headers["content-length"]);
          if (Number.isFinite(declared) && declared > maxBytes) {
            request.destroy();
            oversize();
            return;
          }
          const chunks: Buffer[] = [];
          let received = 0;
          response.on("data", (chunk: Buffer) => {
            received += chunk.length;
            if (received > maxBytes) {
              request.destroy();
              oversize();
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () => {
            resolve({ result: { ok: true, body: new Uint8Array(Buffer.concat(chunks)) } });
          });
          response.on("error", (error) => {
            fail("transport", `${where} could not be read: ${error.message}`);
          });
        },
      );
      request.on("timeout", () => {
        request.destroy(new Error("timed out"));
      });
      request.on("error", (error) => {
        fail("transport", `${where} could not be read: ${error.message}`);
      });
    });
  }
}
