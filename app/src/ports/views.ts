// The runtime's views (spec §8), as the Node-RED glue (adapters/nodered/registration.ts) tells
// them what its instances do. The application's ViewService (application/views.ts) implements
// it: it keeps the snapshots, raises `present` and the pending count to the shell, and
// answers the shell's view and snapshot calls against the instances attached here.

import type { SnapshotAction, ViewWindow } from "../domain/views/views";
import type { NodeProcess, ViewContent } from "./node-process";

/** A deployed view instance, as the Node-RED glue holds it while it is in the flow. */
export interface LiveView {
  /** Its node process: submissions and presses go to the CURRENT one (spec 8.3.3). */
  readonly node: Pick<NodeProcess, "action" | "trigger" | "pid">;
  /** The Node-RED type name. */
  readonly type: string;
  /** The instance's name, else the type's label. */
  readonly label: string;
  readonly window: ViewWindow;
  /** Its output ports in port order: pass-through, then actions (spec 2.2). */
  readonly ports: readonly string[];
  /** Node-RED's `wires` of the deployed instance, one list per port. */
  readonly wires: readonly (readonly string[])[];
  /** A snapshot view's declared actions; empty for an action view. */
  readonly actions: readonly SnapshotAction[];
}

export interface Presented {
  readonly inputId: string;
  readonly instanceId: string;
  readonly content: ViewContent;
  /** Computed from the journal: the entry had no stored content before (spec 8.1.2). */
  readonly first: boolean;
}

export interface Snapshotted {
  readonly instanceId: string;
  readonly content: ViewContent;
  readonly state: unknown;
}

export interface Views {
  /** A view instance was constructed; the returned function detaches it on close. */
  attach(instanceId: string, view: LiveView): () => void;
  /** An action view presented (spec 8.1). */
  presented(presented: Presented): void;
  /** A snapshot view recorded (spec 8.3). */
  snapshot(snapshot: Snapshotted): void;
  /** Something may have changed the number of pending views: a step ended, an instance closed. */
  changed(): void;
}
