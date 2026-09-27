// Telemetry end to end against local fake servers (WI-0018-22): the production pipeline, disk
// queue, HTTPS poster and machine-id hash, a fake GlitchTip and a fake Umami on one local HTTPS
// server (test/fixtures/tls), and a plain-HTTP one that must never be spoken to. Nothing here is
// ever sent to a real GlitchTip or Umami. Every request the servers see is recorded.
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DiskReportQueue } from "../../src/adapters/telemetry/disk-queue";
import { HttpsPoster } from "../../src/adapters/telemetry/https-poster";
import { machineIdHash } from "../../src/adapters/telemetry/machine-id";
import { TelemetryPipeline } from "../../src/application/telemetry";
import { SecretRegistry } from "../../src/domain/redaction/registry";
import { crashPayload, usagePayload, type Versions } from "../../src/domain/telemetry/reports";
import { outgoingFor, type Endpoints } from "../../src/domain/telemetry/transports";
import { RecordingLogger } from "../fakes/children";
import { FakeClock } from "../fakes/clock";
import { MemorySetting, queued } from "../fakes/telemetry";

const TLS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "tls");
const CERT = fs.readFileSync(path.join(TLS, "localhost-cert.pem"), "utf8");
const KEY = fs.readFileSync(path.join(TLS, "localhost-key.pem"), "utf8");

interface Received {
  readonly method: string;
  readonly url: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

const received: Received[] = [];
const receivedInTheClear: string[] = [];
/** How the fake servers answer: a status, or "hang" (accept, never answer). */
let behaviour: number | "hang" = 200;

const server = https.createServer({ cert: CERT, key: KEY }, (request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    received.push({
      method: request.method ?? "",
      url: request.url ?? "",
      headers: request.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    });
    if (behaviour !== "hang") {
      response.writeHead(behaviour).end("{}");
    }
  });
});
const clear = http.createServer((request, response) => {
  receivedInTheClear.push(request.url ?? "");
  response.writeHead(200).end();
});

let base = "";
let clearBase = "";
let scratch = "";

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
  received.length = 0;
  receivedInTheClear.length = 0;
  behaviour = 200;
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "inny-telemetry-servers-"));
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

const VERSIONS: Versions = { appVersion: "2.0.0", os: "linux", osVersion: "6.8", arch: "x64" };
const RAW = "7d3b1c2e-5f60-4a8b-9c1d-rawmachineid";
// The canaries: the Anytype key, the proxy token, a node credential and a home path.
const CANARIES = [
  "canary-anytype-key-3e1f5a7b9c",
  "canary-proxy-token-8d6b4f2a0c",
  "canary-node-credential-1a2b3c",
];
const HOME = `${os.homedir()}/Documents/canary-diary.md`;

function endpoints(): Endpoints {
  const host = base.replace("https://", "");
  return {
    glitchtipDsn: `https://glitchkey@${host}/17`,
    umamiUrl: `${base}/umami`,
    umamiWebsiteId: "site-7",
  };
}

function world(
  answer: "on" | "off" | "unset",
  overrides: { endpoints?: Endpoints; timeoutMs?: number; maxReports?: number } = {},
) {
  const setting = new MemorySetting(answer);
  const registry = new SecretRegistry();
  for (const canary of CANARIES) {
    registry.protect(canary);
  }
  const queueDir = path.join(scratch, "telemetry-queue");
  let identified = 0;
  const pipeline = new TelemetryPipeline({
    setting,
    queue: new DiskReportQueue(queueDir, new RecordingLogger(), {
      maxReports: overrides.maxReports ?? 128,
    }),
    poster: new HttpsPoster({ ca: CERT, timeoutMs: overrides.timeoutMs ?? 5_000 }),
    machineIdentifier: () => {
      identified += 1;
      return RAW;
    },
    hashIdentifier: machineIdHash,
    endpoints: overrides.endpoints ?? endpoints(),
    release: "2.0.0",
    clock: new FakeClock(),
    now: () => Date.UTC(2026, 8, 26, 9),
    newId: () => "c".repeat(32),
    credentials: (text) => registry.redact(text),
    secrets: { protect: (secret) => registry.protect(secret) },
    logger: new RecordingLogger(),
  });
  const queued = (): string =>
    fs.existsSync(queueDir)
      ? fs
          .readdirSync(queueDir)
          .map((name) => fs.readFileSync(path.join(queueDir, name), "utf8"))
          .join("\n")
      : "";
  return { pipeline, setting, queueDir, queued, identified: () => identified };
}

const hostile = (): Record<string, unknown> => ({
  ...crashPayload(
    "services",
    false,
    { runtime: 0, services: 1, node: 0, nodeStopped: 0 },
    VERSIONS,
  ),
  exception_type: `ServicesCrashed near ${HOME} holding ${CANARIES[0] ?? ""}`,
  anytype_api_key: CANARIES[0],
  context: [`Bearer ${CANARIES[1] ?? ""}`, { deeper: CANARIES[2], at: `file://${HOME}` }],
});

describe("telemetry against local fake GlitchTip and Umami servers", () => {
  it("before an answer: no request, no queued file, no machine identifier read", async () => {
    const { pipeline, queueDir, identified } = world("unset");
    pipeline.recordCrash(hostile());
    pipeline.recordUsage(usagePayload(VERSIONS, []));
    await pipeline.flush();
    expect(received).toEqual([]);
    expect(fs.existsSync(queueDir)).toBe(false);
    expect(identified()).toBe(0);
  });

  it("a crash goes to GlitchTip as a Sentry envelope, and what arrives is what was rendered", async () => {
    const { pipeline } = world("on");
    const report = pipeline.recordCrash(hostile());
    expect(await pipeline.flush()).toEqual({ sent: 1, retryInMs: null });
    expect(received).toHaveLength(1);
    const got = received[0];
    expect(got?.method).toBe("POST");
    expect(got?.url).toBe("/api/17/envelope/");
    expect(got?.headers["content-type"]).toBe("application/x-sentry-envelope");
    expect(got?.headers["x-sentry-auth"]).toBe(
      "Sentry sentry_version=7, sentry_client=innytypes/2.0.0, sentry_key=glitchkey",
    );
    // Byte for byte what the transport renders from the queued report.
    expect(got?.body).toBe(outgoingFor(queued(report), endpoints(), "2.0.0").body);
    const event = JSON.parse(got?.body.split("\n")[2] ?? "") as {
      exception: { values: { type: string; value: string }[] };
      tags: Record<string, string>;
    };
    expect(event.exception.values[0]?.value).toBe("");
    expect(event.tags["machine_id"]).toBe(machineIdHash(RAW));
  });

  it("usage goes to Umami as a custom event", async () => {
    const { pipeline } = world("on");
    pipeline.recordUsage(usagePayload(VERSIONS, [{ id: "anytype", version: "1.0.0" }]));
    await pipeline.flush();
    expect(received.map((request) => request.url)).toEqual(["/umami/api/send"]);
    expect(received[0]?.headers["user-agent"]).toBe("innytypes/2.0.0");
    expect(JSON.parse(received[0]?.body ?? "")).toMatchObject({
      type: "event",
      payload: { website: "site-7", name: "usage", hostname: "app.innytypes.invalid" },
    });
  });

  it("no canary secret, home path or raw identifier is in a queued file or a sent request", async () => {
    const { pipeline, queued } = world("on");
    pipeline.recordCrash(hostile());
    pipeline.recordUsage({ ...usagePayload(VERSIONS, []), where: HOME, id: RAW });
    const onDisk = queued();
    expect(onDisk).not.toBe("");
    await pipeline.flush();
    const sent = received
      .map((request) => `${JSON.stringify(request.headers)}${request.body}`)
      .join("\n");
    expect(received).toHaveLength(2);
    for (const canary of [...CANARIES, HOME, os.homedir(), RAW]) {
      expect(onDisk).not.toContain(canary);
      expect(sent).not.toContain(canary);
    }
  });

  it("a failing server keeps the report and backs off", async () => {
    behaviour = 503;
    const { pipeline, queued } = world("on");
    pipeline.recordCrash(hostile());
    expect(await pipeline.flush()).toEqual({ sent: 0, retryInMs: 5_000 });
    expect(queued()).not.toBe("");
    behaviour = 202;
    expect(await pipeline.flush()).toEqual({ sent: 1, retryInMs: null });
    expect(queued()).toBe("");
  });

  it("a hanging server never delays a report, and its request times out", async () => {
    behaviour = "hang";
    const { pipeline } = world("on", { timeoutMs: 300 });
    pipeline.recordCrash(hostile());
    const flushing = pipeline.flush();
    // A restart reports while the server holds the first request: queued at once.
    const started = performance.now();
    expect(pipeline.recordCrash(hostile())).not.toBeNull();
    expect(performance.now() - started).toBeLessThan(100);
    expect(await flushing).toEqual({ sent: 0, retryInMs: 5_000 });
  });

  it("an endpoint in the clear is never spoken to", async () => {
    const host = clearBase.replace("http://", "");
    const { pipeline } = world("on", {
      endpoints: { ...endpoints(), glitchtipDsn: `http://key@${host}/1` },
    });
    pipeline.recordCrash(hostile());
    await pipeline.flush();
    const poster = new HttpsPoster({ ca: CERT });
    expect(await poster.post({ url: `${clearBase}/api/send`, headers: {}, body: "{}" })).toEqual({
      ok: false,
      detail: `${clearBase} is not HTTPS; telemetry is never sent in the clear`,
    });
    expect(await poster.post({ url: "not a url", headers: {}, body: "" })).toMatchObject({
      ok: false,
    });
    expect(receivedInTheClear).toEqual([]);
  });

  it("the queue's bound holds through the pipeline too", async () => {
    behaviour = 503;
    const { pipeline, queueDir } = world("on", { maxReports: 3 });
    for (let n = 0; n < 7; n += 1) {
      pipeline.recordCrash(hostile());
    }
    expect(fs.readdirSync(queueDir).filter((name) => name.endsWith(".json"))).toEqual([
      "000000000005-error.json",
      "000000000006-error.json",
      "000000000007-error.json",
    ]);
    // Offline for good: the bound still holds, and nothing was sent.
    await pipeline.flush();
    expect(fs.readdirSync(queueDir)).toHaveLength(3);
  });

  it("a server that cannot be reached is a result, not an exception", async () => {
    const poster = new HttpsPoster({ ca: CERT, timeoutMs: 2_000 });
    const result = await poster.post({ url: "https://127.0.0.1:9/x", headers: {}, body: "{}" });
    expect(result).toMatchObject({ ok: false });
  });
});
