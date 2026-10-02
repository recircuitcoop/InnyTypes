// The client for Anytype's local API (plan 0018 §3, the port of anytype_api.py and of the
// pairing half of anytype_mcp/keys.py). One client, two users: the services process, and
// later the packages/anytype nodes, which bundle this same file (§4.2).
//
// * The credential, the base URL and the pinned `Anytype-Version` come from one place
//   (domain/anytype/pins.ts), so the client cannot drift from what the MCP child is sent.
// * Connectivity is decided once, by isApiReachable, and asked on every call: a desktop app
//   the person can quit at any moment has no "still up" to remember.
// * Endpoints are wrapped by name only once a slice has a caller for them: GET /v1/spaces
//   (the probe's, for the service), the spaces and types a step's form chooses from
//   (plan 0022 §B, every page of each), and the object and search calls of the packages/anytype
//   nodes (WI-0018-20). Anything else goes through `requestJson`.
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

/** As many entries as Anytype's API answers in one page (its documented maximum). */
const PAGE_SIZE = 1000;
/** The most pages one list reads: a million entries, far beyond any person's Anytype. */
const MAX_PAGES = 1000;

export interface Space {
  readonly id: string;
  /** Empty when the space has no name, never undefined. */
  readonly name: string;
}

/** One object type of a space: the key a node stores, and its name. */
export interface AnytypeType {
  readonly key: string;
  /** Empty when the type has no name, never undefined. */
  readonly name: string;
}

/** One Anytype object, as much of it as the nodes use; the whole answer stays in `raw`. */
export interface AnytypeObject {
  readonly id: string;
  /** Empty when the object has no name, never undefined. */
  readonly name: string;
  /** The object's type key (`page`, `task`, …); empty when Anytype named none. */
  readonly typeKey: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An object of Anytype's answer, or null when it is not one with an id. */
function objectOf(value: unknown): AnytypeObject | null {
  if (!isRecord(value) || typeof value["id"] !== "string" || value["id"] === "") {
    return null;
  }
  const { id, name, type } = value;
  const typeKey = isRecord(type) && typeof type["key"] === "string" ? type["key"] : "";
  return { id, name: typeof name === "string" ? name : "", typeKey, raw: value };
}

/** A space's path, its id escaped: ids come from flow config and payloads. */
function spacePath(spaceId: string): string {
  return `/v1/spaces/${encodeURIComponent(spaceId)}`;
}

/** The deep link the desktop app opens for an object (domain/views/popout.ts isAnytypeLink). */
export function anytypeLink(spaceId: string, objectId: string): string {
  return `anytype://object?objectId=${objectId}&spaceId=${spaceId}`;
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
  getJson(apiKey: string, path: string): Promise<unknown> {
    return this.requestJson(apiKey, "GET", path);
  }

  /**
   * `method` on `path`, with `body` as JSON when there is one, decoded; the same rules as
   * getJson. Sent once: a refusal (a 401 above all) is the caller's to report, never retried.
   */
  async requestJson(
    apiKey: string,
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const url = joinUrl(this.apiBaseUrl, path);
    if (!(await this.reachable(apiKey))) {
      throw this.#named(new AnytypeUnreachableError(this.apiBaseUrl));
    }
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers:
          body === undefined
            ? requestHeaders(apiKey)
            : { ...requestHeaders(apiKey), "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      // It answered the probe a moment ago and not this: the app went away mid-call.
      throw this.#named(new AnytypeUnreachableError(this.apiBaseUrl));
    }
    if (!response.ok) {
      await response.arrayBuffer().catch(() => undefined);
      throw this.#named(statusError(method, url, response.status));
    }
    try {
      return (await response.json()) as unknown;
    } catch {
      throw this.#named(new AnytypeApiError(`${method} ${url} returned a body that is not JSON`));
    }
  }

  // ── objects and search: what the packages/anytype nodes call (§4.2) ────────────────────

  /** Create one object in `spaceId` (POST /v1/spaces/{space_id}/objects). */
  async createObject(
    apiKey: string,
    spaceId: string,
    request: { readonly type_key: string; readonly name: string; readonly body: string },
  ): Promise<AnytypeObject> {
    const path = `${spacePath(spaceId)}/objects`;
    return this.#object("POST", path, await this.requestJson(apiKey, "POST", path, request));
  }

  /** Change an object's name or properties (PATCH /v1/spaces/{space_id}/objects/{id}). */
  async updateObject(
    apiKey: string,
    spaceId: string,
    objectId: string,
    request: Readonly<Record<string, unknown>>,
  ): Promise<AnytypeObject> {
    const path = `${spacePath(spaceId)}/objects/${encodeURIComponent(objectId)}`;
    return this.#object("PATCH", path, await this.requestJson(apiKey, "PATCH", path, request));
  }

  /** One object (GET /v1/spaces/{space_id}/objects/{id}). */
  async getObject(apiKey: string, spaceId: string, objectId: string): Promise<AnytypeObject> {
    const path = `${spacePath(spaceId)}/objects/${encodeURIComponent(objectId)}`;
    return this.#object("GET", path, await this.requestJson(apiKey, "GET", path));
  }

  /** The first `limit` objects of a space, in Anytype's order (GET …/objects). */
  async listObjects(apiKey: string, spaceId: string, limit: number): Promise<AnytypeObject[]> {
    const path = `${spacePath(spaceId)}/objects?offset=0&limit=${String(limit)}`;
    return this.#objects("GET", path, await this.requestJson(apiKey, "GET", path));
  }

  /** Search one space, or every space when `spaceId` is null (POST …/search). */
  async search(
    apiKey: string,
    spaceId: string | null,
    request: { readonly query: string; readonly types?: readonly string[] },
    limit: number,
  ): Promise<AnytypeObject[]> {
    const base = spaceId === null ? "/v1/search" : `${spacePath(spaceId)}/search`;
    const path = `${base}?offset=0&limit=${String(limit)}`;
    return this.#objects("POST", path, await this.requestJson(apiKey, "POST", path, request));
  }

  /** Every space, in Anytype's order, every page of it. Another shape is an error, not []. */
  async listSpaces(apiKey: string): Promise<Space[]> {
    const entries = await this.#everyPage(apiKey, SPACES_PATH, "space");
    return entries.map((entry) => ({
      id: entry.id,
      name: typeof entry.fields["name"] === "string" ? entry.fields["name"] : "",
    }));
  }

  /**
   * Every type of `spaceId` that is not archived, in Anytype's order, every page of it
   * (GET /v1/spaces/{space_id}/types). A type with no key is an error: the key is what a
   * node stores.
   */
  async listTypes(apiKey: string, spaceId: string): Promise<AnytypeType[]> {
    const path = `${spacePath(spaceId)}/types`;
    const entries = await this.#everyPage(apiKey, path, "type");
    return entries.flatMap(({ fields }) => {
      if (fields["archived"] === true) {
        return [];
      }
      const { key, name } = fields;
      if (typeof key !== "string" || key === "") {
        throw this.#named(
          new AnytypeApiError(`GET ${joinUrl(this.apiBaseUrl, path)} listed a type with no key`),
        );
      }
      return [{ key, name: typeof name === "string" ? name : "" }];
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

  /** The `object` of an ObjectResponse, which must carry an id. */
  #object(method: string, path: string, payload: unknown): AnytypeObject {
    const object = isRecord(payload) ? payload["object"] : undefined;
    const shaped = objectOf(object);
    if (shaped === null) {
      throw this.#named(
        new AnytypeApiError(
          `${method} ${joinUrl(this.apiBaseUrl, path)} returned no object with an id`,
        ),
      );
    }
    return shaped;
  }

  /** The `data` of a paginated answer: objects, each with an id. */
  #objects(method: string, path: string, payload: unknown): AnytypeObject[] {
    const entries = isRecord(payload) ? payload["data"] : undefined;
    const fail = (what: string): never => {
      throw this.#named(new AnytypeApiError(`${method} ${joinUrl(this.apiBaseUrl, path)} ${what}`));
    };
    if (!Array.isArray(entries)) {
      return fail("returned no `data` list of objects");
    }
    return entries.map((entry: unknown) => objectOf(entry) ?? fail("listed an object with no id"));
  }

  /**
   * The entries of every page of a paginated list at `path`, each an object with an id.
   * Pages follow `pagination.has_more`; an answer with no pagination is its only page.
   * Bounded, so an API that always says "more" cannot hold the caller forever.
   */
  async #everyPage(
    apiKey: string,
    path: string,
    what: "space" | "type",
  ): Promise<{ id: string; fields: Readonly<Record<string, unknown>> }[]> {
    const entries: { id: string; fields: Readonly<Record<string, unknown>> }[] = [];
    for (let page = 0, offset = 0; page < MAX_PAGES; page += 1) {
      const pagePath = `${path}?offset=${String(offset)}&limit=${String(PAGE_SIZE)}`;
      const payload = await this.getJson(apiKey, pagePath);
      const fail = (problem: string): never => {
        throw this.#named(
          new AnytypeApiError(`GET ${joinUrl(this.apiBaseUrl, pagePath)} ${problem}`),
        );
      };
      if (!isRecord(payload)) {
        return fail("returned something that is not an object");
      }
      const data = payload["data"];
      if (!Array.isArray(data)) {
        return fail(`returned no \`data\` list of ${what}s`);
      }
      for (const entry of data as unknown[]) {
        if (!isRecord(entry)) {
          return fail(`listed a ${what} that is not an object`);
        }
        const id = entry["id"];
        if (typeof id !== "string" || id === "") {
          return fail(`listed a ${what} with no id`);
        }
        entries.push({ id, fields: entry });
      }
      const pagination = payload["pagination"];
      if (data.length === 0 || !isRecord(pagination) || pagination["has_more"] !== true) {
        break;
      }
      offset += data.length;
    }
    return entries;
  }

  #named<T extends Error>(error: T): T {
    error.message = this.#redact(error.message);
    return error;
  }
}
