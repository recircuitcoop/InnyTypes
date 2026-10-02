// Fakes for the Anytype core service: an MCP child whose session answers what a test says, a
// launcher that hands them out, Anytype's API as plain answers and over real HTTP, and a secret
// store in memory.

import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { SessionError } from "../../src/domain/anytype/errors";
import type {
  AnytypeApi,
  McpChild,
  McpChildLauncher,
  McpSession,
  McpTool,
} from "../../src/ports/anytype";
import type { SecretName, SecretStore } from "../../src/ports/secret-store";
import type { AnytypeStatus, McpEndpointStatus } from "../../src/ui/contract";

/** AppApi's Anytype and MCP endpoint members for a page test that never calls them. */
export const ANYTYPE_UNUSED = {
  anytypeStatus: (): Promise<AnytypeStatus> => Promise.reject(new Error("not used here")),
  startAnytypePairing: (): Promise<AnytypeStatus> => Promise.reject(new Error("not used here")),
  completeAnytypePairing: (): Promise<AnytypeStatus> => Promise.reject(new Error("not used here")),
  mcpEndpoint: (): Promise<McpEndpointStatus> => Promise.reject(new Error("not used here")),
  moveMcpEndpoint: (): Promise<McpEndpointStatus> => Promise.reject(new Error("not used here")),
};

/** How a fake child answers pings: at once, never, or with a refusal. */
export type PingMode = "answer" | "silent" | "refuse";

export class FakeSession implements McpSession {
  closed = false;
  pings = 0;
  pingMode: PingMode = "answer";
  /** What initialize does: resolve with these tools, or reject with this error. */
  initializeWith: readonly McpTool[] | Error = [];
  readonly requests: string[] = [];
  readonly #waiting: ((error: SessionError) => void)[] = [];

  initialize(): Promise<readonly McpTool[]> {
    if (this.initializeWith instanceof Error) {
      return Promise.reject(this.initializeWith);
    }
    return Promise.resolve(this.initializeWith);
  }

  ping(): Promise<void> {
    this.pings += 1;
    if (this.closed) {
      return Promise.reject(new SessionError("the Anytype MCP child session is closed"));
    }
    switch (this.pingMode) {
      case "answer":
        return Promise.resolve();
      case "refuse":
        return Promise.reject(new SessionError("the Anytype MCP child refused ping: no"));
      case "silent":
        return new Promise((_resolve, reject) => {
          this.#waiting.push(reject);
        });
    }
  }

  request(method: string): Promise<unknown> {
    this.requests.push(method);
    if (this.closed) {
      return Promise.reject(new SessionError("the Anytype MCP child session is closed"));
    }
    return new Promise((_resolve, reject) => {
      this.#waiting.push(reject);
    });
  }

  /** A silent ping's own timeout firing. */
  timeOutPings(): void {
    for (const reject of this.#waiting.splice(0)) {
      reject(new SessionError("the Anytype MCP child timed out answering ping"));
    }
  }

  close(reason: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const reject of this.#waiting.splice(0)) {
      reject(new SessionError(reason));
    }
  }
}

export class FakeMcpChild implements McpChild {
  readonly session = new FakeSession();
  stops = 0;
  exited = false;
  readonly #listeners: ((code: number | null, signal: string | null) => void)[] = [];

  constructor(readonly pid: number) {}

  onExit(listener: (code: number | null, signal: string | null) => void): void {
    this.#listeners.push(listener);
  }

  stop(): Promise<void> {
    this.stops += 1;
    this.exit(null, "SIGTERM");
    return Promise.resolve();
  }

  /** The child is gone: its session fails everything pending, as the real adapter does. */
  exit(code: number | null, signal: string | null = null): void {
    if (this.exited) {
      return;
    }
    this.exited = true;
    this.session.close(`the Anytype MCP child exited (code ${String(code)})`);
    for (const listener of this.#listeners) {
      listener(code, signal);
    }
  }
}

export class FakeMcpLauncher implements McpChildLauncher {
  readonly children: FakeMcpChild[] = [];
  readonly envs: Readonly<Record<string, string>>[] = [];
  /** Set up each new child before the service sees it. */
  prepare: (child: FakeMcpChild) => void = () => undefined;
  #nextPid = 5000;

  launch(env: Readonly<Record<string, string>>): McpChild {
    const child = new FakeMcpChild(this.#nextPid++);
    this.prepare(child);
    this.envs.push(env);
    this.children.push(child);
    return child;
  }

  get current(): FakeMcpChild {
    const child = this.children.at(-1);
    if (child === undefined) {
      throw new Error("no MCP child was launched");
    }
    return child;
  }
}

export class FakeAnytypeApi implements AnytypeApi {
  up = true;
  readonly probes: (string | null)[] = [];
  challenge = "challenge-1";
  issuedKey = "paired-key-0123456789";

  reachable(apiKey: string | null): Promise<boolean> {
    this.probes.push(apiKey);
    return Promise.resolve(this.up);
  }

  startPairing(): Promise<string> {
    return Promise.resolve(this.challenge);
  }

  completePairing(challengeId: string, code: string): Promise<string> {
    if (challengeId !== this.challenge || code !== "1234") {
      return Promise.reject(new Error("Anytype rejected the pairing code."));
    }
    return Promise.resolve(this.issuedKey);
  }

  /** What the lists answer; an Error is thrown instead. */
  spaces: readonly { id: string; name: string }[] | Error = [];
  types = new Map<string, readonly { key: string; name: string }[]>();
  typesError: Error | null = null;
  /** Each list call, with the key it was made with. */
  readonly listed: string[] = [];

  listSpaces(apiKey: string): Promise<readonly { id: string; name: string }[]> {
    this.listed.push(`spaces ${apiKey}`);
    return this.spaces instanceof Error
      ? Promise.reject(this.spaces)
      : Promise.resolve(this.spaces);
  }

  listTypes(apiKey: string, spaceId: string): Promise<readonly { key: string; name: string }[]> {
    this.listed.push(`types ${spaceId} ${apiKey}`);
    return this.typesError === null
      ? Promise.resolve(this.types.get(spaceId) ?? [])
      : Promise.reject(this.typesError);
  }
}

export class MemorySecretStore implements SecretStore {
  readonly values = new Map<SecretName, string>();

  read(name: SecretName): string | null {
    return this.values.get(name) ?? null;
  }

  write(name: SecretName, value: string): void {
    this.values.set(name, value.trim());
  }
}

/** One request the fake Anytype HTTP server received. */
export interface ReceivedRequest {
  readonly method: string;
  /** The path with its query. */
  readonly url: string;
  readonly authorization: string;
  readonly version: string;
  readonly body: unknown;
}

/** A request body as JSON, or as the text it was when it is not JSON. */
function parsed(text: string): unknown {
  try {
    return text === "" ? null : (JSON.parse(text) as unknown);
  } catch {
    return text;
  }
}

/**
 * Anytype's local API over real HTTP on a free loopback port, holding objects in memory: the
 * probe, create, update, get and list of objects, and search, in the shapes of the pinned
 * API version's OpenAPI spec. It accepts exactly one key; `refuseEveryKey` makes it answer 401
 * to all. Never the person's Anytype: the packages/anytype nodes are tested against this.
 */
export class FakeAnytypeServer {
  readonly received: ReceivedRequest[] = [];
  readonly objects = new Map<string, Record<string, unknown>>();
  refuseEveryKey = false;
  /** The spaces `GET /v1/spaces` lists, and each space's types (`GET …/types`). */
  spaces: { id: string; name: string }[] = [];
  readonly types = new Map<string, { key: string; name: string; archived?: boolean }[]>();
  /**
   * While set, a list of spaces or types asked for a page (`?offset=`) waits for it; the
   * bare health probe is answered at once.
   */
  hold: Promise<void> | null = null;
  #server: http.Server | null = null;
  #next = 1;

  constructor(readonly key: string) {}

  /** Listen on a free loopback port; the base URL comes back. */
  async start(): Promise<string> {
    const server = http.createServer((request, response) => {
      let text = "";
      request.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
      request.on("end", () => {
        this.#answer(request, text, response);
      });
    });
    this.#server = server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  }

  close(): Promise<void> {
    const server = this.#server;
    return server === null
      ? Promise.resolve()
      : new Promise((resolve) => {
          server.closeAllConnections();
          server.close(() => {
            resolve();
          });
        });
  }

  /** The requests of `method` whose path starts with `pathPrefix`. */
  to(method: string, pathPrefix: string): ReceivedRequest[] {
    return this.received.filter(
      (request) => request.method === method && request.url.startsWith(pathPrefix),
    );
  }

  /** An object already in a space, as Anytype would list it. */
  put(spaceId: string, name: string, typeKey = "page"): Record<string, unknown> {
    const id = `obj${String(this.#next++)}`;
    const object = { object: "object", id, name, space_id: spaceId, type: { key: typeKey } };
    this.objects.set(id, object);
    return object;
  }

  #answer(request: http.IncomingMessage, text: string, response: http.ServerResponse): void {
    const url = request.url ?? "/";
    const body = parsed(text);
    this.received.push({
      method: request.method ?? "",
      url,
      authorization: request.headers.authorization ?? "",
      version: String(request.headers["anytype-version"] ?? ""),
      body,
    });
    const reply = (status: number, value: unknown): void => {
      response.statusCode = status;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(value));
    };
    if (this.refuseEveryKey || request.headers.authorization !== `Bearer ${this.key}`) {
      reply(401, { code: "unauthorized", message: "invalid api key" });
      return;
    }
    const [path = "", query = ""] = url.split("?");
    const limit = Number(new URLSearchParams(query).get("limit") ?? "100");
    const sent = (body ?? {}) as Record<string, unknown>;
    const route = /^\/v1\/spaces\/([^/]+)\/(objects|search)(?:\/([^/]+))?$/.exec(path);
    const typesOf = /^\/v1\/spaces\/([^/]+)\/types$/.exec(path);
    if (path === "/v1/spaces" || typesOf !== null) {
      const listed =
        typesOf === null
          ? this.spaces.map((space) => ({ object: "space", ...space }))
          : (this.types.get(decodeURIComponent(typesOf[1] ?? "")) ?? []).map((type) => ({
              object: "type",
              id: `type-${type.key}`,
              ...type,
            }));
      const answer = () => {
        reply(200, this.#page(listed, limit));
      };
      if (this.hold !== null && query.includes("offset=")) {
        void this.hold.then(answer);
      } else {
        answer();
      }
      return;
    }
    if (path === "/v1/search" && request.method === "POST") {
      reply(200, this.#page(this.#search(null, sent), limit));
      return;
    }
    if (route === null) {
      reply(404, { code: "not_found", message: `no route ${path}` });
      return;
    }
    const space = decodeURIComponent(route[1] ?? "");
    const objectId = route[3] === undefined ? null : decodeURIComponent(route[3]);
    if (route[2] === "search" && request.method === "POST") {
      reply(200, this.#page(this.#search(space, sent), limit));
    } else if (objectId === null && request.method === "POST") {
      const name = typeof sent["name"] === "string" ? sent["name"] : "";
      const typeKey = typeof sent["type_key"] === "string" ? sent["type_key"] : "page";
      const object = this.put(space, name, typeKey);
      reply(200, { object: { ...object, markdown: sent["body"] } });
    } else if (objectId === null && request.method === "GET") {
      const inSpace = [...this.objects.values()].filter((object) => object["space_id"] === space);
      reply(200, this.#page(inSpace, limit));
    } else {
      const object = objectId === null ? undefined : this.objects.get(objectId);
      if (object === undefined || object["space_id"] !== space) {
        reply(404, { code: "not_found", message: `object ${String(objectId)} not found` });
      } else if (request.method === "PATCH") {
        object["properties"] = sent["properties"];
        reply(200, { object });
      } else {
        reply(200, { object });
      }
    }
  }

  #search(space: string | null, sent: Record<string, unknown>): Record<string, unknown>[] {
    const query = typeof sent["query"] === "string" ? sent["query"].toLowerCase() : "";
    const types = Array.isArray(sent["types"]) ? (sent["types"] as unknown[]) : [];
    return [...this.objects.values()].filter(
      (object) =>
        (space === null || object["space_id"] === space) &&
        String(object["name"]).toLowerCase().includes(query) &&
        (types.length === 0 || types.includes((object["type"] as { key: string }).key)),
    );
  }

  #page(objects: Record<string, unknown>[], limit: number): unknown {
    return {
      data: objects.slice(0, limit),
      pagination: { total: objects.length, offset: 0, limit, has_more: objects.length > limit },
    };
  }
}

/** Let every promise already settled run its callbacks. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}
