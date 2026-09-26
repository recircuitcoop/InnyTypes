// A created event type's source in the Node-RED glue (adapters/nodered/registration.ts,
// WI-0018-13), against a recording stand-in for Node-RED and for its process: the instance
// joins the runtime's created sources, so the Events page fires it; a message on its input is
// validated against the payload schema BEFORE the process sees it, and refused with the reason
// (spec 9.6); a valid one goes to the process.

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
import type { NodeProcess, NodeProcessLauncher } from "../../src/ports/node-process";
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
const TYPE = userNodeType("note", 1);

beforeEach(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "inny-created-sources-"));
  fired = [];
  inputs = [];
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
    input: (message: unknown, delivery: { done: (error?: Error) => void }) => {
      inputs.push(message);
      delivery.done();
      return "in-1";
    },
    fire: (data: unknown) => fired.push(data),
    close: () => Promise.resolve(),
  } as unknown as NodeProcess;
  const launcher: NodeProcessLauncher = { start: () => process };
  const registration = new TypeRegistration({
    types: new Map<string, LoadedType>(
      loaded.map((l) => [nodeTypeName(l.declaration.package, l.type.id), l]),
    ),
    launcher,
    validator,
    replay: { attach: () => () => undefined },
    views: {} as never,
    sources: events,
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
});
