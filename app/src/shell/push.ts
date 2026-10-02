// The push events to the app page (plan 0022 §N), coalesced. A burst of changes (ten runs of one
// flow finishing together, a package install moving through its phases) reaches the page as one
// event per channel and key, carrying the last value, a moment later. Every other message to the
// page passes straight through.
import { IPC } from "./ipc";

/** The push channels, and what in their value tells two events apart. */
const COALESCED: Readonly<Record<string, ((value: unknown) => string) | null>> = {
  [IPC.runsChanged]: (value) => String((value as { flowId?: unknown } | null)?.flowId),
  [IPC.boardChanged]: (value) => String((value as { flowId?: unknown } | null)?.flowId),
  [IPC.flowsChanged]: null,
  [IPC.setupChanged]: null,
  [IPC.updateStateChanged]: null,
  [IPC.packagesChanged]: null,
  [IPC.statusChanged]: null,
};

/** How long a burst is gathered before it is sent. */
export const COALESCE_MS = 50;

export class PushEvents {
  readonly #send: (channel: string, ...args: unknown[]) => void;
  readonly #after: (ms: number, run: () => void) => void;
  readonly #waiting = new Map<string, { channel: string; args: unknown[] }>();
  #scheduled = false;

  constructor(
    send: (channel: string, ...args: unknown[]) => void,
    after: (ms: number, run: () => void) => void = (ms, run) => {
      setTimeout(run, ms);
    },
  ) {
    this.#send = send;
    this.#after = after;
  }

  /** Send to the page: a push channel coalesced, any other at once. */
  readonly toPage = (channel: string, ...args: unknown[]): void => {
    if (!(channel in COALESCED)) {
      this.#send(channel, ...args);
      return;
    }
    const keyOf = COALESCED[channel];
    const key = keyOf === null || keyOf === undefined ? channel : `${channel} ${keyOf(args[0])}`;
    // A later value replaces a waiting one, and keeps its place in the order.
    this.#waiting.set(key, { channel, args });
    if (!this.#scheduled) {
      this.#scheduled = true;
      this.#after(COALESCE_MS, () => {
        this.#flush();
      });
    }
  };

  #flush(): void {
    this.#scheduled = false;
    const waiting = [...this.#waiting.values()];
    this.#waiting.clear();
    for (const { channel, args } of waiting) {
      this.#send(channel, ...args);
    }
  }
}
