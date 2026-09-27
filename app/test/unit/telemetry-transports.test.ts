// How a queued report goes on the wire (WI-0018-22): a hand-written Sentry envelope for GlitchTip,
// a custom event for Umami, HTTPS only, rendered from the queued payload and nothing else.
import { describe, expect, it } from "vitest";
import type { QueuedReport } from "../../src/domain/telemetry/reports";
import {
  flatten,
  hasEndpoint,
  NO_ENDPOINTS,
  outgoingFor,
  parseDsn,
  renderEnvelope,
  UMAMI_HOSTNAME,
} from "../../src/domain/telemetry/transports";
import { ENDPOINTS } from "../fakes/telemetry";

const ERROR: QueuedReport = {
  sequence: 1,
  kind: "error",
  payload: {
    report_id: "a".repeat(32),
    at: "2026-09-26T12:00:00.000Z",
    kind: "error",
    exception_type: "RuntimeCrashed",
    machine_id: "m".repeat(64),
    os: "darwin",
    os_version: "25.3.0",
    arch: "arm64",
    app_version: "9.9.9",
    crashed: "runtime",
    crashes: { runtime: 1, services: 0, node: 2, node_stopped: 0 },
    stopped_for_good: false,
  },
};

const USAGE: QueuedReport = {
  sequence: 2,
  kind: "usage",
  payload: {
    kind: "usage",
    machine_id: "m".repeat(64),
    app_version: "9.9.9",
    packages: [{ id: "anytype", version: "1.0.0" }],
    crashes: { runtime: 0 },
  },
};

describe("the GlitchTip transport: a Sentry envelope, by hand", () => {
  it("an error goes to GlitchTip's envelope endpoint over the Sentry protocol", () => {
    const outgoing = outgoingFor(ERROR, ENDPOINTS, "9.9.9");
    expect(outgoing.url).toBe("https://glitchtip.test/api/42/envelope/");
    expect(outgoing.headers).toEqual({
      "Content-Type": "application/x-sentry-envelope",
      "X-Sentry-Auth":
        "Sentry sentry_version=7, sentry_client=innytypes/9.9.9, sentry_key=publickey123",
    });
    expect(outgoing.body).toBe(renderEnvelope(ERROR, "9.9.9"));
  });

  it("the envelope is a header, an item header with the event's byte length, and the event", () => {
    const lines = renderEnvelope(ERROR, "9.9.9").split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe("");
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      event_id: "a".repeat(32),
      sent_at: "2026-09-26T12:00:00.000Z",
    });
    const event = lines[2] ?? "";
    expect(JSON.parse(lines[1] ?? "")).toEqual({
      type: "event",
      length: new TextEncoder().encode(event).length,
    });
    expect(JSON.parse(event)).toEqual({
      event_id: "a".repeat(32),
      timestamp: "2026-09-26T12:00:00.000Z",
      platform: "node",
      level: "error",
      logger: "innytypes.shell",
      release: "9.9.9",
      exception: { values: [{ type: "RuntimeCrashed", value: "" }] },
      tags: {
        machine_id: "m".repeat(64),
        os: "darwin",
        os_version: "25.3.0",
        arch: "arm64",
        app_version: "9.9.9",
      },
      extra: {
        crashed: "runtime",
        crashes: { runtime: 1, services: 0, node: 2, node_stopped: 0 },
        stopped_for_good: false,
      },
    });
  });

  it("an error report carries the type but never a message", () => {
    const event = JSON.parse(renderEnvelope(ERROR, "1").split("\n")[2] ?? "") as {
      exception: { values: { value: string }[] };
    };
    expect(event.exception.values[0]?.value).toBe("");
    // A report missing its fields still renders, with the fallbacks.
    const bare = renderEnvelope({ sequence: 3, kind: "error", payload: {} }, "1");
    expect(bare).toContain('"type":"Error"');
  });

  it("the byte length counts bytes, not characters", () => {
    const report = { ...ERROR, payload: { ...ERROR.payload, crashed: "müde ✓" } };
    const lines = renderEnvelope(report, "1").split("\n");
    const length = (JSON.parse(lines[1] ?? "") as { length: number }).length;
    expect(length).toBe(Buffer.byteLength(lines[2] ?? "", "utf8"));
    expect(length).toBeGreaterThan((lines[2] ?? "").length);
  });

  it("a dsn is parsed, with a path prefix kept and the key decoded", () => {
    expect(parseDsn("https://k%40y@errors.example:8443/glitch/7")).toEqual({
      envelopeUrl: "https://errors.example:8443/glitch/api/7/envelope/",
      publicKey: "k@y",
    });
  });

  it("a dsn that is not https is refused, and so is a broken or empty one", () => {
    expect(() => parseDsn("http://key@glitchtip.test/42")).toThrow("must be https, got http");
    expect(() => parseDsn("not a url")).toThrow("is not a URL");
    expect(() => parseDsn("https://glitchtip.test/42")).toThrow("<public key>@<host>");
    expect(() => parseDsn("https://key@glitchtip.test/")).toThrow("<project id>");
    expect(() => parseDsn("")).toThrow("no GlitchTip DSN");
  });
});

describe("the Umami transport: a custom event", () => {
  it("usage goes to Umami as a custom event and never names the machine", () => {
    const outgoing = outgoingFor(USAGE, ENDPOINTS, "9.9.9");
    expect(outgoing.url).toBe("https://umami.test/api/send");
    expect(outgoing.headers).toEqual({
      "Content-Type": "application/json",
      "User-Agent": "innytypes/9.9.9",
    });
    expect(JSON.parse(outgoing.body)).toEqual({
      type: "event",
      payload: {
        website: "website-1",
        hostname: UMAMI_HOSTNAME,
        url: "/app",
        name: "usage",
        data: {
          kind: "usage",
          machine_id: "m".repeat(64),
          app_version: "9.9.9",
          packages: '[{"id":"anytype","version":"1.0.0"}]',
          "crashes.runtime": 0,
        },
      },
    });
    expect(UMAMI_HOSTNAME.endsWith(".invalid")).toBe(true);
  });

  it("flattens nested fields into the scalars Umami keeps", () => {
    expect(flatten({ a: { b: { c: 1 } }, d: [1], e: null })).toEqual({
      "a.b.c": 1,
      d: "[1]",
      e: null,
    });
  });

  it("an Umami URL that is not https, or missing, is refused", () => {
    expect(() => outgoingFor(USAGE, { ...ENDPOINTS, umamiUrl: "http://umami.test" }, "1")).toThrow(
      "must be https",
    );
    expect(() => outgoingFor(USAGE, NO_ENDPOINTS, "1")).toThrow("no Umami endpoint");
    expect(
      outgoingFor(USAGE, { ...ENDPOINTS, umamiUrl: "https://umami.test/base//" }, "1").url,
    ).toBe("https://umami.test/base/api/send");
  });

  it("a build with no endpoint for a kind has nowhere to send it", () => {
    expect(hasEndpoint(NO_ENDPOINTS, "error")).toBe(false);
    expect(hasEndpoint(NO_ENDPOINTS, "usage")).toBe(false);
    expect(hasEndpoint({ ...NO_ENDPOINTS, umamiUrl: "https://u" }, "usage")).toBe(false);
    expect(hasEndpoint(ENDPOINTS, "error")).toBe(true);
    expect(hasEndpoint(ENDPOINTS, "usage")).toBe(true);
  });
});
