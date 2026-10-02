// A step's dynamic options (plan 0022 §B, D9; WI-0022-09): the services process lists spaces
// and types with the key it alone holds, kept 30 s and forgotten on pairing; the runtime's one
// resolver asks it over the direct peer channel; the form model draws the select's states.
import { describe, expect, it } from "vitest";
import {
  AnytypeService,
  OPTIONS_CACHE_MS,
  serveAnytypeOptions,
} from "../../src/application/anytype-service";
import { NodeOptions } from "../../src/application/node-options";
import { answerPeerCalls, PeerCaller, receiveKeys } from "../../src/application/peer-link";
import {
  AnytypeServerError,
  AnytypeUnauthorizedError,
  AnytypeUnreachableError,
} from "../../src/domain/anytype/errors";
import type { OpResult } from "../../src/domain/channel/messages";
import { parsePeerMessage } from "../../src/domain/channel/peer-messages";
import { dynamicSelect, formModel, optionsQueryOf } from "../../src/domain/forms/form-model";
import {
  NOT_PAIRED_SENTENCE,
  parseOptionsAnswer,
  parseOptionsQuery,
  READING_SPACES,
  READING_TYPES,
  refusal,
} from "../../src/domain/forms/node-options";
import { DEFAULT_BACKOFF } from "../../src/domain/supervision/backoff";
import { MCP_STABILITY } from "../../src/domain/supervision/staleness";
import type { PeerLink } from "../../src/ports/shell-link";
import { RecordingLogger, RecordingNotifier } from "../fakes/children";
import { FakeClock } from "../fakes/clock";
import { FakeAnytypeApi, FakeMcpLauncher, flush, MemorySecretStore } from "../fakes/anytype";

const KEY = "options-key-0123456789";
const SPACES = [
  { id: "sp1", name: "Work" },
  { id: "sp2", name: "" },
];
const TYPES = [
  { key: "page", name: "Page" },
  { key: "meeting", name: "Meeting" },
];

/** The services process's Anytype service, never started: the options need no MCP child. */
function services(key: string | null = KEY) {
  const clock = new FakeClock();
  const logger = new RecordingLogger();
  const secrets = new MemorySecretStore();
  if (key !== null) {
    secrets.write("anytype-api-key", key);
  }
  const api = new FakeAnytypeApi();
  api.spaces = SPACES;
  api.types.set("sp1", TYPES);
  const subject = new AnytypeService({
    settings: {
      apiBaseUrl: "http://127.0.0.1:31009",
      backoff: DEFAULT_BACKOFF,
      crashLoop: { maxCrashes: 5, windowMs: 120_000 },
      profile: MCP_STABILITY,
      keyLocation: "the key file",
      healthRetryMs: 10_000,
    },
    secrets,
    api,
    launcher: new FakeMcpLauncher(),
    publishKey: () => undefined,
    childLine: () => undefined,
    command: "node cli.mjs",
    clock,
    logger,
    notifier: new RecordingNotifier(),
  });
  return { subject, clock, logger, secrets, api };
}

/** Two ends of a direct channel in memory, each with any number of listeners. */
function channel(): [PeerLink & { sent: unknown[] }, PeerLink & { sent: unknown[] }] {
  const make = () => {
    const listeners: ((raw: unknown) => void)[] = [];
    const end = {
      sent: [] as unknown[],
      other: null as { listeners: ((raw: unknown) => void)[] } | null,
      listeners,
      post(message: unknown) {
        end.sent.push(message);
        // A structured clone: what crosses is a copy, never the sender's object.
        const copy = structuredClone(message);
        queueMicrotask(() => {
          for (const listener of end.other?.listeners ?? []) {
            listener(copy);
          }
        });
      },
      onMessage(listener: (raw: unknown) => void) {
        listeners.push(listener);
      },
      close() {
        end.other = null;
      },
    };
    return end;
  };
  const [a, b] = [make(), make()];
  a.other = b;
  b.other = a;
  return [a, b];
}

describe("the options a form asks for, and their answers", () => {
  it("reads a query from the page and from the route's search parameters, and refuses others", () => {
    expect(parseOptionsQuery({ source: "spaces" })).toEqual({ source: "spaces" });
    expect(parseOptionsQuery({ source: "types", spaceId: "sp1" })).toEqual({
      source: "types",
      spaceId: "sp1",
    });
    expect(parseOptionsQuery({ source: "types", space: "sp1" })).toEqual({
      source: "types",
      spaceId: "sp1",
    });
    for (const bad of [null, [], {}, { source: "types" }, { source: "types", space: "" }]) {
      expect(parseOptionsQuery(bad)).toBeNull();
    }
  });

  it("reads an answer, a refusal by its reason with its own sentence, and nothing else", () => {
    const options = { options: [{ value: "sp1", label: "Work" }] };
    expect(parseOptionsAnswer(options)).toEqual(options);
    expect(parseOptionsAnswer({ refused: { reason: "not-paired", sentence: "anything" } })).toEqual(
      refusal("not-paired"),
    );
    expect(refusal("not-paired").refused.sentence).toBe(NOT_PAIRED_SENTENCE);
    for (const bad of [null, { options: [{ value: 1 }] }, { refused: { reason: "other" } }, {}]) {
      expect(parseOptionsAnswer(bad)).toBeNull();
    }
  });
});

describe("the services process's spaces and types", () => {
  it("lists ids and names with the key, and never puts the key in an answer", async () => {
    const { subject, api } = services();
    const spaces = await serveAnytypeOptions(subject, "anytype.spaces", {});
    const types = await serveAnytypeOptions(subject, "anytype.types", { spaceId: "sp1" });
    expect(spaces).toEqual({ ok: true, value: SPACES });
    expect(types).toEqual({ ok: true, value: TYPES });
    expect(api.listed).toEqual([`spaces ${KEY}`, `types sp1 ${KEY}`]);
    expect(JSON.stringify([spaces, types])).not.toContain(KEY);
  });

  it("refuses when not paired, with the sentence to show, and asks Anytype nothing", async () => {
    const { subject, api } = services(null);
    expect(await serveAnytypeOptions(subject, "anytype.spaces", {})).toEqual({
      ok: true,
      value: { refused: { reason: "not-paired", sentence: NOT_PAIRED_SENTENCE } },
    });
    expect(await subject.types("sp1")).toEqual(refusal("not-paired"));
    expect(api.listed).toEqual([]);
  });

  it("refuses a types call with no space as a call that could not be made", async () => {
    const { subject } = services();
    expect(await serveAnytypeOptions(subject, "anytype.types", {})).toEqual({
      ok: false,
      error: "anytype.types needs the id of a space",
    });
  });

  it("keeps each list 30 s, per space, and reads again after", async () => {
    const { subject, api, clock } = services();
    api.types.set("sp2", [{ key: "task", name: "Task" }]);
    await subject.spaces();
    await subject.types("sp1");
    await subject.types("sp2");
    clock.advance(OPTIONS_CACHE_MS - 1);
    await subject.spaces();
    await subject.types("sp1");
    expect(api.listed).toHaveLength(3);
    clock.advance(1);
    await subject.spaces();
    expect(api.listed).toHaveLength(4);
  });

  it("forgets every list when a new pairing lands", async () => {
    const { subject, api, secrets } = services();
    await subject.spaces();
    await subject.startPairing();
    await subject.completePairing("1234");
    expect(secrets.read("anytype-api-key")).toBe(api.issuedKey);
    await subject.spaces();
    expect(api.listed).toEqual([`spaces ${KEY}`, `spaces ${api.issuedKey}`]);
    await subject.stop();
  });

  it("says a key Anytype refuses is not paired, and an absent Anytype unreachable, keeping neither", async () => {
    const { subject, api, logger } = services();
    api.spaces = new AnytypeUnauthorizedError("GET", "http://127.0.0.1:31009/v1/spaces", 401);
    expect(await subject.spaces()).toEqual(refusal("not-paired"));
    api.spaces = new AnytypeUnreachableError("http://127.0.0.1:31009");
    expect(await subject.spaces()).toEqual(refusal("unreachable"));
    api.typesError = new AnytypeServerError("GET", "http://127.0.0.1:31009/v1/spaces/x", 503);
    expect(await subject.types("sp1")).toEqual(refusal("unavailable"));
    // A refusal is not kept: the next ask reads again, and gets the list.
    api.spaces = SPACES;
    expect(await subject.spaces()).toEqual(SPACES);
    expect(logger.lines.filter((line) => line.startsWith("WARN"))).toHaveLength(3);
    expect(logger.lines.join("\n")).not.toContain(KEY);
  });
});

describe("the direct channel's calls", () => {
  it("parses a call and its answer, and refuses an op the channel does not carry", () => {
    expect(parsePeerMessage({ v: 1, t: "call", id: "1", op: "anytype.spaces", args: {} })).toEqual({
      v: 1,
      t: "call",
      id: "1",
      op: "anytype.spaces",
      args: {},
    });
    expect(
      parsePeerMessage({ v: 1, t: "answer", id: "1", result: { ok: true, value: [] } }),
    ).toEqual({ v: 1, t: "answer", id: "1", result: { ok: true, value: [] } });
    expect(parsePeerMessage({ v: 1, t: "call", id: "1", op: "anytype.status" })).toBeNull();
    expect(parsePeerMessage({ v: 1, t: "answer", id: "1", result: { ok: "yes" } })).toBeNull();
    expect(parsePeerMessage({ v: 1, t: "call", op: "anytype.spaces" })).toBeNull();
  });

  it("carries a call from the runtime to the services process and its answer back", async () => {
    const [runtimeEnd, servicesEnd] = channel();
    const { subject } = services();
    answerPeerCalls(
      servicesEnd,
      (op, args) => serveAnytypeOptions(subject, op, args),
      new RecordingLogger(),
    );
    const caller = new PeerCaller({ clock: new FakeClock(), timeoutMs: 30_000 });
    const logger = new RecordingLogger();
    // The key listener shares the end and stays quiet about answers it is not for.
    receiveKeys(runtimeEnd, { protect: () => undefined }, logger);
    caller.connect(runtimeEnd);
    expect(await caller.call("anytype.types", { spaceId: "sp1" })).toEqual({
      ok: true,
      value: TYPES,
    });
    expect(logger.lines).toEqual([]);
  });

  it("answers a call itself before any end, after its end is replaced, and once it waited too long", async () => {
    const clock = new FakeClock();
    const caller = new PeerCaller({ clock, timeoutMs: 30_000 });
    expect(await caller.call("anytype.spaces", {})).toMatchObject({ ok: false });

    const [silent] = channel();
    caller.connect(silent);
    const waiting = caller.call("anytype.spaces", {});
    caller.connect(channel()[0]);
    expect(await waiting).toEqual({
      ok: false,
      error: "the services process was linked again; ask again",
    });

    const late = caller.call("anytype.spaces", {});
    clock.advance(30_000);
    expect(await late).toEqual({
      ok: false,
      error: "the services process did not answer anytype.spaces within 30 s",
    });
  });

  it("turns a services failure into a failed answer rather than silence", async () => {
    const [runtimeEnd, servicesEnd] = channel();
    answerPeerCalls(servicesEnd, () => Promise.reject(new Error("broke")), new RecordingLogger());
    const caller = new PeerCaller({ clock: new FakeClock(), timeoutMs: 30_000 });
    caller.connect(runtimeEnd);
    expect(await caller.call("anytype.spaces", {})).toEqual({ ok: false, error: "broke" });
  });
});

describe("the runtime's resolver", () => {
  const resolverOver = (result: OpResult) => {
    const asked: unknown[] = [];
    const logger = new RecordingLogger();
    const resolver = new NodeOptions({
      ask: (op, args) => {
        asked.push([op, args]);
        return Promise.resolve(result);
      },
      logger,
    });
    return { resolver, asked, logger };
  };

  it("turns spaces into id options and types into key options, named, or by their value when unnamed", async () => {
    const spaces = resolverOver({ ok: true, value: SPACES });
    expect(await spaces.resolver.resolve({ source: "spaces" })).toEqual({
      options: [
        { value: "sp1", label: "Work" },
        { value: "sp2", label: "sp2" },
      ],
    });
    const types = resolverOver({ ok: true, value: TYPES });
    expect(await types.resolver.call({ source: "types", spaceId: "sp1" })).toEqual({
      ok: true,
      value: {
        options: [
          { value: "page", label: "Page" },
          { value: "meeting", label: "Meeting" },
        ],
      },
    });
    expect([...spaces.asked, ...types.asked]).toEqual([
      ["anytype.spaces", {}],
      ["anytype.types", { spaceId: "sp1" }],
    ]);
  });

  it("passes a refusal through, and makes every other failure 'unavailable', logged", async () => {
    const refused = resolverOver({ ok: true, value: refusal("not-paired") });
    expect(await refused.resolver.resolve({ source: "spaces" })).toEqual(refusal("not-paired"));
    for (const result of [
      { ok: false, error: "the services process is not linked to the runtime yet" },
      { ok: true, value: { something: "else" } },
      { ok: true, value: [{ name: "no id" }] },
    ] as const) {
      const failing = resolverOver(result);
      expect(await failing.resolver.resolve({ source: "spaces" })).toEqual(refusal("unavailable"));
      expect(failing.logger.lines).toHaveLength(1);
    }
  });

  it("refuses a malformed shell call without asking anything", async () => {
    const { resolver, asked } = resolverOver({ ok: true, value: [] });
    expect(await resolver.call({ source: "types" })).toMatchObject({ ok: false });
    expect(asked).toEqual([]);
  });
});

describe("a dynamic select in a form", () => {
  const [space, type] = formModel({
    type: "object",
    properties: {
      space: { type: "string", innytype: { spaces: true } },
      type: { type: "string", innytype: { types: { of: "space" } } },
    },
  }).fields as [Parameters<typeof dynamicSelect>[0], Parameters<typeof dynamicSelect>[0]];
  const answered = (options: { value: string; label: string }[]) =>
    ({ kind: "answered", answer: { options } }) as const;

  it("asks for the spaces, and for the types of the sibling's space only once one is chosen", () => {
    expect(optionsQueryOf(space, {})).toEqual({ source: "spaces" });
    expect(optionsQueryOf(type, { space: "sp1" })).toEqual({ source: "types", spaceId: "sp1" });
    expect(optionsQueryOf(type, { space: "" })).toBeNull();
    expect(optionsQueryOf(type, {})).toBeNull();
  });

  it("says it is reading, disabled, with the stored value still shown", () => {
    expect(dynamicSelect(space, "sp1", { kind: "loading" })).toEqual({
      options: [
        { value: "", label: "" },
        { value: "sp1", label: "sp1" },
      ],
      value: "sp1",
      disabled: true,
      sentence: READING_SPACES,
    });
    expect(dynamicSelect(type, "", { kind: "loading" }).sentence).toBe(READING_TYPES);
  });

  it("shows the names, storing the plain id, and keeps a stored value the list lacks", () => {
    const listed = [{ value: "sp1", label: "Work" }];
    expect(dynamicSelect(space, "sp1", answered(listed))).toEqual({
      options: [{ value: "", label: "" }, ...listed],
      value: "sp1",
      disabled: false,
      sentence: null,
    });
    expect(dynamicSelect(space, "gone", answered(listed)).options).toContainEqual({
      value: "gone",
      label: "gone",
    });
  });

  it("clears a type the newly chosen space lacks, and keeps one it has", () => {
    const listed = [{ value: "page", label: "Page" }];
    expect(dynamicSelect(type, "meeting", answered(listed), false)).toMatchObject({
      value: "",
      options: [{ value: "", label: "" }, ...listed],
    });
    expect(dynamicSelect(type, "page", answered(listed), false).value).toBe("page");
  });

  it("is empty and disabled with no space chosen", () => {
    expect(dynamicSelect(type, "page", { kind: "waiting" })).toEqual({
      options: [{ value: "", label: "" }],
      value: "",
      disabled: true,
      sentence: null,
    });
  });

  it("shows the not-paired sentence in place of the options, and keeps the stored value", () => {
    const state = { kind: "answered", answer: refusal("not-paired") } as const;
    expect(dynamicSelect(space, "sp1", state)).toEqual({
      options: [
        { value: "", label: "" },
        { value: "sp1", label: "sp1" },
      ],
      value: "sp1",
      disabled: true,
      sentence: NOT_PAIRED_SENTENCE,
    });
  });
});

// The services process answers a call made while the runtime's end is replaced only on the
// end it came in on; the runtime has already answered it. Nothing waits on a dead end.
it("an answer for a call already settled changes nothing", async () => {
  const [runtimeEnd, servicesEnd] = channel();
  let release: () => void = () => undefined;
  answerPeerCalls(
    servicesEnd,
    () =>
      new Promise<OpResult>((resolve) => {
        release = () => {
          resolve({ ok: true, value: [] });
        };
      }),
    new RecordingLogger(),
  );
  const clock = new FakeClock();
  const caller = new PeerCaller({ clock, timeoutMs: 1_000 });
  caller.connect(runtimeEnd);
  const call = caller.call("anytype.spaces", {});
  await flush();
  clock.advance(1_000);
  expect(await call).toMatchObject({ ok: false });
  release();
  await flush();
  expect(servicesEnd.sent).toHaveLength(1);
});
