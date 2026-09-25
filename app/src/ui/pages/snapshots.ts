// The Snapshots page (spec 8.3, 8.4; arch_pivot P10b): what the flow recorded, newest first.
// A snapshot opens here or in its own window, only when the person asks; each action is shown
// pressable, or disabled with the reason, and a press answers with a new run or the reason.

import type { AppApi, SnapshotSummary } from "../contract";
import { attributeOf, escape, formValues, resultText, viewHtml } from "../view/render";
import { unavailable, type Region, type Section } from "./page";

export function snapshotListHtml(snapshots: readonly SnapshotSummary[]): string {
  if (snapshots.length === 0) {
    return '<p data-testid="snapshots-empty">No snapshots yet.</p>';
  }
  const items = snapshots.map(
    (snapshot) =>
      `<li data-testid="snapshot-item" data-id="${escape(snapshot.id)}">` +
      `${escape(snapshot.label)}: ${escape(snapshot.title)} ` +
      `<time>${escape(new Date(snapshot.time).toISOString())}</time> ` +
      `<button type="button" data-open="${escape(snapshot.id)}" data-testid="snapshot-open">Open</button> ` +
      `<button type="button" data-popout="${escape(snapshot.id)}" data-testid="snapshot-popout">Open in window</button>` +
      "</li>",
  );
  return `<ul data-testid="snapshot-list">${items.join("")}</ul>`;
}

export interface SnapshotsPage {
  readonly section: Section;
  readonly list: Region;
  readonly detail: Region;
  readonly message: Region;
}

/** Mount the page; the returned function draws the list again (when the page is shown). */
export function mountSnapshots(page: SnapshotsPage, api: AppApi): () => Promise<void> {
  let selected: string | null = null;
  const say = (text: string): void => {
    page.message.innerHTML = escape(text);
  };
  const refresh = async (): Promise<void> => {
    const result = await api.snapshots();
    if (result.ok) {
      page.list.innerHTML = snapshotListHtml(result.value);
      say("");
    } else {
      say(unavailable(result.error));
    }
  };
  const open = async (id: string): Promise<void> => {
    selected = id;
    const result = await api.snapshot(id);
    page.detail.innerHTML = result.ok ? viewHtml(result.value) : "";
    say(result.ok ? "" : result.error);
  };

  page.section.on("click", (event) => {
    const toOpen = attributeOf(event.target, "data-open");
    const toPopout = attributeOf(event.target, "data-popout");
    if (toOpen !== null) {
      void open(toOpen);
    } else if (toPopout !== null) {
      void api.openSnapshot(toPopout);
    } else if (attributeOf(event.target, "data-refresh") !== null) {
      void refresh();
    }
  });
  page.section.on("submit", (event) => {
    event.preventDefault();
    const action = attributeOf(event.target, "data-action-id");
    if (selected === null || action === null) {
      return;
    }
    const id = selected;
    void api.pressAction(id, action, formValues(event.target)).then(async (result) => {
      // Drawn again, so each action is judged against the flow as it is now (spec 8.4).
      await open(id);
      say(result.ok ? "Started a new run." : resultText(result));
    });
  });
  return refresh;
}
