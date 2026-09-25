// The pop-out page (spec 8.5): one view or snapshot, drawn by the generic renderer, answered
// through the three-call bridge `window.inny` and nothing else. While the runtime restarts,
// `get()` is retried and the page says so (spec 8.5.8).
//
// On a package's own origin (`inny-view://<package>/`) the page has also loaded the package's
// component.js; a content `component: {element}` is then drawn by that custom element, which
// is handed the view as its `view` property and answers with an `inny-submit` event (or the
// bridge itself, which reaches this one view and nothing else).

import type { ViewBridge } from "../contract";
import { attributeOf, componentElementOf, formValues, resultText, viewHtml } from "./render";

/** How often the page asks again while the runtime cannot answer. */
export const RETRY_MS = 1_000;

export const RESTARTING = "The InnyTypes runtime is restarting; trying again in a moment…";

/** What the page needs of its DOM, so it can be exercised without one. */
export interface ViewPage {
  /** Where the view is drawn. */
  readonly root: { innerHTML: string };
  /** One line saying how things stand. */
  readonly status: { textContent: string | null };
  on(type: "submit" | "click" | "inny-submit", listener: (event: PageEvent) => void): void;
  /** Hand the view to its component, once drawn. */
  attach(element: string, value: unknown): void;
  later(ms: number, callback: () => void): void;
}

export interface PageEvent {
  readonly target: unknown;
  readonly detail?: unknown;
  preventDefault(): void;
}

export function mountViewPage(page: ViewPage, bridge: ViewBridge): Promise<void> {
  const say = (text: string): void => {
    page.status.textContent = text;
  };
  const answer = async (sent: ReturnType<ViewBridge["submit"]>): Promise<void> => {
    try {
      say(resultText(await sent));
    } catch (error) {
      say(error instanceof Error ? error.message : String(error));
    }
  };

  page.on("submit", (event) => {
    event.preventDefault();
    const form = event.target;
    const values = formValues(form);
    if (attributeOf(form, "data-form") === "action") {
      void answer(bridge.action(attributeOf(form, "data-action-id") ?? "", values));
    } else {
      void answer(bridge.submit(values));
    }
  });
  page.on("click", (event) => {
    if (attributeOf(event.target, "data-dismiss") !== null) {
      void answer(bridge.submit({ __dismiss__: true }));
    }
  });
  page.on("inny-submit", (event) => {
    const detail = typeof event.detail === "object" && event.detail !== null ? event.detail : {};
    void answer(bridge.submit(detail as Record<string, unknown>));
  });

  const load = async (): Promise<void> => {
    const got = await bridge.get();
    if (!got.ok) {
      say(RESTARTING);
      page.later(RETRY_MS, () => {
        void load();
      });
      return;
    }
    say("");
    page.root.innerHTML = viewHtml(got.value);
    const element = componentElementOf(got.value);
    if (element !== null) {
      page.attach(element, got.value);
    }
  };
  return load();
}

// In a pop-out: mount on the view bridge. A test imports mountViewPage instead.
if (typeof document !== "undefined" && document.getElementById("view") !== null) {
  const root = document.getElementById("view") as HTMLElement;
  const status = document.getElementById("status") as HTMLElement;
  void mountViewPage(
    {
      root,
      status,
      on: (type, listener) => {
        root.addEventListener(type, listener as unknown as EventListener);
      },
      attach: (element, value) => {
        const slot = root.querySelector('[data-slot="component"]');
        if (slot !== null && customElements.get(element) !== undefined) {
          const drawn = document.createElement(element) as HTMLElement & { view?: unknown };
          drawn.view = value;
          slot.append(drawn);
        }
      },
      later: (ms, callback) => {
        setTimeout(callback, ms);
      },
    },
    (window as unknown as { readonly inny: ViewBridge }).inny,
  );
}
