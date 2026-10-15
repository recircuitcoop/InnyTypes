// AppApi: the ONLY surface the app window may use (plan 0018 §2.4), exposed through the
// preload bridge as `window.inny.app`. Plan 0022 §N's calls are AppApiV2 (app-api-v2.ts); the
// members spelled out here are the older ones the redesigned screens still use. Every call
// travels over IPC to the shell, and on over the channel to a child: never HTTP (spec 10.1).
//
// ViewBridge is the other surface: the five id-less calls a pop-out page has (spec 8.5.6).
//
// The UI imports nothing outside ui/, so the types it needs are spelled out here. The shell
// assigns the supervisor's own types to these, so the compiler keeps the two the same.

import type { AppApiV2 } from "./app-api-v2";

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
 * files where there is none (Linux without a keyring). General's Advanced shows it.
 */
export interface SecretStorageStatus {
  readonly backend: "keychain" | "file";
  /** Why the keychain is not used, in words for a person; null when it is. */
  readonly reason: string | null;
}

/** The launch-at-login switch (WI-0018-21), and why it did not move when it did not. */
export interface LaunchAtLoginStatus {
  readonly on: boolean;
  readonly problem: string | null;
}

/**
 * The telemetry switch (WI-0018-22). `unset` is the first-launch question not answered yet: the
 * app asks it, with the privacy notice (worded in strings.ts), and sends nothing at all until it
 * is answered.
 */
export interface TelemetryStatus {
  readonly answer: "on" | "off" | "unset";
  /** Why the switch could not be read; null when it was. */
  readonly problem: string | null;
  /** Reports waiting to be sent: none unless the switch is on. */
  readonly queued: number;
}

/**
 * A report waiting to be sent: its payload as it was queued (redacted then). Sending wraps it for
 * its endpoint, adding the release, the website id and the endpoint's own fields.
 */
export interface TelemetryReport {
  readonly kind: "usage" | "error";
  readonly payload: Readonly<Record<string, unknown>>;
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

/** A node set: its id and its types, as the editor's registry and the runtime both list it. */
export interface NodeSetSummary {
  readonly id: string;
  readonly types: readonly string[];
}

/** What the editor in the app window holds now (WI-0018-12). */
export interface EditorPalette {
  /** The node sets its palette holds. */
  readonly sets: readonly NodeSetSummary[];
  /** It holds edits not yet deployed. */
  readonly dirty: boolean;
}

/** The person's answer when a quit finds undeployed edits in the editor. */
export type QuitChoice = "deploy" | "discard" | "cancel";

/** A quit found undeployed edits; `problem` says why the choice before did not work. */
export interface QuitQuestion {
  readonly problem: string | null;
}

export type { Answer, Refusal, RefusalReason } from "./answer";
export type { AppApiV2 } from "./app-api-v2";
export type {
  FlowAnswer,
  FlowNamed,
  FlowSummary,
  FlowTemplateEntry,
  NodeForm,
  NodeOptions,
  NodeOptionsQuery,
} from "./flow-contract";
export type {
  BoardChange,
  BoardChanged,
  BoardLayout,
  BoardView,
  ChosenFolder,
  Retention,
  RollbackOffer,
  RuntimeBanner,
  SetupMove,
  SetupState,
  StatusPill,
  StatusView,
  UpdateState,
  UpdateView,
} from "./general-contract";
export type {
  ClearedCount,
  RerunStarted,
  RunAnswer,
  RunLineRecord,
  RunListQuery,
  RunPage,
  RunRecord,
  RunsChanged,
  RunStepRecord,
} from "./run-contract";

export interface AppApi extends AppApiV2 {
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
  /** Submit a pending view; `{__dismiss__: true}` dismisses it (spec 8.2). */
  submitView(id: string, values: Readonly<Record<string, unknown>>): Promise<ViewResult>;
  /** Answer: the pending view in its own pop-out, or the open one focused. */
  openView(id: string): Promise<void>;
  /** The editor's palette and whether it is dirty; null while no editor is loaded. */
  editorPalette(): Promise<EditorPalette | null>;
  /** Called when a quit finds undeployed edits and the person must choose. */
  onQuitQuestion(listener: (question: QuitQuestion) => void): void;
  /** The person's choice: Deploy and quit, Quit and discard, or Cancel. */
  answerQuit(choice: QuitChoice): Promise<void>;
  /** The launch-at-login switch (WI-0018-21). */
  launchAtLogin(): Promise<LaunchAtLoginStatus>;
  /** Turn it on or off: the OS is asked first, and a refusal leaves it where it was. */
  setLaunchAtLogin(on: boolean): Promise<LaunchAtLoginStatus>;
  /** The telemetry switch and whether the first-launch question is answered (WI-0018-22). */
  telemetry(): Promise<TelemetryStatus>;
  /** Answer the question, or move the switch: off deletes what waits. Rejects with a sentence. */
  setTelemetry(on: boolean): Promise<TelemetryStatus>;
  /** "See what would be sent": the queued reports, in full, oldest first; none unless it is on. */
  telemetryReports(): Promise<readonly TelemetryReport[]>;
  /** The old installation's plugin environments still on disk, by id (WI-0018-25). */
  legacyPackages(): Promise<readonly string[]>;
  /** Delete them all. Nothing is deleted without this call: the notice's own button. */
  deleteLegacyPackages(): Promise<readonly string[]>;
}

/**
 * A pop-out page's whole reach, as `window.inny` (spec 8.5.6). No call takes an id: the shell
 * answers for the one view or snapshot the window was opened for.
 */
export interface ViewBridge {
  /** `{kind: "view" | "snapshot" | "gone", …}`, or why not (the runtime is restarting). */
  get(): Promise<ViewResult>;
  /** Action views only: submit (or dismiss with `{__dismiss__: true}`). */
  submit(values: Readonly<Record<string, unknown>>): Promise<ViewResult>;
  /** Snapshots only: press an action. */
  action(actionId: string, values: Readonly<Record<string, unknown>>): Promise<ViewResult>;
  /** Action views only: keep the person's unfinished answer; never sent (spec 8.1.6). */
  draft(values: Readonly<Record<string, unknown>>): Promise<ViewResult>;
  /** Page-local: enable (or disable) Continue, by an `inny-valid` event; no IPC call. */
  setValid(valid: boolean): void;
}

/** The event `setValid` dispatches on the page's `window`; its `detail` is the boolean. */
export const VALID_EVENT = "inny-valid";
