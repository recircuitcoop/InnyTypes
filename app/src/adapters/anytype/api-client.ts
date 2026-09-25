// The client for Anytype's local API (plan 0018 §3, the port of anytype_api.py and of the
// pairing half of anytype_mcp/keys.py). One client, two users: the services process, and
// later the packages/anytype nodes, which bundle this same file (§4.2).
//
// * The credential, the base URL and the pinned `Anytype-Version` come from one place
//   (domain/anytype/pins.ts), so the client cannot drift from what the MCP child is sent.
// * Connectivity is decided once, by isApiReachable, and asked on every call: a desktop app
//   the person can quit at any moment has no "still up" to remember.
// * Exactly one endpoint is wrapped by name, GET /v1/spaces, the one the probe already uses.
//   Anything else goes through `getJson`, named in the slice that has a caller for it.
// * No error carries the key or a response body, and every message is redacted on its way out,
//   because a base URL is user-supplied and a key can be embedded in one.

import {
  AnytypeApiError,
  AnytypeUnreachableError,
  PairingError,
  statusError,
} from "../../domain/anytype/errors";
import { ANYTYPE_VERSION, joinUrl } from "../../domain/anytype/pins";
import type { AnytypeApi } from "../../ports/anytype";
import { isApiReachable, requestHeaders, SPACES_PATH, type Fetch } from "./health";

/** Generous rather than snappy: the desktop app can be busy indexing (anytype_api.py:54). */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** What an Anytype API key may consist of (keys.py:70): anything else is not a key. */
const KEY_SHAPE = /^[A-Za-z0-9._~+/=-]{8,}$/;

export interface Space {
  readonly id: string;
  /** Empty when the space has no name, never undefined. */
  readonly name: string;
}

export interface AnytypeClientOptions {
  readonly apiBaseUrl: string;
  readonly fetch?: Fetch;
  readonly timeoutMs?: number;
  /** Applied to every error message this client builds (the process's redactor). */
  readonly redact?: (text: string) => string;
}

export class AnytypeClient implements AnytypeApi {
  readonly apiBaseUrl: string;
  readonly #fetch: Fetch;
  readonly #timeoutMs: number;
  readonly #redact: (text: string) => string;

  constructor(options: AnytypeClientOptions) {
    this.apiBaseUrl = options.apiBaseUrl;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#redact = options.redact ?? ((text) => text);
  }

  reachable(apiKey: string | null): Promise<boolean> {
    return isApiReachable(this.#fetch, this.apiBaseUrl, apiKey);
  }

  /**
   * GET `path`, decoded. An unreachable API, a non-2xx (as its named error) and a body that
   * is not JSON are each an error: a failure is never returned as if it had worked.
   */
  async getJson(apiKey: string, path: string): Promise<unknown> {
    const url = joinUrl(this.apiBaseUrl, path);
    if (!(await this.reachable(apiKey))) {
      throw this.#named(new AnytypeUnreachableError(this.apiBaseUrl));
    }
    let response: Response;
    try {
      response = await this.#fetch(url, {
        headers: requestHeaders(apiKey),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      // It answered the probe a moment ago and not this: the app went away mid-call.
      throw this.#named(new AnytypeUnreachableError(this.apiBaseUrl));
    }
    if (!response.ok) {
      await response.arrayBuffer().catch(() => undefined);
      throw this.#named(statusError("GET", url, response.status));
    }
    try {
      return (await response.json()) as unknown;
    } catch {
      throw this.#named(new AnytypeApiError(`GET ${url} returned a body that is not JSON`));
    }
  }

  /** Every space, in Anytype's order. A payload of another shape is an error, not []. */
  async listSpaces(apiKey: string): Promise<Space[]> {
    const payload = await this.getJson(apiKey, SPACES_PATH);
    const url = joinUrl(this.apiBaseUrl, SPACES_PATH);
    const fail = (what: string): never => {
      throw this.#named(new AnytypeApiError(`GET ${url} ${what}`));
    };
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return fail("returned something that is not an object");
    }
    const entries = (payload as Record<string, unknown>)["data"];
    if (!Array.isArray(entries)) {
      return fail("returned no `data` list of spaces");
    }
    return entries.map((entry: unknown) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        return fail("listed a space that is not an object");
      }
      const { id, name } = entry as Record<string, unknown>;
      if (typeof id !== "string" || id === "") {
        return fail("listed a space with no id");
      }
      return { id, name: typeof name === "string" ? name : "" };
    });
  }

  /** Ask Anytype to show a pairing code for InnyTypes (keys.py:109-129). */
  async startPairing(): Promise<string> {
    const answer = await this.#post("/v1/auth/challenges", { app_name: "InnyTypes" });
    const challengeId = answer?.["challenge_id"];
    if (typeof challengeId !== "string" || challengeId.trim() === "") {
      throw new PairingError(
        "Anytype did not start API pairing. Make sure Anytype is running, then try again.",
      );
    }
    return challengeId.trim();
  }

  /** Exchange the four-digit code for a key (keys.py:132-158). The key is only returned. */
  async completePairing(challengeId: string, code: string): Promise<string> {
    const answer = await this.#post("/v1/auth/api_keys", { challenge_id: challengeId, code });
    if (answer === null) {
      throw new PairingError(
        "Anytype rejected the pairing code. Start pairing again and use the new code.",
      );
    }
    const key = answer["api_key"];
    if (typeof key !== "string" || !KEY_SHAPE.test(key.trim())) {
      throw new PairingError("Anytype returned no usable API key; nothing was stored");
    }
    return key.trim();
  }

  /** Names where it points and what it speaks, never a credential (anytype_api.py:176-187). */
  toString(): string {
    return this.#redact(
      `AnytypeClient(apiBaseUrl=${this.apiBaseUrl}, anytypeVersion=${ANYTYPE_VERSION})`,
    );
  }

  /** POST JSON with only the pinned version; the decoded object, or null on any failure. */
  async #post(path: string, body: unknown): Promise<Record<string, unknown> | null> {
    try {
      const response = await this.#fetch(joinUrl(this.apiBaseUrl, path), {
        method: "POST",
        headers: { "Anytype-Version": ANYTYPE_VERSION, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      if (!response.ok) {
        await response.arrayBuffer().catch(() => undefined);
        return null;
      }
      const decoded = (await response.json()) as unknown;
      return typeof decoded === "object" && decoded !== null && !Array.isArray(decoded)
        ? (decoded as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  #named<T extends Error>(error: T): T {
    error.message = this.#redact(error.message);
    return error;
  }
}
