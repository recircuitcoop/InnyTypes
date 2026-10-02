// A package's calls in General (plan 0022 §F): register, unregister, choose a folder to install
// from, check a folder for changes, and go back. Only the folder chooser and unregister's in-use
// check are this item's: an unregister is refused while a flow uses the package, naming EVERY
// flow and step that does (D6), and otherwise not available until WI-0022-19 adds the
// `packages.unregistered` setting; register, check for changes and go back wait for it too.
//
// The `packages` push event: the Packages page's own calls (shell/packages.ts) are wrapped so a
// finished install, removal, update or source change tells the page.
import type { Dialog, IpcMain } from "electron";
import { typesOf } from "../application/remove-package";
import type { Supervisor } from "../application/supervisor";
import type { StepUse } from "../domain/packages/states";
import type { Logger } from "../ports/logger";
import type { Answer } from "../ui/answer";
import type { ChosenFolder } from "../ui/general-contract";
import type { FlowSummary } from "../ui/flow-contract";
import { guarded, notAvailable, opOf, refused, unknownOp } from "./answer";
import { STRINGS } from "../ui/strings";
import { flowAnswer } from "./flow-calls";
import { IPC } from "./ipc";

/** The Packages page's calls that change what is installed or offered. */
const CHANGING: readonly string[] = [
  IPC.packageInstall,
  IPC.packageInstallFile,
  IPC.packageRemove,
  IPC.packageCheck,
  IPC.packageUpdate,
  IPC.packageInstallSource,
  IPC.sourceRegister,
  IPC.sourceRemove,
  IPC.sourceAutoUpdate,
];

/** `ipc`, with every changing package call telling the page once it is answered. */
export function notifyingPackageChanges(
  ipc: Pick<IpcMain, "handle">,
  toPage: (channel: string, ...args: unknown[]) => void,
): Pick<IpcMain, "handle"> {
  return {
    handle: (channel, listener) => {
      if (!CHANGING.includes(channel)) {
        ipc.handle(channel, listener);
        return;
      }
      ipc.handle(channel, async (event, ...args: unknown[]) => {
        try {
          return (await listener(event, ...args)) as unknown;
        } finally {
          toPage(IPC.packagesChanged, null);
        }
      });
    },
  };
}

/** Every flow and step made from one of package `name`'s types, in the flows' and steps' order. */
export function usesOf(name: string, flows: readonly FlowSummary[]): StepUse[] {
  return flows.flatMap((flow) =>
    flow.steps
      .filter((step) => typesOf(name, [step.type]).length > 0)
      .map((step) => ({ flow: flow.name, step: step.name })),
  );
}

export interface PackageCallsDeps {
  readonly ipc: Pick<IpcMain, "handle">;
  readonly runtime: Pick<Supervisor, "call">;
  readonly dialog: Pick<Dialog, "showOpenDialog">;
  readonly logger: Logger;
}

export function wirePackageCalls({ ipc, runtime, dialog, logger }: PackageCallsDeps): void {
  const unregister = async (name: string): Promise<Answer<null>> => {
    const listed = flowAnswer<readonly FlowSummary[]>(
      await runtime.call("flow.list", null),
      "package.unregister",
      logger,
    );
    if (!listed.ok) {
      return listed;
    }
    const uses = usesOf(name, listed.value);
    if (uses.length > 0) {
      return refused("in-use", uses.length === 1 ? "packages.inUse.one" : "packages.inUse.many", {
        inUse: { name, action: "unregister", uses },
      });
    }
    return notAvailable(); // WI-0022-19: the packages.unregistered setting
  };
  ipc.handle(IPC.packageCall, (_event, call: unknown) => {
    const { op, args } = opOf(call);
    return guarded(op, logger, async (): Promise<Answer<ChosenFolder | null>> => {
      const name = typeof args["name"] === "string" ? args["name"] : "";
      switch (op) {
        case "package.unregister":
          return unregister(name);
        case "package.chooseFolder": {
          const chosen = await dialog.showOpenDialog({
            title: STRINGS["packages.add"],
            properties: ["openDirectory"],
          });
          const folder = chosen.canceled ? null : (chosen.filePaths[0] ?? null);
          return { ok: true, value: { folder } };
        }
        case "package.register":
        case "package.checkFolder":
        case "package.goBack":
          return notAvailable(); // WI-0022-19
        default:
          return unknownOp(op, "package", logger);
      }
    });
  });
}
