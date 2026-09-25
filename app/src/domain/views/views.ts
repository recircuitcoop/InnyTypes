// Views (spec §8, plan 0017 Views): what an instance's config says about its view, what a
// snapshot keeps, and whether each of a snapshot's actions can be pressed NOW.
//
// An action view makes the flow wait for the person; a snapshot view records what the flow
// produced, and its actions start new runs from their own output ports. A snapshot outlives
// the view that took it: when that view is deleted from the flow, or an action's port is
// wired to nothing, the action is shown disabled with the reason, and a press is refused
// with it (spec 8.4). A press is never dropped in silence.
//
// Pure: no I/O.

/** Where a view opens (spec 2.4 `window`, 8.5.1). */
export type ViewWindow = "inline" | "popout";

/**
 * The output port an action view's optional timeout fires on (plan 0017 "after 7 days,
 * continue"). The runtime, not the node, emits on it when the journaled deadline passes.
 */
export const TIMEOUT_PORT = "timeout";

/** The config property that sets the timeout, in seconds (a view's own config schema). */
export const TIMEOUT_PROPERTY = "timeout_seconds";

/** The reason an action press is refused, as spec 8.4 words it; answered with HTTP 409. */
export const REFUSED_STATUS = 409;
export const GONE_FROM_FLOW = "The view that took this snapshot is no longer in the flow.";
export const unwired = (label: string): string => `Nothing is wired to the "${label}" output.`;
export const NOT_RUNNING = "The view's process is not running; try again in a moment.";

/** One declared action of a snapshot view (spec 2.4 `actions`). */
export interface SnapshotAction {
  readonly id: string;
  readonly label: string;
  readonly event: string;
  readonly form?: Readonly<Record<string, unknown>>;
}

/** What a snapshot keeps (spec 8.3.1). Not live: what the flow produced at that moment. */
export interface SnapshotRecord {
  readonly id: string;
  readonly instanceId: string;
  /** The Node-RED type name of the view that took it. */
  readonly type: string;
  /** The instance's name on the canvas, else the type's label. */
  readonly label: string;
  readonly time: number;
  readonly content: Readonly<Record<string, unknown>>;
  readonly state: unknown;
  readonly window: ViewWindow;
  readonly actions: readonly SnapshotAction[];
}

/** The instance that took a snapshot, as the deployed flow holds it now. */
export interface DeployedView {
  /** The type's output ports in port order (spec 2.2): pass-through, then actions. */
  readonly ports: readonly string[];
  /** Node-RED's `wires`: for each port, the ids of the nodes it is wired to. */
  readonly wires: readonly (readonly string[])[];
  /** Whether its node process is running, so a trigger can reach it. */
  readonly running: boolean;
}

/** An action as the person sees it: enabled, or disabled with the reason. */
export interface JudgedAction extends SnapshotAction {
  readonly enabled: boolean;
  readonly reason: string | null;
}

/**
 * Judge one action against the flow as it is now (spec 8.4): null when it can be pressed,
 * else the reason. `deployed` is null when the instance is no longer in the flow.
 */
export function refusalOf(action: SnapshotAction, deployed: DeployedView | null): string | null {
  if (deployed === null) {
    return GONE_FROM_FLOW;
  }
  const index = deployed.ports.indexOf(action.id);
  if (index === -1 || (deployed.wires[index] ?? []).length === 0) {
    return unwired(action.label);
  }
  if (!deployed.running) {
    return NOT_RUNNING;
  }
  return null;
}

export function judgeActions(
  record: SnapshotRecord,
  deployed: DeployedView | null,
): JudgedAction[] {
  return record.actions.map((action) => {
    const reason = refusalOf(action, deployed);
    return { ...action, enabled: reason === null, reason };
  });
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The instance's `window` choice; inline unless it says popout (spec 8.5.1). */
export function windowOf(config: Readonly<Record<string, unknown>>): ViewWindow {
  return config["window"] === "popout" ? "popout" : "inline";
}

/**
 * The instance's timeout in ms: only an action view that declares a `timeout` port has one,
 * and only when its config sets a positive `timeout_seconds`. Null otherwise.
 */
export function timeoutOf(
  config: Readonly<Record<string, unknown>>,
  ports: readonly string[],
): number | null {
  const seconds = config[TIMEOUT_PROPERTY];
  if (!ports.includes(TIMEOUT_PORT) || typeof seconds !== "number" || !(seconds > 0)) {
    return null;
  }
  return Math.round(seconds * 1000);
}

/** The heading a view's content gives itself (spec 8.1.3), for the inbox and the notice. */
export function titleOf(content: Readonly<Record<string, unknown>>): string {
  return typeof content["title"] === "string" ? content["title"] : "";
}

/** Whether a value read back from storage is a snapshot record of this shape. */
export function isSnapshotRecord(value: unknown): value is SnapshotRecord {
  if (!isRecord(value)) {
    return false;
  }
  const { id, instanceId, type, label, time, content, window, actions } = value;
  return (
    typeof id === "string" &&
    typeof instanceId === "string" &&
    typeof type === "string" &&
    typeof label === "string" &&
    typeof time === "number" &&
    isRecord(content) &&
    (window === "inline" || window === "popout") &&
    Array.isArray(actions) &&
    actions.every(
      (action) =>
        isRecord(action) &&
        typeof action["id"] === "string" &&
        typeof action["label"] === "string" &&
        typeof action["event"] === "string",
    )
  );
}
