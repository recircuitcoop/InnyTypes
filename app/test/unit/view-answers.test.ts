// What a view sends back (spec 8.5.7, plan 0021 §1-3): any JSON object, judged ONCE in the
// runtime (application/views.ts) by the bounds and the type's `answer` schema, or by the
// default shape when the type declares none. Both paths are driven through the shell's own
// adapters into one ViewService: the pop-out bridge (adapters/electron/popouts.ts) and the app
// page's view call (shell/runtime-calls.ts). A node here writes its `action` frame with the
// real codec, so "reaches the node" means the encoded frame.

import { beforeEach, describe, expect, it } from "vitest";

import {
  CLOSE_AFTER_SUBMIT_MS,
  Popouts,
  type PopoutWindow,
} from "../../src/adapters/electron/popouts";
import { encodeFrame } from "../../src/adapters/process/codec";
import { AjvSchemaValidator } from "../../src/adapters/schema/ajv-validator";
import type { Supervisor } from "../../src/application/supervisor";
import { ViewService } from "../../src/application/views";
import { newEntry, presented } from "../../src/domain/journal/entry";
import type { JsonSchema } from "../../src/domain/packages/declaration";
import {
  MAX_ANSWER_DEPTH,
  MAX_ANSWER_KEYS,
  MAX_ANSWER_STRING_BYTES,
  REFUSED_ANSWER,
} from "../../src/domain/views/answers";
import { BRIDGE_CHANNELS } from "../../src/domain/views/popout";
import type { LiveView } from "../../src/ports/views";
import { IPC } from "../../src/shell/ipc";
import { wireRuntimeCalls } from "../../src/shell/runtime-calls";
import { FakeClock } from "../fakes/clock";
import { MemoryJournal } from "../fakes/journal";
import { MemorySnapshots } from "../fakes/snapshots";
import { RecordingLogger } from "../fixtures/raw-node/fixture";

/** A view's node process: what it is asked to send, as the frames the codec encodes. */
class FrameNode {
  readonly pid = 7;
  readonly frames: string[] = [];
  action(inputId: string, values: Readonly<Record<string, unknown>>): boolean {
    this.frames.push(encodeFrame({ t: "action", in: inputId, values }));
    return true;
  }
  trigger(action: string, snapshot: { id: string; state: unknown }, values: object): boolean {
    this.frames.push(encodeFrame({ t: "trigger", action, snapshot, values }));
    return true;
  }
  /** The values each frame carried, decoded. */
  sent(): unknown[] {
    return this.frames.map((line) => (JSON.parse(line) as { values: unknown }).values);
  }
}

/** A reorder widget's answer: a list of ranked items, each with its own nested parts. */
const REORDER: JsonSchema = {
  type: "object",
  required: ["order"],
  additionalProperties: false,
  properties: {
    order: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "rank"],
        properties: { id: { type: "string" }, rank: { type: "integer" } },
      },
    },
  },
};

/** An array of objects, 3 levels deep. */
const NESTED = {
  order: [
    { id: "a", rank: 1, tags: [{ name: "urgent", meta: { by: "Ada" } }] },
    { id: "b", rank: 2, tags: [] },
  ],
};

let journal: MemoryJournal;
let logger: RecordingLogger;
let service: ViewService;
let node: FrameNode;

/** Attach instance `ask` of a view type whose answer schema is `answer` (null: none). */
function attach(answer: JsonSchema | null): void {
  const view: LiveView = {
    node,
    type: "inny-kit-reorder",
    package: "kit",
    label: "Reorder",
    window: "popout",
    ports: ["answered"],
    wires: [["next"]],
    actions: [],
    answer,
    props: null,
  };
  service.attach("ask", view);
}

/** Journal input `inputId` of instance `ask`, awaiting the person. */
function awaiting(inputId: string): void {
  const entry = newEntry({
    inputId,
    instanceId: "ask",
    type: "t",
    message: { payload: 1 },
    now: 0,
  });
  journal.put(presented(entry, { title: "Rank them" }, 0));
}

const stateOf = (id: string) => journal.get(id)?.state;

beforeEach(() => {
  journal = new MemoryJournal();
  logger = new RecordingLogger();
  node = new FrameNode();
  service = new ViewService({
    journal,
    snapshots: new MemorySnapshots(),
    clock: new FakeClock(),
    newId: () => "snap-1",
    logger,
    validator: new AjvSchemaValidator(),
    raise: () => undefined,
  });
});

type Handler = (event: unknown, ...args: unknown[]) => unknown;

/** The pop-out path: a window opened for view `id`, and its bridge's submit. */
async function popoutPath(id: string) {
  const handlers = new Map<string, Handler>();
  let destroyed = false;
  const window = {
    webContents: { id: 1, on: () => undefined, setWindowOpenHandler: () => undefined },
    loadURL: () => Promise.resolve(),
    on: () => undefined,
    getBounds: () => ({ x: 0, y: 0, width: 1, height: 1 }),
    focus: () => undefined,
    close: () => {
      destroyed = true;
    },
    isDestroyed: () => destroyed,
  } as unknown as PopoutWindow;
  const clock = new FakeClock();
  const popouts = new Popouts({
    createWindow: () => window,
    ipc: { handle: (channel, handler) => handlers.set(channel, handler as Handler) },
    preload: "preload.cjs",
    show: false,
    call: (op, args) => service.call(op, args),
    placements: { get: () => null, set: () => undefined },
    openExternal: () => undefined,
    clock,
    logger,
  });
  await popouts.open({ kind: "view", id }, "presented");
  const send = (values: unknown): Promise<unknown> =>
    Promise.resolve(handlers.get(BRIDGE_CHANNELS.submit)?.({ sender: { id: 1 } }, values));
  /** Whether the window is still open once a submitted one would have closed. */
  const open = (): boolean => {
    clock.advance(CLOSE_AFTER_SUBMIT_MS * 2);
    return !destroyed;
  };
  return { send, open };
}

/** The in-app path: the app page's view call, as the shell forwards it to the runtime. */
function inAppPath(id: string) {
  const handlers = new Map<string, Handler>();
  const runtime: Pick<Supervisor, "call"> = { call: (op, args) => service.call(op, args) };
  wireRuntimeCalls({
    ipc: { handle: (channel, handler) => handlers.set(channel, handler as Handler) },
    runtime: runtime as Supervisor,
    editor: {
      palette: () => Promise.resolve(null),
      deploy: () => Promise.resolve(null),
      loaded: () => true,
    },
  });
  return (values: unknown): Promise<unknown> =>
    Promise.resolve(handlers.get(IPC.viewCall)?.({}, { op: "view.submit", args: { id, values } }));
}

const ACCEPTED = { ok: true, value: null };
const REFUSED = { ok: false, error: REFUSED_ANSWER };

/** JSON text with a `__proto__` KEY (an object literal would set the prototype instead). */
const withKey = (key: string): unknown =>
  JSON.parse(`{"a": [{"${key}": {"polluted": true}}]}`) as unknown;

describe("view answers, judged in the runtime", () => {
  it("a structured answer reaches the node unchanged", async () => {
    attach(REORDER);
    awaiting("in-1");
    awaiting("in-2");
    const popout = await popoutPath("in-1");
    const inApp = inAppPath("in-2");
    const reversed = { order: [...NESTED.order].reverse() };

    expect(await popout.send(NESTED)).toEqual(ACCEPTED);
    expect(await inApp(reversed)).toEqual(ACCEPTED);

    // Each reached the node's action frame, deep-equal: nothing flattened, nothing dropped.
    expect(node.frames.map((line) => JSON.parse(line) as unknown)).toStrictEqual([
      { t: "action", in: "in-1", values: NESTED },
      { t: "action", in: "in-2", values: reversed },
    ]);
  });

  it("bounds refuse, the view keeps waiting", async () => {
    // A permissive schema, so only the bounds can refuse.
    attach({ type: "object" });
    // Nine objects, each inside the last: one level deeper than the bound.
    let deep: unknown = "bottom";
    for (let depth = 0; depth <= MAX_ANSWER_DEPTH; depth += 1) {
      deep = { d: deep };
    }
    const keys = Object.fromEntries(
      Array.from({ length: MAX_ANSWER_KEYS + 1 }, (_, i) => [`k${String(i)}`, 0]),
    );
    const over: [string, unknown][] = [
      ["size", { text: "x".repeat(MAX_ANSWER_STRING_BYTES), more: ["y".repeat(60_000)] }],
      ["depth", deep],
      ["keys", keys],
      ["string", { text: "x".repeat(MAX_ANSWER_STRING_BYTES + 1) }],
      // Strings are counted in UTF-8 bytes: 16,385 of them, in 3- and 4-byte characters.
      ["euro, 16,385 bytes", { text: `${"€".repeat(5_461)}xx` }],
      ["emoji across the edge, 16,385 bytes", { text: `a${"😀".repeat(4_096)}` }],
      ["euro, 48 KiB in 16,384 UTF-16 units", { text: "€".repeat(16_384) }],
      ["__proto__ at depth 3", withKey("__proto__")],
      ["constructor", withKey("constructor")],
      ["prototype", withKey("prototype")],
      ["not finite", { n: Number.POSITIVE_INFINITY }],
    ];
    for (const [name, values] of over) {
      awaiting(name);
      expect(await service.call("view.submit", { id: name, values }), name).toEqual(REFUSED);
      expect(stateOf(name), name).toBe("awaiting");
    }
    expect(node.frames).toEqual([]);
    expect(logger.has(/a string is over 16384 bytes in UTF-8/)).toBe(true);

    // Just inside every bound is accepted: depth 8, 1,000 keys, 16 KiB strings in UTF-8.
    let inside: unknown = "bottom";
    for (let depth = 0; depth < MAX_ANSWER_DEPTH; depth += 1) {
      inside = { d: inside };
    }
    const fits = [
      inside,
      Object.fromEntries(Array.from({ length: MAX_ANSWER_KEYS }, (_, i) => [`k${String(i)}`, 0])),
      { text: "x".repeat(MAX_ANSWER_STRING_BYTES) },
      { text: `${"€".repeat(5_461)}x` },
      { text: "😀".repeat(4_096) },
      { text: `a${"😀".repeat(4_095)}€` },
    ];
    for (const [i, values] of fits.entries()) {
      awaiting(`fits-${String(i)}`);
      expect(await service.call("view.submit", { id: `fits-${String(i)}`, values })).toEqual(
        ACCEPTED,
      );
    }
    expect(node.frames).toHaveLength(fits.length);
  });

  it("the schema judges both paths", async () => {
    attach(REORDER);
    awaiting("in-1");
    awaiting("in-2");
    const popout = await popoutPath("in-1");
    const inApp = inAppPath("in-2");
    const wrong = { order: "SECRET-VALUE" };
    const extraKey = { order: [], "SENTINEL-KEY": 1 };

    // Refused with the sentence, on each path; nothing reaches the node; both keep waiting.
    expect(await popout.send(wrong)).toEqual(REFUSED);
    expect(await inApp(wrong)).toEqual(REFUSED);
    expect(await popout.send(extraKey)).toEqual(REFUSED);
    expect(await inApp(extraKey)).toEqual(REFUSED);
    expect(node.frames).toEqual([]);
    expect(stateOf("in-1")).toBe("awaiting");
    expect(stateOf("in-2")).toBe("awaiting");
    // The pop-up stays open.
    expect(popout.open()).toBe(true);

    // The log has the type, the input id and ajv's first keyword and schema path; never a
    // value, and never a key of the answer.
    for (const id of ["in-1", "in-2"]) {
      expect(
        logger.has(
          new RegExp(
            `view ${id} of type inny-kit-reorder: .*\\(type at #/properties/order/type\\)`,
          ),
        ),
      ).toBe(true);
      expect(
        logger.has(
          new RegExp(
            `view ${id} of type inny-kit-reorder: .*\\(additionalProperties at #/additionalProperties\\)`,
          ),
        ),
      ).toBe(true);
    }
    expect(logger.has(/SECRET-VALUE/)).toBe(false);
    expect(logger.has(/SENTINEL-KEY/)).toBe(false);

    // A dismissal stays outside the schema (spec 8.2.2), on either path, and only its marker
    // reaches the node: keys sent beside it are not passed on.
    expect(await inApp({ __dismiss__: true, extra: { smuggled: 1 } })).toEqual(ACCEPTED);
    expect(await popout.send({ __dismiss__: true })).toEqual(ACCEPTED);
    expect(node.sent()).toStrictEqual([{ __dismiss__: true }, { __dismiss__: true }]);
  });

  it("no schema means today's shape", async () => {
    attach(null);
    awaiting("in-1");
    awaiting("in-2");
    const popout = await popoutPath("in-1");
    const inApp = inAppPath("in-2");
    const flat = { name: "Ada", ["k".repeat(64)]: "x".repeat(2_000), count: 3, ok: false };

    // Today's flat answers pass, on both paths, unchanged.
    expect(await popout.send(flat)).toEqual(ACCEPTED);
    expect(await inApp(flat)).toEqual(ACCEPTED);
    expect(node.sent()).toStrictEqual([flat, flat]);

    // Anything else is refused, no longer truncated or dropped.
    const outside: [string, unknown][] = [
      ["long string", { text: "x".repeat(2_001) }],
      ["long key", { ["k".repeat(65)]: "v" }],
      ["nested", NESTED],
      ["null", { value: null }],
      ["a key that must not be logged", { "SENTINEL-KEY": { nested: true } }],
      ["a long string under a key that must not be logged", { "SENTINEL-KEY": "x".repeat(2_001) }],
    ];
    for (const [name, values] of outside) {
      awaiting(name);
      expect(await service.call("view.submit", { id: name, values }), name).toEqual(REFUSED);
      expect(stateOf(name), name).toBe("awaiting");
    }
    expect(node.frames).toHaveLength(2);
    expect(logger.has(/SENTINEL-KEY/)).toBe(false);
  });

  it("objects that are not plain JSON are refused, in the shell on both paths and in the runtime", async () => {
    attach({ type: "object" });
    class Custom {
      readonly n = 1;
    }
    const notPlain: [string, unknown][] = [
      ["Date", { at: new Date(0) }],
      ["Map", { m: new Map([["a", 1]]) }],
      ["Set", { s: new Set([1]) }],
      ["ArrayBuffer", { b: new ArrayBuffer(4) }],
      ["typed array", { list: [new Uint8Array([1, 2])] }],
      ["class instance", { deep: { c: new Custom() } }],
      ["a Date as the answer", new Date(0)],
    ];
    for (const [name, values] of notPlain) {
      awaiting(name);
      // Each shell path refuses it before the hop: no runtime judgement is logged.
      const popout = await popoutPath(name);
      expect(await popout.send(values), name).toEqual(REFUSED);
      expect(await inAppPath(name)(values), name).toEqual(REFUSED);
      expect(logger.has(new RegExp(`view ${name} of type`))).toBe(false);
      // And the runtime refuses it on its own, should it arrive.
      expect(await service.call("view.submit", { id: name, values }), name).toEqual(REFUSED);
      expect(logger.has(new RegExp(`view ${name} of type .*not a plain JSON object`))).toBe(true);
      expect(stateOf(name), name).toBe("awaiting");
    }
    expect(node.frames).toEqual([]);
  });

  it("a snapshot's action press is judged by the same bounds and schema", async () => {
    // A press is never a dismissal (spec 8.2.2): `__dismiss__` beside other keys skips
    // nothing, with an answer schema and without one.
    for (const answer of [REORDER, null]) {
      node = new FrameNode();
      service.attach("rec", {
        node,
        type: "inny-kit-record",
        package: "kit",
        label: "Record",
        window: "popout",
        ports: ["passed", "again"],
        wires: [[], ["next"]],
        actions: [{ id: "again", label: "Again", event: "kit.again.v1" }],
        answer,
        props: null,
      });
      service.snapshot({ instanceId: "rec", content: { title: "t" }, state: null });
      const press = (values: unknown) =>
        service.call("snapshot.action", { id: "snap-1", action: "again", values });
      const name = answer === null ? "no schema" : "schema";

      expect(await press({ order: "no", nested: { a: 1 } }), name).toEqual(REFUSED);
      expect(await press(withKey("__proto__")), name).toEqual(REFUSED);
      expect(await press({ __dismiss__: true, evil: { run: "anything" } }), name).toEqual(REFUSED);
      expect(
        await press(JSON.parse('{"__dismiss__": true, "a": {"__proto__": {"x": 1}}}')),
        name,
      ).toEqual(REFUSED);
      expect(node.frames, name).toEqual([]);

      const fits = answer === null ? { note: "again" } : NESTED;
      expect(await press(fits), name).toEqual(ACCEPTED);
      expect(node.sent(), name).toStrictEqual([fits]);
    }
  });
});
