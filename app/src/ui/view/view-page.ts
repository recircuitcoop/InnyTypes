// The pop-out page's logic (spec 8.5), mounted by view.tsx: one view or snapshot, drawn by the generic renderer, answered
// through the five-call bridge `window.inny` and nothing else. While the runtime restarts,
// `get()` is retried and the page says so (spec 8.5.8).
//
// On a package's own origin (`inny-view://<package>/`) the page has also loaded the package's
// component.js; a content `component: {element, props?}` is then drawn by that custom element,
// which is handed the view (its props and its draft with it) as its `view` property, once its
// element is defined. Only then does the chrome under it become InnyTypes' widget chrome (spec
// 8.5.6): Continue starts disabled, the component's `setValid(true)` enables it, and pressing it
// submits what the component's `answer()` returns; Later closes the window; Skip this step
// dismisses. Until then, and for good when the element is never defined, the view keeps its
// enabled Submit and Dismiss. A component written before 0.4.0 still answers with `inny-submit`.

import { VALID_EVENT, type ViewBridge } from "../contract";
import {
  attributeOf,
  componentElementOf,
  formValues,
  listenTo,
  resultText,
  viewHtml,
} from "./render";

/** How often the page asks again while the runtime cannot answer. */
export const RETRY_MS = 1_000;

export const RESTARTING = "The InnyTypes runtime is restarting; trying again in a moment…";

/** What the page says when a component has no `answer()`, or it fails. */
export const NO_ANSWER = "This step's answer couldn't be read. Try again, or skip this step.";

/** A drawn component; Continue calls its `answer()`, when it has one. */
export type Widget = object;

/** What the page needs of its DOM, so it can be exercised without one. */
export interface ViewPage {
  /** Where the view is drawn. */
  readonly root: { innerHTML: string };
  /** One line saying how things stand. */
  readonly status: { textContent: string | null };
  /** Whether the page is on a package's own origin, so its `view/` files are served to it. */
  readonly packageFiles: boolean;
  /**
   * The pop-out's Question pop-out draws the chrome (view.tsx): the title and Continue · Later ·
   * Skip this step are its, so the generic renderer draws neither (render.ts viewHtml).
   */
  readonly chrome?: boolean;
  /** Told what was drawn, after each `get()` that answered. */
  drawn?(value: unknown): void;
  /** `inny-valid` is listened for on the window, where the bridge dispatches it. */
  on(
    type: "submit" | "click" | "inny-submit" | typeof VALID_EVENT,
    listener: (event: PageEvent) => void,
  ): void;
  /**
   * Draw the view's component once its element is defined, handed the view: the element, or
   * null when it cannot be drawn. Never settles while the element is not defined.
   */
  attach(element: string, value: unknown): Promise<Widget | null>;
  /** Put WIDGET_CHROME in place of the view's own buttons (the BUTTONS_SLOT). */
  widgetChrome(): void;
  /** Enable or disable the Continue button. */
  setContinue(enabled: boolean): void;
  /** Close the window (Later): nothing is sent, the view stays pending (spec 8.2.3). */
  close(): void;
  later(ms: number, callback: () => void): void;
}

export interface PageEvent {
  readonly target: unknown;
  readonly detail?: unknown;
  preventDefault(): void;
}

/** What the component's `answer()` returns, awaited; null when it has none or it fails. */
async function answerOf(widget: Widget): Promise<Record<string, unknown> | null> {
  const { answer } = widget as { readonly answer?: unknown };
  if (typeof answer !== "function") {
    return null;
  }
  try {
    const values: unknown = await (answer as () => unknown).call(widget);
    return typeof values === "object" && values !== null && !Array.isArray(values)
      ? (values as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function mountViewPage(page: ViewPage, bridge: ViewBridge): Promise<void> {
  /** The component drawing the view now; null for a view the generic renderer draws. */
  let widget: Widget | null = null;
  /**
   * The component's last `setValid`: kept, because a component may call it while it is being
   * drawn, before the chrome (and its Continue) is in place.
   */
  let valid = false;
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
  /** Continue under a component: InnyTypes sends what the component answers (plan 0021 D2). */
  const continueWith = async (drawn: Widget): Promise<void> => {
    const values = await answerOf(drawn);
    if (values === null) {
      say(NO_ANSWER);
      return;
    }
    await answer(bridge.submit(values));
  };

  page.on("submit", (event) => {
    event.preventDefault();
    const form = event.target;
    if (attributeOf(form, "data-form") === "action") {
      void answer(bridge.action(attributeOf(form, "data-action-id") ?? "", formValues(form)));
    } else if (widget !== null) {
      void continueWith(widget);
    } else {
      void answer(bridge.submit(formValues(form)));
    }
  });
  page.on("click", (event) => {
    if (listenTo(event.target)) {
      return;
    }
    if (attributeOf(event.target, "data-dismiss") !== null) {
      void answer(bridge.submit({ __dismiss__: true }));
    } else if (attributeOf(event.target, "data-later") !== null) {
      page.close();
    }
  });
  page.on("inny-submit", (event) => {
    const detail = typeof event.detail === "object" && event.detail !== null ? event.detail : {};
    void answer(bridge.submit(detail as Record<string, unknown>));
  });
  page.on(VALID_EVENT, (event) => {
    valid = event.detail === true;
    page.setContinue(valid);
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
    page.root.innerHTML = viewHtml(got.value, page.packageFiles, page.chrome === true);
    page.drawn?.(got.value);
    // A component can run only on its package's own origin, where its component.js is loaded.
    const element = componentElementOf(got.value);
    if (element === null || !page.packageFiles) {
      return;
    }
    void page.attach(element, got.value).then((drawn) => {
      if (drawn !== null) {
        widget = drawn;
        page.widgetChrome();
        page.setContinue(valid);
      }
    });
  };
  return load();
}
