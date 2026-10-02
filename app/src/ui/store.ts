// The renderer's state (plan 0022 §N): one external store per domain read, read by components
// through React's useSyncExternalStore and nothing else; no other state library.
//
// * A store loads on its first subscriber (the initial fetch), and again whenever AppApi pushes
//   that its read changed: `onRuns` for that flow's runs, `onFlows` for the flows and every board
//   (a flow's view nodes may have changed), `onBoard` for that flow's board, `onPackages` for the
//   packages. Setup, the update and the status are pushed whole and set as they come.
// * A snapshot is immutable and replaced whole, so React re-renders exactly when it changes. A
//   load that a newer one overtook is dropped, so an old answer never replaces a newer one.
// * The AppApi's push listeners have no unsubscribe: each is registered once, by createStores.
import { createContext, useContext, useSyncExternalStore } from "react";
import type { Answer, Refusal } from "./answer";
import type { AppApi, PackagesState } from "./contract";
import type { FlowSummary } from "./flow-contract";
import type { BoardLayout, SetupState, StatusView, UpdateView } from "./general-contract";
import type { RunPage } from "./run-contract";

/** What a component reads: loading, the value, or why it could not be read. */
export type Loaded<T> =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly value: T }
  | { readonly status: "refused"; readonly refused: Refusal };

const LOADING = { status: "loading" } as const;

/** When a load rejects (it never should: AppApi answers, it does not throw). */
const FAILED: Refusal = { reason: "failed", sentence: "refused.failed" };

/** One read: its snapshot, its subscribers, and how it loads. */
export class Store<T> {
  readonly #load: () => Promise<Answer<T>>;
  readonly #listeners = new Set<() => void>();
  #snapshot: Loaded<T> = LOADING;
  #loaded = false;
  #generation = 0;

  constructor(load: () => Promise<Answer<T>>) {
    this.#load = load;
  }

  /** useSyncExternalStore's subscribe: the first subscriber starts the initial fetch. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    if (!this.#loaded) {
      this.#loaded = true;
      void this.refresh();
    }
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** useSyncExternalStore's getSnapshot (and getServerSnapshot). */
  readonly getSnapshot = (): Loaded<T> => this.#snapshot;

  /** Load again; an answer a newer load overtook is dropped. */
  async refresh(): Promise<void> {
    const generation = ++this.#generation;
    let answer: Answer<T>;
    try {
      answer = await this.#load();
    } catch {
      answer = { ok: false, refused: FAILED };
    }
    if (generation === this.#generation) {
      this.#publish(
        answer.ok
          ? { status: "ready", value: answer.value }
          : { status: "refused", refused: answer.refused },
      );
    }
  }

  /** A value pushed whole (Setup, the update, the status): it overtakes any load under way. */
  set(value: T): void {
    this.#generation += 1;
    this.#loaded = true;
    this.#publish({ status: "ready", value });
  }

  /** Load again only if someone has read it: an unread store waits for its first subscriber. */
  changed(): void {
    if (this.#loaded) {
      void this.refresh();
    }
  }

  #publish(snapshot: Loaded<T>): void {
    this.#snapshot = snapshot;
    for (const listener of [...this.#listeners]) {
      listener();
    }
  }
}

/** One store per key (a flow's runs, a flow's board), made on first use. */
class Keyed<T> {
  readonly #make: (key: string) => Store<T>;
  readonly #stores = new Map<string, Store<T>>();

  constructor(make: (key: string) => Store<T>) {
    this.#make = make;
  }

  get(key: string): Store<T> {
    let store = this.#stores.get(key);
    if (store === undefined) {
      store = this.#make(key);
      this.#stores.set(key, store);
    }
    return store;
  }

  changed(key: string): void {
    this.#stores.get(key)?.changed();
  }

  changedAll(): void {
    for (const store of this.#stores.values()) {
      store.changed();
    }
  }
}

/** How many runs Live's first page holds. */
export const RUNS_PAGE = 50;

export interface Stores {
  runs(flowId: string): Store<RunPage>;
  readonly flows: Store<readonly FlowSummary[]>;
  board(flowId: string): Store<BoardLayout>;
  readonly updateState: Store<UpdateView>;
  readonly packages: Store<PackagesState>;
  readonly status: Store<StatusView>;
  readonly setup: Store<SetupState>;
}

/** Every store, fed by `api`'s push events from now on. */
export function createStores(api: AppApi): Stores {
  const runs = new Keyed((flowId) => new Store(() => api.runs({ flowId, limit: RUNS_PAGE })));
  const boards = new Keyed((flowId) => new Store(() => api.board(flowId)));
  const flows = new Store(() => api.flows());
  const updateState = new Store(() => api.updateState());
  // The Packages page's read answers its state as it is; it is wrapped as an Answer here.
  const packages = new Store(async (): Promise<Answer<PackagesState>> => ({
    ok: true,
    value: await api.packages(),
  }));
  const status = new Store(() => api.status());
  const setup = new Store(() => api.setup());

  api.onRuns(({ flowId }) => {
    runs.changed(flowId);
  });
  api.onFlows(() => {
    flows.changed();
    boards.changedAll();
  });
  api.onBoard(({ flowId }) => {
    boards.changed(flowId);
  });
  api.onPackages(() => {
    packages.changed();
  });
  api.onUpdateState((view) => {
    updateState.set(view);
  });
  api.onStatus((view) => {
    status.set(view);
  });
  api.onSetup((state) => {
    setup.set(state);
  });
  return {
    runs: (flowId) => runs.get(flowId),
    flows,
    board: (flowId) => boards.get(flowId),
    updateState,
    packages,
    status,
    setup,
  };
}

/** The stores, put in place once at the root (`StoresContext.Provider value={createStores(api)}`). */
export const StoresContext = createContext<Stores | null>(null);

function useStores(): Stores {
  const stores = useContext(StoresContext);
  if (stores === null) {
    throw new Error("the stores are read under StoresContext.Provider only");
  }
  return stores;
}

/** A store's snapshot, kept current. */
export function useStore<T>(store: Store<T>): Loaded<T> {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export const useRuns = (flowId: string) => useStore(useStores().runs(flowId));
export const useFlows = () => useStore(useStores().flows);
export const useBoard = (flowId: string) => useStore(useStores().board(flowId));
export const useUpdateState = () => useStore(useStores().updateState);
export const usePackages = () => useStore(useStores().packages);
export const useStatus = () => useStore(useStores().status);
export const useSetup = () => useStore(useStores().setup);
