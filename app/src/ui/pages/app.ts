// The app pages (plan 0018 §2.4; WI-0018-11), served by the shell on inny-app://app/: the
// Node-RED editor in a frame, Inbox, Snapshots, Events, Jobs, Packages and Settings, with the
// children's state and Quit above every page. Every page uses AppApi and nothing else, so they keep
// working while the runtime is down, and a redesign replaces this folder and nothing more.
//
// Plain on purpose: the owner will redesign the UI. Tests find everything by `data-testid`.

import type { AppApi, ChildStatus } from "../contract";
import { attributeOf, escape } from "../view/render";
import { mountEditorSync, type EditorSyncDom } from "./editor-sync";
import { mountEvents, type EventsPage } from "./events";
import { mountInbox, type InboxPage } from "./inbox";
import { mountJobs, type JobsPage } from "./jobs";
import { mountPackages, type PackagesPage } from "./packages";
import type { PageEvent, Region, Section } from "./page";
import { mountQuitQuestion, type QuitQuestionDom } from "./quit-question";
import { mountSettings, type SettingsPage } from "./settings";
import { mountSnapshots, type SnapshotsPage } from "./snapshots";
import { mountStatusPage, type EditorFrame, type StatusRoot } from "./status";
import { mountTelemetry, type TelemetryDom } from "./telemetry";

export const PAGES = [
  "editor",
  "inbox",
  "snapshots",
  "events",
  "jobs",
  "packages",
  "settings",
] as const;
export type PageName = (typeof PAGES)[number];

export const isPageName = (value: unknown): value is PageName =>
  typeof value === "string" && (PAGES as readonly string[]).includes(value);

/** The runtime's state in a line, for the pages that need it (spec 10.8 `childState`). */
export function runtimeLine(status: ChildStatus): string {
  return `<span data-testid="runtime-state" data-state="${status.state}">The runtime is ${escape(status.state)}.</span>`;
}

export interface AppDom {
  readonly nav: Section;
  readonly sections: ReadonlyMap<PageName, { hidden: HTMLElement["hidden"] }>;
  readonly status: StatusRoot;
  readonly editor?: EditorFrame;
  /** Where the runtime's state is said again on every page that asks the runtime. */
  readonly runtimeLines: readonly Region[];
  readonly inbox: InboxPage;
  readonly snapshots: SnapshotsPage;
  readonly jobs: JobsPage;
  readonly settings: SettingsPage;
  readonly packages: PackagesPage;
  /** The event types created in the app (WI-0018-13). */
  readonly events?: EventsPage;
  /** The editor's palette kept in step with the runtime (WI-0018-12). */
  readonly editorSync?: EditorSyncDom;
  /** The question a quit asks when the editor holds undeployed edits (WI-0018-12). */
  readonly quitQuestion?: QuitQuestionDom;
  /** The telemetry question and switch (WI-0018-22). */
  readonly telemetry?: TelemetryDom;
}

/** Mount every page. Returns the function the nav calls to show one. */
export async function mountApp(
  dom: AppDom,
  api: AppApi,
): Promise<(name: PageName) => Promise<void>> {
  const telemetry = dom.telemetry === undefined ? null : mountTelemetry(dom.telemetry, api);
  const settings = mountSettings(dom.settings, api);
  const refreshers: Partial<Record<PageName, () => Promise<void>>> = {
    snapshots: mountSnapshots(dom.snapshots, api),
    jobs: mountJobs(dom.jobs, api),
    settings: async () => {
      await settings();
      await telemetry?.();
    },
    packages: mountPackages(dom.packages, api),
    ...(dom.events === undefined ? {} : { events: mountEvents(dom.events, api) }),
  };
  let shown: PageName = "editor";
  let runtimeRunning = false;
  const syncEditor = dom.editorSync === undefined ? null : mountEditorSync(dom.editorSync, api);
  if (dom.quitQuestion !== undefined) {
    mountQuitQuestion(dom.quitQuestion, api);
  }

  const show = async (name: PageName): Promise<void> => {
    shown = name;
    for (const [page, section] of dom.sections) {
      section.hidden = page !== name;
    }
    await refreshers[name]?.();
  };
  dom.nav.on("click", (event: PageEvent) => {
    const name = attributeOf(event.target, "data-page");
    if (isPageName(name)) {
      void show(name);
    } else if (attributeOf(event.target, "data-quit") !== null) {
      void api.quit();
    }
  });

  // An input started or ended: the Jobs page, when it is shown, asks for the list again, so a
  // cancelled job leaves it once the node has stopped it.
  api.onJobs(() => {
    if (shown === "jobs") {
      void refreshers.jobs?.();
    }
  });

  const onRuntime = (status: ChildStatus): void => {
    for (const line of dom.runtimeLines) {
      line.innerHTML = runtimeLine(status);
    }
    // Back after a restart: the page on show asks the runtime again.
    const running = status.state === "running";
    if (running && !runtimeRunning) {
      void refreshers[shown]?.();
    }
    runtimeRunning = running;
    // Each new generation: bring the editor's palette in step with it.
    syncEditor?.(status);
  };
  await mountStatusPage(dom.status, api, dom.editor, onRuntime);
  await mountInbox(dom.inbox, api);
  // The first-launch question, above whichever page is shown, until it is answered.
  await telemetry?.();
  await show("editor");
  return show;
}

// ── in the app page: the DOM, on the preload bridge. A test imports mountApp instead. ─────

declare global {
  interface Window {
    readonly inny: { readonly app: AppApi };
  }
}

function byId(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`the app page has no #${id}`);
  }
  return element;
}

/** A section's events, with the target the element that carries the data attribute. */
function sectionOf(element: HTMLElement): Section {
  return {
    on: (type, listener) => {
      element.addEventListener(type, (event) => {
        const target =
          event.target instanceof Element
            ? (event.target.closest(
                "[data-page],[data-quit],[data-open],[data-popout],[data-cancel]," +
                  "[data-editor-reload],[data-editor-keep],[data-quit-choice]," +
                  "[data-install],[data-remove],[data-install-file],[data-confirm-unsigned]," +
                  "[data-cancel-unsigned]," +
                  "[data-fire],[data-new-version],[data-delete],[data-add-field],[data-cancel-edit]",
              ) ?? event.target)
            : event.target;
        listener({
          target,
          preventDefault: () => {
            event.preventDefault();
          },
        });
      });
    },
  };
}

if (typeof document !== "undefined" && document.getElementById("nav") !== null) {
  const section = (name: PageName) => sectionOf(byId(`page-${name}`));
  const editor = document.getElementById("editor");
  const quitBox = byId("quit-question");
  void mountApp(
    {
      nav: sectionOf(byId("nav")),
      sections: new Map(PAGES.map((name) => [name, byId(`page-${name}`)])),
      status: byId("status"),
      ...(editor instanceof HTMLIFrameElement ? { editor } : {}),
      runtimeLines: [byId("inbox-runtime"), byId("snapshots-runtime"), byId("jobs-runtime")],
      inbox: {
        section: section("inbox"),
        list: byId("inbox-list"),
        detail: byId("inbox-detail"),
        message: byId("inbox-message"),
        badge: byId("inbox-badge"),
      },
      snapshots: {
        section: section("snapshots"),
        list: byId("snapshots-list"),
        detail: byId("snapshots-detail"),
        message: byId("snapshots-message"),
      },
      jobs: { section: section("jobs"), list: byId("jobs-list"), message: byId("jobs-message") },
      events: {
        section: section("events"),
        list: byId("events-list"),
        editor: byId("events-editor"),
        fire: byId("events-fire"),
        message: byId("events-message"),
      },
      packages: {
        section: section("packages"),
        list: byId("packages-list"),
        catalogue: byId("packages-catalogue"),
        sources: byId("packages-sources"),
        question: byId("packages-question"),
        message: byId("packages-message"),
      },
      settings: {
        section: section("settings"),
        secrets: byId("settings-secrets"),
        endpoint: byId("settings-endpoint"),
        anytype: byId("settings-anytype"),
        login: byId("settings-login"),
        message: byId("settings-message"),
      },
      ...(editor instanceof HTMLIFrameElement
        ? {
            editorSync: {
              section: section("editor"),
              status: byId("editor-sync"),
              prompt: byId("editor-prompt"),
              // The same address again: the frame loads the editor afresh from the runtime.
              reload: () => {
                const address = editor.src;
                editor.src = address;
              },
            },
          }
        : {}),
      quitQuestion: { section: sectionOf(quitBox), box: quitBox },
      telemetry: {
        question: Object.assign(byId("telemetry-question"), sectionOf(byId("telemetry-question"))),
        settings: Object.assign(byId("settings-telemetry"), sectionOf(byId("settings-telemetry"))),
        message: byId("settings-message"),
      },
    },
    window.inny.app,
  );
}
