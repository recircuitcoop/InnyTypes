// The pop-out page (spec 8.5): one view or snapshot, drawn by the generic renderer, answered
// through the five-call bridge `window.inny` and nothing else. While the runtime restarts,
// `get()` is retried and the page says so (spec 8.5.8).
//
// On a package's own origin (`inny-view://<package>/`) the page has also loaded the package's
// component.js; a content `component: {element, props?}` is then drawn by that custom element,
// which is handed the view (its props and its draft with it) as its `view` property, once its
// element is defined. Only then does the chrome under it become InnyTypes' widget chrome (spec
// 8.5.6): Continue starts disabled, the component's `setValid(true)` enables it, and pressing it
// submits what the component's `answer()` returns; Later closes the window; Skip this step
// dismisses. Until then the view keeps its enabled Submit and Dismiss. A component written
// before 0.4.0 still answers with `inny-submit`.
//
// A widget that cannot be drawn falls back (plan 0021 §5): its element is not defined within
// LOAD_TIMEOUT_MS, its component.js is missing or breaks the CSP while it loads, drawing it
// throws (its constructor or connectedCallback), or the page is not its package's own. The page
// then draws the view's `form` with Submit and Dismiss, or, with no form, says the question
// can't be shown here and offers Skip this step only. Never silence, never a dead Continue.

import { VALID_EVENT, type ViewBridge } from "../contract";
import {
  attributeOf,
  BUTTONS_SLOT,
  COMPONENT_SLOT,
  componentElementOf,
  fallbackHtml,
  FIELDS_SLOT,
  formValues,
  isWidgetView,
  listenTo,
  resultText,
  viewHtml,
  WIDGET_CHROME,
} from "./render";

/** How often the page asks again while the runtime cannot answer. */
export const RETRY_MS = 1_000;

export const RESTARTING = "The InnyTypes runtime is restarting; trying again in a moment…";

/** How long a widget's element has to be defined before the page falls back (plan 0021 §5). */
export const LOAD_TIMEOUT_MS = 3_000;

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
  /** `inny-valid` is listened for on the window, where the bridge dispatches it. */
  on(
    type: "submit" | "click" | "inny-submit" | typeof VALID_EVENT,
    listener: (event: PageEvent) => void,
  ): void;
  /**
   * Draw the view's component once its element is defined, handed the view: the element, or
   * null when it cannot be drawn (its slot is gone, or drawing it threw). Never settles while
   * the element is not defined.
   */
  attach(element: string, value: unknown): Promise<Widget | null>;
  /**
   * Call `listener` when the package's component.js fails to load or breaks the CSP; at once
   * when that already happened before the page asked.
   */
  onLoadFailure(listener: () => void): void;
  /** Put `html` in what the slot `selector` holds. */
  fill(selector: string, html: string): void;
  /** Take the slot `selector` out of the page. */
  remove(selector: string): void;
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
    page.root.innerHTML = viewHtml(got.value, page.packageFiles);
    if (!isWidgetView(got.value)) {
      return;
    }
    const value = got.value;
    /** Whether the widget is drawn, or the page fell back: whichever came first holds. */
    let settled = false;
    const fallBack = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      page.remove(COMPONENT_SLOT);
      const { fields, buttons } = fallbackHtml(value);
      page.fill(FIELDS_SLOT, fields);
      if (buttons !== null) {
        page.fill(BUTTONS_SLOT, buttons);
      }
    };
    // A component can run only on its package's own origin, where its component.js is loaded.
    const element = componentElementOf(value);
    if (element === null || !page.packageFiles) {
      fallBack();
      return;
    }
    page.onLoadFailure(fallBack);
    page.later(LOAD_TIMEOUT_MS, fallBack);
    void page.attach(element, value).then((drawn) => {
      if (settled) {
        return;
      }
      if (drawn === null) {
        fallBack();
        return;
      }
      settled = true;
      widget = drawn;
      page.widgetChrome();
      page.setContinue(valid);
    });
  };
  return load();
}

/**
 * Watch for the package's component.js failing while it loads: a CSP violation, or the script
 * itself not loading. view.html loads component.js after view.js, so nothing is missed.
 */
function watchLoadFailures(): (listener: () => void) => void {
  let failed = false;
  const listeners: (() => void)[] = [];
  const fail = (): void => {
    if (failed) {
      return;
    }
    failed = true;
    for (const listener of listeners) {
      listener();
    }
  };
  document.addEventListener("securitypolicyviolation", fail);
  // A script's load error does not bubble: it is caught on its way down, in the capture phase.
  window.addEventListener(
    "error",
    (event) => {
      const { target } = event;
      if (target instanceof HTMLScriptElement && target.src.endsWith("/component.js")) {
        fail();
      }
    },
    true,
  );
  return (listener) => {
    if (failed) {
      listener();
    } else {
      listeners.push(listener);
    }
  };
}

/**
 * Draw `element` into `slot`, handed `value`: null when constructing or connecting it threw.
 * Such a throw is reported (an error event), never thrown to the caller, so it is listened for.
 */
function drawWidget(slot: Element, element: string, value: unknown): HTMLElement | null {
  let crashed = false;
  const onError = (): void => {
    crashed = true;
  };
  window.addEventListener("error", onError);
  let drawn: (HTMLElement & { view?: unknown }) | null = null;
  try {
    drawn = document.createElement(element);
    drawn.view = value;
    slot.append(drawn);
  } catch {
    crashed = true;
  } finally {
    window.removeEventListener("error", onError);
  }
  if (crashed) {
    drawn?.remove();
    return null;
  }
  return drawn;
}

// In a pop-out: mount on the view bridge. A test imports mountViewPage instead.
if (typeof document !== "undefined" && document.getElementById("view") !== null) {
  const root = document.getElementById("view") as HTMLElement;
  const status = document.getElementById("status") as HTMLElement;
  const onLoadFailure = watchLoadFailures();
  void mountViewPage(
    {
      root,
      status,
      // Host `app` is the generic renderer (domain/views/popout VIEW_HOST); any other, a package.
      packageFiles: window.location.host !== "app",
      on: (type, listener) => {
        // The bridge's `setValid` dispatches on the window; everything else bubbles to root.
        const on = type === VALID_EVENT ? window : root;
        on.addEventListener(type, listener);
      },
      attach: async (element, value) => {
        await customElements.whenDefined(element);
        // Gone when the page fell back while the element was still being defined.
        const slot = root.querySelector(COMPONENT_SLOT);
        return slot === null ? null : drawWidget(slot, element, value);
      },
      onLoadFailure,
      fill: (selector, html) => {
        const slot = root.querySelector(selector);
        if (slot !== null) {
          slot.innerHTML = html;
        }
      },
      remove: (selector) => {
        root.querySelector(selector)?.remove();
      },
      widgetChrome: () => {
        const buttons = root.querySelector(BUTTONS_SLOT);
        if (buttons !== null) {
          buttons.innerHTML = WIDGET_CHROME;
        }
      },
      setContinue: (enabled) => {
        const button = root.querySelector<HTMLButtonElement>('[data-testid="view-continue"]');
        if (button !== null) {
          button.disabled = !enabled;
        }
      },
      close: () => {
        window.close();
      },
      later: (ms, callback) => {
        setTimeout(callback, ms);
      },
    },
    (window as unknown as { readonly inny: ViewBridge }).inny,
  );
}
