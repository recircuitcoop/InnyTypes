// AppApi: the ONLY surface the app pages may use (plan 0018 §2.4), exposed through the
// preload bridge as `window.inny.app`. Every call travels over IPC to the shell, and on over
// the channel to a child: never HTTP (spec 10.1). Event types arrived with WI-0018-13 and
// packages with WI-0018-16.
//
// ViewBridge is the other surface: the three id-less calls a pop-out page has (spec 8.5.6).
//
// The UI imports nothing outside ui/, so the types it needs are spelled out here. The shell
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

/** A pending action view in the Inbox; the shell keeps the last list while the runtime is down. */
export interface InboxEntry {
  readonly id: string;
  readonly title: string;
  readonly window: "inline" | "popout";
}

/** One snapshot in the Snapshots page's list, newest first (spec 8.3). */
export interface SnapshotSummary {
  readonly id: string;
  readonly instanceId: string;
  readonly label: string;
  readonly title: string;
  /** Epoch ms. */
  readonly time: number;
}

/** One input a node is working on now: a journal entry in state `sent` (spec 7). */
export interface Job {
  /** The input id. */
  readonly id: string;
  readonly instanceId: string;
  /** The Node-RED type name of the instance. */
  readonly type: string;
  readonly attempts: number;
  /** Epoch ms. */
  readonly createdAt: number;
}

/** A list the runtime answers, or why not (the runtime is down: `code`). */
export type ListResult<T> =
  | { readonly ok: true; readonly value: readonly T[] }
  | { readonly ok: false; readonly error: string; readonly code?: string };

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

/** What the runtime is asked to raise so the editor's palette matches it. */
export interface PaletteChange {
  /** Set ids the editor lacks: Node-RED's `node/added`. */
  readonly added: readonly string[];
  /** Sets the editor holds and the runtime no longer has: Node-RED's `node/removed`. */
  readonly removed: readonly NodeSetSummary[];
}

/** A package on the Packages page (WI-0018-16). */
export interface ListedPackage {
  readonly name: string;
  readonly version: string;
  /** Shipped with the app, or installed by a person. */
  readonly kind: "shipped" | "installed";
  /** False only for an installed package no publisher signed: it is marked unsigned. */
  readonly signed: boolean;
}

/** One entry of the catalogue, as the Packages page offers it. */
export interface CatalogueOffer {
  readonly id: string;
  /** The package name it installs as. */
  readonly name: string;
  readonly summary: string;
  /** It names a signed archive this build can install. */
  readonly installable: boolean;
  readonly installed: boolean;
  /** The catalogue carried a signature that checked out. */
  readonly verified: boolean;
}

export interface PackagesState {
  readonly packages: readonly ListedPackage[];
  readonly catalogue: readonly CatalogueOffer[];
  /** Why no catalogue could be listed; null when it was. */
  readonly catalogueProblem: string | null;
}

/**
 * What an install or a removal came to. `needsConfirmation`: the package is unsigned, and is
 * installed only when the person confirms exactly that.
 */
export type PackageOutcome =
  | { readonly ok: true; readonly message: string }
  | { readonly ok: false; readonly error: string; readonly needsConfirmation?: true };

/**
 * One version of an event type created in the app (spec §9, WI-0018-13): `user.<name>.v<N>`,
 * its payload's JSON Schema 2020-12, and the nodes using it, deployed and only in the editor.
 */
export interface EventTypeSummary {
  readonly name: string;
  readonly version: number;
  readonly type: string;
  readonly label: string;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
  /** Its source's Node-RED type, `inny-user-events-<name>-v<N>`. */
  readonly nodeType: string;
  readonly deployed: readonly string[];
  readonly undeployed: readonly string[];
}

/** The person's answer when a quit finds undeployed edits in the editor. */
export type QuitChoice = "deploy" | "discard" | "cancel";

/** A quit found undeployed edits; `problem` says why the choice before did not work. */
export interface QuitQuestion {
  readonly problem: string | null;
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
  /** The Inbox: the pending action views, as last known (kept while the runtime is down). */
  inbox(): Promise<readonly InboxEntry[]>;
  /** Called with the whole Inbox each time it changes. */
  onInbox(listener: (entries: readonly InboxEntry[]) => void): void;
  /** "Open in window": the pending view in its own pop-out, or the open one focused. */
  openView(id: string): Promise<void>;
  /** The snapshots kept, newest first. */
  snapshots(): Promise<ListResult<SnapshotSummary>>;
  /** A snapshot in a pop-out, only because the person asked (spec 8.5.1). */
  openSnapshot(id: string): Promise<void>;
  /** The inputs the nodes are working on now. */
  jobs(): Promise<ListResult<Job>>;
  /** Cancel an input (spec 4.1 `cancel`): the node stops it and answers with an error. */
  cancelJob(id: string): Promise<ViewResult>;
  /** Quit InnyTypes: the one quit, which stops every process (closing the window does not). */
  quit(): Promise<void>;
  /** The editor's palette and whether it is dirty; null while no editor is loaded. */
  editorPalette(): Promise<EditorPalette | null>;
  /** The node sets the runtime has now. */
  runtimeNodeSets(): Promise<ListResult<NodeSetSummary>>;
  /** Ask the runtime to raise `node/added` and `node/removed` for what the editor lacks. */
  raiseNodeEvents(change: PaletteChange): Promise<ViewResult>;
  /** The created event types, every version, with the nodes that use each (WI-0018-13). */
  eventTypes(): Promise<ListResult<EventTypeSummary>>;
  /**
   * Create `user.<name>.v1` with a payload schema (JSON Schema 2020-12). Only the runtime
   * restarts for it; the editor keeps its edits. Refused with the reason (409: a duplicate).
   */
  createEventType(
    name: string,
    label: string,
    schema: Readonly<Record<string, unknown>>,
  ): Promise<ViewResult>;
  /** A new version, `.v<N+1>`, with a changed schema; an unchanged one is refused (409). */
  versionEventType(name: string, schema: Readonly<Record<string, unknown>>): Promise<ViewResult>;
  /** Delete a version; refused (409), naming the nodes, while a deployed or undeployed node uses it. */
  deleteEventType(type: string): Promise<ViewResult>;
  /** Fire a version from every deployed source of it, after validating `values`: a new run each. */
  fireEvent(type: string, values: Readonly<Record<string, unknown>>): Promise<ViewResult>;
  /** Called when a quit finds undeployed edits and the person must choose. */
  onQuitQuestion(listener: (question: QuitQuestion) => void): void;
  /** The person's choice: Deploy and quit, Quit and discard, or Cancel. */
  answerQuit(choice: QuitChoice): Promise<void>;
  /** The Packages page: every package here, and what the catalogue offers (WI-0018-16). */
  packages(): Promise<PackagesState>;
  /** Install a catalogue entry from its signed archive; only the runtime restarts. */
  installFromCatalogue(id: string): Promise<PackageOutcome>;
  /** "Install from file…": the shell's own file chooser; null when the person cancelled. */
  chooseInstallFile(): Promise<string | null>;
  /** Install a package folder or `.tgz`, unsigned: refused unless `unsignedConfirmed`. */
  installFromFile(file: string, unsignedConfirmed: boolean): Promise<PackageOutcome>;
  /** Remove an installed package; refused while any flow, deployed or not, uses its types. */
  removePackage(name: string): Promise<PackageOutcome>;
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
}
