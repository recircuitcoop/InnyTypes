// A created event type's source in the Node-RED glue (adapters/nodered/registration.ts,
// WI-0018-13), against a recording stand-in for Node-RED and for its process: the instance
// joins the runtime's created sources, so the Events page fires it; a message on its input is
// validated against the payload schema BEFORE the process sees it, and refused with the reason
// (spec 9.6); a valid one goes to the process. Its identity carries its tab, and what it starts
// and reports reaches the runs read model (plan 0022 §C).

import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { JsonEventTypeStore } from "../../src/adapters/fs/event-type-store";
import { TypeRegistration } from "../../src/adapters/nodered/registration";
import { AjvSchemaValidator } from "../../src/adapters/schema/ajv-validator";
import { EventTypeService } from "../../src/application/event-types";
import {
  userEventsDeclaration,
  userEventTypes,
  userNodeType,
} from "../../src/domain/events/event-types";
import { nodeTypeName, type LoadedType } from "../../src/domain/packages/declaration";
import type {
  InputDelivery,
  NodeProcess,
  NodeProcessHost,
  NodeProcessLauncher,
  NodeProcessSpec,
} from "../../src/ports/node-process";
import { FakeClock } from "../fakes/clock";
import { FakeRed } from "../fakes/node-red";

const SCHEMA = {
  type: "object",
  properties: { title: { type: "string" }, minutes: { type: "integer" } },
  required: ["title"],
  additionalProperties: true,
};

let scratch: string;
let events: EventTypeService;
let red: FakeRed;
let fired: unknown[];
let inputs: unknown[];
let started: { spec: NodeProcessSpec; host: NodeProcessHost }[];
let deliveries: InputDelivery[];
let reported: unknown[];
const TYPE = userNodeType("note", 1);

beforeEach(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "inny-created-sources-"));
  fired = [];
  inputs = [];
  started = [];
  deliveries = [];
  reported = [];
  const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const validator = new AjvSchemaValidator();
  const store = new JsonEventTypeStore(path.join(scratch, "event-types.json"));
  events = new EventTypeService({
    store,
    validator,
    deployed: () => Promise.resolve([]),
    clock: new FakeClock(),
    logger,
  });
  await events.call("event.create", { name: "note", label: "Note", schema: SCHEMA });
  const loaded = userEventTypes(userEventsDeclaration(store.list(), ["{node}", "x.cjs"]), scratch);
  const process = {
    pid: 1,
    input: (message: unknown, delivery: InputDelivery) => {
      inputs.push(message);
      deliveries.push(delivery);
      delivery.done();
      return "in-1";
    },
    fire: (data: unknown) => fired.push(data),
    close: () => Promise.resolve(),
  } as unknown as NodeProcess;
  const launcher: NodeProcessLauncher = {
    start: (spec, host) => {
      started.push({ spec, host });
      return process;
    },
  };
  const registration = new TypeRegistration({
    types: new Map<string, LoadedType>(
      loaded.map((l) => [nodeTypeName(l.declaration.package, l.type.id), l]),
    ),
    launcher,
    validator,
    replay: { attach: () => () => undefined },
    views: {} as never,
    sources: events,
    runs: {
      emitted: (fields) => reported.push({ emitted: fields }),
      stepStatus: (inputId, status) => reported.push({ inputId, status }),
    },
    logger,
    commandFor: () => ({ argv: ["node"], cwd: scratch, env: {} }),
    dataDirFor: (id) => path.join(scratch, id),
    closeReason: () => "redeploy",
  });
  red = new FakeRed();
  registration.register(red, TYPE);
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("a created source in the Node-RED glue", () => {
  it("is fired from the Events page while deployed, and no longer once closed", async () => {
    const node = red.create(TYPE, { id: "src1", z: "t", wires: [["next"]] });
    expect(
      await events.call("event.fire", { type: "user.note.v1", values: { title: "T" } }),
    ).toEqual({
      ok: true,
      value: { fired: ["src1"] },
    });
    expect(fired).toEqual([{ title: "T" }]);
    await node.close(false);
    expect(
      await events.call("event.fire", { type: "user.note.v1", values: { title: "T" } }),
    ).toEqual({
      ok: false,
      error: "No deployed source emits user.note.v1.",
    });
  });

  it("refuses an invalid payload on its input with the reason, and passes a valid one on", () => {
    const node = red.create(TYPE, { id: "src1", z: "t", wires: [["next"]] });
    const refused = node.input({ payload: { minutes: "abc" } });
    expect(refused.ends.map((e) => e?.message)).toEqual([
      "Field title is required. Field minutes must be integer.",
    ]);
    expect(inputs).toEqual([]);
    const passed = node.input({ payload: { title: "from a snapshot" } });
    expect(passed.ends).toEqual([undefined]);
    expect(inputs).toEqual([{ payload: { title: "from a snapshot" } }]);
  });

  it("carries its tab as its flow, and tells the runs of a new run and of a step's status", () => {
    red.create(TYPE, { id: "src1", z: "tab9", wires: [["next"]] });
    const { spec, host } = started[0] ?? { spec: null, host: null };
    expect(spec?.identity).toMatchObject({ id: "src1", flowId: "tab9", kind: "source" });
    const inny = { event: {} as never, run: "evt-1" };
    host?.send({ index: 0, port: "out", message: { payload: { title: "T" }, topic: "x", inny } });
    expect(reported).toEqual([
      { emitted: { flowId: "tab9", runId: "evt-1", type: "x", data: { title: "T" } } },
    ]);
    // A status naming the input reaches its step once the process has given the input its id.
    const node = red.create(TYPE, { id: "src2", wires: [["next"]] });
    expect(started[1]?.spec.identity.flowId).toBe("");
    node.input({ payload: { title: "from a snapshot" } });
    deliveries.at(-1)?.status?.({ text: "copying", phase: "copying" });
    expect(reported.at(-1)).toEqual({
      inputId: "in-1",
      status: { text: "copying", phase: "copying" },
    });
  });
});
