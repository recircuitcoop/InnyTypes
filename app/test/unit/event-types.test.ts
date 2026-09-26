// Created event types (spec §9, WI-0018-13) without the app: the rules (domain), the runtime's
// store and service, the shell's restart of the runtime only, the store's immutability, and the
// generic event-source process's answers.

import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { JsonEventTypeStore, writeDeclaration } from "../../src/adapters/fs/event-type-store";
import { AjvSchemaValidator } from "../../src/adapters/schema/ajv-validator";
import { innyPackageOf, refusedTypes } from "../../src/application/deploy-guard";
import { EventTypeChanges, type RuntimeChild } from "../../src/application/event-type-changes";
import { EventTypeService, flowNodesOf, isEventOp } from "../../src/application/event-types";
import type { CallResult } from "../../src/domain/channel/errors";
import type { RestartInfo } from "../../src/domain/channel/messages";
import {
  deletionRefusal,
  judgeCreate,
  judgeVersion,
  payloadProblems,
  payloadRefusal,
  sameSchema,
  SCHEMA_DIALECT,
  usageOf,
  userEventsDeclaration,
  userEventTypes,
  userNodeType,
  type EventTypeRecord,
  type FlowNode,
} from "../../src/domain/events/event-types";
import { answer } from "../../src/runtime/event-source";
import type { EditorNode } from "../../src/ports/editor";
import { FakeClock } from "../fakes/clock";

/** The payload the field editor makes for a meeting note: enums and a nested object. */
const NOTE = {
  $schema: SCHEMA_DIALECT,
  type: "object",
  properties: {
    title: { type: "string" },
    minutes: { type: "integer" },
    kind: { type: "string", enum: ["standup", "review"] },
    where: {
      type: "object",
      properties: { room: { type: "string" }, floor: { type: "integer", enum: [1, 2] } },
      required: ["room"],
      additionalProperties: true,
    },
  },
  required: ["title"],
  additionalProperties: true,
};

const record = (name: string, version: number, schema: object = NOTE): EventTypeRecord => ({
  name,
  version,
  type: `user.${name}.v${String(version)}`,
  label: "Meeting note",
  schema: schema as EventTypeRecord["schema"],
  createdAt: 1,
});

describe("the rules of created event types (spec §9)", () => {
  it("creates user.<name>.v1 from a name, a label and a JSON Schema 2020-12 payload", () => {
    expect(
      judgeCreate([], { name: "meeting_note", label: " Meeting note ", schema: NOTE }, 5),
    ).toEqual({
      ok: true,
      record: {
        name: "meeting_note",
        version: 1,
        type: "user.meeting_note.v1",
        label: "Meeting note",
        schema: NOTE,
        createdAt: 5,
      },
    });
  });

  it("refuses a bad name, no label, a long label, and a duplicate with 409", () => {
    expect(judgeCreate([], { name: "Bad Name!", label: "x", schema: NOTE }, 0)).toMatchObject({
      ok: false,
      error: expect.stringContaining("is invalid: 2 to 40 lower-case letters") as unknown,
    });
    expect(judgeCreate([], { name: "note", label: " ", schema: NOTE }, 0)).toEqual({
      ok: false,
      error: "A label is required.",
    });
    expect(judgeCreate([], { name: "note", label: "x".repeat(51), schema: NOTE }, 0)).toMatchObject(
      {
        ok: false,
      },
    );
    expect(judgeCreate([record("note", 1)], { name: "note", label: "x", schema: NOTE }, 0)).toEqual(
      {
        ok: false,
        status: 409,
        error:
          "An event type named user.note already exists; change its schema to make a new version instead.",
      },
    );
    expect(judgeCreate([], { name: 7, label: "x", schema: NOTE }, 0)).toMatchObject({ ok: false });
  });

  it("judges the payload schema against what the field editor makes", () => {
    expect(payloadProblems(NOTE)).toEqual([]);
    expect(payloadProblems({ type: "object", properties: {}, additionalProperties: true })).toEqual(
      ["At least one payload field is required."],
    );
    expect(payloadProblems("no")).toEqual(["The payload must be an object."]);
    const bad = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      pattern: "x",
      title: 3,
      properties: {
        "Path X": { type: "string" },
        flag: { type: "boolean", enum: [true] },
        list: { type: "array" },
        n: { type: "integer", enum: [1.5] },
        e: { type: "string", enum: [] },
        d: { type: "string", enum: ["a", "a"] },
        t: { type: "string", title: 4, format: "date" },
        o: { type: "object", properties: {}, additionalProperties: true },
        c: { type: "object", properties: { x: { type: "string" } }, additionalProperties: false },
      },
      required: ["missing"],
      additionalProperties: false,
    };
    const problems = payloadProblems(bad);
    for (const expected of [
      '"pattern" is not something the field editor makes',
      "must allow additional properties",
      "its title must be text",
      'Field name "Path X" is invalid',
      "Field flag: only text and number fields",
      "Field list: its type must be one of",
      "Field n: every value in its list must be a integer",
      "Field e: its list of values is empty",
      "Field d: a value is listed twice",
      "Field t: its title must be text",
      'Field t: "format" is not something',
      "Field o has no fields",
      "Field c must allow additional properties",
      '"required" must list its own fields',
      "must be JSON Schema 2020-12",
    ]) {
      expect(problems.join("\n")).toContain(expected);
    }
    const deep = (depth: number): object =>
      depth === 0
        ? { type: "string" }
        : { type: "object", properties: { a: deep(depth - 1) }, additionalProperties: true };
    expect(payloadProblems(deep(5)).join()).toContain("objects nest at most 3 deep");
    expect(payloadProblems(deep(4))).toEqual([]);
    const many = Object.fromEntries(
      Array.from({ length: 41 }, (_, i) => [`f${String(i)}`, { type: "string" }]),
    );
    expect(
      payloadProblems({ type: "object", properties: many, additionalProperties: true }),
    ).toEqual(["The payload has more than 40 fields."]);
    expect(judgeCreate([], { name: "note", label: "x", schema: bad }, 0)).toMatchObject({
      ok: false,
    });
  });

  it("a schema change makes .vN+1 beside the others; an unchanged schema is refused", () => {
    const changed = { ...NOTE, required: ["title", "minutes"] };
    const v2 = judgeVersion([record("note", 1)], { name: "note", schema: changed }, 9);
    expect(v2).toEqual({
      ok: true,
      record: {
        name: "note",
        version: 2,
        type: "user.note.v2",
        label: "Meeting note",
        schema: changed,
        createdAt: 9,
      },
    });
    // Key order and the order of `required` are not a change.
    const reordered = {
      additionalProperties: true,
      required: ["title"],
      properties: NOTE.properties,
      type: "object",
      $schema: SCHEMA_DIALECT,
    };
    expect(sameSchema(reordered, NOTE)).toBe(true);
    expect(
      judgeVersion(
        [record("note", 1), record("note", 2, changed)],
        { name: "note", schema: { ...changed, required: ["minutes", "title"] } },
        0,
      ),
    ).toEqual({
      ok: false,
      status: 409,
      error: "The schema is unchanged from user.note.v2; no new version was made.",
    });
    expect(judgeVersion([], { name: "note", schema: NOTE }, 0)).toEqual({
      ok: false,
      error: "No event type named user.note exists.",
    });
    expect(
      judgeVersion([record("note", 1)], { name: "note", schema: changed, label: "" }, 0),
    ).toEqual({
      ok: false,
      error: "A label is required.",
    });
    expect(judgeVersion([record("note", 1)], { name: "note", schema: {} }, 0)).toMatchObject({
      ok: false,
    });
    expect(
      judgeVersion([record("note", 1)], { name: "note", schema: changed, label: "New" }, 0),
    ).toMatchObject({
      record: { label: "New" },
    });
  });

  it("names every node that uses a version: deployed, and only in the editor", () => {
    const type = userNodeType("note", 1);
    const deployed: FlowNode[] = [
      { id: "src1", type },
      { id: "tab", type: "tab" },
    ];
    const editor: FlowNode[] = [
      { id: "src1", type },
      { id: "draft", type },
      { id: "c", type: "comment" },
    ];
    const usage = usageOf(type, deployed, editor);
    expect(usage).toEqual({ deployed: ["src1"], undeployed: ["draft"] });
    expect(deletionRefusal("user.note.v1", usage)).toBe(
      "Refused: user.note.v1 is used by deployed node(s) src1 and by node(s) draft in the editor, " +
        "not yet deployed; remove them from the flow (and deploy) first.",
    );
    expect(deletionRefusal("user.note.v1", { deployed: [], undeployed: ["draft"] })).toContain(
      "used by node(s) draft in the editor, not yet deployed",
    );
    expect(deletionRefusal("user.note.v1", { deployed: [], undeployed: [] })).toBeNull();
  });

  it("says a payload's problems per field", () => {
    expect(
      payloadRefusal([
        { path: "/title", message: "is required" },
        { path: "/where/room", message: "must be string" },
        { path: "", message: "must be object" },
      ]),
    ).toBe("Field title is required. Field where.room must be string. The payload must be object.");
  });

  it("declares one source per version in the user-events package, with an input", () => {
    const declaration = userEventsDeclaration(
      [record("zeta", 1), record("alpha", 2), record("alpha", 1)],
      ["{node}", "/app/event-source.cjs"],
    );
    expect(declaration.package).toBe("user-events");
    expect(declaration.types.map((t) => t.id)).toEqual(["alpha-v1", "alpha-v2", "zeta-v1"]);
    expect(declaration.types[0]).toMatchObject({
      kind: "source",
      label: "Meeting note v1",
      input: true,
      event: "user.alpha.v1",
      payload: NOTE,
      outputs: [{ port: "event", event: "user.alpha.v1" }],
    });
    const loaded = userEventTypes(declaration, "/data/user-events");
    expect(loaded.map((l) => l.folder)).toEqual([
      "/data/user-events",
      "/data/user-events",
      "/data/user-events",
    ]);
    expect(userNodeType("alpha", 2)).toBe("inny-user-events-alpha-v2");
  });

  it("the deploy guard knows user-events types and refuses a deleted one", () => {
    expect(innyPackageOf("inny-user-events-meeting_note-v1")).toBe("user-events");
    expect(innyPackageOf("inny-viewts-ask")).toBe("viewts");
    const sets = [
      { id: "node-red/x", module: "node-red", types: ["inny-user-events-ab-v1"], enabled: true },
    ];
    const verified = new Set(["user-events"]);
    expect(refusedTypes(["inny-user-events-ab-v1"], sets, verified)).toEqual([]);
    expect(refusedTypes(["inny-user-events-ab-v2"], sets, verified)).toEqual([
      "inny-user-events-ab-v2",
    ]);
  });
});

describe("the event type store", () => {
  let scratch: string;
  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "inny-event-types-"));
  });
  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("keeps versions across a restart and never changes one in place", () => {
    const file = path.join(scratch, "event-types.json");
    const store = new JsonEventTypeStore(file);
    expect(store.problem).toBeNull();
    store.add(record("note", 1));
    expect(() => {
      store.add({ ...record("note", 1), label: "changed" });
    }).toThrow("user.note.v1 is already stored; a version is never changed");
    const stored = store.list()[0] as EventTypeRecord;
    expect(Object.isFrozen(stored) && Object.isFrozen(stored.schema)).toBe(true);
    store.add(record("note", 2));
    const again = new JsonEventTypeStore(file);
    expect(again.list().map((r) => r.type)).toEqual(["user.note.v1", "user.note.v2"]);
    expect(again.list()[0]).toEqual(record("note", 1));
    expect(again.remove("user.note.v1")).toBe(true);
    expect(again.remove("user.note.v1")).toBe(false);
    expect(new JsonEventTypeStore(file).list().map((r) => r.type)).toEqual(["user.note.v2"]);
  });

  it("leaves a file it cannot read as it is, and refuses every change", () => {
    const file = path.join(scratch, "event-types.json");
    fs.writeFileSync(file, "{not json");
    const store = new JsonEventTypeStore(file);
    expect(store.problem).toContain("cannot be read");
    expect(store.list()).toEqual([]);
    expect(() => {
      store.add(record("note", 1));
    }).toThrow("nothing is changed");
    expect(() => store.remove("user.note.v1")).toThrow("nothing is changed");
    expect(fs.readFileSync(file, "utf8")).toBe("{not json");
    fs.writeFileSync(file, JSON.stringify({ format: 1, types: [{ name: 1 }] }));
    expect(new JsonEventTypeStore(file).problem).toContain("not format 1");
    fs.mkdirSync(path.join(scratch, "dir.json"));
    expect(new JsonEventTypeStore(path.join(scratch, "dir.json")).problem).toContain(
      "cannot be read",
    );
  });

  it("writes the user-events declaration into its folder", () => {
    const folder = path.join(scratch, "user-events");
    writeDeclaration(folder, userEventsDeclaration([record("note", 1)], ["{node}", "/x.cjs"]));
    const written = JSON.parse(fs.readFileSync(path.join(folder, "inny-package.json"), "utf8")) as {
      package: string;
      types: { id: string }[];
    };
    expect(written.package).toBe("user-events");
    expect(written.types.map((t) => t.id)).toEqual(["note-v1"]);
  });
});

/** The runtime's service over a real store in a scratch file, with ajv. */
function service(scratch: string, deployed: FlowNode[] = []) {
  const logged: string[] = [];
  const logger = {
    info: (m: string) => logged.push(m),
    warn: (m: string) => logged.push(m),
    error: (m: string) => logged.push(m),
  };
  const store = new JsonEventTypeStore(path.join(scratch, "event-types.json"));
  const events = new EventTypeService({
    store,
    validator: new AjvSchemaValidator(),
    deployed: () => Promise.resolve(deployed),
    clock: new FakeClock(),
    logger,
  });
  return { events, store, logged };
}

describe("the runtime's event type service", () => {
  let scratch: string;
  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "inny-event-service-"));
  });
  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("creates, versions (v1 unchanged), refuses an unchanged schema, and lists with usage", async () => {
    const deployed = [{ id: "src1", type: userNodeType("note", 1) }];
    const { events, store } = service(scratch, deployed);
    expect(
      await events.call("event.create", { name: "note", label: "Note", schema: NOTE }),
    ).toEqual({
      ok: true,
      value: { type: "user.note.v1", added: ["inny-user-events-note-v1"], removed: [] },
    });
    const v1 = structuredClone(store.list()[0]);
    const changed = { ...NOTE, required: ["title", "minutes"] };
    expect(await events.call("event.version", { name: "note", schema: changed })).toMatchObject({
      ok: true,
      value: { type: "user.note.v2", added: ["inny-user-events-note-v2"] },
    });
    expect(
      await events.call("event.version", { name: "note", schema: changed, label: "N2" }),
    ).toEqual({
      ok: false,
      status: 409,
      error: "The schema is unchanged from user.note.v2; no new version was made.",
    });
    expect(store.list()[0]).toEqual(v1);
    const listed = await events.call("event.list", {
      editor: [{ id: "draft", type: userNodeType("note", 2) }],
    });
    expect(listed).toMatchObject({
      ok: true,
      value: [
        { type: "user.note.v1", deployed: ["src1"], undeployed: [] },
        { type: "user.note.v2", deployed: [], undeployed: ["draft"] },
      ],
    });
    expect(
      await events.call("event.create", { name: "note", label: "Note", schema: NOTE }),
    ).toMatchObject({
      status: 409,
    });
    expect(await events.call("event.list", null)).toMatchObject({ ok: true });
  });

  it("refuses to delete a version a deployed node or an undeployed editor node uses; deletes an unused one", async () => {
    const deployed = [{ id: "src1", type: userNodeType("note", 1) }];
    const { events, store } = service(scratch, deployed);
    await events.call("event.create", { name: "note", label: "Note", schema: NOTE });
    await events.call("event.version", { name: "note", schema: { ...NOTE, required: [] } });
    expect(await events.call("event.delete", { type: "user.note.v1", editor: [] })).toMatchObject({
      ok: false,
      status: 409,
      error: expect.stringContaining("deployed node(s) src1") as unknown,
    });
    const draft = [{ id: "draft", type: userNodeType("note", 2) }];
    expect(
      await events.call("event.delete", { type: "user.note.v2", editor: draft }),
    ).toMatchObject({
      ok: false,
      status: 409,
      error: expect.stringContaining("node(s) draft in the editor, not yet deployed") as unknown,
    });
    expect(store.list()).toHaveLength(2);
    expect(await events.call("event.delete", { type: "user.note.v2", editor: [] })).toEqual({
      ok: true,
      value: { type: "user.note.v2", added: [], removed: ["inny-user-events-note-v2"] },
    });
    expect(await events.call("event.delete", { type: "user.none.v1" })).toEqual({
      ok: false,
      error: 'No event type "user.none.v1" exists.',
    });
  });

  it("validates a fire, then fires every deployed source of the version, or the one named", async () => {
    const { events } = service(scratch);
    await events.call("event.create", { name: "note", label: "Note", schema: NOTE });
    const fired: string[] = [];
    const type = userNodeType("note", 1);
    const detach = events.attachSource("s1", type, () => fired.push("s1"));
    events.attachSource("s2", type, () => fired.push("s2"));
    events.attachSource("other", userNodeType("other", 1), () => fired.push("other"));
    expect(
      await events.call("event.fire", { type: "user.note.v1", values: { minutes: "abc" } }),
    ).toEqual({
      ok: false,
      error: "Field title is required. Field minutes must be integer.",
    });
    expect(
      await events.call("event.fire", { type: "user.note.v1", values: { title: "x", where: {} } }),
    ).toEqual({
      ok: false,
      error: "Field where.room is required.",
    });
    expect(fired).toEqual([]);
    const values = { title: "Weekly", minutes: 45, kind: "standup", where: { room: "A" } };
    expect(await events.call("event.fire", { type: "user.note.v1", values })).toEqual({
      ok: true,
      value: { fired: ["s1", "s2"] },
    });
    expect(
      await events.call("event.fire", { type: "user.note.v1", values, instance: "s2" }),
    ).toEqual({
      ok: true,
      value: { fired: ["s2"] },
    });
    detach();
    detach();
    events.attachSource("s2", type, () => fired.push("s2 again"))();
    expect(await events.call("event.fire", { type: "user.note.v1", values })).toEqual({
      ok: false,
      error: "No deployed source emits user.note.v1.",
    });
    expect(await events.call("event.fire", { type: "user.x.v1", values })).toMatchObject({
      ok: false,
    });
    expect(fired).toEqual(["s1", "s2", "s2"]);
  });

  it("knows its ops and reads the editor's nodes defensively", () => {
    expect(isEventOp("event.fire")).toBe(true);
    expect(isEventOp("view.get")).toBe(false);
    expect(flowNodesOf([{ id: "a", type: "t" }, { id: 1 }, null, "x"])).toEqual([
      { id: "a", type: "t" },
    ]);
    expect(flowNodesOf(null)).toEqual([]);
  });
});

/** The shell's use case, against a runtime that records calls and restarts. */
function changes(answerWith: CallResult, editorNodes: EditorNode[] | null = [], running = true) {
  const calls: unknown[][] = [];
  const restarts: [string, RestartInfo][] = [];
  const logged: string[] = [];
  const runtime: RuntimeChild = {
    call: (op, args) => {
      calls.push([op, args]);
      return Promise.resolve(answerWith);
    },
    restart: (reason, info) => {
      restarts.push([reason, info]);
      return running;
    },
  };
  const use = new EventTypeChanges({
    runtime,
    editor: { nodes: () => Promise.resolve(editorNodes) },
    clock: new FakeClock(),
    logger: {
      info: (m) => logged.push(m),
      warn: (m) => logged.push(m),
      error: (m) => logged.push(m),
    },
  });
  return { use, calls, restarts, logged };
}

describe("the shell's event type changes", () => {
  const created = {
    ok: true as const,
    value: { type: "user.a.v1", added: ["inny-user-events-a-v1"], removed: [] },
  };

  it("a create restarts the runtime child only, for types, with what it adds", async () => {
    const { use, calls, restarts, logged } = changes(created);
    expect(await use.call({ op: "event.create", args: { name: "a" } })).toBe(created);
    expect(calls).toEqual([["event.create", { name: "a" }]]);
    expect(restarts).toEqual([
      [
        "types",
        {
          reason: "event type user.a.v1 created",
          added: ["inny-user-events-a-v1"],
          removed: [],
          requestedAt: 0,
        },
      ],
    ]);
    expect(logged.join()).toContain("restarting the runtime only");
  });

  it("a deletion is sent with the editor's nodes, and restarts on success", async () => {
    const deleted = {
      ok: true as const,
      value: { type: "user.a.v1", added: [], removed: ["inny-user-events-a-v1"] },
    };
    const { use, calls, restarts } = changes(deleted, [{ id: "d", type: "x" }]);
    await use.call({ op: "event.delete", args: { type: "user.a.v1" } });
    expect(calls).toEqual([
      ["event.delete", { type: "user.a.v1", editor: [{ id: "d", type: "x" }] }],
    ]);
    expect(restarts[0]?.[1].reason).toBe("event type user.a.v1 deleted");
  });

  it("a refusal, a list or a fire restarts nothing; a list carries the editor's nodes (none without an editor)", async () => {
    const refused = changes({ ok: false, error: "no", status: 409 });
    expect(await refused.use.call({ op: "event.delete", args: { type: "t" } })).toEqual({
      ok: false,
      error: "no",
      status: 409,
    });
    expect(refused.restarts).toEqual([]);
    const listed = changes({ ok: true, value: [] }, null);
    await listed.use.call({ op: "event.list", args: null });
    expect(listed.calls).toEqual([["event.list", { editor: [] }]]);
    const fire = changes({ ok: true, value: { fired: ["s"] } });
    await fire.use.call({ op: "event.fire", args: { type: "t", values: {} } });
    expect(fire.restarts).toEqual([]);
    const odd = changes({ ok: true, value: "not a change" });
    await odd.use.call({ op: "event.version", args: {} });
    expect(odd.restarts).toEqual([]);
  });

  it("refuses a call that is not an event type call, and says when the runtime is not running", async () => {
    const { use, calls } = changes(created);
    expect(await use.call({ op: "view.get", args: {} })).toEqual({
      ok: false,
      error: "view.get is not an event type call",
    });
    expect(await use.call(null)).toMatchObject({ ok: false });
    expect(calls).toEqual([]);
    const down = changes(created, [], false);
    await down.use.call({ op: "event.create", args: {} });
    expect(down.logged.join()).toContain("the runtime is not running");
  });
});

describe("the generic event-source process", () => {
  it("is ready on start, emits a fire as a new run, and turns an input into a new run and done", () => {
    expect(answer({ t: "start", protocol: 2 })).toEqual([{ t: "ready" }]);
    expect(answer({ t: "fire", data: { a: 1 } })).toEqual([
      { t: "emit", port: "event", data: { a: 1 } },
    ]);
    expect(answer({ t: "fire" })).toEqual([{ t: "emit", port: "event", data: {} }]);
    expect(answer({ t: "input", id: "i1", event: { data: { b: 2 } } })).toEqual([
      { t: "emit", port: "event", data: { b: 2 } },
      { t: "done", in: "i1" },
    ]);
    expect(answer({ t: "input", id: "i2" })).toEqual([
      { t: "emit", port: "event", data: {} },
      { t: "done", in: "i2" },
    ]);
    expect(answer({ t: "input" })).toEqual([]);
    expect(answer({ t: "cancel", in: "x" })).toEqual([]);
  });
});
