// One generic supervisor for a utilityProcess child: the runtime or the services process
// (plan 0018 §2.2, spec 10.4–10.8).
//
// It forks the child with explicit settings, sends it planned stops (types, restart, quit),
// restarts it after a crash with backoff, and stops restarting when the crash-loop limit is
// reached. The spike's shell restarted forever and supervised one child (arch_pivot P11,
// `main.js:163-170`); this is the same machine, for any child, with an end.
//
// Every transition goes through `#setState`, which tells each status listener, so the app
// page learns the state from the shell even while the child is gone.

import { CallTable } from "./call-table";
import { channelError, refusalFor, type CallResult } from "../domain/channel/errors";
import {
  parseChildMessage,
  type CallOp,
  type ChildMessage,
  type InitConfig,
  type RestartInfo,
  type SecretPaths,
  type StopReason,
} from "../domain/channel/messages";
import { crashRestartDelay } from "../domain/supervision/backoff";
import { CrashLoopBreaker } from "../domain/supervision/breaker";
import {
  crashLoopMessage,
  type ChildName,
  type ChildState,
  type ChildStatus,
  type SupervisionSettings,
} from "../domain/supervision/child-state";
import type { Cancel, Clock } from "../ports/clock";
import type { Logger } from "../ports/logger";
import type { Notifier } from "../ports/notifier";
import type { ChildHandle, ForkSpec, ProcessLauncher } from "../ports/process-launcher";

/** A child's `present` or `pending` message (spec 10.2). */
export type ViewMessage = Extract<
  ChildMessage,
  { t: "present" } | { t: "pending" } | { t: "runs" }
>;

/** The settings every generation of one child gets; the supervisor adds the rest. */
export interface ChildSettings {
  /** The runtime's stable loopback port (plan 0018 §2.2); null for a child without one. */
  readonly port: number | null;
  readonly userDir: string;
  /** Node-RED's credential secret, for the runtime; absent for the services process. */
  readonly credentialSecret?: string;
  /** Where the Anytype key and the proxy token live, for the services process. */
  readonly secretFiles?: SecretPaths;
}

export interface SupervisorDeps {
  readonly child: ChildName;
  readonly fork: ForkSpec;
  readonly childSettings: ChildSettings;
  readonly settings: SupervisionSettings;
  readonly launcher: ProcessLauncher;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly notifier: Notifier;
  /** A fresh call id (a UUID in the app). */
  readonly newId: () => string;
}

export class Supervisor {
  readonly #deps: SupervisorDeps;
  readonly #breaker: CrashLoopBreaker;
  readonly #calls: CallTable;
  readonly #listeners: ((status: ChildStatus) => void)[] = [];
  readonly #viewListeners: ((event: ViewMessage) => void)[] = [];
  readonly #nodeCrashListeners: ((stopped: boolean) => void)[] = [];
  readonly #quitWaiters: (() => void)[] = [];

  #state: ChildState = "starting";
  #generation = 0;
  #handle: ChildHandle | null = null;
  #pid: number | null = null;
  #port: number | null = null;
  #error: string | null = null;
  /** Crashes since the child was last ready: the backoff's n. */
  #crashesInARow = 0;
  #nextRestart: RestartInfo | null = null;
  #cancelBackoff: Cancel | null = null;
  #cancelKill: Cancel | null = null;
  #started = false;
  #quitting = false;

  constructor(deps: SupervisorDeps) {
    this.#deps = deps;
    this.#breaker = new CrashLoopBreaker(deps.settings.crashLoop, () => deps.clock.now());
    this.#calls = new CallTable(deps.clock, deps.child, deps.settings.callTimeoutMs);
  }

  get child(): ChildName {
    return this.#deps.child;
  }

  status(): ChildStatus {
    return {
      child: this.#deps.child,
      state: this.#state,
      generation: this.#generation,
      pid: this.#pid,
      port: this.#port,
      error: this.#error,
    };
  }

  onStatus(listener: (status: ChildStatus) => void): void {
    this.#listeners.push(listener);
  }

  /** What the runtime raises about views (spec 10.2): `present` and the pending count. */
  onViewEvent(listener: (event: ViewMessage) => void): void {
    this.#viewListeners.push(listener);
  }

  /** A node process of the runtime's crashed (WI-0018-22); `stopped` at the crash-loop limit. */
  onNodeCrash(listener: (stopped: boolean) => void): void {
    this.#nodeCrashListeners.push(listener);
  }

  /** The first fork. Called once; a second call does nothing. */
  start(): void {
    if (this.#started) {
      return;
    }
    this.#started = true;
    this.#fork();
  }

  /**
   * A planned restart (spec 10.4): stop the running child, then fork the next generation with
   * `info`. It never counts as a crash. False when the child is not running.
   */
  restart(reason: Exclude<StopReason, "quit">, info?: RestartInfo): boolean {
    if (this.#state !== "running" || this.#handle === null) {
      return false;
    }
    this.#deps.logger.info(`restarting the ${this.#deps.child} (${reason})`);
    this.#nextRestart = info ?? {
      reason,
      added: [],
      removed: [],
      requestedAt: this.#deps.clock.now(),
    };
    this.#setState("restarting-planned");
    this.#sendStop(this.#handle, reason);
    return true;
  }

  /**
   * A person pressed Restart after the crash-loop limit (plan 0018 §7). Restarting resumes
   * and the crashes counted so far are forgotten. False unless the state is down-for-good.
   */
  recover(): boolean {
    if (this.#state !== "down-for-good" || this.#quitting) {
      return false;
    }
    this.#deps.logger.info(`the ${this.#deps.child} is started again by a person`);
    this.#breaker.reset();
    this.#crashesInARow = 0;
    this.#error = null;
    // Restarting again: another crash loop is news again.
    this.#deps.notifier.clear("child-stopped", this.#deps.child);
    this.#state = "starting";
    this.#fork();
    return true;
  }

  /**
   * Quit (spec 10.7): send `stop {reason: "quit"}`, kill the child if it is still alive after
   * the stop deadline, and settle once it is gone. A pending crash restart is cancelled.
   */
  stop(): Promise<void> {
    const gone = new Promise<void>((resolve) => this.#quitWaiters.push(resolve));
    if (this.#quitting) {
      return gone;
    }
    this.#quitting = true;
    this.#cancelBackoff?.();
    this.#cancelBackoff = null;
    if (this.#handle === null) {
      this.#finishQuit();
      return gone;
    }
    this.#deps.logger.info(`stopping the ${this.#deps.child} for quit`);
    this.#sendStop(this.#handle, "quit");
    return gone;
  }

  /**
   * Call the child (spec 10.2–10.3). Answers at once with a typed error when the child is not
   * running; otherwise the child's reply, `timeout`, or `stopped` if it exits first.
   */
  call(op: CallOp, args: unknown): Promise<CallResult> {
    const refusal = refusalFor(this.#state);
    if (refusal !== null || this.#handle === null) {
      return Promise.resolve(channelError(refusal ?? "down", this.#deps.child));
    }
    const rid = this.#deps.newId();
    const answered = this.#calls.open(rid);
    this.#handle.post({ v: 1, t: "call", rid, op, args });
    return answered;
  }

  /**
   * Hand the running child one end of the runtime ↔ services channel (plan 0018 §2.2). False,
   * and nothing sent, when the child is not running: the next `running` links it again.
   */
  sendPeer(end: object): boolean {
    if (this.#state !== "running" || this.#handle === null) {
      return false;
    }
    this.#handle.post({ v: 1, t: "peer" }, [end]);
    return true;
  }

  // ── the child's lifecycle ──────────────────────────────────────────────────────────────

  #fork(): void {
    this.#generation += 1;
    this.#pid = null;
    this.#port = null;
    const restart = this.#nextRestart;
    this.#nextRestart = null;

    const handle = this.#deps.launcher.fork(this.#deps.fork);
    this.#handle = handle;
    // Events from a handle this supervisor has moved on from are ignored: a late message
    // from an old generation must not change the new one's state.
    handle.onMessage((raw) => {
      if (handle === this.#handle) {
        this.#onMessage(raw);
      }
    });
    handle.onExit((code) => {
      if (handle === this.#handle) {
        this.#onExit(code);
      }
    });

    const { credentialSecret, secretFiles } = this.#deps.childSettings;
    const config: InitConfig = {
      generation: this.#generation,
      port: this.#deps.childSettings.port,
      userDir: this.#deps.childSettings.userDir,
      restart,
      forkedAt: this.#deps.clock.now(),
      ...(credentialSecret === undefined ? {} : { credentialSecret }),
      ...(secretFiles === undefined ? {} : { secretFiles }),
    };
    handle.post({ v: 1, t: "init", config });
    this.#deps.logger.info(`${this.#deps.child} generation ${String(this.#generation)} forked`);
    this.#emit();
  }

  #onMessage(raw: unknown): void {
    const message = parseChildMessage(raw);
    if (message === null) {
      this.#deps.logger.warn(`the ${this.#deps.child} sent a message this channel does not know`);
      return;
    }
    switch (message.t) {
      case "ready":
        this.#pid = message.pid;
        this.#port = message.port;
        this.#crashesInARow = 0;
        this.#deps.logger.info(
          `${this.#deps.child} generation ${String(message.generation)} ready ` +
            `(pid ${String(message.pid)})`,
        );
        if (!this.#quitting) {
          this.#setState("running");
        }
        return;
      case "failed":
        this.#deps.logger.error(`the ${this.#deps.child} failed to start: ${message.error}`);
        return;
      case "stopped":
        this.#deps.logger.info(`the ${this.#deps.child} stopped (${message.reason})`);
        return;
      case "reply":
        this.#calls.settle(message.rid, message.result);
        return;
      case "present":
      case "pending":
      case "runs":
        for (const listener of this.#viewListeners) {
          listener(message);
        }
        return;
      case "notice":
        // The child's notice, told once by the shell's notifier (WI-0018-21).
        this.#deps.notifier.raise(message.notice);
        return;
      case "notice-clear":
        this.#deps.notifier.clear(message.kind, message.subject);
        return;
      case "node-crash":
        for (const listener of this.#nodeCrashListeners) {
          listener(message.stopped);
        }
        return;
    }
  }

  #onExit(code: number): void {
    this.#handle = null;
    this.#cancelKill?.();
    this.#cancelKill = null;
    this.#calls.failAll("stopped");

    if (this.#quitting) {
      this.#deps.logger.info(`the ${this.#deps.child} exited (code ${String(code)}) on quit`);
      this.#finishQuit();
      return;
    }
    if (this.#state === "restarting-planned") {
      this.#deps.logger.info(`the ${this.#deps.child} exited for a planned restart`);
      this.#state = "restarting";
      this.#fork();
      return;
    }
    this.#onCrash(code);
  }

  #onCrash(code: number): void {
    this.#crashesInARow += 1;
    if (!this.#breaker.recordCrash()) {
      // The crash-loop limit: stop restarting, say so on the page, and raise one notice.
      const message = crashLoopMessage(this.#deps.child, this.#deps.settings.crashLoop);
      this.#error = message;
      this.#deps.logger.error(
        `the ${this.#deps.child} exited unexpectedly (code ${String(code)}); ` +
          `crash-loop limit reached, no more restarts`,
      );
      // The state comes first: a notice that could not be shown is never why the page is
      // left saying something else.
      this.#setState("down-for-good");
      try {
        this.#deps.notifier.raise({
          kind: "child-stopped",
          subject: this.#deps.child,
          detail: message,
        });
      } catch (error) {
        this.#deps.logger.error(`the crash-loop notice could not be raised: ${String(error)}`);
      }
      return;
    }

    const delay = crashRestartDelay(this.#crashesInARow, this.#deps.settings.backoff);
    this.#deps.logger.error(
      `the ${this.#deps.child} exited unexpectedly (code ${String(code)}); ` +
        `restart ${String(this.#crashesInARow)} in ${String(delay)} ms`,
    );
    this.#setState("down");
    this.#cancelBackoff = this.#deps.clock.after(delay, () => {
      this.#cancelBackoff = null;
      this.#state = "recovering";
      this.#fork();
    });
  }

  /** Send `stop`, and kill the child if it is still alive at the stop deadline. */
  #sendStop(handle: ChildHandle, reason: StopReason): void {
    handle.post({ v: 1, t: "stop", reason });
    this.#cancelKill?.();
    this.#cancelKill = this.#deps.clock.after(this.#deps.settings.stopDeadlineMs, () => {
      this.#cancelKill = null;
      if (handle === this.#handle) {
        this.#deps.logger.warn(
          `the ${this.#deps.child} did not stop in ` +
            `${String(this.#deps.settings.stopDeadlineMs)} ms; killing it`,
        );
        handle.kill();
      }
    });
  }

  #finishQuit(): void {
    this.#setState("stopped");
    for (const resolve of this.#quitWaiters.splice(0)) {
      resolve();
    }
  }

  #setState(state: ChildState): void {
    this.#state = state;
    this.#emit();
  }

  #emit(): void {
    const status = this.status();
    for (const listener of this.#listeners) {
      listener(status);
    }
  }
}
