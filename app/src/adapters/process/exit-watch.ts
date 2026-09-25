// How a node process's exit is noticed (spec 6.5), apart from node-process.ts so that file
// stays under the 600-line limit (plan 0018 §2.3).

import type { ChildProcessWithoutNullStreams as ChildProcess } from "node:child_process";

import type { ProcessTree } from "./process-tree";

export interface ExitWatch {
  /** After the process exits, how long its pipes may stay open before the exit is handled. */
  readonly graceMs: number;
  /** Schedule on the instance's own timers, which a close or an exit cancels. */
  readonly after: (ms: number, callback: () => void) => void;
  /** Its process group: whatever the process started goes with it. */
  readonly tree: Pick<ProcessTree, "kill">;
  readonly log: (message: string) => void;
  /** Called once, with how it ended: `code N`, `signal S` or "failed to start". */
  readonly exited: (how: string) => void;
}

/** Handle the exit once its pipes have closed, or after the grace period if they do not. */
export function watchExit(child: ChildProcess, watch: ExitWatch): void {
  let how: string | null = null;
  let handled = false;
  const handle = (): void => {
    if (!handled) {
      handled = true;
      watch.exited(how ?? "failed to start");
    }
  };
  child.on("error", (error) => {
    watch.log(`spawn failed: ${error.message}`);
    if (child.pid === undefined) {
      handle();
    }
  });
  child.on("exit", (code, signal) => {
    how = signal !== null ? `signal ${signal}` : `code ${String(code)}`;
    // The node is gone; whatever it started goes too, on close and on crash alike.
    if (child.pid !== undefined) {
      watch.tree.kill(child.pid);
    }
    watch.after(watch.graceMs, handle);
  });
  child.on("close", handle);
}
