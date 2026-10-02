// A step's dynamic options end to end below Electron (plan 0022 §B; WI-0022-09): the runtime's
// resolver asks over the direct channel, the services process reads a fake Anytype over real
// HTTP with the key it alone holds, and ids and names come back. Not paired, it refuses with
// the sentence and Anytype is asked nothing. The key is in no answer and no log line.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AnytypeClient } from "../../src/adapters/anytype/api-client";
import { AnytypeService, serveAnytypeOptions } from "../../src/application/anytype-service";
import { NodeOptions } from "../../src/application/node-options";
import { answerPeerCalls, PeerCaller } from "../../src/application/peer-link";
import { NOT_PAIRED_SENTENCE } from "../../src/domain/forms/node-options";
import { DEFAULT_BACKOFF } from "../../src/domain/supervision/backoff";
import { MCP_STABILITY } from "../../src/domain/supervision/staleness";
import type { PeerLink } from "../../src/ports/shell-link";
import { RecordingLogger, RecordingNotifier } from "../fakes/children";
import { FakeClock } from "../fakes/clock";
import { FakeAnytypeServer, FakeMcpLauncher, MemorySecretStore } from "../fakes/anytype";

const KEY = "integration-options-key-0123456789";

/** Both ends of a direct channel in memory; what crosses is a structured clone. */
function channel(): [PeerLink, PeerLink] {
  const listeners: [((raw: unknown) => void)[], ((raw: unknown) => void)[]] = [[], []];
  const end = (mine: 0 | 1): PeerLink => ({
    post: (message) => {
      const copy = structuredClone(message);
      queueMicrotask(() => {
        for (const listener of listeners[mine === 0 ? 1 : 0]) {
          listener(copy);
        }
      });
    },
    onMessage: (listener) => {
      listeners[mine].push(listener);
    },
    close: () => undefined,
  });
  return [end(0), end(1)];
}

let anytype: FakeAnytypeServer;
let base: string;

beforeEach(async () => {
  anytype = new FakeAnytypeServer(KEY);
  anytype.spaces = [{ id: "sp1", name: "Work" }];
  anytype.types.set("sp1", [
    { key: "page", name: "Page" },
    { key: "old", name: "Old", archived: true },
  ]);
  base = await anytype.start();
});

afterEach(async () => {
  await anytype.close();
});

/** The runtime's resolver, linked to a services process holding `key` (or none). */
function linked(key: string | null) {
  const secrets = new MemorySecretStore();
  if (key !== null) {
    secrets.write("anytype-api-key", key);
  }
  const logger = new RecordingLogger();
  const service = new AnytypeService({
    settings: {
      apiBaseUrl: base,
      backoff: DEFAULT_BACKOFF,
      crashLoop: { maxCrashes: 5, windowMs: 120_000 },
      profile: MCP_STABILITY,
      keyLocation: "the key file",
      healthRetryMs: 10_000,
    },
    secrets,
    api: new AnytypeClient({ apiBaseUrl: base }),
    launcher: new FakeMcpLauncher(),
    publishKey: () => undefined,
    childLine: () => undefined,
    command: "node cli.mjs",
    clock: new FakeClock(),
    logger,
    notifier: new RecordingNotifier(),
  });
  const [runtimeEnd, servicesEnd] = channel();
  answerPeerCalls(servicesEnd, (op, args) => serveAnytypeOptions(service, op, args), logger);
  const caller = new PeerCaller({ clock: new FakeClock(), timeoutMs: 30_000 });
  caller.connect(runtimeEnd);
  const resolver = new NodeOptions({ ask: (op, args) => caller.call(op, args), logger });
  return { resolver, logger };
}

describe("a step's options through the direct channel", () => {
  it("lists the spaces and a space's types from Anytype, with the key, and returns no key", async () => {
    const { resolver, logger } = linked(KEY);
    const spaces = await resolver.resolve({ source: "spaces" });
    const types = await resolver.resolve({ source: "types", spaceId: "sp1" });
    expect(spaces).toEqual({ options: [{ value: "sp1", label: "Work" }] });
    expect(types).toEqual({ options: [{ value: "page", label: "Page" }] });
    const lists = anytype.received.filter((request) => request.url.includes("offset="));
    expect(lists.map((request) => request.authorization)).toEqual([
      `Bearer ${KEY}`,
      `Bearer ${KEY}`,
    ]);
    expect(JSON.stringify([spaces, types]) + logger.lines.join("\n")).not.toContain(KEY);
  });

  it("refuses when not paired, with the sentence, and asks Anytype nothing", async () => {
    const { resolver } = linked(null);
    expect(await resolver.resolve({ source: "spaces" })).toEqual({
      refused: { reason: "not-paired", sentence: NOT_PAIRED_SENTENCE },
    });
    expect(anytype.received).toEqual([]);
  });

  it("refuses as not paired when Anytype no longer accepts the key", async () => {
    const { resolver, logger } = linked("a-key-anytype-revoked-0123");
    expect(await resolver.resolve({ source: "spaces" })).toMatchObject({
      refused: { reason: "not-paired" },
    });
    expect(logger.lines.join("\n")).not.toContain("a-key-anytype-revoked-0123");
  });
});
