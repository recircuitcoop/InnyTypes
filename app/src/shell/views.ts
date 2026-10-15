// The shell's side of the views (WI-0018-10, -11): the runtime raises them, the shell keeps the
// Inbox, tells the person of a first presentation, and opens the pop-outs. Apart from main.ts so
// the composition root stays under its 600 lines (plan 0018 §2.3); main.ts builds the adapters
// and hands them in.

import type { IpcMain } from "electron";
import { Inbox } from "../application/inbox";
import type { Supervisor } from "../application/supervisor";
import type { Logger } from "../ports/logger";
import type { Notifier } from "../ports/notifier";
import { IPC } from "./ipc";
import { questionActions } from "./run-notices";

export interface ViewWiring {
  readonly ipc: Pick<IpcMain, "handle">;
  readonly runtime: Supervisor;
  readonly notifier: Notifier;
  /** Open a view in its pop-out, saying why in the log. */
  readonly openPopout: (target: { kind: "view"; id: string }, why: string) => void;
  /** A run of this flow changed: the run watch reads it (notifications, the badge). */
  readonly runsChanged: (flowId: string) => void;
  /** The flows changed: the run watch reads every flow, so a new flow's first run is news. */
  readonly flowsChanged: () => void;
  /** Send to the app page, when it is open. */
  readonly toPage: (channel: string, ...args: unknown[]) => void;
  readonly logger: Logger;
}

/** The questions waiting, for the status's Live badge: the run watch counts them from records. */
export interface PendingQuestions {
  pending(): number | null;
  onChange(listener: () => void): void;
}

export function wireViews(deps: ViewWiring): void {
  const { ipc, runtime, openPopout, toPage } = deps;
  const inbox = new Inbox({
    notifier: deps.notifier,
    openPopout: (id) => {
      openPopout({ kind: "view", id }, "presented");
    },
    list: () => runtime.call("view.list", null),
    questionActions,
    logger: deps.logger,
  });
  runtime.onViewEvent((event) => {
    if (event.t === "runs") {
      // A run of the flow changed: Live and Run history ask again (plan 0022 §C).
      toPage(IPC.runsChanged, { flowId: event.flowId });
      deps.runsChanged(event.flowId);
      return;
    }
    if (event.t === "flows") {
      // The flows changed: Configuration › Flows asks for its list again (plan 0022 §D).
      toPage(IPC.flowsChanged);
      deps.flowsChanged();
      return;
    }
    inbox.receive(event);
  });
  ipc.handle(IPC.openView, (_event, id: unknown) => {
    if (typeof id === "string" && id !== "") {
      openPopout({ kind: "view", id }, "opened from Live");
    }
  });
}
