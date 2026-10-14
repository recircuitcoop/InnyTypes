// application/run-watch.ts and shell/run-notices.ts (plan 0022 §I): what is news from the run
// records, in which words, with which buttons bound to which run; and the badge from the
// waiting questions, every flow's, hidden places included. Plus the card values the shell
// sends with each run (shell/run-calls.ts cardOf).
import { describe, expect, it } from "vitest";
import {
  FIVE_GOOD_RUNS,
  RunWatch,
  typicalMinutes,
  type RunNews,
} from "../../src/application/run-watch";
import type { OpResult } from "../../src/domain/channel/messages";
import { fold, type Run, type RunEvent } from "../../src/domain/runs/run";
import { cardOf } from "../../src/shell/run-calls";
import {
  noticeHandlers,
  questionActions,
  runNotice,
  wireRunNotices,
} from "../../src/shell/run-notices";
import type { ChildStatus } from "../../src/domain/supervision/child-state";
import { RecordingLogger, RecordingNotifier } from "../fakes/children";

const at = (minute: number) => new Date(2026, 9, 14, 9, minute);
const key = (runId: string, flowId = "f1") => ({ flowId, runId });

/** One run event without its key, kind by kind. */
type Unkeyed<T> = T extends unknown ? Omit<T, "flowId" | "runId"> : never;

/** A run of `flowId`, folded from its events after `started`. */
function run(runId: string, rest: readonly Unkeyed<RunEvent>[], flowId = "f1"): Run {
  const started = { ...key(runId, flowId), at: at(0), kind: "started", title: `call ${runId}` };
  return fold([
    started,
    ...rest.map((event) => ({ ...key(runId, flowId), ...event })),
  ] as RunEvent[]);
}
const step = (name: string, minute = 1) =>
  ({ kind: "stepStarted", instanceId: name, inputId: `in-${name}`, name, at: at(minute) }) as const;
const asked = (name: string) =>
  ({
    kind: "presented",
    instanceId: name,
    inputId: `in-${name}`,
    question: "Who spoke?",
    at: at(2),
  }) as const;
const finished = (minute: number) => ({ kind: "finished", at: at(minute) }) as const;
const done = (name: string, minute: number) =>
  ({ kind: "stepDone", instanceId: name, inputId: `in-${name}`, at: at(minute) }) as const;

const running = (id: string, flowId = "f1") => run(id, [step("Transcribe")], flowId);
const waiting = (id: string, flowId = "f1") =>
  run(id, [step("Speakers"), asked("Speakers")], flowId);
const good = (id: string, minutes = 12) =>
  run(id, [step("Filing"), done("Filing", minutes), finished(minutes)]);
const failed = (id: string) =>
  run(id, [
    step("Transcribe"),
    {
      kind: "stepFailed",
      instanceId: "Transcribe",
      inputId: "in-Transcribe",
      text: "Mistral refused the key",
      at: at(3),
    },
  ]);

/** A runtime whose run.list answers from `runs`, filtered and paged as the store does. */
function watched(flows: Record<string, Run[]>) {
  const news: RunNews[] = [];
  const badges: number[] = [];
  const list = (query: Readonly<Record<string, unknown>>): Promise<OpResult> => {
    const all = flows[query["flowId"] as string] ?? [];
    const state = query["state"];
    const runs = all.filter((each) => state === undefined || each.state === state);
    return Promise.resolve({
      ok: true,
      value: { runs: runs.slice(0, query["limit"] as number), next: null },
    });
  };
  const watch = new RunWatch({
    list,
    flows: () => Promise.resolve({ ok: true, value: Object.keys(flows).map((id) => ({ id })) }),
    news: (one) => news.push(one),
    badge: (count) => badges.push(count),
    logger: new RecordingLogger(),
  });
  return { watch, news, badges };
}

describe("RunWatch", () => {
  it("the first read is a baseline: a restart throws no stack of notifications", async () => {
    const flows = { f1: [running("a"), good("b")] };
    const { watch, news } = watched(flows);
    await watch.refreshAll();
    expect(news).toEqual([]);
  });

  it("tells a start, then its end, then a failure, oldest first; a run moving within a state is no news", async () => {
    const flows: Record<string, Run[]> = { f1: [good("old", 10)] };
    const { watch, news } = watched(flows);
    await watch.changed("f1");
    flows["f1"] = [running("b"), running("a"), good("old", 10)];
    await watch.changed("f1");
    expect(news.map((n) => `${n.kind} ${n.run.runId}`)).toEqual(["started a", "started b"]);
    // The estimate is the flow's good runs' own length.
    expect(news[0]).toMatchObject({ minutes: 10 });
    flows["f1"] = [failed("b"), good("a"), good("old", 10)];
    await watch.changed("f1");
    await watch.changed("f1");
    expect(news.map((n) => `${n.kind} ${n.run.runId}`)).toEqual([
      "started a",
      "started b",
      "done a",
      "failed b",
    ]);
  });

  it("the start notification stops after five good runs; the end notification stays", async () => {
    const goods = Array.from({ length: FIVE_GOOD_RUNS - 1 }, (_, n) => good(`g${String(n)}`));
    const flows: Record<string, Run[]> = { f1: [...goods] };
    const { watch, news } = watched(flows);
    await watch.changed("f1");
    flows["f1"] = [running("fifth"), ...goods];
    await watch.changed("f1");
    expect(news.map((n) => n.kind)).toEqual(["started"]);
    flows["f1"] = [good("fifth"), ...goods];
    await watch.changed("f1");
    flows["f1"] = [running("sixth"), good("fifth"), ...goods];
    await watch.changed("f1");
    flows["f1"] = [good("sixth"), good("fifth"), ...goods];
    await watch.changed("f1");
    // Five good runs: the sixth's start is not told, its end is.
    expect(news.map((n) => `${n.kind} ${n.run.runId}`)).toEqual([
      "started fifth",
      "done fifth",
      "done sixth",
    ]);
  });

  it("the badge counts every waiting question in every flow, and moves only when the count does", async () => {
    const flows: Record<string, Run[]> = {
      f1: [waiting("a"), running("b")],
      f2: [waiting("c", "f2")],
    };
    const { watch, badges } = watched(flows);
    const heard: number[] = [];
    watch.onChange(() => heard.push(watch.pending()));
    expect(watch.pending()).toBe(0);
    await watch.refreshAll();
    expect(watch.pending()).toBe(2);
    flows["f1"] = [waiting("a"), waiting("b")];
    await watch.changed("f1");
    await watch.changed("f1");
    expect(watch.pending()).toBe(3);
    // A flow that is gone waits for nothing.
    delete flows["f2"];
    await watch.refreshAll();
    expect(badges).toEqual([2, 3, 2]);
    expect(heard).toEqual([2, 3, 2]);
  });

  it("a refused read changes nothing; a read that throws is logged", async () => {
    const logger = new RecordingLogger();
    const badges: number[] = [];
    let answer: () => Promise<OpResult> = () => Promise.resolve({ ok: false, error: "restarting" });
    const watch = new RunWatch({
      list: () => answer(),
      flows: () => Promise.resolve({ ok: false, error: "restarting" }),
      news: () => undefined,
      badge: (count) => badges.push(count),
      logger,
    });
    await watch.refreshAll();
    await watch.changed("f1");
    answer = () => Promise.reject(new Error("channel closed"));
    await watch.changed("f1");
    expect(badges).toEqual([]);
    expect(logger.lines).toContain(
      "WARN the runs of flow f1 could not be read: Error: channel closed",
    );
  });

  it("estimates from good runs only, never less than a minute", () => {
    expect(typicalMinutes([running("a")])).toBeNull();
    expect(typicalMinutes([good("a", 4), good("b", 8), failed("c")])).toBe(6);
    expect(typicalMinutes([run("z", [finished(0)])])).toBe(1);
  });
});

describe("the run notices, worded", () => {
  it("start: Processing, with or without an estimate; no button, a click opens Live on its flow", () => {
    expect(runNotice({ kind: "started", run: running("a"), minutes: 12 })).toEqual({
      kind: "run-started",
      subject: "a",
      title: "call a",
      flowId: "f1",
      detail: "Processing call a, about 12 minutes.",
    });
    expect(runNotice({ kind: "started", run: running("a"), minutes: 1 }).detail).toBe(
      "Processing call a, about 1 minute.",
    );
    expect(runNotice({ kind: "started", run: running("a"), minutes: null }).detail).toBe(
      "Processing call a.",
    );
  });

  it("done: Filed with Open in Anytype for an Anytype result, else Done with Open, bound to its run", () => {
    const filed = run("a", [
      step("Filing"),
      {
        kind: "stepDone",
        instanceId: "Filing",
        inputId: "in-Filing",
        at: at(3),
        results: [
          {
            kind: "anytype",
            text: "3 summaries in *Renaissance*",
            anytype: { spaceId: "sp", objectId: "ob" },
          },
        ],
      },
      finished(3),
    ]);
    expect(runNotice({ kind: "done", run: filed })).toMatchObject({
      kind: "run-done",
      detail: "Filed: 3 summaries in Renaissance.",
      actions: [
        {
          label: "Open in Anytype",
          kind: "open-anytype",
          url: "anytype://object?objectId=ob&spaceId=sp",
          flowId: "f1",
          runId: "a",
        },
      ],
    });
    expect(runNotice({ kind: "done", run: good("b") })).toMatchObject({
      detail: "Done: call b.",
      actions: [{ label: "Open", kind: "open-live", flowId: "f1", runId: "b" }],
    });
  });

  it("failed: the run, its step and why, with Open", () => {
    expect(runNotice({ kind: "failed", run: failed("c") })).toMatchObject({
      kind: "run-failed",
      detail: "Couldn't finish call c. Transcribe: Mistral refused the key",
      actions: [{ label: "Open", kind: "open-live", runId: "c" }],
    });
  });

  it("a question: Answer and Later, each bound to the question's own flow, run and view", () => {
    const event = {
      v: 1,
      t: "present",
      id: "v9",
      window: "popout",
      first: true,
      title: "Q",
      flowId: "f1",
      runId: "r9",
    } as const;
    expect(questionActions(event)).toEqual([
      { label: "Answer", kind: "answer", flowId: "f1", runId: "r9", viewId: "v9" },
      { label: "Later", kind: "later", flowId: "f1", runId: "r9", viewId: "v9" },
    ]);
  });

  it("a press runs its own binding only; a click opens Live on the notice's flow", () => {
    const done: string[] = [];
    const handlers = noticeHandlers({
      openView: (id) => done.push(`view ${id}`),
      openLive: (flowId) => done.push(`live ${String(flowId)}`),
      openExternal: (url) => done.push(`open ${url}`),
    });
    const bind = { flowId: "f1", runId: "r1" };
    handlers.onAction({ label: "Answer", kind: "answer", viewId: "v1", ...bind });
    handlers.onAction({ label: "Answer", kind: "answer", viewId: "", ...bind });
    handlers.onAction({ label: "Later", kind: "later", viewId: "v1", ...bind });
    handlers.onAction({ label: "Open", kind: "open-live", ...bind });
    handlers.onAction({ label: "Open", kind: "open-live", flowId: "", runId: "r1" });
    handlers.onAction({
      label: "Open in Anytype",
      kind: "open-anytype",
      url: "anytype://object?objectId=o&spaceId=s",
      ...bind,
    });
    // Only an Anytype object link ever leaves the app.
    handlers.onAction({
      label: "Open in Anytype",
      kind: "open-anytype",
      url: "https://evil.test",
      ...bind,
    });
    handlers.onClick({ title: "T", body: "B", flowId: "f2" });
    handlers.onClick({ title: "T", body: "B" });
    expect(done).toEqual([
      "view v1",
      "live f1",
      "live null",
      "open anytype://object?objectId=o&spaceId=s",
      "live f2",
      "live null",
    ]);
  });

  it("wired: each piece of news is raised once and not kept as a condition; every flow is read on each start", async () => {
    const notifier = new RecordingNotifier();
    let status: ((status: ChildStatus) => void) | null = null;
    const flows: Record<string, Run[]> = { f1: [] };
    const watch = wireRunNotices({
      runtime: {
        call: (op: string, args: unknown) =>
          Promise.resolve(
            op === "flow.list"
              ? { ok: true, value: [{ id: "f1" }] }
              : {
                  ok: true,
                  value: {
                    runs: (flows["f1"] ?? []).filter(
                      (each) =>
                        (args as { state?: string }).state === undefined ||
                        each.state === (args as { state?: string }).state,
                    ),
                    next: null,
                  },
                },
          ),
        onStatus: (listener: (status: ChildStatus) => void) => {
          status = listener;
        },
      } as never,
      notifier,
      badge: () => undefined,
      logger: new RecordingLogger(),
    });
    (status as unknown as (status: ChildStatus) => void)({
      child: "runtime",
      state: "running",
    } as ChildStatus);
    await new Promise((resolve) => setTimeout(resolve, 0));
    flows["f1"] = [waiting("a")];
    await watch.changed("f1");
    expect(notifier.notices.map((n) => `${n.kind} ${n.subject}`)).toEqual(["run-started a"]);
    expect(notifier.cleared).toEqual(["run-started a"]);
    expect(watch.pending()).toBe(1);
  });
});

describe("the card values sent with each run", () => {
  it("a waiting run names its question's view, step and since when; others wait on nothing", () => {
    expect(cardOf(waiting("a"))).toEqual({
      variant: "waiting",
      title: { name: "call a", minutes: null },
      line: { kind: "waiting", question: "Who spoke?" },
      pills: [],
      waiting: { viewId: "in-Speakers", instanceId: "Speakers", step: "Speakers", since: at(1) },
    });
    expect(cardOf(good("b"))).toMatchObject({
      variant: "done",
      pills: [{ kind: "done" }],
      waiting: null,
    });
    expect(cardOf(run("c", [{ kind: "copying", text: "from BOYA…", at: at(1) }]))).toMatchObject({
      variant: "copying",
      line: { kind: "copying", text: "from BOYA…" },
    });
    expect(
      cardOf(
        run("d", [
          { kind: "copying", at: at(1) },
          { kind: "copied", at: at(2) },
        ]),
      ),
    ).toMatchObject({
      variant: "running",
      line: { kind: "safe-to-unplug" },
    });
  });
});
