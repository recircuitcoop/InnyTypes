// Preview a view… (plan 0021 §9, D4): a development build's way to see a package's widget
// without running a flow. Every action view type that declares `props` can be previewed: it is
// drawn in the real pop-out sandbox, on its package's own origin, with its declared sample
// props, and the answer it would send is logged, never sent (spec 2.4).
//
// Pure: which types can be previewed, and the view a preview draws. The menu, the chooser and
// the window are the shell's.

import { nodeTypeName } from "../packages/declaration";

/** One type a preview can draw: its package, its id, its palette label and its sample props. */
export interface PreviewChoice {
  readonly package: string;
  readonly type: string;
  readonly label: string;
  readonly props: Readonly<Record<string, unknown>>;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A type's sample props: the first of its `props` schema's `examples`, else none (`{}`). */
function sampleProps(schema: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const examples = schema["examples"];
  const first: unknown = Array.isArray(examples) ? examples[0] : undefined;
  return isRecord(first) ? first : {};
}

/**
 * The types the packages found declare that a preview can draw: action views with a `props`
 * schema, by package and then in declaration order. A declaration that is not one is skipped.
 */
export function previewChoices(
  documents: readonly { readonly name: string; readonly document: unknown }[],
): PreviewChoice[] {
  const choices: PreviewChoice[] = [];
  for (const { name, document } of documents) {
    const types = isRecord(document) && Array.isArray(document["types"]) ? document["types"] : [];
    for (const type of types) {
      if (!isRecord(type) || type["kind"] !== "view" || type["view"] !== "action") {
        continue;
      }
      const { id, label, props } = type;
      if (typeof id !== "string" || !isRecord(props)) {
        continue;
      }
      choices.push({
        package: name,
        type: id,
        label: typeof label === "string" ? label : id,
        props: sampleProps(props),
      });
    }
  }
  return choices;
}

/** A preview's element: `<package>-<type id>`, its underscores as hyphens (spec 2.4). */
export function previewElement(choice: PreviewChoice): string {
  return `${choice.package}-${choice.type}`.replaceAll("_", "-");
}

/** A preview's pop-out id, one per type. */
export const previewId = (choice: PreviewChoice): string => `${choice.package}-${choice.type}`;

/**
 * The view a preview's page is handed by `get()`: shaped as the runtime's (`view.get`), its
 * content the type's own widget with the sample props, titled with the type's label.
 */
export function previewView(choice: PreviewChoice): Readonly<Record<string, unknown>> {
  return {
    kind: "view",
    id: previewId(choice),
    type: nodeTypeName(choice.package, choice.type),
    package: choice.package,
    content: {
      title: choice.label,
      component: { element: previewElement(choice), props: choice.props },
    },
    window: "popout",
    draft: null,
  };
}
