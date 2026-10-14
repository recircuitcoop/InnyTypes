// What electron-updater installs is what InnyTypes verified (plan 0003 D10; plan 0022 §G): the
// production UpdateCheck, ElectronUpdaterInstaller, HttpsClient, MinisignVerifier and
// sha512Base64, against a local HTTPS release host — never GitHub (test/fixtures/tls).
//
// electron-updater reads the feed a second time, on its own fetch, after InnyTypes verified it.
// The host here can answer that second fetch with another document, as a hostile or broken
// server could. The AppUpdater is a fake that fetches and downloads from that host as
// electron-updater 6 does (its own yml read; an older version offered only with allowDowngrade;
// the download refused unless its bytes hash to the sha512 its own yml named), since the real
// one needs an installed Electron app.
import fs from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { JsonSettingsStore } from "../../src/adapters/fs/settings-store";
import { HttpsClient } from "../../src/adapters/net/https-client";
import { sha512Base64 } from "../../src/adapters/signature/digest";
import { MinisignVerifier } from "../../src/adapters/signature/minisign";
import { ElectronUpdaterInstaller } from "../../src/adapters/update/electron-updater-installer";
import { UpdateCheck } from "../../src/application/update-check";
import { compareVersions } from "../../src/domain/packages/versions";
import {
  parseReleaseMetadata,
  type ReleaseMetadata,
} from "../../src/domain/update/release-metadata";
import { RecordingLogger, RecordingNotifier } from "../fakes/children";
import { Signer } from "../fakes/minisign-signer";

const TLS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "tls");
const CERT = fs.readFileSync(path.join(TLS, "localhost-cert.pem"), "utf8");
const KEY = fs.readFileSync(path.join(TLS, "localhost-key.pem"), "utf8");

const CURRENT = "3.0.0";
const NEWER = "3.0.1";
const OLDER = "2.0.1";
const TAG = `v${OLDER}`;

/** What the host serves at a path; `later`, when set, answers every fetch after the first. */
const published = new Map<string, { first: Uint8Array; later?: Uint8Array }>();
const seen = new Map<string, number>();

const server = https.createServer({ cert: CERT, key: KEY }, (request, response) => {
  const url = request.url ?? "";
  const count = (seen.get(url) ?? 0) + 1;
  seen.set(url, count);
  const entry = published.get(url);
  const body =
    entry === undefined ? undefined : count > 1 ? (entry.later ?? entry.first) : entry.first;
  if (body === undefined) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-length": String(body.length) }).end(body);
});

let base = "";
let scratch = "";
const http = new HttpsClient({ ca: CERT, timeoutMs: 5000 });
const encode = (text: string) => new TextEncoder().encode(text);

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `https://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "inny-update-binding-"));
  published.clear();
  seen.clear();
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** A release as electron-builder publishes it under `dir`: the yml, its signature, the zip. */
function release(version: string, bytes = `InnyTypes ${version}`) {
  const artifact = encode(bytes);
  const file = `InnyTypes-${version}-mac.zip`;
  const yaml = encode(
    `version: ${version}\nfiles:\n  - url: ${file}\n    sha512: ${sha512Base64(artifact)}\n` +
      `    size: ${String(artifact.length)}\n`,
  );
  return { artifact, file, yaml };
}

function publish(
  dir: string,
  signer: Signer,
  version: string,
  later?: { version: string; bytes: string },
) {
  const good = release(version);
  const other = later === undefined ? undefined : release(later.version, later.bytes);
  published.set(`${dir}/latest-mac.yml`, {
    first: good.yaml,
    ...(other === undefined ? {} : { later: other.yaml }),
  });
  published.set(`${dir}/latest-mac.yml.minisig`, { first: encode(signer.sign(good.yaml)) });
  published.set(`${dir}/${good.file}`, { first: good.artifact });
  if (other !== undefined) {
    // The same name: the verified bytes first (InnyTypes' own fetch), the substitute after.
    published.set(
      `${dir}/${other.file}`,
      other.file === good.file
        ? { first: good.artifact, later: other.artifact }
        : { first: other.artifact },
    );
  }
}

/** electron-updater's AppUpdater as far as this adapter uses it, fetching from the host. */
class HostAppUpdater {
  logger: unknown = null;
  autoDownload = true;
  autoInstallOnAppQuit = false;
  allowDowngrade = false;
  #channel = "";
  #feed = "";
  #found: { info: ReleaseMetadata; feed: string } | null = null;
  downloaded: string | null = null;
  readonly installed: (string | null)[] = [];
  failDownload = false;

  set channel(value: string) {
    this.#channel = value;
    this.allowDowngrade = true;
  }
  get channel(): string {
    return this.#channel;
  }
  setFeedURL(options: { provider: string; url?: string }): void {
    // The GitHub provider's own route to the newest release, modelled as the host's feed root.
    this.#feed = options.provider === "github" ? base : String(options.url);
  }
  async checkForUpdates() {
    const got = await http.get(`${this.#feed}/latest-mac.yml`, { maxBytes: 1 << 20 });
    if (!got.ok) {
      throw new Error(got.detail);
    }
    const info = parseReleaseMetadata(new TextDecoder().decode(got.body));
    const order = compareVersions(info.version, CURRENT) ?? 0;
    const isUpdateAvailable = order > 0 || (this.allowDowngrade && order < 0);
    this.#found = isUpdateAvailable ? { info, feed: this.#feed } : null;
    return { isUpdateAvailable, updateInfo: info, versionInfo: info };
  }
  async downloadUpdate(): Promise<string[]> {
    const found = this.#found;
    const file = found?.info.files[0];
    if (found === null || file === undefined || this.failDownload) {
      throw new Error("ECONNRESET");
    }
    const got = await http.get(`${found.feed}/${file.url}`, { maxBytes: 1 << 20 });
    if (!got.ok || sha512Base64(got.body) !== file.sha512) {
      throw new Error("ERR_CHECKSUM_MISMATCH");
    }
    this.downloaded = found.info.version;
    return [file.url];
  }
  quitAndInstall(): void {
    this.installed.push(this.downloaded);
  }
}

function checker(signer: Signer) {
  const updater = new HostAppUpdater();
  const logger = new RecordingLogger();
  const notifier = new RecordingNotifier();
  const events: string[] = [];
  const settings = path.join(scratch, "shell-settings.json");
  fs.writeFileSync(settings, JSON.stringify({ update: { auto_check: true, channel: "latest" } }));
  const check = new UpdateCheck({
    onEvent: (event) => {
      events.push(event.kind === "failed" ? `failed ${event.reason}` : event.kind);
    },
    transport: { http, verifier: new MinisignVerifier(), sha512: sha512Base64 },
    settings: new JsonSettingsStore(settings),
    report: { notifier, logger },
    selfUpdater: new ElectronUpdaterInstaller(updater as never, "acme/innytypes", "latest", logger),
    session: {
      clock: { now: () => 0, after: () => () => undefined },
      currentVersion: () => CURRENT,
    },
    publicKey: signer.publicKeyText,
    feedBaseUrl: base,
    tagBaseUrl: (tag) => `${base}/download/${tag}`,
    platform: "mac",
    arch: "arm64",
  });
  return { check, updater, notifier, events };
}

describe("electron-updater installs only what InnyTypes verified", () => {
  it("the same release on electron-updater's own fetch: downloaded, and installed at quit", async () => {
    const signer = new Signer();
    publish("", signer, NEWER);
    const { check, updater, events } = checker(signer);
    expect(await check.check()).toMatchObject({ ok: true });
    expect(events).toEqual(["check", "found", "progress", "downloaded"]);
    check.installAtQuit();
    expect(updater.installed).toEqual([NEWER]);
  });

  it("a host that serves another update on electron-updater's second fetch is refused", async () => {
    const signer = new Signer();
    // Its own, consistent yml and zip: only the signature it lacks gives it away.
    publish("", signer, NEWER, { version: "3.0.2", bytes: "a substitute" });
    const { check, updater, notifier, events } = checker(signer);
    const outcome = await check.check();
    expect(outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining("not 3.0.1") as unknown,
    });
    expect(events).toEqual(["check", "found", "failed safety-check"]);
    expect(notifier.notices).toContainEqual(
      expect.objectContaining({ kind: "core-update-refused" }),
    );
    expect(updater.downloaded).toBeNull();
    check.installAtQuit();
    expect(updater.installed).toEqual([]);
  });

  it("a host that serves the same version with another artifact on the second fetch is refused", async () => {
    const signer = new Signer();
    publish("", signer, NEWER, { version: NEWER, bytes: "a substitute with the same name" });
    const { check, updater, events } = checker(signer);
    expect(await check.check()).toMatchObject({ ok: false });
    expect(events).toEqual(["check", "found", "failed safety-check"]);
    expect(updater.downloaded).toBeNull();
    check.installAtQuit();
    expect(updater.installed).toEqual([]);
  });

  it("a Go back whose tag is served differently on the second fetch is refused; the feed is restored", async () => {
    const signer = new Signer();
    publish(`/download/${TAG}`, signer, OLDER, { version: OLDER, bytes: "a substitute" });
    const { check, updater, events } = checker(signer);
    expect(await check.goBack({ version: OLDER, tag: TAG })).toMatchObject({ ok: false });
    expect(events).toEqual(["failed safety-check"]);
    expect(updater.downloaded).toBeNull();
    expect(updater.allowDowngrade).toBe(false);
    check.installAtQuit();
    expect(updater.installed).toEqual([]);
  });

  it("a Go back whose download fails leaves no pinned feed: the next check stages the verified forward version only", async () => {
    const signer = new Signer();
    publish(`/download/${TAG}`, signer, OLDER);
    const { check, updater, events } = checker(signer);
    updater.failDownload = true;
    expect(await check.goBack({ version: OLDER, tag: TAG })).toMatchObject({ ok: false });
    expect(events).toEqual(["failed no-connection"]);
    expect(updater.allowDowngrade).toBe(false);

    // Later, the scheduled check (or Check now) finds the newer release on the normal feed.
    updater.failDownload = false;
    publish("", signer, NEWER);
    expect(await check.check()).toMatchObject({ ok: true });
    expect(updater.downloaded).toBe(NEWER);
    check.installAtQuit();
    expect(updater.installed).toEqual([NEWER]);
  });
});
