// One telemetry POST over node:https (plan 0018 §2.3 adapters/telemetry; telemetry.py:1016-1105).
//
// HTTPS only, checked before anything is sent; no redirect is followed (a report goes where the
// build says, or nowhere); every request has a timeout; every failure is a result, never an
// exception, so a server that is down, slow or gone is a retry and nothing more.

import https from "node:https";
import type { Outgoing } from "../../domain/telemetry/transports";
import type { PostResult, TelemetryPoster } from "../../ports/telemetry";

/** Nothing may wait on a slow telemetry server for longer than this (telemetry.py SEND_TIMEOUT). */
export const SEND_TIMEOUT_MS = 10_000;

export interface HttpsPosterOptions {
  /** Certificates to trust instead of the system's. Production leaves it out; tests pass theirs. */
  readonly ca?: string;
  readonly timeoutMs?: number;
}

export class HttpsPoster implements TelemetryPoster {
  readonly #options: HttpsPosterOptions;

  constructor(options: HttpsPosterOptions = {}) {
    this.#options = options;
  }

  post(request: Outgoing): Promise<PostResult> {
    let target: URL;
    try {
      target = new URL(request.url);
    } catch {
      return Promise.resolve({ ok: false, detail: "the telemetry endpoint is not a URL" });
    }
    if (target.protocol !== "https:") {
      return Promise.resolve({
        ok: false,
        detail: `${target.origin} is not HTTPS; telemetry is never sent in the clear`,
      });
    }
    const body = Buffer.from(request.body, "utf8");
    return new Promise<PostResult>((resolve) => {
      const outgoing = https.request(
        target,
        {
          method: "POST",
          timeout: this.#options.timeoutMs ?? SEND_TIMEOUT_MS,
          headers: { ...request.headers, "Content-Length": String(body.length) },
          ...(this.#options.ca === undefined ? {} : { ca: this.#options.ca }),
        },
        (response) => {
          const status = response.statusCode ?? 0;
          // The answer's body is not wanted; reading it to the end frees the socket.
          response.resume();
          resolve(
            status >= 200 && status < 300
              ? { ok: true }
              : { ok: false, detail: `${target.origin} answered ${String(status)}` },
          );
        },
      );
      outgoing.on("timeout", () => {
        outgoing.destroy(new Error("timed out"));
      });
      outgoing.on("error", (error) => {
        resolve({ ok: false, detail: `${target.origin} could not be reached: ${error.message}` });
      });
      outgoing.end(body);
    });
  }
}
