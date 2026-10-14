// The person reached with the window closed (plan 0022 §I; interaction-design moments 2 to 4):
// the run notifications, the question's buttons, and the dock badge, wired in the shell.
//
// * application/run-watch.ts decides what is news from the run records; this words it from
//   ui/strings.ts and raises it on the one NoticeBoard: "Processing *client call*, about 12
//   minutes." (until five good runs), "Filed: …" or "Done: …" with Open in Anytype or Open, and
//   "Couldn't finish *client call*. …" with Open.
// * A question's notification (the Inbox's, on a first presentation) carries Answer and Later,
//   each bound to that question's own flow, run and view.
// * A press runs only what its own binding names: Answer opens that view's pop-out, Open opens
//   Live on that run's flow, Open in Anytype opens that object (an anytype:// link, checked
//   again here). A click on the notification itself opens Live on its flow.
// * The dock badge counts the waiting questions from run records, hidden places included.
import type { InboxEvent } from "../application/inbox";
import { RunWatch, type RunNews } from "../application/run-watch";
import type { Supervisor } from "../application/supervisor";
import type { Message, Notice, NoticeAction } from "../domain/notices/notices";
import type { ResultLine } from "../domain/runs/run";
import { isAnytypeLink } from "../domain/views/popout";
import type { Logger } from "../ports/logger";
import type { Notifier } from "../ports/notifier";
import { plural, t } from "../ui/strings";

/** A sentence for a notification: its `*names*` marks dropped (a notification draws no italics). */
const plain = (text: string): string => text.replace(/\*/g, "");

/** An Anytype result's link, when it names an object the desktop app can open. */
function anytypeLink(result: ResultLine): string | null {
  if (result.anytype === null) {
    return null;
  }
  const url = `anytype://object?objectId=${result.anytype.objectId}&spaceId=${result.anytype.spaceId}`;
  return isAnytypeLink(url) ? url : null;
}

/** The notice a piece of run news is, worded (ux-writing "Notifications"). */
export function runNotice(news: RunNews): Notice {
  const { run } = news;
  const base = { subject: run.runId, title: run.title, flowId: run.flowId };
  const bind = { flowId: run.flowId, runId: run.runId };
  const open: NoticeAction = { label: t("notify.open"), kind: "open-live", ...bind };
  switch (news.kind) {
    case "started":
      return {
        ...base,
        kind: "run-started",
        detail: plain(
          news.minutes === null
            ? t("notify.start.noEstimate", { event: run.title })
            : plural(news.minutes, "notify.start", { event: run.title }),
        ),
      };
    case "done": {
      const first = run.results[0];
      const url = first === undefined ? null : anytypeLink(first);
      if (first !== undefined && url !== null) {
        return {
          ...base,
          kind: "run-done",
          detail: plain(t("notify.filed", { result: first.text })),
          actions: [{ label: t("notify.openInAnytype"), kind: "open-anytype", url, ...bind }],
        };
      }
      return {
        ...base,
        kind: "run-done",
        detail: plain(t("notify.done", { result: first?.text ?? `*${run.title}*` })),
        actions: [open],
      };
    }
    case "failed": {
      const reason = run.failure === null ? "" : `${run.failure.step}: ${run.failure.text}`;
      return {
        ...base,
        kind: "run-failed",
        detail: plain(t("notify.failed", { event: run.title, reason })).trim(),
        actions: [open],
      };
    }
  }
}

/** A question's buttons: Answer opens its pop-out, Later leaves it waiting. */
export function questionActions(event: Extract<InboxEvent, { t: "present" }>): NoticeAction[] {
  const bind = { flowId: event.flowId ?? "", runId: event.runId ?? "", viewId: event.id };
  return [
    { label: t("card.answer"), kind: "answer", ...bind },
    { label: t("notify.later"), kind: "later", ...bind },
  ];
}

export interface NoticePresses {
  /** Open a question's pop-out. */
  readonly openView: (viewId: string) => void;
  /** Bring the window forward on Live, on this flow. */
  readonly openLive: (flowId: string | null) => void;
  /** Hand an anytype:// link to the desktop app. */
  readonly openExternal: (url: string) => void;
}

/** What a click on a notification, and a press of one of its buttons, does. */
export function noticeHandlers(presses: NoticePresses) {
  return {
    onClick: (message: Message): void => {
      presses.openLive(message.flowId ?? null);
    },
    onAction: (action: NoticeAction): void => {
      switch (action.kind) {
        case "answer":
          if (action.viewId !== undefined && action.viewId !== "") {
            presses.openView(action.viewId);
          }
          return;
        case "open-live":
          presses.openLive(action.flowId === "" ? null : action.flowId);
          return;
        case "open-anytype":
          // Checked again: only a link to an Anytype object ever leaves the app.
          if (action.url !== undefined && isAnytypeLink(action.url)) {
            presses.openExternal(action.url);
          }
          return;
        case "later":
          return; // the question keeps waiting; the badge keeps counting it
      }
    },
  };
}

export interface RunNoticesDeps {
  readonly runtime: Pick<Supervisor, "call" | "onStatus">;
  readonly notifier: Notifier;
  /** The dock or taskbar badge. */
  readonly badge: (count: number) => void;
  readonly logger: Logger;
}

/** The run watch, raising its news on the notifier; every flow is read again on each start. */
export function wireRunNotices(deps: RunNoticesDeps): RunWatch {
  const { runtime, notifier, logger } = deps;
  const watch = new RunWatch({
    list: (query) => runtime.call("run.list", query),
    flows: () => runtime.call("flow.list", null),
    news: (news) => {
      // A run's news is told once and is no condition that stays true: it is not kept as
      // current (notices.json), and the watch never tells the same news twice.
      const notice = runNotice(news);
      notifier.raise(notice);
      notifier.clear(notice.kind, notice.subject);
    },
    badge: deps.badge,
    logger,
  });
  runtime.onStatus((status) => {
    if (status.state === "running") {
      void watch.refreshAll();
    }
  });
  return watch;
}
