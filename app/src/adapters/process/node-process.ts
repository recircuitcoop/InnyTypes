// One node instance's process, speaking protocol v2 (spec §3–§6, §11.2).
//
// It spawns the process with a minimal environment in its package directory, sends `start`,
// waits for `ready` (30 s), routes every frame the process writes, and closes it with
// `close` → `closed` → exit, killing it 5 s after `close`. An unexpected exit fails the inputs
// the process held (`sent`), keeps the ones waiting on a person (`awaiting`), and respawns
// after 1 s until the domain crash-loop breaker trips (plan 0018 §7).
//
// Identity is bound here (spec 11.2): the runtime stamps every envelope field; a process emits
// only on its declared ports, for its own live input ids. The spike did this in
// `runtime/runtime.js`, without the codec (ajv, 1 MiB), the minimal environment, the process
// group, the ready deadline and a windowed breaker. Inputs are journaled before they are sent
// (spec §7, input-journal.ts); an action view's timeout fires from its journaled deadline.

import { spawn, type ChildProcessWithoutNullStreams as ChildProcess } from "node:child_process";
import * as fs from "node:fs";

import type { CloseReason } from "../../domain/journal/entry";
import type { QueueReport } from "../../domain/journal/queue";
import { CrashLoopBreaker } from "../../domain/supervision/breaker";
import { TIMEOUT_PORT } from "../../domain/views/views";
import type { Cancel } from "../../ports/clock";
import { forEachLine } from "../../domain/logging/lines";
import type { NodeLineLevel } from "../../ports/logger";
import type {
  EventEnvelope,
  InputDelivery,
  InputEvent,
  InputMessage,
  NodeOutput,
  NodeProcess,
  NodeProcessHost,
  NodeProcessLauncher,
  NodeProcessSpec,
  NodeStatus,
  ViewContent,
} from "../../ports/node-process";
import {
  decodeFrame,
  encodeFrame,
  FrameTooLargeError,
  LineReader,
  type NodeFrame,
  type ReadLine,
  type RuntimeFrame,
} from "./codec";
import { inputJournalFor, type Admitted, type InputJournal } from "./input-journal";
import type { NodeProcessDeps } from "./node-process-settings";
import { watchExit } from "./exit-watch";
import { ViewDeadlines } from "./view-deadlines";

export {
  DEFAULT_NODE_PROCESS,
  type NodeProcessDeps,
  type NodeProcessSettings,
} from "./node-process-settings";

type InputState = "queued" | "sent" | "awaiting";

interface Input {
  readonly event: InputEvent;
  readonly delivery: InputDelivery;
  /** queued: not written to any process yet; sent: written; awaiting: presented (spec 8.1). */
  state: InputState;
}

export function nodeProcessLauncher(deps: NodeProcessDeps): NodeProcessLauncher {
  return { start: (spec, host) => new ChildNodeProcess(spec, host, deps) };
}

class ChildNodeProcess implements NodeProcess {
  readonly #spec: NodeProcessSpec;
  readonly #host: NodeProcessHost;
  readonly #deps: NodeProcessDeps;
  readonly #breaker: CrashLoopBreaker;
  /** The outstanding inputs: journaled, not yet done (spec 7.6). */
  readonly #inputs = new Map<string, Input>();
  readonly #journal: InputJournal;
  readonly #deadlines: ViewDeadlines;
  readonly #who: string;
  readonly #closeWaiters: (() => void)[] = [];

  #child: ChildProcess | null = null;
  ready = false;
  #statusSeen = false;
  #closing = false;
  #closedAck = false;
  #stopped = false;
  #timers: Cancel[] = [];

  constructor(spec: NodeProcessSpec, host: NodeProcessHost, deps: NodeProcessDeps) {
    this.#spec = spec;
    this.#host = host;
    this.#deps = deps;
    this.#breaker = new CrashLoopBreaker(deps.settings.crashLoop, () => deps.clock.now());
    this.#who = `[${spec.identity.type} ${spec.identity.id}]`;
    this.#journal = inputJournalFor(spec.identity, deps, (level, message) => {
      this.#log(level, message);
    });
    this.#deadlines = new ViewDeadlines(deps.clock, (inputId) => {
      this.#timedOut(inputId);
    });
    if (deps.tree.blocked !== null) {
      deps.logger.warn(`${this.#who} ${deps.tree.blocked}`);
    }
    // Registered before the first spawn, so no line of this node is written unredacted
    // (spec 11.1).
    for (const secret of Object.values(spec.credentials)) {
      if (secret !== "") {
        deps.secrets.protect(secret);
      }
    }
    fs.mkdirSync(spec.dataDir, { recursive: true });
    // Created again (a redeploy): a crash loop from here on is news again.
    deps.notifier.clear("node-stopped", spec.identity.name || spec.identity.typeId);
    this.#spawn();
  }

  get pid(): number | null {
    return this.#child?.pid ?? null;
  }

  // ── from the runtime ───────────────────────────────────────────────────────────────────

  input(message: InputMessage, delivery: InputDelivery): string | null {
    const replayed = this.#journal.claim(message);
    if (this.#closing || this.#stopped) {
      const why = `the node process is ${this.#closing ? "closing" : "stopped after repeated exits"}`;
      this.#log(
        "warn",
        `refused ${replayed === undefined ? "an input" : `input ${replayed}`}: ${why}`,
      );
      delivery.done(new Error(why));
      return null;
    }
    // Journal, then send (spec 7.1): nothing reaches the process before its entry is on disk.
    const admitted =
      replayed === undefined
        ? this.#journal.admit(message, delivery, this.#inputs.size)
        : this.#journal.readmit(replayed, delivery, this.#inputs.has(replayed));
    return admitted === null ? null : this.#queue(admitted, delivery);
  }

  #queue(admitted: Admitted, delivery: InputDelivery): string {
    const { id, event, awaiting } = admitted;
    const input: Input = { event, delivery, state: awaiting ? "awaiting" : "queued" };
    this.#inputs.set(id, input);
    if (this.#child !== null) {
      this.#sendInput(id, input);
    } else {
      this.#log("info", `input ${id} queued: no process is running`);
    }
    return id;
  }

  replay(redeliver: (message: InputMessage) => void): number {
    return this.#closing ? 0 : this.#journal.redeliver(redeliver);
  }

  queue(): QueueReport {
    return this.#journal.report(this.#inputs.size);
  }

  cancel(inputId: string): void {
    const input = this.#inputs.get(inputId);
    if (input?.state === "queued") {
      // Never written to a process, so there is no one to ask: it ends here.
      this.#fail(inputId, new Error("cancelled before it started"));
      return;
    }
    this.#write({ t: "cancel", in: inputId });
  }

  action(inputId: string, values: Readonly<Record<string, unknown>>): boolean {
    const input = this.#inputs.get(inputId);
    if (input?.state !== "awaiting" || this.#child === null) {
      this.#log("warn", `refused an action for ${inputId}: no view is waiting on it`);
      return false;
    }
    input.state = "sent";
    this.#deadlines.disarm(inputId);
    this.#journal.submitted(inputId);
    this.#write({ t: "action", in: inputId, values });
    return true;
  }

  trigger(action: string, snapshot: { id: string; state: unknown }, values: object): boolean {
    const running = this.#child !== null;
    this.#write({ t: "trigger", action, snapshot, values }); // with none running, logged only
    return running;
  }

  fire(data: Readonly<Record<string, unknown>>): void {
    this.#write({ t: "fire", data });
  }

  close(reason: CloseReason): Promise<void> {
    if (this.#closing && this.#child === null) {
      return Promise.resolve(); // already closed
    }
    const gone = new Promise<void>((resolve) => this.#closeWaiters.push(resolve));
    if (this.#closing) {
      return gone;
    }
    this.#closing = true;
    this.#cancelTimers();
    this.#deadlines.disarmAll();
    // The inputs still open belong to the journal now: it re-sends them to the next instance
    // (spec 7.2), marked by why this one closed. They are neither done nor failed here.
    this.#journal.close(reason, [...this.#inputs.keys()]);
    this.#inputs.clear();
    const child = this.#child;
    if (child === null) {
      this.#finishClose();
      return gone;
    }
    this.#write({ t: "close" });
    this.#after(this.#deps.settings.closeDeadlineMs, () => {
      if (child === this.#child && child.pid !== undefined) {
        this.#log(
          "warn",
          `did not exit within ${String(this.#deps.settings.closeDeadlineMs)} ms of close; ` +
            `sending SIGKILL to its process group`,
        );
        this.#deps.tree.kill(child.pid);
      }
    });
    return gone;
  }

  // ── the process ────────────────────────────────────────────────────────────────────────

  #spawn(): void {
    const { argv, cwd, env } = this.#spec;
    const child = spawn(argv[0] as string, argv.slice(1), {
      cwd,
      env: { ...env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: this.#deps.tree.detached,
    });
    this.#child = child;
    this.ready = false;
    this.#statusSeen = false;
    this.#closedAck = false;
    this.#log("info", `spawned pid ${String(child.pid)}: ${argv.join(" ")}`);

    const stdout = new LineReader();
    child.stdout.on("data", (chunk: Buffer) => {
      this.#onStdout(child, stdout.push(chunk));
    });
    child.stdout.on("end", () => {
      this.#onStdout(child, stdout.end());
    });
    child.stderr.setEncoding("utf8");
    forEachLine(child.stderr, (line) => {
      this.#line("STDERR", line.cut ? `${line.text} [line cut]` : line.text);
    });
    child.stdin.on("error", () => {
      // A dead process's stdin; its exit is what reports it.
    });
    watchExit(child, {
      graceMs: this.#deps.settings.exitGraceMs,
      after: this.#after.bind(this),
      tree: this.#deps.tree,
      log: this.#log.bind(this, "error"),
      exited: this.#onExit.bind(this, child),
    });

    this.#host.status({ fill: "grey", shape: "ring", text: "starting" });
    const { identity, config, credentials, dataDir } = this.#spec;
    this.#write({
      t: "start",
      protocol: 2,
      node: { id: identity.id, type: identity.type, name: identity.name },
      config,
      credentials,
      data_dir: dataDir,
    });
    // Everything still open goes to the new process: inputs that arrived while none ran, and
    // action views, which are re-presented rather than failed (spec 6.5).
    for (const [id, input] of this.#inputs) {
      this.#sendInput(id, input);
    }
    this.#after(this.#deps.settings.readyDeadlineMs, () => {
      if (child === this.#child && !this.ready && child.pid !== undefined) {
        const seconds = String(this.#deps.settings.readyDeadlineMs / 1000);
        this.#log("error", `sent no ready within ${seconds} s of start; killing it`);
        this.#host.status({ fill: "red", shape: "dot", text: `did not start in ${seconds} s` });
        this.#deps.tree.kill(child.pid);
      }
    });
  }

  #onExit(child: ChildProcess, how: string): void {
    if (child !== this.#child) {
      return;
    }
    this.#child = null;
    this.ready = false;
    this.#cancelTimers();
    if (this.#closing) {
      this.#log("info", `process exited (${how}) on close`);
      this.#finishClose();
      return;
    }
    this.#log("error", `process exited unexpectedly (${how})`);
    this.#host.status({ fill: "red", shape: "dot", text: `process exited (${how})` });
    for (const [id, input] of this.#inputs) {
      if (input.state === "sent") {
        const label = this.#spec.identity.name || this.#spec.identity.typeId;
        this.#fail(
          id,
          new Error(`${label}: node process exited (${how}) while handling this event`),
        );
      }
    }
    if (!this.#breaker.recordCrash()) {
      this.#stop();
      return;
    }
    this.#after(this.#deps.settings.respawnDelayMs, () => {
      this.#spawn();
    });
  }

  /** The crash-loop limit: no more processes until the instance is re-created. */
  #stop(): void {
    this.#stopped = true;
    const { maxCrashes, windowMs } = this.#deps.settings.crashLoop;
    const text = `stopped after ${String(maxCrashes)} exits in ${String(windowMs / 1000)} s`;
    this.#log("error", `${text}; no more restarts until it is redeployed`);
    this.#host.status({ fill: "red", shape: "dot", text });
    for (const [id, input] of this.#inputs) {
      if (input.state === "queued") {
        this.#fail(id, new Error(`the node process ${text}`));
      }
    }
    for (const held of this.#journal.takeHeld()) {
      held.delivery.done(new Error(`the node process ${text}`));
    }
    try {
      const subject = this.#spec.identity.name || this.#spec.identity.typeId;
      this.#deps.notifier.raise({ kind: "node-stopped", subject, detail: `Its process ${text}` });
    } catch (error) {
      this.#log("error", `the crash-loop notice could not be raised: ${String(error)}`);
    }
  }

  #finishClose(): void {
    for (const resolve of this.#closeWaiters.splice(0)) {
      resolve();
    }
  }

  // ── frames from the process ────────────────────────────────────────────────────────────

  #onStdout(child: ChildProcess, lines: ReadLine[]): void {
    for (const line of lines) {
      // After `closed` the runtime ignores the process (spec 4.3.4); a stale process is
      // ignored always.
      if (child !== this.#child || this.#closedAck) {
        continue;
      }
      if (line.kind === "dropped") {
        this.#oversize(line.bytes, null);
        continue;
      }
      this.#onLine(line.bytes);
    }
  }

  #onLine(bytes: Buffer): void {
    const decoded = decodeFrame(bytes);
    switch (decoded.kind) {
      case "oversize":
        this.#oversize(decoded.bytes, decoded.inputId);
        return;
      case "violation":
        this.#line("stdout", `protocol violation (${decoded.reason}): ${decoded.text}`);
        return;
      case "unknown":
        this.#log("warn", `ignored a frame of unknown type ${JSON.stringify(decoded.t)}`);
        return;
      case "invalid":
        this.#log("error", `refused an invalid ${decoded.t} frame: ${decoded.problems}`);
        return;
      case "frame":
        this.#onFrame(decoded.frame);
        return;
    }
  }

  #oversize(bytes: number, inputId: string | null): void {
    this.#log("error", `discarded a ${String(bytes)}-byte frame: frame too large (limit 1 MiB)`);
    if (inputId !== null && this.#inputs.has(inputId)) {
      this.#fail(inputId, new Error("frame too large"));
    }
  }

  #onFrame(frame: NodeFrame): void {
    switch (frame.t) {
      case "ready":
        this.ready = true;
        this.#log("info", "ready");
        if (!this.#statusSeen) {
          const text = this.#spec.identity.kind === "source" ? "watching" : "ready";
          this.#host.status({ fill: "green", shape: "ring", text });
        }
        return;
      case "status":
        this.#statusSeen = true;
        this.#host.status(statusOf(frame));
        return;
      case "log":
        this.#line(frame.level ?? "info", frame.msg);
        return;
      case "emit":
        this.#onEmit(frame.port, frame.data, frame.in);
        return;
      case "done":
        this.#finish(frame.in, undefined);
        return;
      case "error":
        if (frame.in !== undefined) {
          this.#finish(frame.in, new Error(frame.message));
          return;
        }
        this.#log("error", frame.message);
        this.#host.nodeError(frame.message);
        return;
      case "present":
        this.#onPresent(frame.in, frame.content);
        return;
      case "snapshot":
        this.#onSnapshot(frame.content, frame.state, frame.in);
        return;
      case "closed":
        this.#closedAck = true;
        this.#log("info", "close acknowledged");
        return;
    }
  }

  #onEmit(port: string, data: unknown, inputId: string | undefined): void {
    const index = this.#spec.ports.findIndex((declared) => declared.port === port);
    const declared = this.#spec.ports[index];
    if (declared === undefined) {
      this.#log("error", `refused an emit on undeclared port ${JSON.stringify(port)}`);
      return;
    }
    const input = inputId === undefined ? undefined : this.#inputs.get(inputId);
    if (inputId !== undefined && input === undefined) {
      this.#log("error", `refused an emit for unknown input ${JSON.stringify(inputId)}`);
      return;
    }
    const event = this.#envelope(declared.event);
    if (inputId === undefined || input === undefined) {
      // A new run: its id is this event's id (spec 5.4.2, 5.5).
      const message = { payload: data, topic: declared.event, inny: { event, run: event.id } };
      this.#host.send({ index, port, message });
      return;
    }
    // Caused by an input: it keeps the input's run and names the input (spec 5.4.1).
    const run = input.event.run ?? event.id;
    const output: NodeOutput = {
      index,
      port,
      message: { payload: data, topic: declared.event, inny: { event, run, cause: inputId } },
    };
    input.delivery.send(output);
  }

  /** Every field stamped by the runtime; nothing comes from the process (spec 5.3, 11.2). */
  #envelope(type: string): EventEnvelope {
    const { package: pkg, typeId, id } = this.#spec.identity;
    return {
      specversion: "1.0",
      id: this.#deps.newId(),
      source: `inny://${pkg}/${typeId}/${id}`,
      type,
      time: new Date(this.#deps.clock.now()).toISOString(),
      datacontenttype: "application/json",
    };
  }

  #onPresent(inputId: string, content: ViewContent): void {
    const input = this.#inputs.get(inputId);
    if (input === undefined) {
      this.#log("error", `refused a present for unknown input ${JSON.stringify(inputId)}`);
      return;
    }
    input.state = "awaiting";
    const timeout = this.#spec.viewTimeoutMs ?? null;
    const { first, deadline } = this.#journal.presented(inputId, content, timeout);
    this.#deadlines.arm(inputId, deadline);
    this.#host.present(inputId, content, first);
  }

  /** The journaled deadline passed with the view pending: emit on `timeout`, end the step. */
  #timedOut(inputId: string): void {
    const input = this.#inputs.get(inputId);
    if (input?.state !== "awaiting") {
      return;
    }
    this.#log("info", `view ${inputId} timed out; the flow continues from its timeout output`);
    this.#onEmit(TIMEOUT_PORT, input.event.data, inputId);
    this.#child?.stdin.write(encodeFrame({ t: "cancel", in: inputId })); // the node forgets it
    this.#finish(inputId, undefined);
  }

  #onSnapshot(content: ViewContent, state: unknown, inputId: string | undefined): void {
    if (inputId !== undefined && !this.#inputs.has(inputId)) {
      this.#log("error", `refused a snapshot for unknown input ${JSON.stringify(inputId)}`);
      return;
    }
    this.#host.snapshot(content, state, inputId ?? null);
  }

  /** The terminal frame of an input; a second one, or one for an unknown id, is ignored. */
  #finish(inputId: string, error: Error | undefined): void {
    const input = this.#inputs.get(inputId);
    if (input === undefined) {
      this.#log("warn", `ignored done/error for unknown or finished input ${inputId}`);
      return;
    }
    this.#inputs.delete(inputId);
    this.#deadlines.disarm(inputId);
    // Cleared before Node-RED hears of it: a crash in between loses nothing that was not done,
    // and never re-sends a step that was.
    this.#journal.finished(inputId);
    input.delivery.done(error);
    // A place under the bound: the oldest held input goes next (spec 7.6).
    const next = this.#closing || this.#stopped ? undefined : this.#journal.nextHeld();
    if (next !== undefined) {
      const admitted = this.#journal.admit(next.message, next.delivery, this.#inputs.size);
      if (admitted !== null) {
        this.#queue(admitted, next.delivery);
      }
    }
  }

  #fail(inputId: string, error: Error): void {
    this.#log("error", `input ${inputId} failed: ${error.message}`);
    this.#finish(inputId, error);
  }

  // ── writing ────────────────────────────────────────────────────────────────────────────

  #sendInput(id: string, input: Input): void {
    let line: string;
    try {
      line = encodeFrame({ t: "input", id, event: input.event });
    } catch (error) {
      this.#fail(
        id,
        error instanceof FrameTooLargeError ? new Error("frame too large") : (error as Error),
      );
      return;
    }
    this.#child?.stdin.write(line);
    if (input.state === "queued") {
      input.state = "sent";
    }
  }

  #write(frame: RuntimeFrame): void {
    if (this.#child === null) {
      this.#log("warn", `no process is running; a ${frame.t} frame was not sent`);
      return;
    }
    this.#child.stdin.write(encodeFrame(frame));
  }

  // ── time and logging ───────────────────────────────────────────────────────────────────

  #after(ms: number, callback: () => void): void {
    this.#timers.push(this.#deps.clock.after(ms, callback));
  }

  #cancelTimers(): void {
    for (const cancel of this.#timers.splice(0)) {
      cancel();
    }
  }

  /** The runtime's own words about this node. */
  #log(level: "info" | "warn" | "error", message: string): void {
    this.#deps.logger[level](`${this.#who} ${message}`);
  }

  /** A line the node itself wrote: stderr, stray stdout, or a `log` frame (spec 3.3, 3.4). */
  #line(level: NodeLineLevel, text: string): void {
    const { type, id } = this.#spec.identity;
    this.#deps.logger.nodeLine?.({ type, instance: id }, level, text);
  }
}

function statusOf(frame: Extract<NodeFrame, { t: "status" }>): NodeStatus {
  return { text: frame.text, fill: frame.fill ?? "blue", shape: frame.shape ?? "dot" };
}
