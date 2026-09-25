// The catalogue read end to end against a local HTTPS server (WI-0018-14): the production
// HttpsClient, FileCatalogueCache, MinisignVerifier and CatalogueReader, with only the
// certificate the client trusts swapped for the test server's (test/fixtures/tls, made for
// 127.0.0.1 and localhost and used by nothing else). Every request the servers see is recorded.
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FileCatalogueCache } from "../../src/adapters/fs/catalogue-cache";
import { HttpsClient } from "../../src/adapters/net/https-client";
import { MinisignVerifier } from "../../src/adapters/signature/minisign";
import { CatalogueReader } from "../../src/application/catalogue-reader";
import { CatalogueRejected, type CatalogueSource } from "../../src/domain/packages/catalogue";
import { Signer } from "../fakes/minisign-signer";

// The ceilings of catalogue.py:173-174, written out rather than imported: a test that reads
// the bound from the code under test moves with it when somebody lifts it.
const MAX_CATALOGUE_BYTES = 1024 * 1024;
const MAX_SIGNATURE_BYTES = 4096;

const TLS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "tls");
const CERT = fs.readFileSync(path.join(TLS, "localhost-cert.pem"), "utf8");
const KEY = fs.readFileSync(path.join(TLS, "localhost-key.pem"), "utf8");

interface Published {
  readonly body?: Uint8Array;
  readonly status?: number;
  readonly location?: string;
  /** Send no Content-Length, so only counting the bytes can find the ceiling. */
  readonly chunked?: boolean;
  /** Never answer. */
  readonly silent?: boolean;
}

/** What the servers publish, by path, and every path they were asked for. */
const published = new Map<string, Published>();
const asked: string[] = [];
const askedInTheClear: string[] = [];

function answer(request: http.IncomingMessage, response: http.ServerResponse): void {
  const url = request.url ?? "";
  const found = published.get(url);
  if (found === undefined) {
    response.writeHead(404).end("no such object");
    return;
  }
  if (found.silent === true) {
    // Accept, and never answer: the client's timeout is what ends it.
    return;
  }
  if (found.location !== undefined) {
    const headers = found.location === "" ? {} : { location: found.location };
    response.writeHead(found.status ?? 302, headers).end();
    return;
  }
  const body = found.body ?? new Uint8Array(0);
  if (found.chunked === true) {
    response.writeHead(found.status ?? 200);
    // Written in pieces so the client sees a stream, as a server that never stops would send.
    for (let offset = 0; offset < body.length; offset += 64 * 1024) {
      response.write(body.subarray(offset, offset + 64 * 1024));
    }
    response.end();
    return;
  }
  response.writeHead(found.status ?? 200, { "content-length": String(body.length) }).end(body);
}

const server = https.createServer({ cert: CERT, key: KEY }, (request, response) => {
  asked.push(request.url ?? "");
  answer(request, response);
});
const clear = http.createServer((request, response) => {
  askedInTheClear.push(request.url ?? "");
  answer(request, response);
});

let base = "";
let clearBase = "";
let scratch = "";
let now = Date.UTC(2026, 8, 25, 12);

function listen(target: http.Server): Promise<string> {
  return new Promise((resolve) => {
    target.listen(0, "127.0.0.1", () => {
      resolve(String((target.address() as AddressInfo).port));
    });
  });
}

beforeAll(async () => {
  base = `https://127.0.0.1:${await listen(server)}`;
  clearBase = `http://127.0.0.1:${await listen(clear)}`;
});

afterAll(async () => {
  await Promise.all(
    [server, clear].map(
      (target) =>
        new Promise((resolve) => {
          target.closeAllConnections();
          target.close(resolve);
        }),
    ),
  );
});

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "inny-catalogue-server-"));
  published.clear();
  asked.length = 0;
  askedInTheClear.length = 0;
  now = Date.UTC(2026, 8, 25, 12);
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

function reader(officialKey: string | null, officialPath = "/official/catalogue.json") {
  return new CatalogueReader({
    http: new HttpsClient({ ca: CERT, timeoutMs: 5000 }),
    cache: new FileCatalogueCache(path.join(scratch, "catalogues")),
    verifier: new MinisignVerifier(),
    now: () => now,
    maxAgeSeconds: () => 3600,
    officialUrl: `${base}${officialPath}`,
    officialKey,
  });
}

function catalogue(...ids: string[]): Uint8Array {
  const plugins = ids.map((id) => ({ id, summary: `The ${id} package.`, source: `pypi:${id}` }));
  return new TextEncoder().encode(JSON.stringify({ catalogue: 1, plugins }));
}

function publish(route: string, body: Uint8Array, signer?: Signer): void {
  published.set(route, { body });
  if (signer !== undefined) {
    published.set(`${route}.minisig`, { body: new TextEncoder().encode(signer.sign(body)) });
  }
}

function source(name: string, url: string, publicKey: string | null = null): CatalogueSource {
  return { name, url, publicKey, autoUpdate: null };
}

describe("the catalogue over real HTTPS", () => {
  it("reads a signed official catalogue, and keeps it", async () => {
    const signer = new Signer();
    publish("/official/catalogue.json", catalogue("monty", "whodunnit"), signer);
    const read = await reader(signer.publicKeyText).official();
    expect(read.verified).toBe(true);
    expect(read.entries.map((entry) => entry.packageId)).toEqual(["monty", "whodunnit"]);
    expect(asked).toEqual(["/official/catalogue.json", "/official/catalogue.json.minisig"]);
    expect(fs.existsSync(path.join(scratch, "catalogues", "official.json"))).toBe(true);
  });

  it("serves a second read from the cache, asking the server nothing", async () => {
    const signer = new Signer();
    publish("/official/catalogue.json", catalogue("monty"), signer);
    await reader(signer.publicKeyText).official();
    const before = asked.length;
    now += 60_000;
    const again = await reader(signer.publicKeyText).official();
    expect(asked).toHaveLength(before);
    expect(again.entries.map((entry) => entry.packageId)).toEqual(["monty"]);
  });

  it("refuses a bad signature and keeps nothing", async () => {
    const signer = new Signer();
    publish("/official/catalogue.json", catalogue("monty", "evil"));
    published.set("/official/catalogue.json.minisig", {
      body: new TextEncoder().encode(signer.sign(catalogue("monty"))),
    });
    await expect(reader(signer.publicKeyText).official()).rejects.toMatchObject({
      reason: "signature",
      minisign: "bad-signature",
    });
    expect(fs.existsSync(path.join(scratch, "catalogues", "official.json"))).toBe(false);
  });

  it("reads a second source beside the official one: any publisher, keyed or not", async () => {
    const release = new Signer();
    const acme = new Signer();
    publish("/official/catalogue.json", catalogue("monty"), release);
    publish("/acme/catalogue.json", catalogue("anvil"), acme);
    publish("/hobbyist/catalogue.json", catalogue("kite"));
    const catalogues = reader(release.publicKeyText);

    const official = await catalogues.official();
    const keyed = await catalogues.registered(
      source("acme", `${base}/acme/catalogue.json`, acme.publicKeyLine),
    );
    const keyless = await catalogues.registered(
      source("hobbyist", `${base}/hobbyist/catalogue.json`),
    );

    expect([official, keyed, keyless].map((read) => [read.name, read.verified])).toEqual([
      ["official", true],
      ["acme", true],
      ["hobbyist", false],
    ]);
    expect(keyless.entries).toEqual([
      expect.objectContaining({ packageId: "kite", catalogue: "hobbyist", verified: false }),
    ]);
    // A source's key is its own: the official key does not verify acme's listing.
    await expect(
      catalogues.registered(source("acme-2", `${base}/acme/catalogue.json`, release.publicKeyLine)),
    ).rejects.toMatchObject({ reason: "signature", minisign: "wrong-key" });
  });
});

describe("the 1 MiB bound", () => {
  /** A valid catalogue padded with trailing spaces to exactly `size` bytes. */
  function padded(size: number): Uint8Array {
    const body = catalogue("monty");
    const out = new Uint8Array(size).fill(0x20);
    out.set(body, 0);
    return out;
  }

  it("reads a catalogue of exactly 1 MiB", async () => {
    published.set("/big/catalogue.json", { body: padded(MAX_CATALOGUE_BYTES), chunked: true });
    const read = await reader(null).registered(source("big", `${base}/big/catalogue.json`));
    expect(read.entries).toHaveLength(1);
  });

  it("abandons one byte more, counted as it arrives and when it is declared", async () => {
    for (const chunked of [true, false]) {
      published.set("/big/catalogue.json", { body: padded(MAX_CATALOGUE_BYTES + 1), chunked });
      await expect(
        reader(null).registered(source("big", `${base}/big/catalogue.json`)),
      ).rejects.toMatchObject({ reason: "oversize" });
    }
    expect(fs.existsSync(path.join(scratch, "catalogues", "big.json"))).toBe(false);
  });

  it("abandons a signature larger than its ceiling, as unsigned", async () => {
    const signer = new Signer();
    publish("/acme/catalogue.json", catalogue("monty"));
    published.set("/acme/catalogue.json.minisig", {
      body: new Uint8Array(MAX_SIGNATURE_BYTES + 1).fill(0x41),
    });
    const error: unknown = await reader(null)
      .registered(source("acme", `${base}/acme/catalogue.json`, signer.publicKeyLine))
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(CatalogueRejected);
    expect(error).toMatchObject({ reason: "unsigned" });
  });
});

describe("HTTPS only, and never an exception of the transport's own", () => {
  it("refuses a source at plain http before any request", async () => {
    publish("/acme/catalogue.json", catalogue("monty"));
    await expect(
      reader(null).registered(source("acme", `${clearBase}/acme/catalogue.json`)),
    ).rejects.toThrow("HTTPS");
    expect(askedInTheClear).toEqual([]);
  });

  it("follows a redirect to HTTPS and refuses one that drops to plain http", async () => {
    publish("/moved/catalogue.json", catalogue("monty"));
    published.set("/acme/catalogue.json", { status: 301, location: "/moved/catalogue.json" });
    const read = await reader(null).registered(source("acme", `${base}/acme/catalogue.json`));
    expect(read.entries).toHaveLength(1);

    published.set("/acme/catalogue.json", {
      status: 302,
      location: `${clearBase}/moved/catalogue.json`,
    });
    await expect(
      reader(null).registered(source("acme-2", `${base}/acme/catalogue.json`)),
    ).rejects.toThrow("HTTPS");
    expect(askedInTheClear).toEqual([]);
  });

  it("reports a server that is not there as a catalogue refusal", async () => {
    const gone = http.createServer();
    const port = await listen(gone);
    await new Promise((resolve) => gone.close(resolve));
    await expect(
      reader(null).registered(source("acme", `https://127.0.0.1:${port}/catalogue.json`)),
    ).rejects.toMatchObject({ reason: "unreachable" });
  });

  it("refuses a server whose certificate is not trusted", async () => {
    publish("/acme/catalogue.json", catalogue("monty"));
    const untrusting = new CatalogueReader({
      http: new HttpsClient({ timeoutMs: 5000 }),
      cache: new FileCatalogueCache(path.join(scratch, "catalogues")),
      verifier: new MinisignVerifier(),
      now: () => now,
      maxAgeSeconds: () => 3600,
      officialUrl: `${base}/official/catalogue.json`,
      officialKey: null,
    });
    await expect(
      untrusting.registered(source("acme", `${base}/acme/catalogue.json`)),
    ).rejects.toMatchObject({ reason: "unreachable" });
  });

  it("answers every other way a GET can fail with a result, never an exception", async () => {
    const client = new HttpsClient({ ca: CERT, timeoutMs: 300 });
    published.set("/nowhere", { status: 302, location: "" });
    published.set("/loop", { status: 302, location: "/loop" });
    published.set("/silent", { silent: true });
    const cases: [string, string, string][] = [
      [`${base}/missing`, "status", "answered 404"],
      [`${base}/nowhere`, "status", "redirected to nowhere"],
      [`${base}/loop`, "status", "redirected more than"],
      [`${base}/silent`, "transport", "timed out"],
      ["not a url", "insecure", "not an HTTPS URL"],
    ];
    for (const [url, failure, detail] of cases) {
      const result = await client.get(url, { maxBytes: 1024 });
      expect(result, url).toMatchObject({ ok: false, failure });
      expect(result.ok ? "" : result.detail, url).toContain(detail);
    }
  });
});
