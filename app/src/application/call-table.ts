// The calls a supervisor has sent and not yet had answered (spec 10.3).
//
// Every call ends exactly once: with the child's reply, with `timeout` after the call
// timeout, or with `stopped` when the child exits first. A reply that arrives after its call
// already ended is dropped.

import { channelError, type CallResult, type ChannelErrorCode } from "../domain/channel/errors";
import type { ChildName } from "../domain/supervision/child-state";
import type { Cancel, Clock } from "../ports/clock";

interface Pending {
  readonly resolve: (result: CallResult) => void;
  readonly cancelTimeout: Cancel;
}

export class CallTable {
  readonly #pending = new Map<string, Pending>();
  readonly #clock: Clock;
  readonly #child: ChildName;
  readonly #timeoutMs: number;

  constructor(clock: Clock, child: ChildName, timeoutMs: number) {
    this.#clock = clock;
    this.#child = child;
    this.#timeoutMs = timeoutMs;
  }

  /** Start waiting for the reply to `rid`; the promise always settles. */
  open(rid: string): Promise<CallResult> {
    return new Promise((resolve) => {
      const cancelTimeout = this.#clock.after(this.#timeoutMs, () => {
        this.#end(rid, channelError("timeout", this.#child));
      });
      this.#pending.set(rid, { resolve, cancelTimeout });
    });
  }

  /** The child answered. False when nothing was waiting for `rid` any more. */
  settle(rid: string, result: CallResult): boolean {
    return this.#end(rid, result);
  }

  /** End every call still waiting, with `code`: the child they were sent to is gone. */
  failAll(code: ChannelErrorCode): void {
    for (const rid of [...this.#pending.keys()]) {
      this.#end(rid, channelError(code, this.#child));
    }
  }

  get size(): number {
    return this.#pending.size;
  }

  #end(rid: string, result: CallResult): boolean {
    const pending = this.#pending.get(rid);
    if (pending === undefined) {
      return false;
    }
    this.#pending.delete(rid);
    pending.cancelTimeout();
    pending.resolve(result);
    return true;
  }
}
