// AppApi over the renderer's IPC (plan 0018 §2.4): what the preload exposes as
// `window.inny.app`. Built here, apart from the preload, so the contract tests can exercise
// every method against a recording IPC with no DOM and no Electron.

import type { IpcRenderer } from "electron";
import { appApiV2Over } from "./app-bridge-v2";
import { IPC } from "./ipc";
import type {
  AnytypeStatus,
  AppApi,
  ChildName,
  ChildStatus,
  EditorPalette,
  LaunchAtLoginStatus,
  McpEndpointStatus,
  QuitChoice,
  QuitQuestion,
  SecretStorageStatus,
  TelemetryReport,
  TelemetryStatus,
  ViewResult,
} from "../ui/contract";

/** ipcRenderer, as far as AppApi goes. */
export type RendererIpc = Pick<IpcRenderer, "invoke" | "on">;

export function appApiOver(ipc: RendererIpc): AppApi {
  return {
    ...appApiV2Over(ipc),
    secretStorage: () => ipc.invoke(IPC.secretStorage) as Promise<SecretStorageStatus>,
    childStatus: () => ipc.invoke(IPC.childStatus) as Promise<readonly ChildStatus[]>,
    onChildStatus: (listener) => {
      ipc.on(IPC.childStatusChanged, (_event, status: ChildStatus) => {
        listener(status);
      });
    },
    restartChild: async (child: ChildName) => {
      await ipc.invoke(IPC.restartChild, child);
    },
    anytypeStatus: () => ipc.invoke(IPC.anytypeStatus) as Promise<AnytypeStatus>,
    startAnytypePairing: () => ipc.invoke(IPC.anytypePairStart) as Promise<AnytypeStatus>,
    completeAnytypePairing: (code: string) =>
      ipc.invoke(IPC.anytypePairComplete, code) as Promise<AnytypeStatus>,
    mcpEndpoint: () => ipc.invoke(IPC.mcpEndpoint) as Promise<McpEndpointStatus>,
    moveMcpEndpoint: (host: string, port: number) =>
      ipc.invoke(IPC.mcpEndpointMove, host, port) as Promise<McpEndpointStatus>,
    submitView: (id, values) =>
      ipc.invoke(IPC.viewCall, { op: "view.submit", args: { id, values } }) as Promise<ViewResult>,
    openView: async (id) => {
      await ipc.invoke(IPC.openView, id);
    },
    editorPalette: () => ipc.invoke(IPC.editorPalette) as Promise<EditorPalette | null>,
    onQuitQuestion: (listener) => {
      ipc.on(IPC.quitQuestion, (_event, question: QuitQuestion) => {
        listener(question);
      });
    },
    answerQuit: async (choice: QuitChoice) => {
      await ipc.invoke(IPC.quitAnswer, choice);
    },
    launchAtLogin: () => ipc.invoke(IPC.launchAtLogin) as Promise<LaunchAtLoginStatus>,
    setLaunchAtLogin: (on: boolean) =>
      ipc.invoke(IPC.setLaunchAtLogin, on) as Promise<LaunchAtLoginStatus>,
    telemetry: () => ipc.invoke(IPC.telemetry) as Promise<TelemetryStatus>,
    setTelemetry: (on: boolean) => ipc.invoke(IPC.setTelemetry, on) as Promise<TelemetryStatus>,
    telemetryReports: () => ipc.invoke(IPC.telemetryReports) as Promise<readonly TelemetryReport[]>,
    legacyPackages: () => ipc.invoke(IPC.legacyPackages) as Promise<readonly string[]>,
    deleteLegacyPackages: () => ipc.invoke(IPC.deleteLegacyPackages) as Promise<readonly string[]>,
  };
}
