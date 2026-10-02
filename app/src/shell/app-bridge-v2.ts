// AppApi v2 over the renderer's IPC (plan 0022 §N): the half of `window.inny.app` the redesigned
// screens use. app-bridge.ts spreads it into the whole AppApi. Each call is one `invoke` of a
// `{op, args}` channel, answered by the shell's *-calls.ts with an Answer; each push event is one
// `on`, its value passed as it came.
import type { IpcRendererEvent } from "electron";
import type { AppApiV2 } from "../ui/app-api-v2";
import { IPC } from "./ipc";
import type { RendererIpc } from "./app-bridge";

export function appApiV2Over(ipc: RendererIpc): AppApiV2 {
  /** One `{op, args}` call on `channel`; its answer is the shell's Answer, typed by the caller. */
  const call =
    (channel: string) =>
    <T>(op: string, args: unknown = null): Promise<T> =>
      ipc.invoke(channel, { op, args }) as Promise<T>;
  const run = call(IPC.runCall);
  const flow = call(IPC.flowCall);
  const board = call(IPC.boardCall);
  const setup = call(IPC.setupCall);
  const update = call(IPC.updateCall);
  const pkg = call(IPC.packageCall);
  const general = call(IPC.generalCall);
  /** A push event: the listener hears the value the shell sent. */
  const on = (channel: string, listener: (value: never) => void): void => {
    ipc.on(channel, (_event: IpcRendererEvent, value: unknown) => {
      listener(value as never);
    });
  };

  return {
    runs: (query) => run("run.list", query),
    run: (runId) => run("run.get", { runId }),
    clearDone: (flowId) => run("run.clearDone", { flowId }),
    undoClear: (flowId) => run("run.undoClear", { flowId }),
    rerun: (flowId, runId, from) =>
      run("run.rerun", from === undefined ? { flowId, runId } : { flowId, runId, from }),
    rerunMany: (flowId, runIds) => run("run.rerunMany", { flowId, runIds }),
    deleteRuns: (flowId, runIds) => run("run.deleteMany", { flowId, runIds }),
    onRuns: (listener) => {
      on(IPC.runsChanged, listener);
    },
    flows: () => flow("flow.list"),
    setFlowOn: (id, on) => flow("flow.setOn", { id, on }),
    renameFlow: (id, name) => flow("flow.rename", { id, name }),
    duplicateFlow: (id, name) => flow("flow.duplicate", name === undefined ? { id } : { id, name }),
    exportFlow: (id) => flow("flow.export", { id }),
    deleteFlow: (id) => flow("flow.delete", { id }),
    templates: () => flow("flow.templates"),
    flowFromTemplate: (templateId, name) =>
      flow("flow.fromTemplate", name === undefined ? { templateId } : { templateId, name }),
    nodeForm: (flowId, nodeId) => flow("flow.node.form", { flowId, nodeId }),
    configureNode: (flowId, nodeId, values) =>
      flow("flow.node.configure", { flowId, nodeId, values }),
    nodeOptions: (query) => flow("node.options", query),
    onFlows: (listener) => {
      on(IPC.flowsChanged, () => {
        listener();
      });
    },
    board: (flowId) => board("board.get", { flowId }),
    saveBoard: (layout) => board("board.save", { layout }),
    onBoard: (listener) => {
      on(IPC.boardChanged, listener);
    },
    setup: () => setup("setup.get"),
    setSetupStep: (move) => setup("setup.move", move),
    completeSetup: () => setup("setup.complete"),
    trySample: () => setup("setup.trySample"),
    onSetup: (listener) => {
      on(IPC.setupChanged, listener);
    },
    updateState: () => update("update.state"),
    checkNow: () => update("update.checkNow"),
    quitAndUpdate: () => update("update.quit"),
    goBack: () => update("update.goBack"),
    onUpdateState: (listener) => {
      on(IPC.updateStateChanged, listener);
    },
    registerPackage: (name) => pkg("package.register", { name }),
    unregisterPackage: (name) => pkg("package.unregister", { name }),
    chooseInstallFolder: () => pkg("package.chooseFolder"),
    checkFolder: (name) => pkg("package.checkFolder", { name }),
    goBackPackage: (name) => pkg("package.goBack", { name }),
    onPackages: (listener) => {
      on(IPC.packagesChanged, () => {
        listener();
      });
    },
    anytypeSpaces: () => flow("anytype.spaces"),
    status: () => general("status.get"),
    onStatus: (listener) => {
      on(IPC.statusChanged, listener);
    },
    retention: () => general("retention.get"),
    setRetention: (days) => general("retention.set", { days }),
  };
}
