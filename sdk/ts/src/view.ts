// @innytypes/node/view: defineView, the one way to write a widget (plan 0021 §9), the browser
// half of the TypeScript SDK. A widget is a plain web component, defined in the package's
// `view/component.js` and drawn by InnyTypes in the pop-up's sandbox (spec 8.5.3), inside
// InnyTypes' chrome: the page draws the title and Continue · Later · Skip this step, the widget
// draws only its body (spec 8.5.6). No framework and no imports, so a package bundles it into
// its one component.js as it is.
//
// defineView wires what the page and the bridge expect of a component:
// * the view the page hands the element (`view`, before it is connected) becomes the
//   context's `props` (`content.component.props`, `{}` when absent) and `draft`;
// * `setValid` and `saveDraft` are the bridge's `setValid` and `draft` (spec 8.5.6);
// * the element's `answer()`, which Continue calls, returns the definition's answer. The widget
//   never submits by itself (plan 0021 D2).
//
// What a widget answers reaches the flow as any JSON its type's `answer` schema allows, so a
// node must treat it as input (plan 0021, Security).

/** The two bridge calls a widget makes (spec 8.5.6); the page owns the other three. */
interface WidgetBridge {
  setValid(valid: boolean): void;
  draft(values: Readonly<Record<string, unknown>>): Promise<unknown>;
}

/** What a widget is handed: where to draw, its props, its draft, and the two bridge calls. */
export interface WidgetContext<Props extends object, Answer extends object> {
  /** The widget's own element: it draws its body into it. */
  readonly element: HTMLElement;
  /** `content.component.props`, as the node presented them and the runtime judged them. */
  readonly props: Props;
  /** The person's unfinished answer, as last kept (spec 8.1.6); null when there is none. */
  readonly draft: Answer | null;
  /** Enable Continue for `true`, disable it for `false`; it starts disabled. */
  setValid(valid: boolean): void;
  /** Keep the unfinished answer with the view, through Later, a closed window and a restart. */
  saveDraft(values: Answer): Promise<void>;
}

/** A widget: how it draws, and what it answers when the person presses Continue. */
export interface ViewDefinition<Props extends object, Answer extends object> {
  render(context: WidgetContext<Props, Answer>): void;
  answer(context: WidgetContext<Props, Answer>): Answer | Promise<Answer>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `window.inny`, the bridge the pop-up's preload exposes. */
function bridge(): WidgetBridge {
  return (window as unknown as { inny: WidgetBridge }).inny;
}

/** The context of `element`, from the view the page handed it. */
function contextOf<Props extends object, Answer extends object>(
  element: HTMLElement,
  view: unknown,
): WidgetContext<Props, Answer> {
  const content = isRecord(view) && isRecord(view["content"]) ? view["content"] : {};
  const component = isRecord(content["component"]) ? content["component"] : {};
  const props = isRecord(component["props"]) ? component["props"] : {};
  const kept = isRecord(view) && isRecord(view["draft"]) ? view["draft"] : null;
  const context = {
    element,
    props: props as Props,
    draft: kept as Answer | null,
    setValid: (valid: boolean): void => {
      bridge().setValid(valid);
    },
    saveDraft: async (values: Answer): Promise<void> => {
      // Kept here too, so `answer` can read the work in hand from the draft.
      context.draft = values;
      await bridge().draft(values as Readonly<Record<string, unknown>>);
    },
  };
  return context;
}

/** Define the custom element `name` as a widget drawn by `definition`. */
export function defineView<
  Props extends object = Record<string, unknown>,
  Answer extends object = Record<string, unknown>,
>(name: string, definition: ViewDefinition<Props, Answer>): void {
  class Widget extends HTMLElement {
    /** The view, set by the page before the element is connected (spec 8.5.6). */
    view: unknown;
    #context: WidgetContext<Props, Answer> | null = null;

    connectedCallback(): void {
      this.#context = contextOf<Props, Answer>(this, this.view);
      definition.render(this.#context);
    }

    /** What Continue submits. */
    answer(): Answer | Promise<Answer> {
      if (this.#context === null) {
        throw new Error(`<${name}> answered before it was drawn`);
      }
      return definition.answer(this.#context);
    }
  }
  customElements.define(name, Widget);
}
