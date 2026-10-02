// The self-update check over real HTTPS (WI-0018-24): the production HttpsClient,
// MinisignVerifier, sha512Base64 and JsonSettingsStore, against a local fake release server —
// never GitHub (test/fixtures/tls, the same certificate WI-0018-14's catalogue-server.test.ts
// uses). Every request the server sees is recorded, so "no request at all" is provable.
import fs from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sha512Base64 } from "../../src/adapters/signature/digest";
import { MinisignVerifier } from "../../src/adapters/signature/minisign";
import { HttpsClient } from "../../src/adapters/net/https-client";
import { JsonSettingsStore } from "../../src/adapters/fs/settings-store";
import { UpdateCheck } from "../../src/application/update-check";
import type { SelfUpdater } from "../../src/ports/self-updater";
import { RecordingLogger, RecordingNotifier } from "../fakes/children";
import { Signer } from "../fakes/minisign-signer";

const TLS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "tls");
const CERT = fs.readFileSync(path.join(TLS, "localhost-cert.pem"), "utf8");
const KEY = fs.readFileSync(path.join(TLS, "localhost-key.pem"), "utf8");

const published = new Map<string, Uint8Array>();
const asked: string[] = [];

const server = https.createServer({ cert: CERT, key: KEY }, (request, response) => {
  const url = request.url ?? "";
  asked.push(url);
  const body = published.get(url);
  if (body === undefined) {
    response.writeHead(404).end("no such object");
    return;
  }
  response.writeHead(200, { "content-length": String(body.length) }).end(body);
});

let base = "";
let scratch = "";

function listen(): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(String((server.address() as AddressInfo).port));
    });
  });
}

beforeAll(async () => {
  base = `https://127.0.0.1:${await listen()}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "inny-update-server-"));
  published.clear();
  asked.length = 0;
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** A fake SelfUpdater: records every call, and never touches a real platform updater. */
class RecordingSelfUpdater implements SelfUpdater {
  checked = 0;
  installed = 0;
  checkForUpdates(): Promise<void> {
    this.checked += 1;
    return Promise.resolve();
  }
  quitAndInstall(): void {
    this.installed += 1;
  }
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function metadataYaml(version: string, fileName: string, artifact: Uint8Array): string {
  return (
    `version: ${version}\n` +
    "files:\n" +
    `  - url: ${fileName}\n` +
    `    sha512: ${sha512Base64(artifact)}\n` +
    `    size: ${String(artifact.length)}\n` +
    `path: ${fileName}\n` +
    `sha512: ${sha512Base64(artifact)}\n`
  );
}

function settingsFile(update: Record<string, unknown> | undefined): JsonSettingsStore {
  const file = path.join(scratch, "shell-settings.json");
  if (update !== undefined) {
    fs.writeFileSync(file, JSON.stringify({ update }));
  }
  return new JsonSettingsStore(file);
}

function checker(options: {
  publicKey: string | null;
  update?: Record<string, unknown>;
  currentVersion?: string;
  selfUpdater?: RecordingSelfUpdater;
  notifier?: RecordingNotifier;
}) {
  const notifier = options.notifier ?? new RecordingNotifier();
  const selfUpdater = options.selfUpdater ?? new RecordingSelfUpdater();
  const logger = new RecordingLogger();
  /** domain/updates' events, in order, as General's update line hears them (plan 0022 §G). */
  const events: string[] = [];
  const check = new UpdateCheck({
    onEvent: (event) => {
      events.push(
        event.kind === "found"
          ? `found ${String(event.version)}`
          : event.kind === "failed"
            ? `failed ${event.reason}`
            : event.kind,
      );
    },
    transport: {
      http: new HttpsClient({ ca: CERT, timeoutMs: 5000 }),
      verifier: new MinisignVerifier(),
      sha512: sha512Base64,
    },
    settings: settingsFile(options.update ?? { auto_check: true, channel: "latest" }),
    report: { notifier, logger },
    selfUpdater,
    session: {
      clock: { now: () => 0, after: () => () => undefined },
      currentVersion: () => options.currentVersion ?? "1.0.0",
    },
    publicKey: options.publicKey,
    feedBaseUrl: base,
    platform: "mac",
    arch: "arm64",
  });
  return { check, notifier, selfUpdater, logger, events };
}

describe("the self-update check over real HTTPS", () => {
  it("off in the settings: not one request is made", async () => {
    const { check, events } = checker({ publicKey: "irrelevant", update: { auto_check: false } });
    const outcome = await check.check();
    expect(events).toEqual([]);
    expect(outcome).toMatchObject({ ok: true });
    expect(asked).toEqual([]);
  });

  it("a valid signed yml: downloads the artifact, checks its sha512, and stages the install", async () => {
    const signer = new Signer();
    const artifact = encode("the InnyTypes.zip bytes");
    const fileName = "InnyTypes-1.2.3-mac.zip";
    const yaml = metadataYaml("1.2.3", fileName, artifact);
    published.set("/latest-mac.yml", encode(yaml));
    published.set("/latest-mac.yml.minisig", encode(signer.sign(encode(yaml))));
    published.set(`/${fileName}`, artifact);

    const { check, events, notifier, selfUpdater } = checker({ publicKey: signer.publicKeyText });
    const outcome = await check.check();
    expect(events).toEqual(["check", "found 1.2.3", "progress", "downloaded"]);

    expect(outcome).toMatchObject({
      ok: true,
      message: expect.stringContaining("1.2.3") as unknown,
    });
    expect(asked).toEqual(["/latest-mac.yml", "/latest-mac.yml.minisig", `/${fileName}`]);
    expect(selfUpdater.checked).toBe(1);
    expect(notifier.notices).toContainEqual(
      expect.objectContaining({ kind: "core-update-available", version: "1.2.3" }),
    );

    check.installAtQuit();
    expect(selfUpdater.installed).toBe(1);
  });

  it("a tampered yml is refused, with a notice, and never reaches the platform updater", async () => {
    const signer = new Signer();
    const impostor = new Signer();
    const artifact = encode("bytes");
    const fileName = "InnyTypes-1.2.3-mac.zip";
    const yaml = metadataYaml("1.2.3", fileName, artifact);
    published.set("/latest-mac.yml", encode(yaml));
    // Signed by a key other than the one this build trusts.
    published.set("/latest-mac.yml.minisig", encode(impostor.sign(encode(yaml))));
    published.set(`/${fileName}`, artifact);

    const { check, events, notifier, selfUpdater } = checker({ publicKey: signer.publicKeyText });
    const outcome = await check.check();
    expect(events).toEqual(["check", "failed unreadable"]);

    expect(outcome).toMatchObject({ ok: false });
    expect(notifier.notices).toContainEqual(
      expect.objectContaining({ kind: "core-update-refused" }),
    );
    expect(selfUpdater.checked).toBe(0);
    check.installAtQuit();
    expect(selfUpdater.installed).toBe(0);
  });

  it("a tampered artifact is refused: its bytes do not match the signed sha512", async () => {
    const signer = new Signer();
    const fileName = "InnyTypes-1.2.3-mac.zip";
    const yaml = metadataYaml("1.2.3", fileName, encode("the real bytes"));
    published.set("/latest-mac.yml", encode(yaml));
    published.set("/latest-mac.yml.minisig", encode(signer.sign(encode(yaml))));
    // The artifact actually served does not match the sha512 the signed metadata named.
    published.set(`/${fileName}`, encode("a substituted, different file"));

    const { check, events, notifier, selfUpdater } = checker({ publicKey: signer.publicKeyText });
    const outcome = await check.check();
    expect(events).toEqual(["check", "found 1.2.3", "failed safety-check"]);

    expect(outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining("sha512") as unknown,
    });
    expect(notifier.notices).toContainEqual(
      expect.objectContaining({ kind: "core-update-refused" }),
    );
    expect(selfUpdater.checked).toBe(0);
  });

  it("a build with no embedded key refuses rather than trust an unverifiable feed", async () => {
    const signer = new Signer();
    const yaml = metadataYaml("1.2.3", "a.zip", encode("x"));
    published.set("/latest-mac.yml", encode(yaml));
    published.set("/latest-mac.yml.minisig", encode(signer.sign(encode(yaml))));

    const { check, events, notifier } = checker({ publicKey: null });
    const outcome = await check.check();
    expect(events).toEqual(["check", "failed unreadable"]);
    expect(outcome).toMatchObject({ ok: false });
    expect(notifier.notices).toContainEqual(
      expect.objectContaining({ kind: "core-update-refused" }),
    );
  });

  it("a feed that cannot be reached is a failure, not a refusal: no notice, nothing tampered", async () => {
    // Nothing is published: every request 404s.
    const { check, events, notifier, selfUpdater } = checker({ publicKey: "irrelevant" });
    const outcome = await check.check();
    expect(events).toEqual(["check", "failed no-connection"]);
    expect(outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining("could not be read") as unknown,
    });
    expect(notifier.notices).toEqual([]);
    expect(selfUpdater.checked).toBe(0);
  });

  it("a signature that cannot be reached is a failure, not a refusal", async () => {
    published.set("/latest-mac.yml", encode(metadataYaml("1.2.3", "a.zip", encode("x"))));
    const { check, events, notifier } = checker({ publicKey: "irrelevant" });
    const outcome = await check.check();
    expect(events).toEqual(["check", "failed no-connection"]);
    expect(outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining("could not be read") as unknown,
    });
    expect(notifier.notices).toEqual([]);
  });

  it("a signature that is not UTF-8 text is refused", async () => {
    const signer = new Signer();
    const yaml = metadataYaml("1.2.3", "a.zip", encode("x"));
    published.set("/latest-mac.yml", encode(yaml));
    published.set("/latest-mac.yml.minisig", new Uint8Array([0xff, 0xfe, 0xfd]));
    const { check, events, notifier } = checker({ publicKey: signer.publicKeyText });
    const outcome = await check.check();
    expect(events).toEqual(["check", "failed unreadable"]);
    expect(outcome).toMatchObject({ ok: false });
    expect(notifier.notices).toContainEqual(
      expect.objectContaining({ kind: "core-update-refused" }),
    );
  });

  it("an artifact that cannot be reached, after a verified yml, is a failure not a refusal", async () => {
    const signer = new Signer();
    const yaml = metadataYaml("1.2.3", "missing.zip", encode("x"));
    published.set("/latest-mac.yml", encode(yaml));
    published.set("/latest-mac.yml.minisig", encode(signer.sign(encode(yaml))));
    // "missing.zip" is never published.
    const { check, events, notifier } = checker({ publicKey: signer.publicKeyText });
    const outcome = await check.check();
    expect(events).toEqual(["check", "found 1.2.3", "failed no-connection"]);
    expect(outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining("could not be read") as unknown,
    });
    expect(notifier.notices).toEqual([]);
  });

  it("the settings themselves cannot be read: a failure, no request at all", async () => {
    const { check, events } = checker({ publicKey: "irrelevant" });
    fs.writeFileSync(path.join(scratch, "shell-settings.json"), "not json");
    const outcome = await check.check();
    expect(events).toEqual(["failed unreadable"]);
    expect(outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining("update settings cannot be read") as unknown,
    });
    expect(asked).toEqual([]);
  });

  it("a verified feed whose platform updater cannot be reached is not staged, but is not a refusal", async () => {
    const signer = new Signer();
    const artifact = encode("bytes");
    const fileName = "a.zip";
    const yaml = metadataYaml("1.2.3", fileName, artifact);
    published.set("/latest-mac.yml", encode(yaml));
    published.set("/latest-mac.yml.minisig", encode(signer.sign(encode(yaml))));
    published.set(`/${fileName}`, artifact);

    const failing = new RecordingSelfUpdater();
    failing.checkForUpdates = () => Promise.reject(new Error("offline"));
    const { check, events, notifier } = checker({
      publicKey: signer.publicKeyText,
      selfUpdater: failing,
    });
    const outcome = await check.check();
    expect(events).toEqual(["check", "found 1.2.3", "failed no-connection"]);
    expect(outcome).toMatchObject({ ok: true });
    expect(notifier.notices).toContainEqual(
      expect.objectContaining({ kind: "core-update-available" }),
    );
    check.installAtQuit();
    expect(failing.installed).toBe(0);
  });

  it("a version no newer than this one is not proposed", async () => {
    const signer = new Signer();
    const artifact = encode("bytes");
    const yaml = metadataYaml("1.0.0", "a.zip", artifact);
    published.set("/latest-mac.yml", encode(yaml));
    published.set("/latest-mac.yml.minisig", encode(signer.sign(encode(yaml))));

    const { check, events, selfUpdater } = checker({
      publicKey: signer.publicKeyText,
      currentVersion: "1.0.0",
    });
    const outcome = await check.check();
    expect(events).toEqual(["check", "found null"]);
    expect(outcome).toMatchObject({
      ok: true,
      message: expect.stringContaining("up to date") as unknown,
    });
    expect(selfUpdater.checked).toBe(0);
  });
});
