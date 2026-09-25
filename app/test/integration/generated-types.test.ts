// adapters/nodered/registration.ts with the real node process adapter, the real journal replay
// and the every-control fixture package, against a recording stand-in for Node-RED's node API:
// each instance's config is coerced and validated before its process starts, the start frame
// carries it, inputs are journaled and answered on the right port, done/error and status are
// mapped, and journaled inputs are re-sent through node.receive on flows:started.

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TypeRegistration } from "../../src/adapters/nodered/registration";
import { resolveCommand } from "../../src/adapters/process/command";
import { DEFAULT_NODE_PROCESS, nodeProcessLauncher } from "../../src/adapters/process/node-process";
import { processTreeFor } from "../../src/adapters/process/process-tree";
import { AjvSchemaValidator } from "../../src/adapters/schema/ajv-validator";
import { systemClock } from "../../src/adapters/system/clock";
import { JournalReplay } from "../../src/application/journal-replay";
import { loadNodeTypes } from "../../src/application/load-node-types";
import { ViewService } from "../../src/application/views";
import { newEntry, type CloseReason } from "../../src/domain/journal/entry";
import { nodeTypeName, type LoadedType } from "../../src/domain/packages/declaration";
import type { NodeProcessLauncher } from "../../src/ports/node-process";
import { MemoryJournal } from "../fakes/journal";
import { FakeNode, FakeRed, type Message } from "../fakes/node-red";
import { MemorySnapshots } from "../fakes/snapshots";
import {
  RecordingLogger,
  RecordingNotifier,
  RecordingSecrets,
  rawNodeEnv,
  waitFor,
} from "../fixtures/raw-node/fixture";

const FIXTURE = path.resolve(import.meta.dirname, "..", "fixtures", "every-control");
const PROBE = "inny-everycontrol-probe";
const TICKER = "inny-everycontrol-ticker";

let scratch: string;
let journal: MemoryJournal;
let events: EventEmitter;
let logger: RecordingLogger;
let started: string[];
let closes: string[];
let closeReason: Exclude<CloseReason, "removed">;
let red: FakeRed;
let live: FakeNode[];

function setUp(commandFor?: () => never): TypeRegistration {
  const validator = new AjvSchemaValidator();
  const document: unknown = JSON.parse(
    fs.readFileSync(path.join(FIXTURE, "inny-package.json"), "utf8"),
  );
  const loaded = loadNodeTypes(
    [{ name: "everycontrol", folder: FIXTURE, document }],
    validator,
    logger,
  );
  const real = nodeProcessLauncher({
    clock: systemClock,
    logger,
    notifier: new RecordingNotifier(),
    tree: processTreeFor(process.platform),
    newId: randomUUID,
    secrets: new RecordingSecrets(),
    journal,
    settings: DEFAULT_NODE_PROCESS,
  });
  // The real launcher, counting what it starts.
  const launcher: NodeProcessLauncher = {
    start: (spec, host) => {
      started.push(spec.identity.id);
      const child = real.start(spec, host);
      return {
        get pid() {
          return child.pid;
        },
        input: (message, delivery) => child.input(message, delivery),
        cancel: (id) => {
          child.cancel(id);
        },
        action: (id, values) => child.action(id, values),
        trigger: (action, snapshot, values) => child.trigger(action, snapshot, values),
        fire: (data) => {
          child.fire(data);
        },
        replay: (redeliver) => child.replay(redeliver),
        queue: () => child.queue(),
        close: (reason) => {
          closes.push(`${spec.identity.id} ${reason}`);
          return child.close(reason);
        },
      };
    },
  };
  const registration = new TypeRegistration({
    types: new Map<string, LoadedType>(
      loaded.map((l) => [nodeTypeName(l.declaration.package, l.type.id), l]),
    ),
    launcher,
    validator,
    replay: new JournalReplay({ store: journal, logger, events }),
    views: new ViewService({
      journal,
      snapshots: new MemorySnapshots(),
      clock: systemClock,
      newId: randomUUID,
      logger,
      raise: () => undefined,
    }),
    logger,
    commandFor:
      commandFor ??
      (({ type, folder }) => ({
        ...resolveCommand(type.command, process.platform, {
          python: "python3",
          node: process.execPath,
          package: folder,
        }),
        env: rawNodeEnv(),
      })),
    dataDirFor: (id) => path.join(scratch, "instances", id),
    closeReason: () => closeReason,
  });
  registration.register(red, PROBE);
  registration.register(red, TICKER);
  return registration;
}

/** A valid probe config, as Node-RED keeps it: every value a string or as the form saved it. */
function probeConfig(id: string, overrides: Message = {}): Message {
  return {
    id,
    z: "tab1",
    name: "the probe",
    wires: [[], []],
    x: 100,
    y: 40,
    label: "L",
    ratio: "0.25",
    count: "",
    enabled: true,
    mode: "slow",
    level: "2",
    retry: { attempts: "4", backoff: "1.5" },
    volumes: [
      { name: "media", path: "/Volumes/media", size_gb: "2000", readonly: "true" },
      { name: "scratch", path: "/tmp/scratch", size_gb: "", readonly: false },
    ],
    ...overrides,
  };
}

function create(type: string, config: Message, credentials: Message = {}): FakeNode {
  const node = red.create(type, config, credentials);
  live.push(node);
  return node;
}

function startFrame(id: string): Record<string, unknown> {
  const file = path.join(scratch, "instances", id, "start.json");
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

beforeEach(() => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "inny-types-")));
  journal = new MemoryJournal();
  events = new EventEmitter();
  logger = new RecordingLogger();
  started = [];
  closes = [];
  closeReason = "redeploy";
  red = new FakeRed();
  live = [];
});

afterEach(async () => {
  closeReason = "quit";
  await Promise.all(live.map((node) => node.close(true)));
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("a generated type's instance", () => {
  it("starts its process with the coerced, validated config and its credentials", async () => {
    setUp();
    create(PROBE, probeConfig("p1"), { token: "s3cret", apikey: "" });
    const file = path.join(scratch, "instances", "p1", "start.json");
    await waitFor("the start frame", () => fs.existsSync(file));
    await waitFor("the whole start frame", () => fs.readFileSync(file, "utf8").endsWith("}"));
    expect(startFrame("p1")).toEqual({
      t: "start",
      protocol: 2,
      node: { id: "p1", type: PROBE, name: "the probe" },
      config: {
        label: "L",
        ratio: 0.25,
        count: 3,
        enabled: true,
        mode: "slow",
        level: 2,
        retry: { attempts: 4, backoff: 1.5 },
        volumes: [
          { name: "media", path: "/Volumes/media", size_gb: 2000, readonly: true },
          { name: "scratch", path: "/tmp/scratch", readonly: false },
        ],
      },
      credentials: { token: "s3cret" },
      data_dir: path.join(scratch, "instances", "p1"),
    });
  });

  it("registers every secret as a password credential with Node-RED", () => {
    setUp();
    expect(red.options.get(PROBE)).toEqual({
      credentials: { token: { type: "password" }, apikey: { type: "password" } },
    });
  });

  it("starts nothing when the schema refuses its config, says why, and fails its inputs", async () => {
    setUp();
    const node = create(PROBE, probeConfig("bad", { count: "three", volumes: [] }));
    expect(started).toEqual([]);
    expect(node.statuses).toEqual([{ fill: "red", shape: "ring", text: "invalid configuration" }]);
    const [said] = node.errors;
    expect(said).toContain("not started: its configuration is refused:");
    expect(said).toContain("count must be integer");
    expect(said).toContain("volumes must NOT have fewer than 1 items");
    expect(said).toContain("token is required");
    expect(logger.has(new RegExp(`^\\[${PROBE} bad\\] not started`))).toBe(true);
    const answer = node.input({ payload: 1, _msgid: "m" });
    expect(answer.ends).toHaveLength(1);
    expect(answer.ends[0]?.message).toContain("count must be integer");
    await node.close(false);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fs.existsSync(path.join(scratch, "instances", "bad", "start.json"))).toBe(false);
  });

  it("starts nothing when its command cannot run here, and says why", () => {
    setUp(() => {
      throw new Error("the command declares nothing for this platform");
    });
    const node = create(PROBE, probeConfig("cmd"), { token: "t" });
    expect(started).toEqual([]);
    expect(node.errors[0]).toContain("its command cannot run: the command declares nothing");
  });

  it("journals an input, answers it on the port its emit names, and maps done", async () => {
    setUp();
    const node = create(PROBE, probeConfig("p2"), { token: "t" });
    const input = { payload: { x: 1 }, topic: "everycontrol.tick.v1", _msgid: "m1", extra: "kept" };
    const answer = node.input(input);
    await waitFor("the input to finish", () => answer.ends.length === 1);
    expect(answer.ends).toEqual([undefined]);
    expect(answer.outputs).toHaveLength(1);
    const [first, second] = answer.outputs[0] ?? [];
    expect(first).toBeNull();
    // A clone of the input: _msgid and its other fields kept, payload and topic replaced.
    expect(second).toMatchObject({
      _msgid: "m1",
      extra: "kept",
      topic: "everycontrol.second.v1",
      payload: { received: { x: 1 }, label: "L" },
      inny: { event: { type: "everycontrol.second.v1", source: `inny://everycontrol/probe/p2` } },
    });
    expect((second?.["inny"] as { cause: string }).cause).toMatch(/[0-9a-f-]{36}/);
    // Journaled before it was sent, cleared when it was done.
    expect(journal.calls).toHaveLength(2);
    expect(journal.calls[0]).toMatch(/^put /);
    expect(journal.calls[1]).toMatch(/^clear /);
    expect(journal.all()).toEqual([]);
  });

  it("shows the process's status on the node", async () => {
    setUp();
    const node = create(PROBE, probeConfig("p3"), { token: "t" });
    await waitFor("ready", () => node.statuses.length >= 2);
    expect(node.statuses.slice(0, 2)).toEqual([
      { fill: "grey", shape: "ring", text: "starting" },
      { fill: "green", shape: "ring", text: "ready" },
    ]);
  });

  it("sends a source's emission as a new run on its own port", async () => {
    setUp();
    const node = create(TICKER, { id: "t1", greeting: "hi", delay_ms: "0" });
    await waitFor("the tick", () => node.sent.length === 1);
    const [message] = node.sent[0] ?? [];
    expect(message).toMatchObject({ payload: { greeting: "hi" }, topic: "everycontrol.tick.v1" });
    const inny = message?.["inny"] as { run: string; event: { id: string }; cause?: string };
    expect(inny.run).toBe(inny.event.id);
    expect(inny.cause).toBeUndefined();
    expect(node.statuses).toContainEqual({ fill: "green", shape: "ring", text: "watching" });
  });

  it("is attached to the journal replay: a journaled input is re-sent through node.receive", async () => {
    setUp();
    const message = { payload: { again: true }, topic: "everycontrol.tick.v1", _msgid: "old" };
    journal.put(
      newEntry({ inputId: "kept-1", instanceId: "p4", type: PROBE, message, now: Date.now() }),
    );
    const node = create(PROBE, probeConfig("p4"), { token: "t" });
    expect(node.received).toEqual([]);
    events.emit("flows:started");
    expect(node.received).toEqual([message]);
    await waitFor("the replayed input to finish", () => node.answered[0]?.ends.length === 1);
    expect(node.answered[0]?.outputs[0]?.[1]).toMatchObject({
      _msgid: "old",
      payload: { received: { again: true }, label: "L" },
      inny: { cause: "kept-1" },
    });
    expect(journal.all()).toEqual([]);
  });

  it("closes its process for the reason it is closed, and waits for it to exit", async () => {
    setUp();
    const planned = create(PROBE, probeConfig("p5"), { token: "t" });
    const removed = create(PROBE, probeConfig("p6"), { token: "t" });
    await waitFor("ready", () => planned.statuses.length >= 2 && removed.statuses.length >= 2);
    closeReason = "types";
    await planned.close(false);
    await removed.close(true);
    expect(closes).toEqual(["p5 types", "p6 removed"]);
    expect(logger.has(new RegExp(`^\\[${PROBE} p5\\] process exited \\(code 0\\) on close`))).toBe(
      true,
    );
    live.length = 0;
  });

  it("refuses to register a type no loaded package declares", () => {
    const registration = setUp();
    expect(() => {
      registration.register(red, "inny-everycontrol-nope");
    }).toThrow("inny-everycontrol-nope is not a type of any loaded node package");
  });
});
