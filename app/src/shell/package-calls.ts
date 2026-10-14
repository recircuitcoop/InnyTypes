// A package's calls in General (plan 0022 §F): the rows, install from a catalogue or a folder,
// remove, update, register, unregister, check a folder for changes, and go back. The work is
// application/package-board.ts's; here each outcome becomes an Answer whose refusal carries a
// strings.ts key. An unregister or a removal refused while a flow uses the package names EVERY
// flow and step that does (D6), read from the runtime's flow list.
//
// The `packages` push event: every call here that changes something tells the page once it is
// answered.
import type { Dialog, IpcMain } from "electron";
import type { BoardOutcome, PackageBoard } from "../application/package-board";
import { typesOf } from "../application/remove-package";
import type { Supervisor } from "../application/supervisor";
import { rowActions, type StepUse } from "../domain/packages/states";
import type { EditorNode, EditorNodes } from "../ports/editor";
import type { Logger } from "../ports/logger";
import type { Answer } from "../ui/answer";
import type { ChosenFolder, PackagesView } from "../ui/general-contract";
import type { FlowSummary } from "../ui/flow-contract";
import { guarded, opOf, refused, unknownOp } from "./answer";
import { STRINGS } from "../ui/strings";
import { flowAnswer } from "./flow-calls";
import { IPC } from "./ipc";

/** Every flow and step made from one of package `name`'s types: sources, then steps, flow by flow. */
export function usesOf(name: string, flows: readonly FlowSummary[]): StepUse[] {
  return stepsOf(name, flows).map(({ flow, step }) => ({ flow, step }));
}

function stepsOf(name: string, flows: readonly FlowSummary[]) {
  return flows.flatMap((flow) =>
    [...flow.sources, ...flow.steps]
      .filter((step) => typesOf(name, [step.type]).length > 0)
      .map((step) => ({ id: step.id, flow: flow.name, step: step.name })),
  );
}

/**
 * The uses of package `name`, deployed (the runtime's flows) and undeployed (the editor's nodes
 * not deployed yet), as the removal check asks both (application/remove-package.ts).
 */
export function allUsesOf(
  name: string,
  flows: readonly FlowSummary[],
  editorNodes: readonly EditorNode[] | null,
): StepUse[] {
  const deployed = stepsOf(name, flows);
  const ids = new Set(deployed.map((use) => use.id));
  const undeployed = (editorNodes ?? [])
    .filter((node) => !ids.has(node.id) && typesOf(name, [node.type]).length > 0)
    .map((node) => ({ flow: node.flow ?? "", step: node.name ?? node.type }));
  return [...deployed.map(({ flow, step }) => ({ flow, step })), ...undeployed];
}

export interface PackageCallsDeps {
  readonly ipc: Pick<IpcMain, "handle">;
  readonly runtime: Pick<Supervisor, "call">;
  readonly dialog: Pick<Dialog, "showOpenDialog">;
  /** The open editor: a step on its canvas, not saved, uses a package too (D6). */
  readonly editor: EditorNodes;
  readonly board: Pick<
    PackageBoard,
    | "board"
    | "install"
    | "installFolder"
    | "remove"
    | "update"
    | "register"
    | "unregister"
    | "checkFolder"
    | "goBack"
    | "reinstall"
  >;
  readonly toPage: (channel: string, ...args: unknown[]) => void;
  /** Wall-clock time, epoch ms: when a row's actions are judged (Go back's seven days). */
  readonly now: () => number;
  readonly logger: Logger;
}

/** A package action's outcome as AppApi answers it; `name` fills the sentences that name it. */
export function answerOf(name: string, outcome: BoardOutcome): Answer<null> {
  if (outcome.ok) {
    return { ok: true, value: null };
  }
  if ("failed" in outcome) {
    switch (outcome.failed) {
      case "install":
        return refused("failed", "packages.installFailed");
      case "update":
        return refused("failed", "packages.updateFailed", { params: { name } });
      case "go-back":
        return refused("failed", "packages.goBackFailed", {
          params: { name, version: outcome.version ?? "" },
        });
      case "remove":
        return refused("failed", "refused.failed");
    }
  }
  const { refusal } = outcome;
  switch (refusal.reason) {
    case "in-use":
      return refused(
        "in-use",
        refusal.uses.length === 1 ? "packages.inUse.one" : "packages.inUse.many",
        { inUse: { name, action: refusal.action, uses: refusal.uses } },
      );
    case "shipped":
      return refused("shipped", "packages.shipped", { params: { name } });
    case "busy":
      return refused("busy", "packages.busy");
    case "rollback-expired":
      return refused("nothing-to-do", "packages.goBackExpired");
    case "not-installed":
      return refused("not-installed", "refused.failed");
    default:
      return refused("nothing-to-do", "refused.failed");
  }
}

export function wirePackageCalls(deps: PackageCallsDeps): void {
  const { ipc, runtime, dialog, editor, board, toPage, logger } = deps;
  /** Every flow and step that uses `name`, or the refusal of the flow list. */
  const uses = async (name: string, op: string): Promise<Answer<StepUse[]>> => {
    const listed = flowAnswer<readonly FlowSummary[]>(
      await runtime.call("flow.list", null),
      op,
      logger,
    );
    return listed.ok
      ? { ok: true, value: allUsesOf(name, listed.value, await editor.nodes()) }
      : listed;
  };
  const list = async (): Promise<Answer<PackagesView>> => {
    const { rows, offers } = await board.board();
    const now = new Date(deps.now());
    return {
      ok: true,
      value: {
        packages: rows.map((row) => ({ ...row, actions: rowActions(row.package, now) })),
        offers,
      },
    };
  };
  /** A call that changes what is installed or registered: answered, then the page is told. */
  const changing = async (
    name: string,
    work: () => Promise<BoardOutcome | Answer<StepUse[]>>,
  ): Promise<Answer<null>> => {
    try {
      const outcome = await work();
      // A refused flow list is already an Answer.
      return "refused" in outcome ? outcome : answerOf(name, outcome);
    } finally {
      toPage(IPC.packagesChanged, null);
    }
  };
  /** Unregister or remove: refused while used, naming every use. */
  const withUses = (
    name: string,
    op: string,
    act: (used: StepUse[]) => Promise<BoardOutcome>,
  ): Promise<Answer<null>> =>
    changing(name, async () => {
      const used = await uses(name, op);
      return used.ok ? act(used.value) : used;
    });
  ipc.handle(IPC.packageCall, (_event, call: unknown) => {
    const { op, args } = opOf(call);
    return guarded(op, logger, async (): Promise<Answer<PackagesView | ChosenFolder | null>> => {
      const text = (key: string) => (typeof args[key] === "string" ? args[key] : "");
      const name = text("name");
      switch (op) {
        case "package.list":
          return list();
        case "package.install":
          return changing(text("id"), () => board.install(text("source"), text("id")));
        case "package.installFolder":
          return changing("", () => board.installFolder(text("folder")));
        case "package.remove":
          return withUses(name, op, (used) => board.remove(name, used));
        case "package.update":
          return changing(name, () => board.update(name));
        case "package.register":
          return changing(name, () => board.register(name));
        case "package.unregister":
          return withUses(name, op, (used) => board.unregister(name, used));
        case "package.reinstall":
          return changing(name, () => board.reinstall(name));
        case "package.checkFolder":
          return changing(name, () => board.checkFolder(name));
        case "package.goBack":
          return changing(name, () => board.goBack(name));
        case "package.chooseFolder": {
          const chosen = await dialog.showOpenDialog({
            title: STRINGS["packages.add"],
            properties: ["openDirectory"],
          });
          const folder = chosen.canceled ? null : (chosen.filePaths[0] ?? null);
          return { ok: true, value: { folder } };
        }
        default:
          return unknownOp(op, "package", logger);
      }
    });
  });
}
