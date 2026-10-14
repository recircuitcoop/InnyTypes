// The Inbox (spec 8.1, 8.2; arch_pivot P10d, P10e): the action views waiting on the person,
// with the badge. A view opens here, drawn by the generic renderer, or in its own window
// ("Open in window"). The list is the shell's, so it keeps its last contents while the runtime
// is down; opening or answering one then says why it cannot.
//
// A view its package's widget draws is never drawn here (plan 0021 §8): its row says
// "Waiting for you: title" with Answer, which opens its pop-up.

import type { AppApi, InboxEntry } from "../contract";
import {
  attributeOf,
  escape,
  formValues,
  isWidgetView,
  listenTo,
  resultText,
  viewHtml,
  waitingHtml,
} from "../view/render";
import type { Region, Section } from "./page";

function rowHtml(entry: InboxEntry): string {
  const id = escape(entry.id);
  const title = escape(entry.title === "" ? "(untitled)" : entry.title);
  if (entry.widget === true) {
    return (
      `<li data-testid="inbox-item" data-id="${id}">` +
      `<span data-testid="inbox-title"><strong>Waiting for you:</strong> ${title}</span> ` +
      `<button type="button" data-popout="${id}" data-testid="inbox-answer">Answer</button>` +
      "</li>"
    );
  }
  return (
    `<li data-testid="inbox-item" data-id="${id}">` +
    `<span data-testid="inbox-title">${title}</span> ` +
    `<button type="button" data-open="${id}" data-testid="inbox-open">Open</button> ` +
    `<button type="button" data-popout="${id}" data-testid="inbox-popout">Open in window</button>` +
    "</li>"
  );
}

export function inboxListHtml(entries: readonly InboxEntry[]): string {
  if (entries.length === 0) {
    return '<p data-testid="inbox-empty">Nothing is waiting for you.</p>';
  }
  return `<ul data-testid="inbox-list">${entries.map(rowHtml).join("")}</ul>`;
}

/** A view as the Inbox draws it here: a widget only says it waits, with Answer. */
function detailHtml(id: string, value: unknown): string {
  if (!isWidgetView(value)) {
    // An app page never holds a package's files: a package-file sample is drawn as a sentence.
    return viewHtml(value, false);
  }
  const content = (value as { content: { title?: unknown } }).content;
  return waitingHtml(id, typeof content.title === "string" ? content.title : "");
}

export const badgeText = (count: number | null): string =>
  count === null || count === 0 ? "" : String(count);

export interface InboxPage {
  readonly section: Section;
  readonly list: Region;
  readonly detail: Region;
  readonly message: Region;
  readonly badge: Region;
}

export async function mountInbox(page: InboxPage, api: AppApi): Promise<void> {
  let selected: string | null = null;
  const say = (text: string): void => {
    page.message.innerHTML = escape(text);
  };
  const open = async (id: string): Promise<void> => {
    selected = id;
    const result = await api.view(id);
    page.detail.innerHTML = result.ok ? detailHtml(id, result.value) : "";
    say(result.ok ? "" : result.error);
  };
  const answer = async (values: Readonly<Record<string, unknown>>): Promise<void> => {
    if (selected === null) {
      return;
    }
    const result = await api.submitView(selected, values);
    say(resultText(result));
    if (result.ok) {
      selected = null;
      page.detail.innerHTML = "";
    }
  };

  // Subscribed first, so no change is missed while the first answers are on their way.
  api.onInbox((entries) => {
    page.list.innerHTML = inboxListHtml(entries);
  });
  api.onPendingViews((count) => {
    page.badge.innerHTML = badgeText(count);
  });
  page.section.on("click", (event) => {
    const toOpen = attributeOf(event.target, "data-open");
    const toPopout = attributeOf(event.target, "data-popout");
    if (listenTo(event.target)) {
      return;
    }
    if (toOpen !== null) {
      void open(toOpen);
    } else if (toPopout !== null) {
      void api.openView(toPopout);
    } else if (attributeOf(event.target, "data-dismiss") !== null) {
      void answer({ __dismiss__: true });
    }
  });
  page.section.on("submit", (event) => {
    event.preventDefault();
    if (attributeOf(event.target, "data-form") === "view") {
      void answer(formValues(event.target));
    }
  });
  page.list.innerHTML = inboxListHtml(await api.inbox());
  page.badge.innerHTML = badgeText(await api.pendingViews());
}
