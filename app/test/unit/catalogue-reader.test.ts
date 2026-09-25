// Reading a catalogue: signatures, sources and the cache (WI-0018-14). tests/test_plugin_catalogue.py
// acceptances 2, 3, 4, 7 and 8, ported. Every fetch goes through PublishingHost, which records
// every request, so a refusal can assert the strong form: nothing was ever asked for. The cache
// is a real FileCatalogueCache in a scratch directory, and the signing keys are made per test.
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileCatalogueCache } from "../../src/adapters/fs/catalogue-cache";
import { MinisignVerifier } from "../../src/adapters/signature/minisign";
import { CatalogueReader } from "../../src/application/catalogue-reader";
import {
  CatalogueDocumentError,
  CatalogueRejected,
  entryFor,
  OFFICIAL_SOURCE_NAME,
  parseCatalogue,
  type CatalogueSource,
} from "../../src/domain/packages/catalogue";
import {
  decodeCachedCatalogue,
  encodeCachedCatalogue,
} from "../../src/domain/packages/catalogue-cache";
import { Signer } from "../fakes/minisign-signer";
import { PublishingHost } from "../fakes/publishing-host";

const OFFICIAL_URL = "https://catalogues.example.invalid/official/catalogue.json";
const ACME_URL = "https://acme.example.invalid/catalogue.json";
const NOW = Date.UTC(2026, 8, 19, 12, 0, 0);
const CHECK_INTERVAL = 3600;

let scratch = "";
let host: PublishingHost;
let now = NOW;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "inny-catalogue-"));
  host = new PublishingHost();
  now = NOW;
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

const cacheDirectory = (): string => path.join(scratch, "catalogues");
const cacheFile = (name: string): string => path.join(cacheDirectory(), `${name}.json`);

function reader(officialKey: string | null = null): CatalogueReader {
  return new CatalogueReader({
    http: host,
    cache: new FileCatalogueCache(cacheDirectory()),
    verifier: new MinisignVerifier(),
    now: () => now,
    maxAgeSeconds: () => CHECK_INTERVAL,
    officialUrl: OFFICIAL_URL,
    officialKey,
  });
}

function serialized(...ids: string[]): Uint8Array {
  const plugins = (ids.length === 0 ? ["monty"] : ids).map((id) => ({
    id,
    summary: `The ${id} package.`,
    source: `pypi:${id}`,
  }));
  return new TextEncoder().encode(JSON.stringify({ catalogue: 1, plugins }));
}

function acme(publicKey: string | null = null, url = ACME_URL): CatalogueSource {
  return { name: "acme", url, publicKey, autoUpdate: null };
}

async function rejection(read: Promise<unknown>): Promise<CatalogueRejected> {
  const error: unknown = await read.then(
    () => new Error("expected a rejection, and the catalogue was read"),
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(CatalogueRejected);
  return error as CatalogueRejected;
}

describe("fetching (acceptance 2)", () => {
  it("fetches a catalogue through the HttpClient", async () => {
    host.publish(ACME_URL, serialized("monty", "whodunnit"));
    const catalogue = await reader().registered(acme());
    expect(host.urls).toEqual([ACME_URL]);
    expect(catalogue.entries.map((item) => item.packageId)).toEqual(["monty", "whodunnit"]);
    expect(catalogue).toMatchObject({ name: "acme", url: ACME_URL, fetchedAt: NOW });
  });

  it("refuses a source that answers with an error, and keeps nothing", async () => {
    await expect(reader().registered(acme())).rejects.toThrow(ACME_URL);
    await expect(reader().registered(acme())).rejects.toMatchObject({ reason: "unreachable" });
    expect(fs.existsSync(cacheFile("acme"))).toBe(false);
  });

  it("refuses a source that answers with something that is not JSON", async () => {
    host.publish(ACME_URL, new TextEncoder().encode("<html>not a catalogue</html>"));
    await expect(reader().registered(acme())).rejects.toThrow("not valid JSON");
    expect(fs.existsSync(cacheFile("acme"))).toBe(false);
  });

  it("refuses a source that answers with bytes that are not UTF-8", async () => {
    host.publish(ACME_URL, Uint8Array.from([0xff, 0xfe, 0x7b, 0x7d]));
    await expect(reader().registered(acme())).rejects.toThrow("not UTF-8");
  });

  it("reports a transport failure as a catalogue refusal", async () => {
    host.failure = { ok: false, failure: "transport", detail: "connection refused" };
    await expect(reader().registered(acme())).rejects.toBeInstanceOf(CatalogueDocumentError);
  });

  it("refuses a catalogue past its ceiling as oversize", async () => {
    host.failure = { ok: false, failure: "oversize", detail: "too large" };
    await expect(reader().registered(acme())).rejects.toMatchObject({ reason: "oversize" });
  });
});

describe("the official catalogue must be signed, and a bad one is never kept (acceptance 3)", () => {
  it("verifies the official catalogue against the release's public key", async () => {
    const signer = new Signer();
    const body = serialized("monty");
    host.publish(OFFICIAL_URL, body, signer.sign(body));
    const catalogue = await reader(signer.publicKeyText).official();
    expect(catalogue.name).toBe(OFFICIAL_SOURCE_NAME);
    expect(catalogue.verified).toBe(true);
    expect(catalogue.entries.every((item) => item.verified)).toBe(true);
    expect(host.urls).toEqual([OFFICIAL_URL, `${OFFICIAL_URL}.minisig`]);
    expect(fs.existsSync(cacheFile(OFFICIAL_SOURCE_NAME))).toBe(true);
  });

  it("rejects a tampered official catalogue and keeps nothing", async () => {
    const signer = new Signer();
    const genuine = serialized("monty");
    const tampered = serialized("monty", "evil");
    host.publish(OFFICIAL_URL, tampered, signer.sign(genuine));
    // The tampered document is beyond reproach as a document: only the signature check refuses.
    expect(
      parseCatalogue(JSON.parse(new TextDecoder().decode(tampered)), {
        catalogue: "x",
        verified: false,
      }),
    ).toHaveLength(2);
    const error = await rejection(reader(signer.publicKeyText).official());
    expect(error).toMatchObject({
      reason: "signature",
      minisign: "bad-signature",
      source: OFFICIAL_SOURCE_NAME,
    });
    expect(fs.existsSync(cacheFile(OFFICIAL_SOURCE_NAME))).toBe(false);
  });

  it("rejects an official catalogue signed by a stranger", async () => {
    const signer = new Signer();
    const stranger = new Signer();
    const body = serialized("monty");
    host.publish(OFFICIAL_URL, body, stranger.sign(body));
    const error = await rejection(reader(signer.publicKeyText).official());
    expect(error).toMatchObject({ reason: "signature", minisign: "wrong-key" });
    expect(fs.existsSync(cacheFile(OFFICIAL_SOURCE_NAME))).toBe(false);
  });

  it("rejects an official catalogue with no signature published", async () => {
    host.publish(OFFICIAL_URL, serialized("monty"));
    const error = await rejection(reader(new Signer().publicKeyText).official());
    expect(error.reason).toBe("unsigned");
    expect(fs.existsSync(cacheFile(OFFICIAL_SOURCE_NAME))).toBe(false);
  });

  it("rejects the official catalogue when its signature is not UTF-8", async () => {
    host.publish(OFFICIAL_URL, serialized("monty"));
    host.responses.set(`${OFFICIAL_URL}.minisig`, Uint8Array.from([0xff, 0xfe]));
    expect((await rejection(reader(new Signer().publicKeyText).official())).reason).toBe(
      "signature",
    );
  });

  it("cannot read the official catalogue in a build with no release key, and asks nothing", async () => {
    host.publish(OFFICIAL_URL, serialized("monty"));
    expect((await rejection(reader(null).official())).reason).toBe("key");
    expect(host.urls).toEqual([]);
  });
});

describe("a registered source: keyed, keyed and lying, or keyless (acceptance 4)", () => {
  it("verifies a registered source with a key the same way", async () => {
    const signer = new Signer();
    const body = serialized("monty", "whodunnit");
    host.publish(ACME_URL, body, signer.sign(body));
    const catalogue = await reader().registered(acme(signer.publicKeyLine));
    expect(catalogue.verified).toBe(true);
    expect(catalogue.entries.every((item) => item.verified)).toBe(true);
    expect(host.urls).toEqual([ACME_URL, `${ACME_URL}.minisig`]);
  });

  it("rejects the whole catalogue of a registered source with a bad signature", async () => {
    const signer = new Signer();
    const stranger = new Signer();
    const body = serialized("monty", "whodunnit", "summarize");
    host.publish(ACME_URL, body, stranger.sign(body));
    const error = await rejection(reader().registered(acme(signer.publicKeyLine)));
    expect(error).toMatchObject({ reason: "signature", source: "acme" });
    expect(fs.existsSync(cacheFile("acme"))).toBe(false);
  });

  it("reads a registered source with no key over one request, and marks it unverified", async () => {
    host.publish(ACME_URL, serialized("monty", "whodunnit"));
    const catalogue = await reader().registered(acme());
    expect(catalogue.verified).toBe(false);
    expect(catalogue.entries.map((item) => [item.verified, item.catalogue])).toEqual([
      [false, "acme"],
      [false, "acme"],
    ]);
    expect(host.urls).toEqual([ACME_URL]);
  });

  it("rejects a keyed source that publishes no signature", async () => {
    host.publish(ACME_URL, serialized("monty"));
    expect((await rejection(reader().registered(acme(new Signer().publicKeyLine)))).reason).toBe(
      "unsigned",
    );
  });

  it("rejects a source whose key will not parse, before any request", async () => {
    host.publish(ACME_URL, serialized("monty"));
    const error = await rejection(reader().registered(acme("not-a-key")));
    expect(error).toMatchObject({ reason: "key", minisign: "malformed-key" });
    expect(host.urls).toEqual([]);
  });

  it("answers for one entry of a catalogue", async () => {
    host.publish(ACME_URL, serialized("monty", "whodunnit"));
    const catalogue = await reader().registered(acme());
    expect(entryFor(catalogue, "whodunnit")?.installSource).toBe("pypi:whodunnit");
    expect(entryFor(catalogue, "summarize")).toBeNull();
  });
});

describe("the cache, and the interval it is judged against (acceptance 7)", () => {
  it("makes no request for a second read inside the check interval", async () => {
    const signer = new Signer();
    const body = serialized("monty");
    host.publish(ACME_URL, body, signer.sign(body));
    const first = await reader().registered(acme(signer.publicKeyLine));
    const askedOnce = [...host.urls];
    now = NOW + (CHECK_INTERVAL - 1) * 1000;
    const second = await reader().registered(acme(signer.publicKeyLine));
    expect(host.urls).toEqual(askedOnce);
    expect(second.entries).toEqual(first.entries);
    expect(second.verified).toBe(true);
    // The moment kept is when it was fetched, not when it was read back.
    expect(second.fetchedAt).toBe(NOW);
  });

  it("fetches again once the kept copy is as old as the check interval", async () => {
    host.publish(ACME_URL, serialized("monty"));
    await reader().registered(acme());
    now = NOW + CHECK_INTERVAL * 1000;
    const later = await reader().registered(acme());
    expect(host.urls).toEqual([ACME_URL, ACME_URL]);
    expect(later.fetchedAt).toBe(now);
  });

  it("forgets a kept catalogue that no longer verifies", async () => {
    const signer = new Signer();
    const stranger = new Signer();
    const body = serialized("monty");
    host.publish(ACME_URL, body, signer.sign(body));
    await reader().registered(acme(signer.publicKeyLine));
    // The kept copy is now checked against a key it was never signed with.
    await rejection(reader().registered(acme(stranger.publicKeyLine)));
    expect(fs.existsSync(cacheFile("acme"))).toBe(false);
  });

  it("refuses a kept unsigned catalogue once the source is given a key", async () => {
    const signer = new Signer();
    const body = serialized("monty");
    host.publish(ACME_URL, body, signer.sign(body));
    await reader().registered(acme());
    expect(fs.existsSync(cacheFile("acme"))).toBe(true);
    const keyed = await reader().registered(acme(signer.publicKeyLine));
    expect(keyed.verified).toBe(true);
    expect(host.urls).toEqual([ACME_URL, ACME_URL, `${ACME_URL}.minisig`]);
  });

  it("ignores a kept copy under the same name for another URL", async () => {
    const moved = "https://acme.example.invalid/v2/catalogue.json";
    host.publish(ACME_URL, serialized("monty"));
    host.publish(moved, serialized("whodunnit"));
    await reader().registered(acme());
    const after = await reader().registered(acme(null, moved));
    expect(after.entries.map((item) => item.packageId)).toEqual(["whodunnit"]);
    expect(host.urls).toEqual([ACME_URL, moved]);
  });

  const kept = (fetchedAt: number) =>
    encodeCachedCatalogue({
      name: "acme",
      url: ACME_URL,
      document: serialized("monty"),
      signature: null,
      fetchedAt,
    });
  const match = { name: "acme", url: ACME_URL, maxAgeSeconds: CHECK_INTERVAL, now: NOW };

  it("treats a kept copy written in the future as stale", () => {
    expect(decodeCachedCatalogue(kept(NOW + 60_000), match)).toBeNull();
    expect(decodeCachedCatalogue(kept(NOW - 60_000), match)).not.toBeNull();
  });

  it("treats a kept copy that cannot be read as absent", () => {
    expect(new FileCatalogueCache(cacheDirectory()).read("acme")).toBeNull();
    expect(decodeCachedCatalogue(null, match)).toBeNull();
  });

  const record = (fields: string): string => `{"source": "acme", "url": "${ACME_URL}"${fields}}`;
  it.each([
    ["not json at all", "not json at all"],
    ["a list", '["a list"]'],
    ["another source", `{"source": "other", "url": "${ACME_URL}"}`],
    ["another url", '{"source": "acme", "url": "somewhere else"}'],
    ["a document that is not text", record(', "document": 7')],
    ["a signature that is not text", record(', "document": "{}", "signature": 7')],
    ["no moment", record(', "document": "{}", "signature": null')],
    ["a moment that is a number", record(', "document": "{}", "signature": null, "fetched_at": 7')],
    [
      "a moment that is not one",
      record(', "document": "{}", "signature": null, "fetched_at": "not a moment"'),
    ],
    [
      "a naive moment",
      record(', "document": "{}", "signature": null, "fetched_at": "2026-09-19T12:00:00"'),
    ],
  ])("ignores a kept copy this build cannot account for: %s", (_what, text) => {
    const cache = new FileCatalogueCache(cacheDirectory());
    cache.write("acme", text);
    expect(decodeCachedCatalogue(cache.read("acme"), match)).toBeNull();
  });

  it("never turns a source name that is not a name into a path", () => {
    const cache = new FileCatalogueCache(cacheDirectory());
    expect(() => cache.pathFor("../../etc/passwd")).toThrow(CatalogueDocumentError);
    expect(() => {
      cache.write("../../etc/passwd", "x");
    }).toThrow(CatalogueDocumentError);
    // A read and a forget swallow it: neither is worth an exception.
    expect(cache.read("../../etc/passwd")).toBeNull();
    cache.forget("../../etc/passwd");
  });

  it("does not fail when a kept catalogue cannot be removed", () => {
    const blocker = path.join(scratch, "blocker");
    fs.writeFileSync(blocker, "a file where a directory would have to be");
    new FileCatalogueCache(path.join(blocker, "catalogues")).forget("acme");
  });
});

describe("a broken verifier is a bug, never a verdict", () => {
  it("lets an error that is not a refusal through, fetched or kept, and keeps nothing", async () => {
    const signer = new Signer();
    const body = serialized("monty");
    host.publish(ACME_URL, body, signer.sign(body));
    await reader().registered(acme(signer.publicKeyLine));
    const broken = new CatalogueReader({
      http: host,
      cache: new FileCatalogueCache(cacheDirectory()),
      verifier: {
        verify: () => {
          throw new TypeError("the verifier itself failed");
        },
      },
      now: () => now,
      maxAgeSeconds: () => CHECK_INTERVAL,
      officialUrl: OFFICIAL_URL,
      officialKey: null,
    });
    // Kept copy: not forgotten as if it were refused, and not reported as a signature failure.
    await expect(broken.registered(acme(signer.publicKeyLine))).rejects.toThrow(TypeError);
    expect(fs.existsSync(cacheFile("acme"))).toBe(true);
    // Fetched copy: the same, and nothing new is kept.
    fs.rmSync(cacheFile("acme"));
    await expect(broken.registered(acme(signer.publicKeyLine))).rejects.toThrow(TypeError);
    expect(fs.existsSync(cacheFile("acme"))).toBe(false);
  });
});

describe("the catalogue decides what is offered, never what is installed (acceptance 8)", () => {
  it("imports nothing but its own domain and the three ports it reads through", () => {
    // Read off the files' own imports, so it cannot drift towards installing without this
    // going red (plan 0003 D16: the package's own signature settles what is genuine).
    const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
    const allowed: Record<string, string[]> = {
      "domain/packages/catalogue.ts": ["../signature/minisign"],
      "domain/packages/catalogue-cache.ts": [],
      "application/catalogue-reader.ts": [
        "../domain/packages/catalogue",
        "../domain/packages/catalogue-cache",
        "../domain/signature/minisign",
        "../ports/catalogue-cache",
        "../ports/http-client",
        "../ports/signature-verifier",
      ],
    };
    for (const [file, expected] of Object.entries(allowed)) {
      const text = fs.readFileSync(path.join(src, file), "utf8");
      const imported = [...text.matchAll(/^import[^;]*?from "([^"]+)";/gms)].map(
        (found) => found[1],
      );
      expect(imported.sort(), file).toEqual(expected);
    }
  });
});
