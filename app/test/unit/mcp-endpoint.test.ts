// The MCP endpoint's address, served and saved (plan 0018 §4.1 points 3 and 4; WI-0018-19):
// when it opens, a collision that degrades with the address named, the stored value winning,
// and moves that are stored only once served. Ported from tests/test_mcp_host_integration.py,
// tests/test_control_channel.py and tests/test_independent_client_connection.py; the listener
// is a fake here, and test/integration/mcp-gateway.test.ts is the real one.
import { describe, expect, it } from "vitest";
import {
  McpEndpoint,
  NOT_YET_OPEN,
  serveEndpointCall,
  stopServing,
} from "../../src/application/mcp-endpoint";
import { EndpointError, type StoredEndpoint } from "../../src/domain/endpoint/address";
import { CLIENTS_MUST_BE_UPDATED } from "../../src/domain/endpoint/status";
import type { McpListener, ServedAddress } from "../../src/ports/mcp-gateway";
import type { SettingsStore } from "../../src/ports/settings-store";
import { RecordingLogger, RecordingNotifier } from "../fakes/children";

const PROXY_TOKEN = "fake-proxy-token-for-the-endpoint-0123456789";
const ANYTYPE_KEY = "fake-anytype-key-for-the-endpoint-0123456789";

/** A listener whose binds succeed except on the ports a test says are taken. */
class FakeListener implements McpListener {
  serving: ServedAddress | null = null;
  readonly taken = new Set<number>();
  readonly binds: ServedAddress[] = [];
  stops = 0;

  serveAt(host: string, port: number): Promise<void> {
    this.binds.push({ host, port });
    if (this.taken.has(port)) {
      return Promise.reject(
        new EndpointError(`could not bind the MCP service at ${host}:${String(port)}: EADDRINUSE`),
      );
    }
    this.serving = { host, port };
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.stops += 1;
    this.serving = null;
    return Promise.resolve();
  }
}

class MemorySettings implements SettingsStore {
  stored: StoredEndpoint = {};
  broken: Error | null = null;
  writes = 0;

  readEndpoint(): StoredEndpoint {
    if (this.broken !== null) {
      throw this.broken;
    }
    return this.stored;
  }
  writeEndpoint(endpoint: StoredEndpoint): void {
    this.writes += 1;
    this.stored = endpoint;
  }
}

function endpoint(variables: Record<string, string> = { INNYTYPES_MCP_PORT: "40001" }) {
  const listener = new FakeListener();
  const settings = new MemorySettings();
  const logger = new RecordingLogger();
  const notifier = new RecordingNotifier();
  const subject = new McpEndpoint({ settings, variables, listener, logger, notifier });
  return { subject, listener, settings, logger, notifier };
}

describe("opening the endpoint", () => {
  it("binds nothing before the child has first been validated, and says why", () => {
    const { subject, listener } = endpoint();
    expect(listener.binds).toEqual([]);
    expect(subject.status()).toMatchObject({
      served: null,
      saved: "http://127.0.0.1:40001/mcp",
      problem: NOT_YET_OPEN,
      warning: CLIENTS_MUST_BE_UPDATED,
    });
  });

  it("serves the configured address, not the default port, once, however often it is asked", async () => {
    const { subject, listener } = endpoint();
    await subject.start();
    await subject.start();
    expect(listener.binds).toEqual([{ host: "127.0.0.1", port: 40001 }]);
    expect(subject.status()).toMatchObject({
      served: "http://127.0.0.1:40001/mcp",
      saved: "http://127.0.0.1:40001/mcp",
      problem: null,
    });
    expect(subject.status().served).not.toContain("31010");
  });

  it("serves the stored address and not the variable, and names the variable it ignores", async () => {
    const { subject, listener, settings } = endpoint({ INNYTYPES_MCP_PORT: "40001" });
    settings.stored = { host: "127.0.0.1", port: 40002 };
    await subject.start();
    expect(listener.binds).toEqual([{ host: "127.0.0.1", port: 40002 }]);
    expect(subject.status()).toMatchObject({
      served: "http://127.0.0.1:40002/mcp",
      stored: true,
      ignoredVariables: ["INNYTYPES_MCP_PORT"],
    });
  });

  it("degrades on a collision with the address named, once, and binds no other port", async () => {
    const { subject, listener, notifier, logger } = endpoint();
    listener.taken.add(40001);
    await subject.start();
    await subject.start();
    expect(listener.binds).toEqual([{ host: "127.0.0.1", port: 40001 }]);
    const status = subject.status();
    expect(status.served).toBeNull();
    expect(status.problem).toContain("127.0.0.1:40001");
    expect(notifier.notices).toHaveLength(1);
    expect(notifier.notices[0]?.body).toContain("127.0.0.1:40001");
    expect(logger.lines.join("\n")).toContain("the MCP endpoint is not served");
  });

  it("shows no address and the refusal for a configuration that can never be served", async () => {
    const { subject, listener } = endpoint({ INNYTYPES_MCP_HOST: "0.0.0.0" });
    await subject.start();
    expect(listener.binds).toEqual([]);
    expect(subject.status()).toMatchObject({
      served: null,
      saved: null,
      problem: "the MCP address must be loopback; wildcard and network binds are refused",
    });
  });

  it("names a settings file it cannot read, rather than serving an address nobody chose", async () => {
    const { subject, listener, settings } = endpoint();
    settings.broken = new Error("/data/settings.json is not JSON");
    await subject.start();
    expect(listener.binds).toEqual([]);
    expect(subject.status().problem).toBe("/data/settings.json is not JSON");
  });

  it("never carries either credential in what the page is told", async () => {
    const { subject, listener } = endpoint();
    listener.taken.add(40001);
    await subject.start();
    const shown = JSON.stringify([
      subject.status(),
      await serveEndpointCall(subject, "mcp.endpoint", null),
    ]);
    for (const credential of [PROXY_TOKEN, ANYTYPE_KEY]) {
      expect(shown).not.toContain(credential);
    }
  });
});

describe("moving the endpoint", () => {
  async function serving() {
    const ctx = endpoint();
    await ctx.subject.start();
    return ctx;
  }

  it("binds the new address, stores it once it is served, and answers what is served", async () => {
    const { subject, listener, settings } = await serving();
    const status = await subject.move({ host: "127.0.0.1", port: 40005 });
    expect(listener.binds.at(-1)).toEqual({ host: "127.0.0.1", port: 40005 });
    expect(settings.stored).toEqual({ host: "127.0.0.1", port: 40005 });
    expect(status).toMatchObject({
      served: "http://127.0.0.1:40005/mcp",
      saved: "http://127.0.0.1:40005/mcp",
      stored: true,
      ignoredVariables: ["INNYTYPES_MCP_PORT"],
      problem: null,
      warning: CLIENTS_MUST_BE_UPDATED,
    });
  });

  it.each([
    [{ host: "0.0.0.0", port: 40005 }, "must be loopback"],
    [{ host: "192.168.1.2", port: 40005 }, "must be loopback"],
    [{ host: "localhost", port: 40005 }, "numeric loopback"],
    [{ host: "127.0.0.1", port: 0 }, "between 1 and 65535"],
    [{ host: "127.0.0.1" }, "needs a host and a port"],
    [null, "needs a host and a port"],
  ])("refuses %j with its reason, binds nothing and stores nothing", async (request, reason) => {
    const { subject, listener, settings } = await serving();
    await expect(subject.move(request)).rejects.toThrow(reason);
    expect(listener.binds).toHaveLength(1);
    expect(listener.serving).toEqual({ host: "127.0.0.1", port: 40001 });
    expect(settings.writes).toBe(0);
  });

  it("refuses a taken port: the stored setting and the running endpoint are untouched", async () => {
    const { subject, listener, settings } = await serving();
    listener.taken.add(40006);
    await expect(subject.move({ host: "127.0.0.1", port: 40006 })).rejects.toThrow(
      "127.0.0.1:40006",
    );
    expect(listener.serving).toEqual({ host: "127.0.0.1", port: 40001 });
    expect(settings.writes).toBe(0);
    expect(subject.status().served).toBe("http://127.0.0.1:40001/mcp");
  });

  it("saving the address already served stores it and moves nothing", async () => {
    const { subject, listener, settings } = await serving();
    const status = await subject.move({ host: "127.0.0.1", port: 40001 });
    expect(listener.binds).toHaveLength(1);
    expect(settings.stored).toEqual({ host: "127.0.0.1", port: 40001 });
    expect(status).toMatchObject({ served: "http://127.0.0.1:40001/mcp", problem: null });
  });

  it("after a collision, binds the address it is given outright", async () => {
    const { subject, listener, settings } = endpoint();
    listener.taken.add(40001);
    await subject.start();
    await subject.move({ host: "127.0.0.1", port: 40007 });
    expect(listener.serving).toEqual({ host: "127.0.0.1", port: 40007 });
    expect(settings.stored).toEqual({ host: "127.0.0.1", port: 40007 });
    expect(subject.status().problem).toBeNull();
  });

  it("after a collision, may not claim it already serves the address it could not bind", async () => {
    const { subject, listener, settings } = endpoint();
    listener.taken.add(40001);
    await subject.start();
    await expect(subject.move({ host: "127.0.0.1", port: 40001 })).rejects.toThrow(
      "127.0.0.1:40001",
    );
    expect(listener.serving).toBeNull();
    expect(settings.writes).toBe(0);
  });

  it("before the endpoint has opened, stores the address and binds nothing: no start in disguise", async () => {
    const { subject, listener, settings } = endpoint();
    const status = await subject.move({ host: "127.0.0.1", port: 40008 });
    expect(listener.binds).toEqual([]);
    expect(settings.stored).toEqual({ host: "127.0.0.1", port: 40008 });
    expect(status).toMatchObject({ served: null, saved: "http://127.0.0.1:40008/mcp" });
    await subject.start();
    expect(listener.serving).toEqual({ host: "127.0.0.1", port: 40008 });
  });

  it("says so when the move was served but the setting could not be saved", async () => {
    const { subject, settings } = await serving();
    settings.writeEndpoint = () => {
      throw new Error("disk full");
    };
    await expect(subject.move({ host: "127.0.0.1", port: 40009 })).rejects.toThrow(
      "could not be saved: disk full",
    );
    expect(subject.status().problem).toBe(
      "http://127.0.0.1:40001/mcp is saved, but http://127.0.0.1:40009/mcp is served",
    );
  });

  it("runs two moves one after the other, never interleaved", async () => {
    const { subject, listener } = await serving();
    await Promise.all([
      subject.move({ host: "127.0.0.1", port: 40010 }),
      subject.move({ host: "127.0.0.1", port: 40011 }),
    ]);
    expect(listener.binds.slice(1)).toEqual([
      { host: "127.0.0.1", port: 40010 },
      { host: "127.0.0.1", port: 40011 },
    ]);
    expect(listener.serving).toEqual({ host: "127.0.0.1", port: 40011 });
  });
});

describe("the shell's calls", () => {
  it("answers status and move, and a refusal as a result carrying its sentence", async () => {
    const { subject } = endpoint();
    await subject.start();
    expect(await serveEndpointCall(subject, "mcp.endpoint", null)).toMatchObject({
      ok: true,
      value: { served: "http://127.0.0.1:40001/mcp" },
    });
    expect(
      await serveEndpointCall(subject, "mcp.endpoint.move", { host: "127.0.0.1", port: 40012 }),
    ).toMatchObject({ ok: true, value: { served: "http://127.0.0.1:40012/mcp" } });
    expect(
      await serveEndpointCall(subject, "mcp.endpoint.move", { host: "10.0.0.5", port: 1 }),
    ).toEqual({
      ok: false,
      error: "the MCP address must be loopback; wildcard and network binds are refused",
    });
    expect(await serveEndpointCall(subject, "view.get", null)).toEqual({
      ok: false,
      error: "the MCP endpoint does not serve view.get",
    });
  });
});

describe("quitting", () => {
  it("closes the listener before it stops the child", async () => {
    const order: string[] = [];
    await stopServing(
      { stop: () => Promise.resolve(void order.push("listener")) },
      { stop: () => Promise.resolve(void order.push("child")) },
    );
    expect(order).toEqual(["listener", "child"]);
    const { subject, listener } = endpoint();
    await subject.start();
    await stopServing(subject, null);
    expect(listener.stops).toBe(1);
    expect(listener.serving).toBeNull();
  });
});
