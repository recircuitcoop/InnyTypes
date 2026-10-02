// ui/store.ts (plan 0022 §N): one external store per domain read, fed by AppApi's push events,
// read through useSyncExternalStore. Tested on the subscribe/getSnapshot contract React relies
// on, with a fake AppApi, and once through React itself (react-dom/server, no DOM).
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Answer } from "../../src/ui/answer";
import type { AppApi } from "../../src/ui/contract";
import {
  createStores,
  RUNS_PAGE,
  Store,
  StoresContext,
  useBoard,
  useFlows,
  usePackages,
  useRuns,
  useSetup,
  useStatus,
  useUpdateState,
  type Loaded,
} from "../../src/ui/store";
import { V2_UNUSED } from "../fakes/app-api-v2";

/** Lets every pending promise settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeApi() {
  const listeners = new Map<string, (value: never) => void>();
  const asked: unknown[][] = [];
  let version = 0;
  const answer = <T>(name: string, ...args: unknown[]): Promise<Answer<T>> => {
    asked.push([name, ...args]);
    version += 1;
    return Promise.resolve({ ok: true, value: { name, args, version } as T });
  };
  const on = (name: string) => (listener: (value: never) => void) => {
    listeners.set(name, listener);
  };
  const api = {
    ...V2_UNUSED,
    runs: (query: unknown) => answer("runs", query),
    flows: () => answer("flows"),
    board: (flowId: string) => answer("board", flowId),
    updateState: () => answer("updateState"),
    status: () => answer("status"),
    setup: () => answer("setup"),
    packages: () => {
      asked.push(["packages"]);
      return Promise.resolve({ packages: [] } as never);
    },
    onRuns: on("runs"),
    onFlows: on("flows"),
    onBoard: on("board"),
    onPackages: on("packages"),
    onUpdateState: on("updateState"),
    onStatus: on("status"),
    onSetup: on("setup"),
  } as unknown as AppApi;
  const emit = (name: string, value?: unknown) => {
    listeners.get(name)?.(value as never);
  };
  return { api, asked, emit };
}

describe("a store", () => {
  it("loads on its first subscriber, tells every subscriber, and stops telling one that left", async () => {
    let answers = 0;
    const store = new Store<number>(() => Promise.resolve({ ok: true, value: ++answers }));
    expect(store.getSnapshot()).toEqual({ status: "loading" });
    const told: string[] = [];
    const leave = store.subscribe(() => told.push("first"));
    store.subscribe(() => told.push("second"));
    await settle();
    expect(store.getSnapshot()).toEqual({ status: "ready", value: 1 });
    expect(told).toEqual(["first", "second"]);
    leave();
    await store.refresh();
    expect(told).toEqual(["first", "second", "second"]);
    expect(answers).toBe(2);
  });

  it("keeps the same snapshot until it changes, as useSyncExternalStore needs", async () => {
    const store = new Store<string>(() => Promise.resolve({ ok: true, value: "x" }));
    store.subscribe(() => undefined);
    await settle();
    expect(store.getSnapshot()).toBe(store.getSnapshot());
  });

  it("drops an answer a newer load overtook, and one a pushed value overtook", async () => {
    const resolvers: ((answer: Answer<string>) => void)[] = [];
    const store = new Store<string>(
      () => new Promise<Answer<string>>((resolve) => resolvers.push(resolve)),
    );
    const first = store.refresh();
    const second = store.refresh();
    resolvers[1]?.({ ok: true, value: "new" });
    resolvers[0]?.({ ok: true, value: "old" });
    await Promise.all([first, second]);
    expect(store.getSnapshot()).toEqual({ status: "ready", value: "new" });
    const third = store.refresh();
    store.set("pushed");
    resolvers[2]?.({ ok: true, value: "stale" });
    await third;
    expect(store.getSnapshot()).toEqual({ status: "ready", value: "pushed" });
  });

  it("shows a refusal, and a load that throws as a failure", async () => {
    const refused = new Store<string>(() =>
      Promise.resolve({ ok: false, refused: { reason: "down", sentence: "refused.down" } }),
    );
    await refused.refresh();
    expect(refused.getSnapshot()).toEqual({
      status: "refused",
      refused: { reason: "down", sentence: "refused.down" },
    });
    const throwing = new Store<string>(() => Promise.reject(new Error("boom")));
    await throwing.refresh();
    expect(throwing.getSnapshot()).toEqual({
      status: "refused",
      refused: { reason: "failed", sentence: "refused.failed" },
    });
  });

  it("loads again on a change only once someone has read it", async () => {
    let loads = 0;
    const store = new Store<number>(() => Promise.resolve({ ok: true, value: ++loads }));
    store.changed();
    await settle();
    expect(loads).toBe(0);
    store.subscribe(() => undefined);
    store.changed();
    await settle();
    expect(loads).toBe(2);
  });
});

describe("the stores, fed by AppApi's push events", () => {
  it("keeps one store per flow's runs and board, each asked again on its own push", async () => {
    const { api, asked, emit } = fakeApi();
    const stores = createStores(api);
    expect(stores.runs("a")).toBe(stores.runs("a"));
    stores.runs("a").subscribe(() => undefined);
    stores.runs("b").subscribe(() => undefined);
    stores.board("a").subscribe(() => undefined);
    await settle();
    asked.length = 0;
    emit("runs", { flowId: "a" });
    emit("runs", { flowId: "never-read" });
    emit("board", { flowId: "a" });
    await settle();
    expect(asked).toEqual([
      ["runs", { flowId: "a", limit: RUNS_PAGE }],
      ["board", "a"],
    ]);
  });

  it("asks the flows and every board read so far again when the flows change", async () => {
    const { api, asked, emit } = fakeApi();
    const stores = createStores(api);
    stores.flows.subscribe(() => undefined);
    stores.board("a").subscribe(() => undefined);
    stores.board("b").subscribe(() => undefined);
    await settle();
    asked.length = 0;
    emit("flows");
    emit("packages");
    await settle();
    expect(asked).toEqual([["flows"], ["board", "a"], ["board", "b"]]);
    stores.packages.subscribe(() => undefined);
    await settle();
    expect(stores.packages.getSnapshot()).toEqual({ status: "ready", value: { packages: [] } });
  });

  it("sets Setup, the update and the status as they are pushed", () => {
    const { api, asked, emit } = fakeApi();
    const stores = createStores(api);
    emit("setup", { step: "reports" });
    emit("updateState", { state: { kind: "checking" }, goBack: null });
    emit("status", { pill: "running", banner: null, badge: 1 });
    expect(stores.setup.getSnapshot()).toEqual({ status: "ready", value: { step: "reports" } });
    expect(stores.updateState.getSnapshot()).toMatchObject({
      value: { state: { kind: "checking" } },
    });
    expect(stores.status.getSnapshot()).toMatchObject({ value: { badge: 1 } });
    // A pushed store needs no first fetch.
    stores.status.subscribe(() => undefined);
    expect(asked).toEqual([]);
  });
});

describe("the hooks, through React", () => {
  it("read each store's snapshot under the provider, and refuse outside it", async () => {
    const { api } = fakeApi();
    const stores = createStores(api);
    for (const store of [
      stores.runs("a"),
      stores.flows,
      stores.board("a"),
      stores.updateState,
      stores.packages,
      stores.status,
      stores.setup,
    ]) {
      store.subscribe(() => undefined);
    }
    await settle();
    const statuses: string[] = [];
    function Probe() {
      const all: Loaded<unknown>[] = [
        useRuns("a"),
        useFlows(),
        useBoard("a"),
        useUpdateState(),
        usePackages(),
        useStatus(),
        useSetup(),
      ];
      statuses.push(...all.map((loaded) => loaded.status));
      return null;
    }
    renderToString(createElement(StoresContext.Provider, { value: stores }, createElement(Probe)));
    expect(statuses).toEqual(Array(7).fill("ready"));
    expect(() => renderToString(createElement(Probe))).toThrow(/StoresContext/);
  });
});
