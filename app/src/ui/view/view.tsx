// The pop-out page (spec 8.5; plan 0022 §M "their page becomes view.tsx with QuestionPopout and
// the tokens"): one view or snapshot, in the InnyTypes chrome, under the pop-out's own CSP,
// unchanged (domain/views/popout VIEW_CSP). The tokens arrive as tokens.css and the components'
// classes as app.css, both served beside view.js on the view origin (style-src 'self').
//
// * An action view is drawn in the Question pop-out: its title, the view's content and form
//   (the generic renderer, render.ts), then Continue · Later · Skip this step. Continue submits
//   the form; under a package's component it waits for the component's setValid(true) and sends
//   its answer() (view-page.ts, plan 0021 §6). Later closes the window and sends nothing: the step
//   keeps waiting. Skip this step confirms once, then dismisses (the flow's error path).
// * A snapshot, or a view no longer waiting, is drawn in a plain panel, as the renderer draws it.
// * The logic is view-page.ts's mountViewPage: this file is only its page, drawn with React. The
//   renderer's HTML lives in one element React never draws into (the host), moved into the
//   chrome once the chrome knows what it holds.
// * Development builds only: `#ark-widgets` draws every Ark UI atom and molecule of the gallery
//   instead, so the e2e gate can open each under this very CSP (plan 0022 risk 7). esbuild drops
//   the branch from a production build (INNY_BUILD_MODE, ui/build-mode.d.ts).
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { VALID_EVENT, type ViewBridge } from "../contract";
import { DialogButtons } from "../components/molecules/DialogButtons";
import { Dialog } from "../components/organisms/Dialog";
import { QuestionPopout } from "../components/organisms/QuestionPopout";
import { t } from "../strings";
import { wordSkip } from "../words";
import { resultText, VIEW_FORM_ID } from "./render";
import { mountViewPage } from "./view-page";

type Fields = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What the chrome needs to know of the page: what was drawn, and whether Continue may go. */
interface Chrome {
  readonly value: unknown;
  readonly continueOn: boolean;
}

/** A tiny store the page's callbacks write and the chrome reads. */
class ChromeState {
  #state: Chrome = { value: null, continueOn: true };
  readonly #listeners = new Set<() => void>();

  get = (): Chrome => this.#state;

  set(change: Partial<Chrome>): void {
    this.#state = { ...this.#state, ...change };
    for (const listener of this.#listeners) {
      listener();
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
}

/** The element the renderer draws into, moved under `Host` wherever the chrome puts it. */
function Host({ element }: { readonly element: HTMLElement }) {
  const place = useRef<HTMLDivElement>(null);
  useEffect(() => {
    place.current?.append(element);
  });
  return <div ref={place} className="flex flex-col gap-4 text-body text-primary" />;
}

export function PopoutChrome({
  state,
  host,
  bridge,
  say,
}: {
  readonly state: ChromeState;
  readonly host: HTMLElement;
  readonly bridge: ViewBridge;
  readonly say: (text: string) => void;
}) {
  const { value, continueOn } = useSyncExternalStore(state.subscribe, state.get, state.get);
  const [skipping, setSkipping] = useState(false);
  const content = isRecord(value) && isRecord(value["content"]) ? value["content"] : null;
  const asks = isRecord(value) && value["kind"] === "view" && content !== null;
  if (!asks) {
    return (
      <section
        data-component="popout-panel"
        className="flex w-[var(--inny-size-popout-width)] max-w-full flex-col gap-4 rounded-l bg-surface-panel p-5 shadow-popout"
      >
        <Host element={host} />
      </section>
    );
  }
  const title = typeof content["title"] === "string" ? content["title"] : "";
  const confirm = wordSkip(title);
  const skip = async () => {
    setSkipping(false);
    try {
      say(resultText(await bridge.submit({ __dismiss__: true })));
    } catch (error) {
      say(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <>
      <QuestionPopout
        title={title}
        continueLabel={t("question.continue")}
        laterLabel={t("question.later")}
        skipLabel={t("question.skip")}
        continueForm={VIEW_FORM_ID}
        continueDisabled={!continueOn}
        onLater={() => {
          // Nothing is sent: the step keeps waiting (spec 8.2.3).
          window.close();
        }}
        onSkip={() => {
          setSkipping(true);
        }}
      >
        <Host element={host} />
      </QuestionPopout>
      <Dialog
        kind="warning"
        open={skipping}
        title={confirm.title}
        body={confirm.body}
        onClose={() => {
          setSkipping(false);
        }}
        buttons={
          <DialogButtons
            kind="neutral"
            primaryLabel={t("question.keepWaiting")}
            cancelLabel={t("question.skip.yes")}
            onPrimary={() => {
              setSkipping(false);
            }}
            onCancel={() => {
              void skip();
            }}
          />
        }
      />
    </>
  );
}

/** Mount the pop-out on its bridge: the chrome with React, the logic with mountViewPage. */
function mountPopout(frame: HTMLElement, host: HTMLElement, status: HTMLElement): void {
  const bridge = (window as unknown as { readonly inny: ViewBridge }).inny;
  const state = new ChromeState();
  const say = (text: string): void => {
    status.textContent = text;
  };
  createRoot(frame).render(<PopoutChrome state={state} host={host} bridge={bridge} say={say} />);
  void mountViewPage(
    {
      root: host,
      status,
      // Host `app` is the generic renderer (domain/views/popout VIEW_HOST); any other, a package.
      packageFiles: window.location.host !== "app",
      chrome: true,
      drawn: (value) => {
        state.set({ value, continueOn: true });
      },
      on: (type, listener) => {
        // The bridge's `setValid` dispatches on the window; everything else bubbles to the host.
        const on = type === VALID_EVENT ? window : host;
        on.addEventListener(type, listener);
      },
      attach: async (element, value) => {
        await customElements.whenDefined(element);
        const slot = host.querySelector('[data-slot="component"]');
        if (slot === null) {
          return null;
        }
        const drawn = document.createElement(element) as HTMLElement & { view?: unknown };
        drawn.view = value;
        slot.append(drawn);
        return drawn;
      },
      // The chrome's Continue is the widget's: nothing to put in place, only to wait for valid.
      widgetChrome: () => undefined,
      setContinue: (enabled) => {
        state.set({ continueOn: enabled });
      },
      close: () => {
        window.close();
      },
      later: (ms, callback) => {
        setTimeout(callback, ms);
      },
    },
    bridge,
  );
}

const frame = document.getElementById("popout");
const host = document.getElementById("view");
const status = document.getElementById("status");
if (frame !== null && host !== null && status !== null) {
  if (INNY_BUILD_MODE !== "production" && window.location.hash === "#ark-widgets") {
    void import("./ArkWidgetsProbe").then(({ ArkWidgetsProbe }) => {
      host.remove();
      createRoot(frame).render(<ArkWidgetsProbe />);
    });
  } else {
    mountPopout(frame, host, status);
  }
}
