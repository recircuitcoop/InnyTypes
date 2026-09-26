// The Anytype API client, the health gate and pairing against a fake Anytype over real HTTP
// on a free loopback port (plan 0018 §3: the anytype_api.py, health.py and keys.py rows).
// Never the owner's Anytype, never port 31009 or 31010, never the owner's key file.
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AnytypeClient } from "../../src/adapters/anytype/api-client";
import { isApiReachable } from "../../src/adapters/anytype/health";
import { anytypeSecretFiles, OwnerOnlyFileStore } from "../../src/adapters/fs/owner-only-files";
import { Pairing } from "../../src/application/pair-anytype";
import { registering } from "../../src/application/secrets";
import {
  AnytypeApiError,
  AnytypeNotFoundError,
  AnytypeServerError,
  AnytypeStatusError,
  AnytypeUnauthorizedError,
  AnytypeUnreachableError,
  PairingError,
} from "../../src/domain/anytype/errors";
import { ANYTYPE_VERSION } from "../../src/domain/anytype/pins";
import { REDACTED, SecretRegistry } from "../../src/domain/redaction/registry";
import { RecordingLogger } from "../fakes/children";

const KEY = "client-key-0123456789";

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

/** A fake Anytype: answers with whatever `route` says, and records every request. */
class FakeAnytype {
  readonly seen: Seen[] = [];
  route: (seen: Seen) => { status: number; body: string } = () => ({
    status: 200,
    body: '{"data":[]}',
  });
  #server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    request.on("end", () => {
      const seen = {
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        body,
      };
      this.seen.push(seen);
      const answer = this.route(seen);
      response.writeHead(answer.status, { "content-type": "application/json" });
      response.end(answer.body);
    });
  });

  async listen(): Promise<string> {
    await new Promise<void>((resolve) => this.#server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${String((this.#server.address() as AddressInfo).port)}`;
  }

  close(): Promise<void> {
    return new Promise((resolve) =>
      this.#server.close(() => {
        resolve();
      }),
    );
  }
}

/** A URL where nothing listens: a port that was free a moment ago. */
async function deadUrl(): Promise<string> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
  return `http://127.0.0.1:${String(port)}`;
}

let anytype: FakeAnytype;
let base: string;

beforeEach(async () => {
  anytype = new FakeAnytype();
  base = await anytype.listen();
});

afterEach(async () => {
  await anytype.close();
});

describe("the health gate", () => {
  it("says a live API is reachable, and a 401 still is: the key is wrong, not the app absent", async () => {
    expect(await isApiReachable(fetch, base, KEY)).toBe(true);
    anytype.route = () => ({ status: 401, body: "{}" });
    expect(await isApiReachable(fetch, base, KEY)).toBe(true);
  });

  it("says a server error is not reachable, and a refused connection too, without a throw", async () => {
    anytype.route = () => ({ status: 503, body: "{}" });
    expect(await isApiReachable(fetch, base, KEY)).toBe(false);
    expect(await isApiReachable(fetch, await deadUrl(), KEY)).toBe(false);
  });

  it("carries the pinned API version, and the key only when there is one", async () => {
    await isApiReachable(fetch, base, KEY);
    await isApiReachable(fetch, base, null);
    expect(anytype.seen.map((s) => s.url)).toEqual(["/v1/spaces", "/v1/spaces"]);
    expect(anytype.seen[0]?.headers["anytype-version"]).toBe(ANYTYPE_VERSION);
    expect(anytype.seen[0]?.headers["authorization"]).toBe(`Bearer ${KEY}`);
    expect(anytype.seen[1]?.headers["authorization"]).toBeUndefined();
  });
});

describe("the client", () => {
  it("lists every space, with an empty name for a space that has none", async () => {
    anytype.route = () => ({
      status: 200,
      body: JSON.stringify({ data: [{ id: "a", name: "Work" }, { id: "b" }] }),
    });
    const client = new AnytypeClient({ apiBaseUrl: base });
    expect(await client.listSpaces(KEY)).toEqual([
      { id: "a", name: "Work" },
      { id: "b", name: "" },
    ]);
  });

  it("says no spaces with an empty list, not an error", async () => {
    expect(await new AnytypeClient({ apiBaseUrl: base }).listSpaces(KEY)).toEqual([]);
  });

  it("sends every request where the base URL says, with exactly the config's headers, once", async () => {
    await new AnytypeClient({ apiBaseUrl: `${base}/` }).getJson(KEY, "/v1/spaces");
    // The probe, then the request: both to the configured base, no doubled slash.
    expect(anytype.seen.map((s) => s.url)).toEqual(["/v1/spaces", "/v1/spaces"]);
    for (const seen of anytype.seen) {
      expect(seen.headers["authorization"]).toBe(`Bearer ${KEY}`);
      expect(seen.headers["anytype-version"]).toBe(ANYTYPE_VERSION);
    }
  });

  it.each([
    ["not an object", "[]", /not an object/],
    ["no data list", "{}", /no `data` list/],
    ["an entry that is not an object", '{"data":[1]}', /not an object/],
    ["an entry with no id", '{"data":[{"name":"x"}]}', /no id/],
    ["an entry with an empty id", '{"data":[{"id":""}]}', /no id/],
  ])("refuses a payload with %s", async (_what, body, message) => {
    anytype.route = () => ({ status: 200, body });
    await expect(new AnytypeClient({ apiBaseUrl: base }).listSpaces(KEY)).rejects.toThrow(message);
  });

  it.each([
    [401, AnytypeUnauthorizedError],
    [404, AnytypeNotFoundError],
    [418, AnytypeStatusError],
    [503, AnytypeServerError],
  ])("raises the named error for HTTP %i, carrying the status", async (status, kind) => {
    // The probe is answered below 500 so the call goes ahead; the call itself gets `status`.
    anytype.route = () =>
      anytype.seen.length === 1 && status >= 500
        ? { status: 200, body: "{}" }
        : { status, body: "{}" };
    const error = await new AnytypeClient({ apiBaseUrl: base })
      .getJson(KEY, "/v1/objects")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(kind);
    expect(error).toBeInstanceOf(AnytypeApiError);
    expect((error as AnytypeStatusError).status).toBe(status);
    expect((error as Error).message).toContain(`answered HTTP ${String(status)}`);
  });

  it("refuses a success whose body is not JSON", async () => {
    anytype.route = (seen) =>
      seen.url === "/v1/objects" ? { status: 200, body: "<html>" } : { status: 200, body: "{}" };
    await expect(
      new AnytypeClient({ apiBaseUrl: base }).getJson(KEY, "/v1/objects"),
    ).rejects.toThrow(/not JSON/);
  });

  it("refuses an unreachable API before the request, and names the base URL", async () => {
    const dead = await deadUrl();
    const error = await new AnytypeClient({ apiBaseUrl: dead })
      .getJson(KEY, "/v1/spaces")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AnytypeUnreachableError);
    expect((error as Error).message).toContain(dead);
    expect((error as Error).message).toContain("start the Anytype desktop app");
  });

  it("calls an API that went away mid-call unreachable too", async () => {
    let answered = 0;
    const flaky: typeof fetch = (input, init) => {
      answered += 1;
      return answered === 1 ? fetch(input, init) : Promise.reject(new TypeError("reset"));
    };
    await expect(
      new AnytypeClient({ apiBaseUrl: base, fetch: flaky }).getJson(KEY, "/v1/spaces"),
    ).rejects.toBeInstanceOf(AnytypeUnreachableError);
  });

  it("puts no key in any error, and redacts a key embedded in the base URL out of everything", async () => {
    const registry = new SecretRegistry();
    registry.protect(KEY);
    const embedded = (await deadUrl()).replace("http://", `http://${KEY}@`);
    const client = new AnytypeClient({
      apiBaseUrl: embedded,
      redact: (text) => registry.redact(text),
    });
    const error = await client.getJson(KEY, "/v1/spaces").catch((e: unknown) => e);
    for (const text of [String(error), String(client)]) {
      expect(text).not.toContain(KEY);
      expect(text).toContain(REDACTED);
    }
    // Break it, watch it fail: without the redactor the same call leaks the credential.
    const leaky = new AnytypeClient({ apiBaseUrl: embedded });
    expect(String(await leaky.getJson(KEY, "/v1/spaces").catch((e: unknown) => e))).toContain(KEY);
  });

  it("names where it points and never the key in its string form", () => {
    const text = String(new AnytypeClient({ apiBaseUrl: base }));
    expect(text).toBe(`AnytypeClient(apiBaseUrl=${base}, anytypeVersion=${ANYTYPE_VERSION})`);
  });
});

describe("pairing", () => {
  let scratch: string;
  beforeEach(() => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "inny-pairing-")));
  });
  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  const PAIRED_KEY = "paired-key-abcdefghij";

  function anytypePairs() {
    anytype.route = (seen) => {
      if (seen.url === "/v1/auth/challenges") {
        return { status: 201, body: '{"challenge_id":"ch-1"}' };
      }
      if (seen.url === "/v1/auth/api_keys") {
        const sent = JSON.parse(seen.body) as { challenge_id: string; code: string };
        return sent.challenge_id === "ch-1" && sent.code === "4321"
          ? { status: 201, body: JSON.stringify({ api_key: PAIRED_KEY }) }
          : { status: 400, body: "{}" };
      }
      return { status: 404, body: "{}" };
    };
  }

  function pairing() {
    const registry = new SecretRegistry();
    const files = anytypeSecretFiles({ platform: process.platform, home: scratch, env: {} });
    const store = registering(new OwnerOnlyFileStore(files), {
      protect: (secret) => registry.protect(secret),
    });
    const logger = new RecordingLogger();
    const subject = new Pairing(new AnytypeClient({ apiBaseUrl: base }), store, logger);
    return { subject, registry, logger, file: files["anytype-api-key"]?.file ?? "" };
  }

  it("starts with Anytype, and stores the key owner-only (0600 in a 0700 directory)", async () => {
    anytypePairs();
    const { subject, file, registry } = pairing();
    await subject.start();
    expect(anytype.seen[0]).toMatchObject({ method: "POST", url: "/v1/auth/challenges" });
    expect(JSON.parse(anytype.seen[0]?.body ?? "")).toEqual({ app_name: "InnyTypes" });
    expect(anytype.seen[0]?.headers["anytype-version"]).toBe(ANYTYPE_VERSION);
    await subject.complete("4321");
    expect(file).toBe(path.join(scratch, ".config", "innytypes", "anytype_api_key"));
    expect(fs.readFileSync(file, "utf8")).toBe(PAIRED_KEY);
    if (process.platform !== "win32") {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    }
    // Registered before the write: from here on no line can carry it.
    expect(registry.redact(`key ${PAIRED_KEY}`)).toBe(`key ${REDACTED}`);
  });

  it.each(["", "123", "12345", "abcd", "12 4", null, 1234])(
    "refuses %j, anything other than four digits, before asking Anytype",
    async (code) => {
      anytypePairs();
      const { subject } = pairing();
      await subject.start();
      await expect(subject.complete(code)).rejects.toBeInstanceOf(PairingError);
      expect(anytype.seen.map((s) => s.url)).toEqual(["/v1/auth/challenges"]);
    },
  );

  it("stores nothing, and prints the key nowhere, when Anytype rejects the code", async () => {
    anytypePairs();
    const { subject, file, logger } = pairing();
    await subject.start();
    await expect(subject.complete("0000")).rejects.toThrow(/rejected the pairing code/);
    expect(fs.existsSync(file)).toBe(false);
    await subject.complete("4321");
    expect(logger.lines.join("\n")).not.toContain(PAIRED_KEY);
  });

  it("refuses an answer that holds no usable key, and a pairing Anytype did not start", async () => {
    anytype.route = (seen) =>
      seen.url === "/v1/auth/challenges"
        ? { status: 201, body: '{"challenge_id":"ch-1"}' }
        : { status: 201, body: '{"api_key":"has a space"}' };
    const { subject, file } = pairing();
    await subject.start();
    await expect(subject.complete("1234")).rejects.toThrow(/no usable API key/);
    expect(fs.existsSync(file)).toBe(false);
    anytype.route = () => ({ status: 500, body: "{}" });
    await expect(subject.start()).rejects.toThrow(/did not start API pairing/);
  });

  it("writes only the canonical file: the legacy one is read, never written", async () => {
    anytypePairs();
    const files = anytypeSecretFiles({ platform: process.platform, home: scratch, env: {} });
    const legacy = files["anytype-api-key"]?.legacy ?? "";
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, "legacy-key-0123456789", { mode: 0o600 });
    const { subject, file } = pairing();
    await subject.start();
    await subject.complete("4321");
    expect(fs.readFileSync(legacy, "utf8")).toBe("legacy-key-0123456789");
    expect(fs.readFileSync(file, "utf8")).toBe(PAIRED_KEY);
    expect(new OwnerOnlyFileStore(files).read("anytype-api-key")).toBe(PAIRED_KEY);
  });
});

describe("the object and search calls (the packages/anytype nodes, WI-0018-20)", () => {
  /** A client over this file's fake, which answers each request with `answer`. */
  function answering(answer: unknown, status = 200): AnytypeClient {
    anytype.route = (seen) =>
      seen.url === "/v1/spaces"
        ? { status: 200, body: '{"data":[]}' }
        : { status, body: JSON.stringify(answer) };
    return new AnytypeClient({ apiBaseUrl: base });
  }

  const sent = () => anytype.seen.filter((seen) => seen.url !== "/v1/spaces");

  it("creates, updates and reads an object, each sent once with the key, JSON and the pinned version", async () => {
    const object = { id: "o1", name: "Notes", space_id: "s/1", type: { key: "page" } };
    const client = answering({ object });
    const created = await client.createObject(KEY, "s/1", {
      type_key: "page",
      name: "Notes",
      body: "b",
    });
    expect(created).toEqual({ id: "o1", name: "Notes", typeKey: "page", raw: object });
    await client.updateObject(KEY, "s/1", "o 1", { properties: [] });
    await client.getObject(KEY, "s/1", "o1");
    expect(sent().map((seen) => `${seen.method} ${seen.url}`)).toEqual([
      "POST /v1/spaces/s%2F1/objects",
      "PATCH /v1/spaces/s%2F1/objects/o%201",
      "GET /v1/spaces/s%2F1/objects/o1",
    ]);
    const [post] = sent();
    expect(post?.headers["authorization"]).toBe(`Bearer ${KEY}`);
    expect(post?.headers["anytype-version"]).toBe(ANYTYPE_VERSION);
    expect(post?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(post?.body ?? "")).toEqual({ type_key: "page", name: "Notes", body: "b" });
  });

  it("lists and searches, bounded by the limit, in one space or every space", async () => {
    const client = answering({
      data: [
        { id: "a", name: 3 },
        { id: "b", type: "odd" },
      ],
    });
    expect(await client.listObjects(KEY, "s1", 5)).toEqual([
      { id: "a", name: "", typeKey: "", raw: { id: "a", name: 3 } },
      { id: "b", name: "", typeKey: "", raw: { id: "b", type: "odd" } },
    ]);
    await client.search(KEY, null, { query: "q" }, 7);
    await client.search(KEY, "s1", { query: "", types: ["task"] }, 9);
    expect(sent().map((seen) => `${seen.method} ${seen.url} ${seen.body}`)).toEqual([
      "GET /v1/spaces/s1/objects?offset=0&limit=5 ",
      'POST /v1/search?offset=0&limit=7 {"query":"q"}',
      'POST /v1/spaces/s1/search?offset=0&limit=9 {"query":"","types":["task"]}',
    ]);
  });

  it("refuses answers of another shape, and names a 401 as the key being refused", async () => {
    await expect(answering({}).getObject(KEY, "s", "o")).rejects.toThrow(
      /GET .*\/v1\/spaces\/s\/objects\/o returned no object with an id$/,
    );
    await expect(answering({ object: { id: "" } }).getObject(KEY, "s", "o")).rejects.toThrow(
      AnytypeApiError,
    );
    await expect(answering([]).listObjects(KEY, "s", 1)).rejects.toThrow(
      /returned no `data` list of objects$/,
    );
    await expect(
      answering({ data: [{ name: "x" }] }).search(KEY, null, { query: "" }, 1),
    ).rejects.toThrow(/listed an object with no id$/);
    await expect(
      answering({}, 401).createObject(KEY, "s", { type_key: "page", name: "", body: "" }),
    ).rejects.toBeInstanceOf(AnytypeUnauthorizedError);
    // Once: a refusal is the caller's to report, never retried here.
    expect(sent().filter((seen) => seen.url === "/v1/spaces/s/objects")).toHaveLength(1);
  });
});
