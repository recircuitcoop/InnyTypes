// AppApi v2 (plan 0022 §N): every call the redesigned screens make, and the push events that keep
// ui/store.ts current. contract.ts's AppApi extends it with the calls only the old pages use
// until WI-0022-21's cutover removes them.
//
// Every call answers an Answer (answer.ts): a value, or a refusal carrying a ui/strings.ts key.
// Nothing throws across IPC. A call declared before its work item lands is refused with
// `not-available` by the shell, and says which item answers it:
// * rerun, rerunMany, deleteRuns: WI-0022-15 (the runtime's run.rerun, run.deleteMany);
// * trySample: WI-0022-16;
// * goBack: WI-0022-20 (the state stream, checkNow and quitAndUpdate are real now);
//
// The push events say what changed: the flow whose runs or board changed (the store asks again),
// a bare "the flows / the packages changed", or the small state itself (Setup, the update, the
// status). Each is coalesced by the shell (shell/push.ts): a burst reaches the page as one event
// per key, carrying the last value.
import type { Answer } from "./answer";
import type {
  FlowAnswer,
  FlowNamed,
  FlowSummary,
  FlowTemplateEntry,
  NodeForm,
  NodeOptions,
  NodeOptionsQuery,
} from "./flow-contract";
import type {
  BoardChange,
  BoardChanged,
  BoardView,
  ChosenFolder,
  PackagesChanged,
  PackagesView,
  Retention,
  SetupMove,
  SetupState,
  StatusView,
  UpdateView,
} from "./general-contract";
import type {
  ClearedCount,
  RerunStarted,
  RunAnswer,
  RunListQuery,
  RunPage,
  RunRecord,
  RunsChanged,
} from "./run-contract";

export interface AppApiV2 {
  // ── runs (plan 0022 §C, §E) ──
  /** A flow's runs, newest first, a page at a time. */
  runs(query: RunListQuery): RunAnswer<RunPage>;
  /** One run, by its id (the source event's id). */
  run(runId: string): RunAnswer<RunRecord>;
  /** "Clear done": the flow's done runs leave the board; never a delete. */
  clearDone(flowId: string): RunAnswer<ClearedCount>;
  /** Undo "Clear done", within a minute of it. */
  undoClear(flowId: string): RunAnswer<ClearedCount>;
  /** Re-run, from the start or from step `from`: a new run (not available until WI-0022-15). */
  rerun(flowId: string, runId: string, from?: string): RunAnswer<RerunStarted>;
  /** Re-run up to 100 runs (not available until WI-0022-15). */
  rerunMany(flowId: string, runIds: readonly string[]): RunAnswer<{ readonly started: number }>;
  /** Delete up to 100 runs' records; Anytype is never touched (not available until WI-0022-15). */
  deleteRuns(flowId: string, runIds: readonly string[]): RunAnswer<{ readonly deleted: number }>;
  /** A run of a flow changed: coalesced per flow. */
  onRuns(listener: (changed: RunsChanged) => void): void;

  // ── flows (plan 0022 §D) ──
  /** Every flow, one per tab. */
  flows(): FlowAnswer<readonly FlowSummary[]>;
  setFlowOn(id: string, on: boolean): FlowAnswer<{ readonly id: string; readonly on: boolean }>;
  renameFlow(id: string, name: string): FlowAnswer<FlowNamed>;
  /** A copy of the flow, off, with no credentials. */
  duplicateFlow(id: string, name?: string): FlowAnswer<FlowNamed>;
  /** "Export flow…": the shell's save dialog; `saved` is null when the person cancelled. */
  exportFlow(id: string): FlowAnswer<{ readonly saved: string | null }>;
  /** Delete a flow, its runs and its in-hand inputs. */
  deleteFlow(id: string): FlowAnswer<{ readonly id: string; readonly runs: number }>;
  /** The templates New flow offers. */
  templates(): FlowAnswer<readonly FlowTemplateEntry[]>;
  /** A new flow, off, from a template. */
  flowFromTemplate(templateId: string, name?: string): FlowAnswer<FlowNamed>;
  /** A step's form; `innytype` options unresolved (nodeOptions resolves them). */
  nodeForm(flowId: string, nodeId: string): FlowAnswer<NodeForm>;
  /** Save a step's form: validated, written, that tab deployed. */
  configureNode(
    flowId: string,
    nodeId: string,
    values: Readonly<Record<string, unknown>>,
  ): FlowAnswer<{ readonly flowId: string; readonly nodeId: string }>;
  /** A step's dynamic options (D9): the spaces, or one space's types. The key never leaves services. */
  nodeOptions(query: NodeOptionsQuery): FlowAnswer<NodeOptions>;
  /**
   * The canvas frame's "Save and run": the shell presses the editor's own Deploy, as the quit's
   * "Save and quit" does, and answers once the canvas is clean. Refused `loading` with no editor
   * loaded; `failed` when the deploy did not finish.
   */
  saveCanvas(): FlowAnswer<null>;
  /** The flows changed: coalesced. */
  onFlows(listener: () => void): void;

  // ── board (plan 0022 §A, §C) ──
  /** A flow's board, kept in boards.json and reconciled with its view nodes at read time. */
  board(flowId: string): Promise<Answer<BoardView>>;
  /** One Edit-layout change, applied and kept at once; answers the board as it now reads. */
  saveBoard(flowId: string, change: BoardChange): Promise<Answer<BoardView>>;
  /** A flow's board changed: coalesced per flow. */
  onBoard(listener: (changed: BoardChanged) => void): void;

  // ── Setup (plan 0022 §H) ──
  /** Where Setup is; a 0.2.1 installation is completed and never sees it. */
  setup(): Promise<Answer<SetupState>>;
  /** Move through Setup; the state is stored at every step. */
  setSetupStep(move: SetupMove): Promise<Answer<SetupState>>;
  /** Close Setup for good, from wherever it is. */
  completeSetup(): Promise<Answer<SetupState>>;
  /** "Try with a sample": the bundled sample where the starter watches (not available until WI-0022-16). */
  trySample(): Promise<Answer<null>>;
  /** Setup's state changed. */
  onSetup(listener: (state: SetupState) => void): void;

  // ── InnyTypes' own update (plan 0022 §G) ──
  updateState(): Promise<Answer<UpdateView>>;
  /** "Check now": the check runs, and the state moves as it goes. */
  checkNow(): Promise<Answer<UpdateView>>;
  /** "Quit and update": only when an update is ready; InnyTypes quits and installs it. */
  quitAndUpdate(): Promise<Answer<null>>;
  /** Go back to the previous release (D4; not available until WI-0022-20). */
  goBack(): Promise<Answer<UpdateView>>;
  /** The update state changed. */
  onUpdateState(listener: (view: UpdateView) => void): void;

  // ── packages (plan 0022 §F) ──
  /** Every package's row, each state with when it was verified, and what can be added. */
  listPackages(): Promise<Answer<PackagesView>>;
  /** "Add a package… › From the catalogue": install an entry from its signed archive. */
  installCatalogueEntry(source: string, id: string): Promise<Answer<null>>;
  /** "Add a package… › From a folder": install the chosen folder, confirmed unsigned. */
  installFolder(folder: string): Promise<Answer<null>>;
  /** Remove a package's files and environment; refused while used, naming EVERY use (D6). */
  uninstallPackage(name: string): Promise<Answer<null>>;
  /** Update a package to the newer version its source holds now. */
  updatePackage(name: string): Promise<Answer<null>>;
  /** Register a package: its steps are offered again. */
  registerPackage(name: string): Promise<Answer<null>>;
  /** Unregister a package; refused while a flow uses it, naming EVERY flow and step (D6). */
  unregisterPackage(name: string): Promise<Answer<null>>;
  /** "Add a package… › From a folder": the shell's own folder chooser. */
  chooseInstallFolder(): Promise<Answer<ChosenFolder>>;
  /** "Check for changes" on a package from a folder: re-hashed and judged now (plan 0013). */
  checkFolder(name: string): Promise<Answer<null>>;
  /** Go back to a package's previous version, within seven days of its update (D5). */
  goBackPackage(name: string): Promise<Answer<null>>;
  /** An install's phase as it starts, or null when packages changed otherwise: coalesced. */
  onPackages(listener: (changed: PackagesChanged) => void): void;

  // ── Anytype, status, General ──
  /** The paired Anytype's spaces (Setup's "Found 8 spaces."). */
  anytypeSpaces(): FlowAnswer<NodeOptions>;
  /** The status pill, the runtime banner and the Live badge. */
  status(): Promise<Answer<StatusView>>;
  /** They changed: coalesced. */
  onStatus(listener: (view: StatusView) => void): void;
  /** Run history's retention (D8): 90 days unless changed. */
  retention(): Promise<Answer<Retention>>;
  /** 7, 30, 90 or 365 days, or null for Forever. */
  setRetention(days: number | null): Promise<Answer<Retention>>;
}
