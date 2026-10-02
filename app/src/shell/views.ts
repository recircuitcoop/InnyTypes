// The shell's side of the views (WI-0018-10, -11): the runtime raises them, the shell keeps the
// Inbox, tells the person of a first presentation, and opens the pop-outs. Apart from main.ts so
// the composition root stays under its 600 lines (plan 0018 §2.3); main.ts builds the adapters
// and hands them in.

import type { IpcMain } from "electron";
import { Inbox } from "../application/inbox";
import type { Supervisor } from "../application/supervisor";
import type { Logger } from "../ports/logger";
import type { Notifier } from "../ports/notifier";
import type * as Contract from "../ui/contract";
import { IPC } from "./ipc";

export interface ViewWiring {
  readonly ipc: Pick<IpcMain, "handle">;
  readonly runtime: Supervisor;
  readonly notifier: Notifier;
  /** Open a view or a snapshot in its pop-out, saying why in the log. */
  readonly openPopout: (target: { kind: "view" | "snapshot"; id: string }, why: string) => void;
  readonly badge: (count: number) => void;
  /** Send to the app page, when it is open. */
  readonly toPage: (channel: string, ...args: unknown[]) => void;
  readonly logger: Logger;
}

export function wireViews(deps: ViewWiring): void {
  const { ipc, runtime, openPopout, toPage } = deps;
  const inbox = new Inbox({
    notifier: deps.notifier,
    openPopout: (id) => {
      openPopout({ kind: "view", id }, "presented");
    },
    list: () => runtime.call("view.list", null),
    badge: deps.badge,
    logger: deps.logger,
  });
  inbox.onChange((items) => {
    toPage(IPC.inboxChanged, items);
  });
  runtime.onViewEvent((event) => {
    if (event.t === "runs") {
      // A run of the flow changed: Live and Run history ask again (plan 0022 §C).
      toPage(IPC.runsChanged, { flowId: event.flowId });
      // The Jobs page asks for its list again, until WI-0022-21's cutover removes it.
      toPage(IPC.jobsChanged);
      return;
    }
    if (event.t === "flows") {
      // The flows changed: Configuration › Flows asks for its list again (plan 0022 §D).
      toPage(IPC.flowsChanged);
      return;
    }
    inbox.receive(event);
    if (event.t === "present") {
      const view: Contract.ViewPresented = {
        id: event.id,
        window: event.window,
        first: event.first,
        title: event.title,
      };
      toPage(IPC.viewPresented, view);
    } else {
      toPage(IPC.pendingViews, event.count);
    }
  });
  ipc.handle(IPC.pendingViewsNow, () => inbox.pending());
  ipc.handle(IPC.inbox, (): readonly Contract.InboxEntry[] => inbox.items());
  ipc.handle(IPC.openView, (_event, id: unknown) => {
    if (typeof id === "string" && id !== "") {
      openPopout({ kind: "view", id }, "opened from the Inbox");
    }
  });
  ipc.handle(IPC.openSnapshot, (_event, id: unknown) => {
    if (typeof id === "string" && id !== "") {
      openPopout({ kind: "snapshot", id }, "opened from the Snapshots page");
    }
  });
}
