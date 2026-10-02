// The supervised children as the app page sees them (WI-0018-03): every child's status, pushed as
// it changes, and the Restart button. Apart from main.ts so the composition root only constructs.
import type { IpcMain } from "electron";
import type { Supervisor } from "../application/supervisor";
import { isChildName, type ChildName } from "../domain/supervision/child-state";
import type * as Contract from "../ui/contract";
import { IPC } from "./ipc";

export function wireChildCalls(
  ipc: Pick<IpcMain, "handle">,
  supervisors: ReadonlyMap<ChildName, Pick<Supervisor, "status" | "onStatus" | "recover">>,
  toPage: (channel: string, ...args: unknown[]) => void,
): void {
  for (const supervisor of supervisors.values()) {
    supervisor.onStatus((status) => {
      toPage(IPC.childStatusChanged, status);
    });
  }
  ipc.handle(IPC.childStatus, (): Contract.ChildStatus[] =>
    [...supervisors.values()].map((supervisor) => supervisor.status()),
  );
  ipc.handle(IPC.restartChild, (_event, child: unknown) => {
    if (isChildName(child)) {
      supervisors.get(child)?.recover();
    }
  });
}
