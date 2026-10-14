// Pop-out windows for views and snapshots (spec 8.5; arch_pivot P10, spike shell/popouts.js).
//
// Each pop-out runs sandboxed: the exact webPreferences of spec 8.5.4, in the `inny-views`
// partition, on a page the shell serves (adapters/electron/schemes.ts) under a strict CSP. No
// navigation, no new windows. Its only way out is the five-call bridge, and the bridge takes
// no ids: this file binds each window, by its webContents, to the one view or snapshot it was
// opened for, so a page can read and answer its own and nothing else. What a page sends is
// passed on as it is, and judged by the runtime (spec 8.5.7); only its size and that it is
// plain JSON are checked here, so an oversized or non-JSON answer never makes the hop.
//
// Several may be open at once, one per target; a second open focuses the first. Closing one
// without submitting leaves the view pending (spec 8.2.3). Its placement is remembered per
// view type, and a type's next pop-out opens there.
//
// A preview (Preview a view…, development builds only, plan 0021 D4) is a pop-out like a
// view's, in the same sandbox, with no runtime behind it: its page gets the view it was opened
// with, a draft is accepted and kept nowhere, and its answer is logged, never sent.

import type { CallOp } from "../../domain/channel/messages";
import {
  BRIDGE_CHANNELS,
  componentPackageOf,
  DEFAULT_SIZE,
  isAnytypeLink,
  placementKey,
  popoutKey,
  VIEW_PARTITION,
  viewPageUrl,
  viewWebPreferences,
  type Bounds,
  type PopoutTarget,
} from "../../domain/views/popout";
import { refusedBeforeHop, REFUSED_ANSWER, REFUSED_DRAFT } from "../../domain/views/answers";
import type { Clock } from "../../ports/clock";
import type { Logger } from "../../ports/logger";
import type { PlacementStore } from "../../ports/placement-store";

/** A call's answer: the runtime's OpResult, or the channel's typed error. */
export type Answer =
  { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string };

/** The part of a BrowserWindow the pop-outs use. */
export interface PopoutWindow {
  readonly webContents: {
    readonly id: number;
    on(
      event: "will-navigate",
      listener: (event: { preventDefault(): void }, url: string) => void,
    ): void;
    setWindowOpenHandler(handler: () => { action: "deny" }): void;
  };
  loadURL(url: string): Promise<void>;
  on(event: "close" | "closed", listener: () => void): void;
  getBounds(): Bounds;
  focus(): void;
  close(): void;
  isDestroyed(): boolean;
}

export interface PopoutWindowOptions extends Partial<Bounds> {
  readonly width: number;
  readonly height: number;
  readonly title: string;
  readonly show: boolean;
  readonly webPreferences: ReturnType<typeof viewWebPreferences> & { readonly partition: string };
}

/** ipcMain, as far as the bridge goes. */
export interface BridgeIpc {
  handle(
    channel: string,
    handler: (event: { readonly sender: { readonly id: number } }, ...args: unknown[]) => unknown,
  ): void;
}

export interface PopoutDeps {
  readonly createWindow: (options: PopoutWindowOptions) => PopoutWindow;
  readonly ipc: BridgeIpc;
  /** The view bridge's preload script (shell/view-preload.ts, built). */
  readonly preload: string;
  /** False in the e2e gate's hidden runs. */
  readonly show: boolean;
  /** A call to the runtime (spec 10.2). */
  readonly call: (op: CallOp, args: unknown) => Promise<Answer>;
  readonly placements: PlacementStore;
  /** Hand an Anytype object link to the desktop app. */
  readonly openExternal: (url: string) => void;
  readonly clock: Clock;
  readonly logger: Logger;
}

/** An answer over the size bound or not plain JSON, refused before the hop to the runtime. */
const OVERSIZED: Answer = { ok: false, error: REFUSED_ANSWER };

/** Each kind of pop-out's window title. */
const TITLES: Readonly<Record<PopoutTarget["kind"], string>> = {
  view: "InnyTypes — waiting for you",
  snapshot: "InnyTypes — snapshot",
  preview: "InnyTypes — preview",
};

/** How long a submitted pop-out stays, so its page can say it was sent. */
export const CLOSE_AFTER_SUBMIT_MS = 300;

export class Popouts {
  readonly #deps: PopoutDeps;
  readonly #windows = new Map<string, PopoutWindow>();
  readonly #opening = new Set<string>();
  /** webContents id → the one target that window may reach. */
  readonly #targets = new Map<number, PopoutTarget>();
  /** A preview's id → the view its page is handed. */
  readonly #previews = new Map<string, unknown>();

  constructor(deps: PopoutDeps) {
    this.#deps = deps;
    const { ipc } = deps;
    ipc.handle(BRIDGE_CHANNELS.get, (event) => this.#get(this.#targetOf(event.sender.id)));
    ipc.handle(BRIDGE_CHANNELS.submit, (event, values) => {
      const target = this.#targetOf(event.sender.id);
      if (target.kind === "snapshot") {
        throw new Error("not an action view");
      }
      return this.#submit(target, values);
    });
    ipc.handle(BRIDGE_CHANNELS.action, (event, actionId, values) => {
      const target = this.#targetOf(event.sender.id);
      if (target.kind !== "snapshot") {
        throw new Error("not a snapshot");
      }
      if (refusedBeforeHop(values)) {
        return Promise.resolve(OVERSIZED);
      }
      return deps.call("snapshot.action", { id: target.id, action: String(actionId), values });
    });
    // A draft is kept by the runtime with the view's journal entry, never sent (spec 8.1.6).
    ipc.handle(BRIDGE_CHANNELS.draft, (event, values) => {
      const target = this.#targetOf(event.sender.id);
      if (target.kind === "snapshot") {
        throw new Error("not an action view");
      }
      if (refusedBeforeHop(values)) {
        return Promise.resolve({ ok: false, error: REFUSED_DRAFT });
      }
      if (target.kind === "preview") {
        return Promise.resolve({ ok: true, value: null });
      }
      return deps.call("view.draft", { id: target.id, values });
    });
  }

  /** The keys (`view:<id>`, `snapshot:<id>`) of the pop-outs open now. */
  list(): string[] {
    return [...this.#windows.keys()];
  }

  /** Open the target in its own window, or focus the one already open. */
  async open(target: PopoutTarget, reason: string): Promise<void> {
    const key = popoutKey(target);
    const existing = this.#windows.get(key);
    if (existing !== undefined && !existing.isDestroyed()) {
      existing.focus();
      return;
    }
    if (this.#opening.has(key)) {
      return;
    }
    this.#opening.add(key);
    try {
      // What it shows decides its page (a package's component or the generic one) and where
      // it opens (its type's placement). A runtime that cannot answer gets the generic page,
      // which retries and says so (spec 8.5.8).
      const answer = await this.#get(target);
      const value = answer.ok ? answer.value : null;
      this.#create(target, value, reason);
    } finally {
      this.#opening.delete(key);
    }
  }

  /** Preview `value` in its own window as preview `id`, or focus the one already open. */
  preview(id: string, value: unknown): Promise<void> {
    this.#previews.set(id, value);
    return this.open({ kind: "preview", id }, "previewed");
  }

  /** Close the target's window, if one is open. */
  close(target: PopoutTarget): void {
    const window = this.#windows.get(popoutKey(target));
    if (window !== undefined && !window.isDestroyed()) {
      window.close();
    }
  }

  #create(target: PopoutTarget, value: unknown, reason: string): void {
    const deps = this.#deps;
    const key = popoutKey(target);
    const place = placementKey(target.kind, value);
    const bounds = place === null ? null : deps.placements.get(place);
    const window = deps.createWindow({
      ...(bounds ?? DEFAULT_SIZE),
      title: TITLES[target.kind],
      show: deps.show,
      webPreferences: { ...viewWebPreferences(deps.preload), partition: VIEW_PARTITION },
    });
    const contentsId = window.webContents.id;
    this.#windows.set(key, window);
    this.#targets.set(contentsId, target);
    window.webContents.on("will-navigate", (event, url) => {
      event.preventDefault();
      // The one way a view page may point outside itself: an Anytype object, in Anytype.
      if (isAnytypeLink(url)) {
        deps.openExternal(url);
      }
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.on("close", () => {
      if (place !== null) {
        deps.placements.set(place, window.getBounds());
      }
    });
    window.on("closed", () => {
      this.#windows.delete(key);
      this.#targets.delete(contentsId);
      if (target.kind === "preview") {
        this.#previews.delete(target.id);
      }
      deps.logger.info(`${key} window closed`);
    });
    const url = viewPageUrl(componentPackageOf(value));
    window.loadURL(url).catch((error: unknown) => {
      deps.logger.warn(`${key} did not load ${url}: ${String(error)}`);
    });
    deps.logger.info(`${key} opened in its own window (${reason}) at ${url}`);
  }

  #targetOf(senderId: number): PopoutTarget {
    const target = this.#targets.get(senderId);
    if (target === undefined) {
      throw new Error("this window is not a view window");
    }
    return target;
  }

  #get(target: PopoutTarget): Promise<Answer> {
    if (target.kind === "preview") {
      return Promise.resolve({ ok: true, value: this.#previews.get(target.id) ?? null });
    }
    return this.#deps.call(target.kind === "view" ? "view.get" : "snapshot.get", {
      id: target.id,
    });
  }

  async #submit(target: PopoutTarget, values: unknown): Promise<Answer> {
    if (refusedBeforeHop(values)) {
      return OVERSIZED;
    }
    if (target.kind === "preview") {
      this.#deps.logger.info(`${popoutKey(target)} would send ${JSON.stringify(values)}`);
      this.#deps.clock.after(CLOSE_AFTER_SUBMIT_MS, () => {
        this.close(target);
      });
      return { ok: true, value: null };
    }
    const result = await this.#deps.call("view.submit", { id: target.id, values });
    if (result.ok) {
      this.#deps.clock.after(CLOSE_AFTER_SUBMIT_MS, () => {
        this.close(target);
      });
    }
    return result;
  }
}
