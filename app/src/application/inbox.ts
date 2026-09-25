// The Inbox, as the shell keeps it (spec 8.1, 10.6; arch_pivot P10e; WI-0018-11).
//
// The runtime raises `present` for every presentation and the pending count whenever it
// moves. The shell keeps the list the pages show, so the Inbox keeps its last contents while
// the runtime is down, and decides what a presentation does besides:
// - a FIRST presentation raises a notification, and opens a pop-out when its instance asks;
// - a re-presentation (after a restart or a redeploy) waits quietly: no notice, no window.
// Whenever the count moves, the list is asked of the runtime again, so a view answered in a
// pop-out, timed out or removed with its node leaves the Inbox too.

import type { ChildMessage, OpResult, PresentWindow } from "../domain/channel/messages";
import type { Logger } from "../ports/logger";
import type { Notifier } from "../ports/notifier";

/** What the runtime raises about views (spec 10.2). */
export type InboxEvent = Extract<ChildMessage, { t: "present" } | { t: "pending" }>;

export interface InboxItem {
  readonly id: string;
  readonly title: string;
  readonly window: PresentWindow;
}

export interface InboxDeps {
  readonly notifier: Notifier;
  /** Open the view in its own pop-out (spec 8.5.1): a first presentation only. */
  readonly openPopout: (id: string) => void;
  /** The runtime's `view.list`; a refusal (the runtime is down) keeps the list as it is. */
  readonly list: () => Promise<OpResult | { readonly ok: false; readonly error: string }>;
  /** The dock or taskbar badge. */
  readonly badge: (count: number) => void;
  readonly logger: Logger;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function isInboxItem(value: unknown): value is InboxItem {
  return (
    isRecord(value) &&
    typeof value["id"] === "string" &&
    typeof value["title"] === "string" &&
    (value["window"] === "inline" || value["window"] === "popout")
  );
}

export class Inbox {
  readonly #deps: InboxDeps;
  readonly #items = new Map<string, InboxItem>();
  readonly #listeners: ((items: readonly InboxItem[]) => void)[] = [];
  readonly #countListeners: ((count: number) => void)[] = [];
  #pending: number | null = null;

  constructor(deps: InboxDeps) {
    this.#deps = deps;
  }

  /** The pending views as last known, oldest first. */
  items(): readonly InboxItem[] {
    return [...this.#items.values()];
  }

  /** The count the runtime last raised; null before it has. */
  pending(): number | null {
    return this.#pending;
  }

  onChange(listener: (items: readonly InboxItem[]) => void): void {
    this.#listeners.push(listener);
  }

  onCount(listener: (count: number) => void): void {
    this.#countListeners.push(listener);
  }

  /** One `present` or `pending` from the runtime. */
  receive(event: InboxEvent): void {
    if (event.t === "pending") {
      this.#pending = event.count;
      this.#deps.badge(event.count);
      for (const listener of this.#countListeners) {
        listener(event.count);
      }
      void this.refresh();
      return;
    }
    const { id, title, window, first } = event;
    this.#items.set(id, { id, title, window });
    this.#changed();
    if (!first) {
      // P10e: a restart must not throw a stack of windows (or notices) at the person.
      this.#deps.logger.info(`view ${id} re-presented: it waits quietly in the Inbox`);
      return;
    }
    this.#deps.notifier.raise({
      title: "InnyTypes is waiting for you",
      body: title === "" ? "A view waits in the Inbox." : title,
    });
    if (window === "popout") {
      this.#deps.openPopout(id);
    }
  }

  /** Ask the runtime for the list again; kept as it is when the runtime cannot answer. */
  async refresh(): Promise<void> {
    const answer = await this.#deps.list();
    if (!answer.ok || !Array.isArray(answer.value)) {
      return;
    }
    const listed = (answer.value as unknown[]).filter(isInboxItem);
    this.#items.clear();
    for (const item of listed) {
      this.#items.set(item.id, { id: item.id, title: item.title, window: item.window });
    }
    this.#changed();
  }

  #changed(): void {
    const items = this.items();
    for (const listener of this.#listeners) {
      listener(items);
    }
  }
}
