// The Jobs page (spec 7, 4.1 `cancel`; arch_pivot P3): the inputs the nodes are working on
// now, each with Cancel. A cancel is sent to the node, which ends the input with an error that
// reaches Catch; the list is drawn again after.

import type { AppApi, Job } from "../contract";
import { attributeOf, escape } from "../view/render";
import { unavailable, type Region, type Section } from "./page";

export function jobListHtml(jobs: readonly Job[]): string {
  if (jobs.length === 0) {
    return '<p data-testid="jobs-empty">No node is working on anything now.</p>';
  }
  const items = jobs.map(
    (job) =>
      `<li data-testid="job-item" data-id="${escape(job.id)}">` +
      `${escape(job.type)} (${escape(job.instanceId)}), attempt ${String(job.attempts)}, ` +
      `since <time>${escape(new Date(job.createdAt).toISOString())}</time> ` +
      `<button type="button" data-cancel="${escape(job.id)}" data-testid="job-cancel">Cancel</button>` +
      "</li>",
  );
  return `<ul data-testid="job-list">${items.join("")}</ul>`;
}

export interface JobsPage {
  readonly section: Section;
  readonly list: Region;
  readonly message: Region;
}

/** Mount the page; the returned function draws the list again (when the page is shown). */
export function mountJobs(page: JobsPage, api: AppApi): () => Promise<void> {
  const say = (text: string): void => {
    page.message.innerHTML = escape(text);
  };
  const refresh = async (): Promise<void> => {
    const result = await api.jobs();
    if (result.ok) {
      page.list.innerHTML = jobListHtml(result.value);
    } else {
      say(unavailable(result.error));
    }
  };
  page.section.on("click", (event) => {
    const toCancel = attributeOf(event.target, "data-cancel");
    if (toCancel !== null) {
      void api.cancelJob(toCancel).then(async (result) => {
        say(result.ok ? "Cancel sent." : result.error);
        await refresh();
      });
    } else if (attributeOf(event.target, "data-refresh") !== null) {
      say("");
      void refresh();
    }
  });
  return refresh;
}
