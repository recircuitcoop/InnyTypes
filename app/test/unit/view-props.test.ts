// A widget's input and its unfinished work (spec 8.1.5, 8.1.6, plan 0021 §4, §6, D3).
//
// Props: `content.component.props` is judged at `present`, by the same bounds as an answer
// (domain/views/answers.ts) and then by the type's `props` schema, BEFORE the entry is
// journaled; props refused fail the step. Props that pass are journaled with the content, so
// `get()` hands them back after a restart. Drafts: `draft(values)` through the pop-out bridge
// is judged by the bounds alone, kept with the journal entry, returned by `get()`, survives a
// restart, is cleared on submit and on dismiss, and never reaches the node.
//
// Both run against the raw node through the real node process adapter, as the runtime runs
// it, with the views service judging; a restart is the journal left behind, handed to a new
// process and a new service.

import { afterEach, describe, expect, it } from "vitest";

import { Popouts, type PopoutWindow } from "../../src/adapters/electron/popouts";
import { AjvSchemaValidator } from "../../src/adapters/schema/ajv-validator";
import { ViewService } from "../../src/application/views";
import type { JsonSchema } from "../../src/domain/packages/declaration";
import { MAX_ANSWER_DEPTH, PROPS_REFUSED, REFUSED_DRAFT } from "../../src/domain/views/answers";
import { BRIDGE_CHANNELS } from "../../src/domain/views/popout";
import type { ViewContent } from "../../src/ports/node-process";
import { FakeClock } from "../fakes/clock";
import { MemoryJournal } from "../fakes/journal";
import { MemorySnapshots } from "../fakes/snapshots";
import {
  RecordingDelivery,
  RecordingLogger,
  startRaw,
  waitFor,
  type RawNode,
} from "../fixtures/raw-node/fixture";

/** A reorder widget's input: the items to rank. */
const PROPS: JsonSchema = {
  type: "object",
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: { type: "object", required: ["id", "title"] },
    },
  },
};

const INSTANCE = "ask-props";
const GOOD = {
  items: [
    { id: "a", title: "Write" },
    { id: "b", title: "Ship" },
  ],
};

/** A content drawn by the package's own component, handed `props`. */
const contentWith = (props: unknown): ViewContent => ({
  title: "Rank them",
  component: { element: "kit-reorder", props },
});

/** An object nested `depth` deep (the object itself is depth 1). */
function nested(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = { leaf: true };
  for (let level = 1; level < depth; level += 1) {
    value = { inner: value };
  }
  return value;
}

const started: RawNode[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((raw) => raw.node.close("redeploy")));
});

/** One runtime: a views service over `journal`, and instance INSTANCE judged by it. */
function runtime(journal: MemoryJournal) {
  const logger = new RecordingLogger();
  const service = new ViewService({
    journal,
    snapshots: new MemorySnapshots(),
    clock: new FakeClock(),
    newId: () => "snap-1",
    logger,
    validator: new AjvSchemaValidator(),
    raise: () => undefined,
  });
  /** Every content the props judgement was asked about, in order. */
  const judged: ViewContent[] = [];
  const raw = startRaw({
    id: INSTANCE,
    journal,
    judgeProps: (content) => {
      judged.push(content);
      return service.propsRefusal(INSTANCE, content);
    },
  });
  started.push(raw);
  service.attach(INSTANCE, {
    node: raw.node,
    type: "inny-rawnode-raw",
    package: "rawnode",
    label: "Rank",
    window: "popout",
    ports: ["out"],
    wires: [["next"]],
    actions: [],
    answer: null,
    props: PROPS,
  });
  return { service, raw, logger, judged };
}

/** Present `content` on the raw node; the input's id and its delivery. */
function present(raw: RawNode, content: ViewContent) {
  const delivery = new RecordingDelivery();
  const id = raw.node.input({ payload: { do: "present", content }, topic: "t.v1" }, delivery);
  expect(id).not.toBeNull();
  return { id: id as string, delivery };
}

/** The pop-out bridge of a window opened for view `id`: its draft and get calls. */
async function bridgeFor(service: ViewService, id: string) {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const window = {
    webContents: { id: 1, on: () => undefined, setWindowOpenHandler: () => undefined },
    loadURL: () => Promise.resolve(),
    on: () => undefined,
    getBounds: () => ({ x: 0, y: 0, width: 1, height: 1 }),
    focus: () => undefined,
    close: () => undefined,
    isDestroyed: () => false,
  } as unknown as PopoutWindow;
  const popouts = new Popouts({
    createWindow: () => window,
    ipc: { handle: (channel, handler) => handlers.set(channel, handler as never) },
    preload: "preload.cjs",
    show: false,
    call: (op, args) => service.call(op, args),
    placements: { get: () => null, set: () => undefined },
    openExternal: () => undefined,
    clock: new FakeClock(),
    logger: new RecordingLogger(),
  });
  await popouts.open({ kind: "view", id }, "presented");
  const sender = { sender: { id: 1 } };
  return {
    draft: (values: unknown) =>
      Promise.resolve(handlers.get(BRIDGE_CHANNELS.draft)?.(sender, values)),
    get: () => Promise.resolve(handlers.get(BRIDGE_CHANNELS.get)?.(sender)),
  };
}

/** What view.get answers for `id`. */
async function viewOf(service: ViewService, id: string): Promise<Record<string, unknown>> {
  const got = await service.call("view.get", { id });
  expect(got.ok).toBe(true);
  return (got as { value: Record<string, unknown> }).value;
}

const propsIn = (view: Record<string, unknown>): unknown =>
  ((view["content"] as Record<string, unknown>)["component"] as Record<string, unknown>)["props"];

describe("component props and drafts", () => {
  it("props survive a restart", async () => {
    const journal = new MemoryJournal();
    const first = runtime(journal);

    // ── judged at present: off the schema, the step fails and nothing is presented ──────
    const offSchema = present(first.raw, contentWith({ ranked: [] }));
    await waitFor("the refused step", () => offSchema.delivery.finished);
    expect(offSchema.delivery.ends[0]?.message).toBe(PROPS_REFUSED);
    expect(journal.get(offSchema.id)).toBeNull();
    expect(first.raw.host.presented).toEqual([]);
    expect(first.logger.has(/the props schema refused it \(required at #\/required\)/)).toBe(true);

    // ── and by the same bounds as an answer, before any schema ──────────────────────────
    const deep = { items: [{ id: "a", title: "Write", more: nested(MAX_ANSWER_DEPTH) }] };
    const outOfBounds = present(first.raw, contentWith(deep));
    await waitFor("the second refused step", () => outOfBounds.delivery.finished);
    expect(outOfBounds.delivery.ends[0]?.message).toBe(PROPS_REFUSED);
    expect(journal.get(outOfBounds.id)).toBeNull();
    expect(first.logger.has(/nested deeper than 8/)).toBe(true);
    // The log names the problem, never a value of the props.
    expect(first.logger.lines.some((line) => line.text.includes("Write"))).toBe(false);

    // ── props that pass are journaled with the content and handed back by get() ─────────
    const good = present(first.raw, contentWith(GOOD));
    await waitFor("the presentation", () => first.raw.host.presented.length === 1);
    expect(journal.get(good.id)).toMatchObject({ state: "awaiting" });
    expect(propsIn(await viewOf(first.service, good.id))).toEqual(GOOD);
    expect(first.judged).toHaveLength(3);

    // ── a restart: the journal left behind, a new service and a new process ─────────────
    const left = journal.snapshot();
    const next = runtime(left);
    // Handed back from the journal before the node has said anything again.
    expect(propsIn(await viewOf(next.service, good.id))).toEqual(GOOD);
    const delivery = new RecordingDelivery();
    next.raw.node.replay((message) => {
      next.raw.node.input(message, delivery);
    });
    await waitFor("the re-presentation", () => next.raw.host.presented.length === 1);
    expect(next.raw.host.presented[0]).toMatchObject({ inputId: good.id, first: false });
    // A re-presentation is judged again, and its props are still what get() hands back.
    expect(next.judged).toEqual([contentWith(GOOD)]);
    expect(left.get(good.id)).toMatchObject({ state: "awaiting" });
    expect(propsIn(await viewOf(next.service, good.id))).toEqual(GOOD);
  });

  it("a draft is kept until answered", async () => {
    const journal = new MemoryJournal();
    const first = runtime(journal);
    const asked = present(first.raw, contentWith(GOOD));
    const dismissed = present(first.raw, contentWith(GOOD));
    await waitFor("both presentations", () => first.raw.host.presented.length === 2);
    const popout = await bridgeFor(first.service, asked.id);

    // ── none yet; then a draft through the pop-out bridge, returned by get() ────────────
    expect(await popout.get()).toMatchObject({ ok: true, value: { draft: null } });
    const half = { order: ["b"] };
    expect(await popout.draft(half)).toEqual({ ok: true, value: null });
    expect(await popout.get()).toMatchObject({ ok: true, value: { draft: half } });

    // ── judged by the same bounds: refused, and the draft before it kept ────────────────
    const tooDeep = { order: nested(MAX_ANSWER_DEPTH) };
    expect(await popout.draft(tooDeep)).toEqual({ ok: false, error: REFUSED_DRAFT });
    expect(await popout.draft(JSON.parse('{"__proto__": {"x": 1}}'))).toEqual({
      ok: false,
      error: REFUSED_DRAFT,
    });
    expect(await popout.draft({ big: "x".repeat(70 * 1024) })).toEqual({
      ok: false,
      error: REFUSED_DRAFT,
    });
    // Not the answer's judgement: a draft of any shape within the bounds is kept.
    const nestedDraft = { order: [{ id: "b", notes: [{ by: "Ada" }] }] };
    expect(await popout.draft(nestedDraft)).toEqual({ ok: true, value: null });
    expect((await viewOf(first.service, asked.id))["draft"]).toEqual(nestedDraft);

    // ── it survives a restart ───────────────────────────────────────────────────────────
    const left = journal.snapshot();
    await Promise.all(started.splice(0).map((raw) => raw.node.close("quit")));
    const next = runtime(left);
    expect((await viewOf(next.service, asked.id))["draft"]).toEqual(nestedDraft);
    const replayed = new Map<string, RecordingDelivery>();
    next.raw.node.replay((message) => {
      const delivery = new RecordingDelivery();
      const id = next.raw.node.input(message, delivery);
      replayed.set(id as string, delivery);
    });
    await waitFor("both re-presentations", () => next.raw.host.presented.length === 2);
    expect((await viewOf(next.service, asked.id))["draft"]).toEqual(nestedDraft);

    // ── a draft on the other view, then a dismissal clears it ───────────────────────────
    await next.service.call("view.draft", { id: dismissed.id, values: { order: ["a"] } });
    expect(left.get(dismissed.id)?.draft).toEqual({ order: ["a"] });
    await next.service.call("view.submit", { id: dismissed.id, values: { __dismiss__: true } });
    expect(left.get(dismissed.id)?.draft ?? null).toBeNull();

    // ── a submission clears it, and only what was submitted reaches the node ────────────
    // The type declares no answer schema: the default flat shape (spec 8.5.7).
    const answer = { first: "a", second: "b" };
    expect(await next.service.call("view.submit", { id: asked.id, values: answer })).toEqual({
      ok: true,
      value: null,
    });
    // Cleared at once, before the node has answered.
    expect(left.get(asked.id)).toMatchObject({ state: "sent" });
    expect(left.get(asked.id)?.draft ?? null).toBeNull();
    const delivery = replayed.get(asked.id) as RecordingDelivery;
    await waitFor("the answered step", () => delivery.finished);
    expect(delivery.outputs.map((output) => output.message.payload)).toEqual([answer]);
    expect(await viewOf(next.service, asked.id)).toEqual({ kind: "gone", id: asked.id });
    // And a draft for a view no longer waiting is refused.
    expect(await next.service.call("view.draft", { id: asked.id, values: half })).toEqual({
      ok: false,
      error: "This view is no longer waiting.",
    });
  });
});
