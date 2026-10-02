// AppApi v2 (plan 0022 §N) for a test that never calls it: every call rejects, every push
// listener is dropped. Typed as the whole AppApiV2, so a member added to the contract fails tsc
// here until it is listed.
import type { AppApiV2 } from "../../src/ui/app-api-v2";

const never = <T>(): Promise<T> => Promise.reject(new Error("not used here"));
const ignored = (): void => undefined;

export const V2_UNUSED: AppApiV2 = {
  runs: never,
  run: never,
  clearDone: never,
  undoClear: never,
  rerun: never,
  rerunMany: never,
  deleteRuns: never,
  onRuns: ignored,
  flows: never,
  setFlowOn: never,
  renameFlow: never,
  duplicateFlow: never,
  exportFlow: never,
  deleteFlow: never,
  templates: never,
  flowFromTemplate: never,
  nodeForm: never,
  configureNode: never,
  nodeOptions: never,
  onFlows: ignored,
  board: never,
  saveBoard: never,
  onBoard: ignored,
  setup: never,
  setSetupStep: never,
  completeSetup: never,
  trySample: never,
  onSetup: ignored,
  updateState: never,
  checkNow: never,
  quitAndUpdate: never,
  goBack: never,
  onUpdateState: ignored,
  registerPackage: never,
  unregisterPackage: never,
  chooseInstallFolder: never,
  checkFolder: never,
  goBackPackage: never,
  onPackages: ignored,
  anytypeSpaces: never,
  status: never,
  onStatus: ignored,
  retention: never,
  setRetention: never,
};
