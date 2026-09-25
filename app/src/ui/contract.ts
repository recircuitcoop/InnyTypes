// AppApi: the ONLY surface the app pages may use (plan 0018 §2.4), exposed through the
// preload bridge as `window.inny.app`. Its other members (inbox, submit, snapshots, actions,
// event types, jobs, cancel, packages, settings, pairing) arrive with WI-0018-11.
//
// The UI imports nothing but this file, so the types it needs are spelled out here. The shell
// assigns the supervisor's own types to these, so the compiler keeps the two the same.

/** A supervised child process. */
export type ChildName = "runtime" | "services";

/** `childState` (spec 10.8), with the crash-loop limit's `down-for-good`. */
export type ChildState =
  | "starting"
  | "running"
  | "restarting-planned"
  | "restarting"
  | "recovering"
  | "down"
  | "down-for-good"
  | "stopped";

export interface ChildStatus {
  readonly child: ChildName;
  readonly state: ChildState;
  readonly generation: number;
  readonly pid: number | null;
  readonly port: number | null;
  /** What a person is told when the state is down-for-good; null otherwise. */
  readonly error: string | null;
}

export interface AppApi {
  /** Every supervised child's status now. */
  childStatus(): Promise<readonly ChildStatus[]>;
  /** Called with a child's status each time it changes. */
  onChildStatus(listener: (status: ChildStatus) => void): void;
  /** The Restart button: start a child the crash-loop limit stopped. */
  restartChild(child: ChildName): Promise<void>;
}
