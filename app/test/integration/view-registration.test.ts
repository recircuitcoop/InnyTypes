// Views through adapters/nodered/registration.ts (WI-0018-10), with the real node process
// adapter, the reference Python view node, the real ViewService and SQLite for journal and
// snapshots, against a recording stand-in for Node-RED: a view instance attaches with its
// wires; its presentations reach the shell as `present` with the pending count; its snapshots
// are kept with the type's actions; a press starts a new run from the action port, and is
// refused with 409 once the port is unwired or the view has left the flow.

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
import { openSqliteJournal, type SqliteJournal } from "../../src/adapters/sqlite/journal";
import { openSqliteSnapshots } from "../../src/adapters/sqlite/snapshots";
import { systemClock } from "../../src/adapters/system/clock";
import { JournalReplay } from "../../src/application/journal-replay";
import { loadNodeTypes } from "../../src/application/load-node-types";
import { ViewService, type ViewEvent } from "../../src/application/views";
import { nodeTypeName, type LoadedType } from "../../src/domain/packages/declaration";
import type { SnapshotStore } from "../../src/ports/snapshot-store";
import { FakeRed, type FakeNode, type Message } from "../fakes/node-red";
import {
  RecordingLogger,
  RecordingNotifier,
  RecordingSecrets,
  rawNodeEnv,
  waitFor,
} from "../fixtures/raw-node/fixture";
import { viewPackageDir } from "../fixtures/views";

const ASK = "inny-viewpy-ask";
const RECORD = "inny-viewpy-record";

let scratch: string;
let journal: SqliteJournal;
let snapshots: SnapshotStore;
let raised: ViewEvent[];
let views: ViewService;
let red: FakeRed;
let live: FakeNode[];
/** The snapshot ids the service made, in order. */
let snapshotIds: string[];

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "inny-views-"));
  journal = openSqliteJournal(path.join(scratch, "journal.sqlite"));
  snapshots = openSqliteSnapshots(path.join(scratch, "snapshots.sqlite"));
  raised = [];
  live = [];
  snapshotIds = [];
  const logger = new RecordingLogger();
  views = new ViewService({
    journal,
    snapshots,
    clock: systemClock,
    newId: () => {
      const id = randomUUID();
      snapshotIds.push(id);
      return id;
    },
    logger,
    raise: (event) => raised.push(event),
  });
  const validator = new AjvSchemaValidator();
  const folder = viewPackageDir("py");
  const document: unknown = JSON.parse(
    fs.readFileSync(path.join(folder, "inny-package.json"), "utf8"),
  );
  const loaded = loadNodeTypes([{ name: "viewpy", folder, document }], validator, logger);
  const registration = new TypeRegistration({
    types: new Map<string, LoadedType>(
      loaded.map((l) => [nodeTypeName(l.declaration.package, l.type.id), l]),
    ),
    launcher: nodeProcessLauncher({
      clock: systemClock,
      logger,
      notifier: new RecordingNotifier(),
      tree: processTreeFor(process.platform),
      newId: randomUUID,
      secrets: new RecordingSecrets(),
      journal,
      settings: DEFAULT_NODE_PROCESS,
    }),
    validator,
    replay: new JournalReplay({ store: journal, logger, events: new EventEmitter() }),
    views,
    logger,
    commandFor: ({ type, folder: dir }) => ({
      ...resolveCommand(type.command, process.platform, {
        python: "python3",
        node: process.execPath,
        package: dir,
      }),
      env: rawNodeEnv(),
    }),
    dataDirFor: (id) => path.join(scratch, "instances", id),
    closeReason: () => "redeploy",
  });
  red = new FakeRed();
  registration.register(red, ASK);
  registration.register(red, RECORD);
});

afterEach(async () => {
  await Promise.all(live.splice(0).map((node) => node.close(false)));
  journal.close();
  snapshots.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

function create(type: string, config: Message): FakeNode {
  const node = red.create(type, config);
  live.push(node);
  return node;
}

describe("a view instance in the Node-RED glue", () => {
  it("an action view's presentation is raised with its window and counted; a submission continues on its output", async () => {
    const ask = create(ASK, { id: "ask1", z: "t", window: "popout", wires: [["next"], []] });
    const answer = ask.input({ payload: { n: 1 }, topic: "t.v1" });
    await waitFor("present", () => raised.some((event) => event.t === "present"));
    const present = raised.find((event) => event.t === "present");
    expect(present).toMatchObject({
      window: "popout",
      first: true,
      title: "Answer the Python view",
    });
    expect(raised).toContainEqual({ v: 1, t: "pending", count: 1 });

    const id = present?.t === "present" ? present.id : "";
    expect(await views.call("view.get", { id })).toMatchObject({ value: { kind: "view", id } });
    expect(await views.call("view.submit", { id, values: { answer: "Ada" } })).toEqual({
      ok: true,
      value: null,
    });
    await waitFor("done", () => answer.ends.length === 1);
    expect(answer.ends).toEqual([undefined]);
    expect(answer.outputs[0]?.[0]).toMatchObject({ payload: { answer: "Ada" } });
    expect(raised.at(-1)).toEqual({ v: 1, t: "pending", count: 0 });
    expect(await views.call("view.get", { id })).toMatchObject({ value: { kind: "gone" } });
  });

  it("a dismissal ends the step in Node-RED's done(err), which is what fires Catch", async () => {
    const ask = create(ASK, { id: "ask2", z: "t", wires: [["next"], []] });
    const answer = ask.input({ payload: { n: 2 }, topic: "t.v1" });
    await waitFor("present", () => raised.some((event) => event.t === "present"));
    const present = raised.find((event) => event.t === "present");
    const id = present?.t === "present" ? present.id : "";
    await views.call("view.submit", { id, values: { __dismiss__: true } });
    await waitFor("done", () => answer.ends.length === 1);
    expect(answer.ends[0]?.message).toBe("dismissed by the person");
    expect(answer.outputs).toEqual([]);
  });

  it("a snapshot is kept with the type's actions and the instance id; a press starts a new run, or is refused with 409", async () => {
    const rec = create(RECORD, { id: "rec1", z: "t", name: "Rec", wires: [[], ["later"], []] });
    const passed = rec.input({ payload: { n: 5 }, topic: "t.v1", inny: { run: "old-run" } });
    await waitFor("done", () => passed.ends.length === 1);
    expect(snapshotIds).toHaveLength(1);
    const record = snapshotIds[0] as string;
    const got = await views.call("snapshot.get", { id: record });
    expect(got).toMatchObject({
      ok: true,
      value: {
        kind: "snapshot",
        instanceId: "rec1",
        type: RECORD,
        label: "Rec",
        state: { n: 5 },
        actions: [
          { id: "again", enabled: true, reason: null },
          { id: "spare", enabled: false, reason: 'Nothing is wired to the "Spare" output.' },
        ],
      },
    });

    expect(await views.call("snapshot.action", { id: record, action: "again" })).toEqual({
      ok: true,
      value: null,
    });
    await waitFor("the new run", () => rec.sent.length === 1);
    const message = rec.sent[0]?.[1] as { inny: { run: string; event: { id: string } } };
    expect(rec.sent[0]?.[0]).toBeNull();
    expect(message.inny.run).toBe(message.inny.event.id);
    expect(message.inny.run).not.toBe("old-run");

    expect(await views.call("snapshot.action", { id: record, action: "spare" })).toEqual({
      ok: false,
      error: 'Nothing is wired to the "Spare" output.',
      status: 409,
    });
    // Deleted from the flow and deployed: the snapshot stays, its actions are refused.
    live.splice(live.indexOf(rec), 1);
    await rec.close(true);
    expect(await views.call("snapshot.action", { id: record, action: "again" })).toEqual({
      ok: false,
      error: "The view that took this snapshot is no longer in the flow.",
      status: 409,
    });
    expect(rec.sent).toHaveLength(1);
  });
});
