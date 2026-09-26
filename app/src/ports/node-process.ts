// One node instance's process, as the runtime holds it (spec §3–§6, plan 0018 §3 `children.py`).
//
// The adapter (adapters/process/node-process.ts) speaks protocol v2 to the process; whoever
// hosts the instance (the Node-RED glue of WI-0018-08) gives it inputs and receives what the
// process emits through this port. The host never sees a frame: it sees Node-RED-shaped
// messages whose envelope the runtime stamped (spec 5.3, 11.2).

import type { CloseReason, JournaledMessage } from "../domain/journal/entry";
import type { QueueReport } from "../domain/journal/queue";

/** An input as Node-RED delivers it: the journal keeps these four fields (spec 7.1). */
export type InputMessage = JournaledMessage;

/** A Node-RED status (spec 4.2 `status`). */
export interface NodeStatus {
  readonly text: string;
  readonly fill: "red" | "green" | "yellow" | "blue" | "grey";
  readonly shape: "ring" | "dot";
}

/** One declared output port, in declaration order: `outputs[]`, then snapshot `actions[]`. */
export interface OutputPort {
  readonly port: string;
  readonly event: string;
}

/** The CloudEvents-shaped envelope the runtime stamps on every emission (spec 5.3). */
export interface EventEnvelope {
  readonly specversion: "1.0";
  readonly id: string;
  readonly source: string;
  readonly type: string;
  readonly time: string;
  readonly datacontenttype: "application/json";
}

/** What goes on a wire (spec 5.1), before Node-RED adds or keeps `_msgid`. */
export interface NodeMessage {
  readonly payload: unknown;
  readonly topic: string;
  readonly inny: {
    readonly event: EventEnvelope;
    readonly run: string;
    /** The input id that caused this output; absent for a new run. */
    readonly cause?: string;
  };
}

/** One emission, with the port index it goes out on (spec 5.4.3). */
export interface NodeOutput {
  readonly index: number;
  readonly port: string;
  readonly message: NodeMessage;
}

/** The event an input carries to the process (spec 4.1 `input`). */
export interface InputEvent {
  readonly type: string;
  readonly data: unknown;
  readonly run?: string;
}

/** Where the outputs and the end of ONE input go: Node-RED's `send` and `done` for it. */
export interface InputDelivery {
  send(output: NodeOutput): void;
  /** Called exactly once: with no error for `done`, with one for `error` or a failure. */
  done(error?: Error): void;
}

/** View content (spec 4.5 `viewContent`). */
export type ViewContent = Readonly<Record<string, unknown>>;

/** What the instance's host is told that belongs to no one input. */
export interface NodeProcessHost {
  status(status: NodeStatus): void;
  /** An emission with no `in`: a new run (spec 5.4.2). */
  send(output: NodeOutput): void;
  /**
   * An action view presented `inputId`; the input is now awaiting (spec 8.1). `first` is
   * computed from the journal: false for a re-presentation after a restart or a re-send.
   */
  present(inputId: string, content: ViewContent, first: boolean): void;
  /** A snapshot view recorded this (spec 8.3). */
  snapshot(content: ViewContent, state: unknown, inputId: string | null): void;
  /** An `error` frame with no `in`: `node.error()`, no Catch (spec 4.2). */
  nodeError(message: string): void;
}

/** Who the instance is. */
export interface NodeIdentity {
  /** The instance id on the canvas. */
  readonly id: string;
  /** The package name and the type id within it (spec 2.1). */
  readonly package: string;
  readonly typeId: string;
  /** The Node-RED type name, `inny-<package>-<id>` (spec 2.1.4). */
  readonly type: string;
  /** The instance's name on the canvas; empty when it has none. */
  readonly name: string;
  readonly kind: "source" | "node" | "view";
}

/** Everything a node process is started with. Nothing is inherited that is not named here. */
export interface NodeProcessSpec {
  readonly identity: NodeIdentity;
  /** The argv, placeholders already substituted (spec 2.3). */
  readonly argv: readonly string[];
  /** The unpacked package directory (spec 2.3.4). */
  readonly cwd: string;
  /** The process's whole environment: never the runtime's own (plan 0018 §7). */
  readonly env: Readonly<Record<string, string>>;
  readonly config: Readonly<Record<string, unknown>>;
  readonly credentials: Readonly<Record<string, string>>;
  readonly dataDir: string;
  readonly ports: readonly OutputPort[];
  /**
   * An action view's timeout (domain/views `timeoutOf`): when its journaled deadline passes
   * with the view still pending, the runtime emits on port `timeout` and ends the step.
   */
  readonly viewTimeoutMs?: number | null;
}

/** One instance's process, respawned after an unexpected exit until the breaker trips. */
export interface NodeProcess {
  /** The current process's pid; null while none is running. */
  readonly pid: number | null;
  /**
   * The current process sent `ready` (spec 3.1). The update of a package waits for this from
   * every instance of its types (WI-0018-17); undefined where a host cannot say.
   */
  readonly ready?: boolean;
  /**
   * A message arrived at the instance (Node-RED's `input`). It is journaled, then its `input`
   * frame is written (spec 7.1), unless the queue is at its bound (spec 7.6). A message this
   * instance handed to `replay` is the journaled input again, under its original id. Returns
   * the input id; null when the input was refused or held.
   */
  input(message: InputMessage, delivery: InputDelivery): string | null;
  cancel(inputId: string): void;
  /**
   * An action view was submitted or dismissed (spec 8.2); the input is `sent` again. False,
   * and nothing sent, when no view of this instance waits on `inputId`.
   */
  action(inputId: string, values: Readonly<Record<string, unknown>>): boolean;
  /**
   * A snapshot's action was pressed (spec 8.3.3): `trigger` to the current process. False,
   * and nothing sent, when no process is running to receive it.
   */
  trigger(action: string, snapshot: { id: string; state: unknown }, values: object): boolean;
  fire(data: Readonly<Record<string, unknown>>): void;
  /**
   * `close`, then `closed` and the exit; SIGKILL at the deadline (spec 6.2, 6.3). Why it
   * closes decides what happens to its journal entries (spec 6.7, 7.3).
   */
  close(reason: CloseReason): Promise<void>;
  /**
   * Replay (spec 7.2): hand each journaled entry of this instance to `redeliver` (Node-RED's
   * `node.receive`), as a message of its journaled fields and nothing else. Returns how many.
   */
  replay(redeliver: (message: InputMessage) => void): number;
  /** Its queue now: outstanding, held and refused inputs against the bound (spec 7.6). */
  queue(): QueueReport;
}

export interface NodeProcessLauncher {
  start(spec: NodeProcessSpec, host: NodeProcessHost): NodeProcess;
}
