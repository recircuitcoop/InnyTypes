// The telemetry pipeline (WI-0018-22), the port of TelemetryPipeline (telemetry.py:1125-1370)
// against in-memory edges: the switch, re-read on every call and every send; nothing queued, sent
// or even identified before the question is answered (F2); the one redaction before the queue;
// the backoff on the injected clock; and a server that never answers costing a caller nothing.
import { describe, expect, it } from "vitest";
import { TelemetryPipeline, DEFAULT_BACKOFF_MS } from "../../src/application/telemetry";
import { REDACTED } from "../../src/domain/redaction/registry";
import { crashPayload, usagePayload, type Versions } from "../../src/domain/telemetry/reports";
import { NO_ENDPOINTS, outgoingFor } from "../../src/domain/telemetry/transports";
import { ENDPOINTS, queued, RAW_IDENTIFIER, settle, telemetryWorld } from "../fakes/telemetry";

const VERSIONS: Versions = {
  appVersion: "9.9.9",
  os: "darwin",
  osVersion: "25.3.0",
  arch: "arm64",
};
const COUNTS = { runtime: 1, services: 0, node: 0, nodeStopped: 0 };
const crash = () => crashPayload("runtime", false, COUNTS, VERSIONS);
const usage = () => usagePayload(VERSIONS, [{ id: "anytype", version: "1.0.0" }]);

// The canaries of plan 0018 §5.4: none may appear in a queued or a sent payload.
const ANYTYPE_KEY = "canary-anytype-key-2f6c1e9a8b7d";
const PROXY_TOKEN = "canary-proxy-token-5d4c3b2a1f0e";
const NODE_CREDENTIAL = "canary-node-credential-9a8b7c6d";
const HOME_PATH = "/Users/canary-home-person/Documents/diary.md";

describe("the telemetry pipeline: nothing before the question is answered (F2)", () => {
  it("with the question unanswered, nothing is sent, queued or even identified", async () => {
    const world = telemetryWorld("unset");
    const pipeline = new TelemetryPipeline(world.deps);
    pipeline.start();
    expect(pipeline.recordCrash(crash())).toBeNull();
    expect(pipeline.recordUsage(usage())).toBeNull();
    expect(await pipeline.flush()).toEqual({ sent: 0, retryInMs: null });
    world.clock.advance(60_000);
    await settle();
    expect(world.queue.reports).toEqual([]);
    expect(world.poster.sent).toEqual([]);
    expect(world.identifierCalls()).toBe(0);
    expect(world.registry.size).toBe(0);
  });

  it("the F2 check covers every public method of the pipeline", async () => {
    const world = telemetryWorld("unset");
    // Something a previous "on" left behind: unset must not send it either.
    world.queue.enqueue("error", { left: "behind" });
    const pipeline = new TelemetryPipeline(world.deps);
    const methods = Object.getOwnPropertyNames(TelemetryPipeline.prototype).filter(
      (name) => name !== "constructor",
    );
    // Every public method, so a new one cannot slip past the gate unseen.
    expect(methods.sort()).toEqual(
      ["answer", "flush", "pending", "recordCrash", "recordUsage", "start", "state", "stop"].sort(),
    );
    pipeline.start();
    pipeline.recordCrash(crash());
    pipeline.recordUsage(usage());
    expect(pipeline.pending()).toEqual([]);
    expect(pipeline.state()).toEqual({ answer: "unset", problem: null, queued: 0 });
    await pipeline.flush();
    world.clock.advance(60_000);
    await settle();
    pipeline.stop();
    expect(world.queue.reports).toEqual([]);
    expect(world.poster.sent).toEqual([]);
    expect(world.identifierCalls()).toBe(0);
  });

  it("the unanswered check can fail when the switch is on", async () => {
    // The canary for the two tests above: the same calls, switched on, do queue and send.
    const world = telemetryWorld("on");
    const pipeline = new TelemetryPipeline(world.deps);
    expect(pipeline.recordCrash(crash())).not.toBeNull();
    expect(await pipeline.flush()).toEqual({ sent: 1, retryInMs: null });
    expect(world.poster.sent).toHaveLength(1);
    expect(world.identifierCalls()).toBe(1);
  });

  it("off stops everything too, and a report a previous on left behind is deleted, not sent", async () => {
    const world = telemetryWorld("off");
    world.queue.enqueue("error", { left: "behind" });
    const pipeline = new TelemetryPipeline(world.deps);
    expect(pipeline.recordCrash(crash())).toBeNull();
    await pipeline.flush();
    expect(world.queue.reports).toEqual([]);
    expect(world.poster.sent).toEqual([]);
    expect(world.logger.lines).toContain("INFO telemetry is off: dropped 1 queued report(s)");
  });

  it("an unreadable switch is never permission to send", async () => {
    const world = telemetryWorld("on");
    const pipeline = new TelemetryPipeline(world.deps);
    pipeline.recordCrash(crash());
    world.setting.unreadable = true;
    expect(pipeline.recordCrash(crash())).toBeNull();
    expect(await pipeline.flush()).toEqual({ sent: 0, retryInMs: null });
    expect(world.poster.sent).toEqual([]);
    expect(pipeline.state()).toEqual({
      answer: "unset",
      problem: "shell-settings.json is not JSON",
      queued: 0,
    });
    expect(world.logger.lines.join("\n")).toContain("the telemetry switch could not be read");
  });
});

describe("the telemetry pipeline: the switch is read again, every time", () => {
  it("re-reads the switch on every record and before every single send", async () => {
    const world = telemetryWorld("on");
    const pipeline = new TelemetryPipeline(world.deps);
    pipeline.recordCrash(crash());
    pipeline.recordCrash(crash());
    pipeline.recordCrash(crash());
    const before = world.setting.reads;
    await pipeline.flush();
    // pending() once, then one read before each of the three sends.
    expect(world.setting.reads - before).toBe(4);
  });

  it("turning it off mid-drain stops the drain at that report and empties the queue", async () => {
    const world = telemetryWorld("on");
    const pipeline = new TelemetryPipeline(world.deps);
    pipeline.recordCrash(crash());
    pipeline.recordCrash(crash());
    pipeline.recordCrash(crash());
    world.poster.answer = () => {
      // The person turns telemetry off while the first report is on its way.
      world.setting.answer = "off";
      return { ok: true };
    };
    expect(await pipeline.flush()).toEqual({ sent: 1, retryInMs: null });
    expect(world.poster.sent).toHaveLength(1);
    expect(world.queue.reports).toEqual([]);
  });

  it("turning it off empties the queue at once and sends nothing more", async () => {
    const world = telemetryWorld("on");
    const pipeline = new TelemetryPipeline(world.deps);
    pipeline.recordCrash(crash());
    pipeline.recordUsage(usage());
    expect(pipeline.state().queued).toBe(2);
    pipeline.answer(false);
    expect(world.queue.reports).toEqual([]);
    expect(pipeline.recordCrash(crash())).toBeNull();
    await pipeline.flush();
    expect(world.poster.sent).toEqual([]);
    expect(pipeline.state()).toEqual({ answer: "off", problem: null, queued: 0 });
    expect(pipeline.pending()).toEqual([]);
  });

  it("an answer that cannot be stored throws and changes nothing", () => {
    const world = telemetryWorld("unset");
    world.setting.unwritable = true;
    const pipeline = new TelemetryPipeline(world.deps);
    expect(() => {
      pipeline.answer(true);
    }).toThrow("EACCES");
    expect(pipeline.state().answer).toBe("unset");
  });
});

describe("the telemetry pipeline: what is queued", () => {
  it("stamps each report and redacts it before the queue", () => {
    const world = telemetryWorld("on");
    const pipeline = new TelemetryPipeline(world.deps);
    const report = pipeline.recordCrash(crash());
    expect(report?.kind).toBe("error");
    expect(report?.payload).toMatchObject({
      kind: "error",
      machine_id: `hash-of-${String(RAW_IDENTIFIER.length)}-chars`,
      report_id: "report00000000000000000000000001",
      at: "2026-09-26T12:00:00.000Z",
      exception_type: "RuntimeCrashed",
      crashed: "runtime",
      crashes: { runtime: 1, services: 0, node: 0, node_stopped: 0 },
    });
  });

  it("computing the id arms the redactor against the raw identifier, once", () => {
    const world = telemetryWorld("on");
    const pipeline = new TelemetryPipeline(world.deps);
    pipeline.recordCrash(crash());
    pipeline.recordUsage(usage());
    expect(world.identifierCalls()).toBe(1);
    expect(world.registry.redact(`id ${RAW_IDENTIFIER}`)).toBe(`id ${REDACTED}`);
    // Even when a caller put it in a report, it does not survive the redaction.
    const leaked = pipeline.recordCrash({ ...crash(), exception_type: `x ${RAW_IDENTIFIER}` });
    expect(JSON.stringify(leaked?.payload)).not.toContain(RAW_IDENTIFIER);
  });

  it("canary secrets never appear in a queued or a sent payload", async () => {
    const world = telemetryWorld("on");
    // The Anytype key, the proxy token and a node credential are registered where they are
    // held, as the one log's registry learns them.
    for (const secret of [ANYTYPE_KEY, PROXY_TOKEN, NODE_CREDENTIAL]) {
      world.registry.protect(secret);
    }
    const pipeline = new TelemetryPipeline(world.deps);
    const hostile = {
      ...crash(),
      exception_type: `Error at ${HOME_PATH} with ${ANYTYPE_KEY}`,
      detail: [`Bearer ${PROXY_TOKEN}`, { deeper: `node said ${NODE_CREDENTIAL}` }],
      anytype_api_key: ANYTYPE_KEY,
      where: `file://${HOME_PATH}`,
    };
    pipeline.recordCrash(hostile);
    pipeline.recordUsage({ ...usage(), note: HOME_PATH, arch: HOME_PATH });
    const queued = JSON.stringify(world.queue.reports);
    await pipeline.flush();
    const sent = JSON.stringify(world.poster.sent);
    for (const canary of [
      ANYTYPE_KEY,
      PROXY_TOKEN,
      NODE_CREDENTIAL,
      HOME_PATH,
      "canary-home",
      RAW_IDENTIFIER,
    ]) {
      expect(queued).not.toContain(canary);
      expect(sent).not.toContain(canary);
    }
    expect(world.poster.sent).toHaveLength(2);
  });

  it("the leak check itself can fail", () => {
    // The same payload WITHOUT the registry armed: the canary survives, so the check above sees.
    const world = telemetryWorld("on");
    const pipeline = new TelemetryPipeline(world.deps);
    pipeline.recordCrash({ ...crash(), exception_type: `with ${ANYTYPE_KEY}` });
    expect(JSON.stringify(world.queue.reports)).toContain(ANYTYPE_KEY);
  });

  it("a build with no endpoint queues nothing", () => {
    const world = telemetryWorld("on", { endpoints: NO_ENDPOINTS });
    const pipeline = new TelemetryPipeline(world.deps);
    expect(pipeline.recordCrash(crash())).toBeNull();
    expect(pipeline.recordUsage(usage())).toBeNull();
    expect(world.queue.reports).toEqual([]);
    expect(world.identifierCalls()).toBe(0);
  });

  it("a queue that cannot be written never reaches the caller", () => {
    const world = telemetryWorld("on");
    world.queue.unwritable = true;
    const pipeline = new TelemetryPipeline(world.deps);
    expect(pipeline.recordCrash(crash())).toBeNull();
    expect(world.logger.lines.join("\n")).toContain("a crash report could not be queued: ENOSPC");
  });

  it("an empty or stub identifier is refused rather than hashed, and nothing is queued", () => {
    for (const raw of ["", "   ", "short"]) {
      let hashed = 0;
      const world = telemetryWorld("on", {
        machineIdentifier: () => raw,
        hashIdentifier: () => {
          hashed += 1;
          return "x";
        },
      });
      const pipeline = new TelemetryPipeline(world.deps);
      expect(pipeline.recordCrash(crash())).toBeNull();
      expect(hashed).toBe(0);
      expect(world.queue.reports).toEqual([]);
    }
  });
});

describe("the telemetry pipeline: sending", () => {
  it("drains the queue in the background, in order", async () => {
    const world = telemetryWorld("on");
    const pipeline = new TelemetryPipeline(world.deps);
    pipeline.start();
    pipeline.start();
    const first = pipeline.recordUsage(usage());
    const second = pipeline.recordCrash(crash());
    expect(world.poster.sent).toEqual([]);
    world.clock.advance(0);
    await settle();
    expect(world.poster.sent.map((request) => request.url)).toEqual([
      "https://umami.test/api/send",
      "https://glitchtip.test/api/42/envelope/",
    ]);
    // What was posted is byte for byte what the transport renders from the queued report.
    expect(world.poster.sent[0]?.body).toBe(outgoingFor(queued(first), ENDPOINTS, "9.9.9").body);
    expect(world.poster.sent[1]?.body).toBe(outgoingFor(queued(second), ENDPOINTS, "9.9.9").body);
    expect(world.queue.reports).toEqual([]);
  });

  it("a report recorded while one is being sent is sent after it", async () => {
    const world = telemetryWorld("on");
    const pipeline = new TelemetryPipeline(world.deps);
    pipeline.start();
    let release: (() => void) | null = null;
    world.poster.post = (request) => {
      world.poster.sent.push(request);
      return new Promise((resolve) => {
        release = () => {
          resolve({ ok: true });
        };
      });
    };
    pipeline.recordCrash(crash());
    world.clock.advance(0);
    await settle();
    pipeline.recordCrash(crash());
    (release as unknown as () => void)();
    await settle();
    world.clock.advance(0);
    await settle();
    expect(world.poster.sent).toHaveLength(2);
  });

  it("a failing server backs off on the injected clock, and a success resets it", async () => {
    const world = telemetryWorld("on");
    const pipeline = new TelemetryPipeline(world.deps);
    pipeline.start();
    let failing = true;
    world.poster.answer = () => (failing ? { ok: false, detail: "answered 503" } : { ok: true });
    pipeline.recordCrash(crash());
    world.clock.advance(0);
    await settle();
    expect(world.poster.sent).toHaveLength(1);
    // A report recorded during the backoff waits for it rather than cutting it short.
    pipeline.recordCrash(crash());
    const [first = 0, second = 0] = DEFAULT_BACKOFF_MS;
    expect([first, second]).toEqual([5_000, 30_000]);
    world.clock.advance(first - 1);
    await settle();
    expect(world.poster.sent).toHaveLength(1);
    world.clock.advance(1);
    await settle();
    expect(world.poster.sent).toHaveLength(2);
    // The second failure in a row waits the second step.
    world.clock.advance(second - 1);
    await settle();
    expect(world.poster.sent).toHaveLength(2);
    failing = false;
    world.clock.advance(1);
    await settle();
    expect(world.poster.sent).toHaveLength(4);
    expect(world.queue.reports).toEqual([]);
    expect(world.logger.lines.join("\n")).toContain(
      "a crash report could not be sent (answered 503); trying again in 5 s",
    );
  });

  it("the backoff's last step repeats", async () => {
    const world = telemetryWorld("on", { backoffMs: [10, 20] });
    world.poster.answer = () => ({ ok: false, detail: "down" });
    const pipeline = new TelemetryPipeline(world.deps);
    pipeline.recordCrash(crash());
    expect((await pipeline.flush()).retryInMs).toBe(10);
    expect((await pipeline.flush()).retryInMs).toBe(20);
    expect((await pipeline.flush()).retryInMs).toBe(20);
  });

  it("reporting does not wait on the server at all", async () => {
    const world = telemetryWorld("on");
    world.poster.answer = () => "hang";
    const pipeline = new TelemetryPipeline(world.deps);
    pipeline.start();
    pipeline.recordCrash(crash());
    world.clock.advance(0);
    await settle();
    // The server holds the first report forever; the next restart's report is queued at once.
    const started = performance.now();
    expect(pipeline.recordCrash(crash())).not.toBeNull();
    expect(performance.now() - started).toBeLessThan(50);
    expect(world.queue.reports).toHaveLength(2);
  });

  it("a report whose endpoint is not https is dropped unsent", async () => {
    const world = telemetryWorld("on", {
      endpoints: { ...ENDPOINTS, glitchtipDsn: "http://key@glitchtip.test/42" },
    });
    const pipeline = new TelemetryPipeline(world.deps);
    pipeline.recordCrash(crash());
    expect(await pipeline.flush()).toEqual({ sent: 0, retryInMs: null });
    expect(world.poster.sent).toEqual([]);
    expect(world.queue.reports).toEqual([]);
    expect(world.logger.lines.join("\n")).toContain("must be https, got http");
  });

  it("stopping stops the sender, and stopping twice is harmless", async () => {
    const world = telemetryWorld("on");
    const pipeline = new TelemetryPipeline(world.deps);
    pipeline.start();
    pipeline.recordCrash(crash());
    pipeline.stop();
    pipeline.stop();
    world.clock.advance(60_000);
    await settle();
    expect(world.poster.sent).toEqual([]);
    expect(await pipeline.flush()).toEqual({ sent: 0, retryInMs: null });
    expect(world.queue.reports).toHaveLength(1);
    // Started again, it sends what waited.
    pipeline.start();
    world.clock.advance(0);
    await settle();
    expect(world.poster.sent).toHaveLength(1);
  });

  it("a yes wakes the sender for what a previous on left", async () => {
    const world = telemetryWorld("unset");
    const pipeline = new TelemetryPipeline(world.deps);
    pipeline.start();
    pipeline.answer(true);
    pipeline.recordUsage(usage());
    world.clock.advance(0);
    await settle();
    expect(world.poster.sent).toHaveLength(1);
    expect(world.logger.lines).toContain("INFO telemetry is turned on");
  });

  it("a sender that throws is logged and never takes the shell down", async () => {
    const world = telemetryWorld("on");
    const pipeline = new TelemetryPipeline(world.deps);
    pipeline.start();
    pipeline.recordCrash(crash());
    world.poster.post = () => Promise.reject(new Error("the socket blew up"));
    world.clock.advance(0);
    await settle();
    expect(world.logger.lines.join("\n")).toContain(
      "the telemetry sender failed: the socket blew up",
    );
  });
});
