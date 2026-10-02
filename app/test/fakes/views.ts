// AppApi's view members (WI-0018-10), the app pages' lists (WI-0018-11) and the editor sync
// and quit question (WI-0018-12) and the event types (WI-0018-13), for a page test that never
// calls them.
import type {
  EditorPalette,
  EventTypeSummary,
  InboxEntry,
  Job,
  ListResult,
  NodeSetSummary,
  PackageOutcome,
  PackagesState,
  SnapshotSummary,
  ViewResult,
} from "../../src/ui/contract";

const unused = (): Promise<ViewResult> => Promise.reject(new Error("not used here"));
const never = <T>(): Promise<T> => Promise.reject(new Error("not used here"));

export const VIEWS_UNUSED = {
  onViewPresented: (): void => undefined,
  onPendingViews: (): void => undefined,
  pendingViews: (): Promise<number | null> => Promise.reject(new Error("not used here")),
  view: unused,
  submitView: unused,
  snapshot: unused,
  pressAction: unused,
  inbox: (): Promise<readonly InboxEntry[]> => never(),
  onInbox: (): void => undefined,
  onJobs: (): void => undefined,
  // The runs read model (plan 0022 §C).
  runList: unused,
  runGet: unused,
  runClearDone: unused,
  runUndoClear: unused,
  onRuns: (): void => undefined,
  openView: (): Promise<void> => never(),
  snapshots: (): Promise<ListResult<SnapshotSummary>> => never(),
  openSnapshot: (): Promise<void> => never(),
  jobs: (): Promise<ListResult<Job>> => never(),
  cancelJob: unused,
  quit: (): Promise<void> => never(),
  editorPalette: (): Promise<EditorPalette | null> => never(),
  runtimeNodeSets: (): Promise<ListResult<NodeSetSummary>> => never(),
  raiseNodeEvents: unused,
  eventTypes: (): Promise<ListResult<EventTypeSummary>> => never(),
  createEventType: unused,
  versionEventType: unused,
  deleteEventType: unused,
  fireEvent: unused,
  onQuitQuestion: (): void => undefined,
  answerQuit: (): Promise<void> => never(),
  // The Packages page (WI-0018-16).
  packages: (): Promise<PackagesState> => never(),
  installFromCatalogue: (): Promise<PackageOutcome> => never(),
  chooseInstallFile: (): Promise<string | null> => never(),
  installFromFile: (): Promise<PackageOutcome> => never(),
  removePackage: (): Promise<PackageOutcome> => never(),
  // Updates and registered sources (WI-0018-17).
  checkPackageUpdates: (): Promise<PackageOutcome> => never(),
  applyPackageUpdate: (): Promise<PackageOutcome> => never(),
  installFromSource: (): Promise<PackageOutcome> => never(),
  registerSource: (): Promise<PackageOutcome> => never(),
  removeSource: (): Promise<PackageOutcome> => never(),
  setSourceAutoUpdate: (): Promise<PackageOutcome> => never(),
};
