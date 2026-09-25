// AppApi: the ONLY surface the app pages may use (plan 0018 §2.4), exposed through the
// preload bridge as `window.inny.app`. Its other members (inbox, submit, snapshots, actions,
// event types, jobs, cancel, packages, settings) arrive with WI-0018-11; Anytype pairing and
// status arrived with WI-0018-18, for the Settings page WI-0018-11 builds.
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

/**
 * Where the application keeps its own secrets (WI-0018-06): the system keychain, or owner-only
 * files where there is none (Linux without a keyring). The Settings page shows it.
 */
export interface SecretStorageStatus {
  readonly backend: "keychain" | "file";
  /** Why the keychain is not used, in words for a person; null when it is. */
  readonly reason: string | null;
}

/** The Anytype core service's state (WI-0018-18); see domain/anytype/status.ts. */
export type AnytypeState =
  | "no-key"
  | "unreachable"
  | "starting"
  | "ready"
  | "tool-surface-mismatch"
  | "down"
  | "down-for-good"
  | "stopped";

export interface AnytypeStatus {
  readonly state: AnytypeState;
  /** What a person is told about the state; null when there is nothing to add. */
  readonly detail: string | null;
  /** The MCP child's pid while one runs. */
  readonly childPid: number | null;
  /** Pings the current MCP child answered. */
  readonly beats: number;
  /** A pairing waits for its four-digit code. */
  readonly pairing: boolean;
}

/** An action view presented (spec 8.1): the runtime's `present`, as the shell passes it on. */
export interface ViewPresented {
  readonly id: string;
  readonly window: "inline" | "popout";
  /** False for a re-presentation: it waits quietly in the Inbox and opens nothing by itself. */
  readonly first: boolean;
  readonly title: string;
}

/**
 * What a view or snapshot call answers (WI-0018-10): the runtime's value, or why not. A press
 * of a disabled action is refused with `status: 409` and the reason (spec 8.4); a runtime that
 * is not running answers with the channel's `code` (spec 10.3).
 */
export type ViewResult =
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false;
      readonly error: string;
      readonly status?: 409;
      readonly code?: "restarting" | "down" | "timeout" | "stopped";
    };

/**
 * The loopback MCP endpoint (WI-0018-19); see domain/endpoint/status.ts. Neither credential is
 * ever in it: a client needs the URL and the proxy token file, and the page shows only the URL.
 */
export interface McpEndpointStatus {
  /** The URL being served now; null when nothing is. */
  readonly served: string | null;
  /** The URL the setting resolves to; null when it cannot be served. */
  readonly saved: string | null;
  /** Any part of the saved address came from the stored setting. */
  readonly stored: boolean;
  /** INNYTYPES_MCP_HOST or INNYTYPES_MCP_PORT set and ignored, because a stored value wins. */
  readonly ignoredVariables: readonly string[];
  /** Why nothing is served, or why saved and served differ; null when they agree. */
  readonly problem: string | null;
  /** Shown beside the edit: clients must be updated to the new URL. */
  readonly warning: string;
}

export interface AppApi {
  /** Where the application's secrets are kept, and why when it is not the keychain. */
  secretStorage(): Promise<SecretStorageStatus>;
  /** Every supervised child's status now. */
  childStatus(): Promise<readonly ChildStatus[]>;
  /** Called with a child's status each time it changes. */
  onChildStatus(listener: (status: ChildStatus) => void): void;
  /** The Restart button: start a child the crash-loop limit stopped. */
  restartChild(child: ChildName): Promise<void>;
  /** The Anytype core service now: its state, the MCP child's pid and beats. */
  anytypeStatus(): Promise<AnytypeStatus>;
  /** "Pair with Anytype": Anytype shows a four-digit code. Rejects with a sentence. */
  startAnytypePairing(): Promise<AnytypeStatus>;
  /** The code Anytype shows. The key is stored owner-only and never reaches the page. */
  completeAnytypePairing(code: string): Promise<AnytypeStatus>;
  /** The MCP endpoint now: the URL served against the URL saved. */
  mcpEndpoint(): Promise<McpEndpointStatus>;
  /**
   * Move the MCP endpoint: the new address is bound before the old one closes, and stored once
   * it is served. Rejects with the reason (a non-loopback address, a port that is taken); the
   * old endpoint then still serves and nothing was stored.
   */
  moveMcpEndpoint(host: string, port: number): Promise<McpEndpointStatus>;
  /** Called each time an action view presents (spec 8.1), first or again after a restart. */
  onViewPresented(listener: (view: ViewPresented) => void): void;
  /** Called with the number of pending action views each time it changes: the Inbox badge. */
  onPendingViews(listener: (count: number) => void): void;
  /** The pending views last counted by the runtime; null before it has said. */
  pendingViews(): Promise<number | null>;
  /** The pending view `id`: `{kind: "view", content, …}`, or `{kind: "gone"}`. */
  view(id: string): Promise<ViewResult>;
  /** Submit a pending view; `{__dismiss__: true}` dismisses it (spec 8.2). */
  submitView(id: string, values: Readonly<Record<string, unknown>>): Promise<ViewResult>;
  /** The snapshot `id`, each action judged against the flow now (spec 8.3, 8.4). */
  snapshot(id: string): Promise<ViewResult>;
  /** Press a snapshot's action: a new run, or 409 and the reason (spec 8.3.3, 8.4). */
  pressAction(
    id: string,
    action: string,
    values: Readonly<Record<string, unknown>>,
  ): Promise<ViewResult>;
}
