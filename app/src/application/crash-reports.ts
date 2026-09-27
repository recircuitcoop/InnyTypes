// Crash reports (WI-0018-22): the runtime's, the services process's and every node process's
// crashes counted, and each crash handed to the telemetry pipeline as one report built from the
// counts alone. The pipeline decides whether it is queued at all, and redacts it first.
//
// A supervised child's crash is seen in its status (the supervisor sets `down` after a crash it
// will restart, `down-for-good` at the crash-loop limit); a node process's crash is told by the
// runtime (NodeCrashSink), without the node's name.

import type { ChildStatus } from "../domain/supervision/child-state";
import {
  crashPayload,
  type CrashCounts,
  type CrashedProcess,
  type Versions,
} from "../domain/telemetry/reports";
import type { NodeCrashSink } from "../ports/telemetry";

export interface CrashReportsDeps {
  /** The pipeline's recordCrash: gated by the switch, redacted before it is queued. */
  readonly record: (payload: Readonly<Record<string, unknown>>) => unknown;
  readonly versions: Versions;
}

export class CrashReports implements NodeCrashSink {
  readonly #deps: CrashReportsDeps;
  #counts: CrashCounts = { runtime: 0, services: 0, node: 0, nodeStopped: 0 };

  constructor(deps: CrashReportsDeps) {
    this.#deps = deps;
  }

  /** A child's status, as each change is published: a crash is `down` or `down-for-good`. */
  childStatus(status: ChildStatus): void {
    if (status.state === "down" || status.state === "down-for-good") {
      this.#crashed(status.child, status.state === "down-for-good");
    }
  }

  nodeCrashed(stopped: boolean): void {
    this.#crashed("node", stopped);
  }

  /** The counts since the app started. */
  counts(): CrashCounts {
    return this.#counts;
  }

  #crashed(process: CrashedProcess, stoppedForGood: boolean): void {
    const counts = this.#counts;
    this.#counts = {
      ...counts,
      [process]: counts[process] + 1,
      nodeStopped: counts.nodeStopped + (process === "node" && stoppedForGood ? 1 : 0),
    };
    this.#deps.record(crashPayload(process, stoppedForGood, this.#counts, this.#deps.versions));
  }
}
