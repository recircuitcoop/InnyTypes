// The generic view renderer (spec 8.1.3; plan 0018 §2.3 ui/view): a view's or snapshot's
// content drawn as plain HTML, for the Inbox, the Snapshots page and every pop-out.
//
// | content    | drawn as                                                        |
// |------------|-----------------------------------------------------------------|
// | title      | a heading                                                       |
// | text       | preformatted text                                               |
// | fields     | a key → value table                                             |
// | table      | `{columns, rows}` as a table                                    |
// | media      | images: `data:image/…` URIs, or a file of the view's own origin |
// |            | audio: a Listen control for `data:audio/…`, or a package's file   |
// |            | on its own pop-out only (elsewhere, a sentence saying where)      |
// | anytype    | `{objectId, spaceId, name}` as a link Anytype opens             |
// | form       | JSON Schema properties, as inputs                               |
// | component  | `{element, props?}`: the view's own package's web component     |
// |            | (view.ts); once drawn, InnyTypes' Continue · Later · Skip this step |
//
// Everything is escaped; nothing in the content is ever markup. Plain on purpose: the owner
// will redesign the UI (plan 0018 §2.4). Tests find everything by `data-testid`.

import type { ViewResult } from "../contract";

const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escape(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}

type Fields = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A value as text in a cell: strings as they are, anything else as JSON. */
function cell(value: unknown): string {
  // Content arrives as JSON, so JSON.stringify answers for anything in it but undefined.
  if (value === undefined) {
    return "";
  }
  return escape(typeof value === "string" ? value : JSON.stringify(value));
}

function fieldsHtml(fields: Fields): string {
  const rows = Object.entries(fields).map(
    ([key, value]) => `<tr><th>${escape(key)}</th><td>${cell(value)}</td></tr>`,
  );
  return `<table data-testid="view-fields">${rows.join("")}</table>`;
}

function tableHtml(table: Fields): string {
  const columns = Array.isArray(table["columns"]) ? table["columns"] : [];
  const rows = Array.isArray(table["rows"]) ? table["rows"] : [];
  const head = columns.map((column) => `<th>${cell(column)}</th>`).join("");
  const body = rows
    .filter((row): row is unknown[] => Array.isArray(row))
    .map((row) => `<tr>${row.map((value) => `<td>${cell(value)}</td>`).join("")}</tr>`)
    .join("");
  return `<table data-testid="view-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/** An image the CSP lets through: a data URI of an image, or a flat file of the page's origin. */
const IMAGE_SOURCE =
  /^(data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+|[A-Za-z0-9][A-Za-z0-9_-]*\.(png|svg))$/;

/** A sample the CSP lets through (plan 0020 D1): a data URI of audio, or a flat file of the origin. */
const AUDIO_SOURCE =
  /^(data:audio\/(mpeg|ogg|wav|webm);base64,[A-Za-z0-9+/=]+|[A-Za-z0-9][A-Za-z0-9_-]*\.(mp3|ogg|wav))$/;

/** Lucide's `play` (the design's icon set, ui/components/atoms/Icon.tsx), 16px, 1.5px stroke. */
const PLAY_ICON =
  '<svg data-component="icon" data-variant="name=play;size=16" width="16" height="16" ' +
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" pointer-events="none">' +
  '<path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/>' +
  "</svg>";

/**
 * The runtime's reason for an audio item over the bound (domain/views SAMPLE_TOO_LARGE): the
 * runtime marks the item `refused: "too-large"`, and only that code is drawn, as this sentence.
 */
export const SAMPLE_TOO_LARGE = "the sample is too large to show; keep it under 768 KB";

/**
 * What a package-file sample is drawn as where the page does not hold the package's files
 * (inline, and a pop-out with no component): it would never play there, so no button is drawn.
 */
export const SAMPLE_PLAYS_ELSEWHERE = "This sample plays in the view's own window.";

/** What a Listen control reads while its sample plays. */
export const LISTENING = "Listening…";

/**
 * An audio item as a Listen control (plan 0020 §1, D3): a Secondary button with the play icon
 * and the label. The sample sits inside it with no `controls` and no `autoplay`, so the system
 * player is never shown and nothing plays until the person presses (listenTo). An item the
 * runtime refused over the bound is drawn as its reason. A package-file sample is drawn as a
 * control only where `packageFiles` says the page holds the package's files.
 */
function audioHtml(item: Fields, packageFiles: boolean): string {
  if (item["refused"] !== undefined) {
    return item["refused"] === "too-large"
      ? `<p data-testid="view-media-refused">${SAMPLE_TOO_LARGE}</p>`
      : "";
  }
  if (typeof item["src"] !== "string" || !AUDIO_SOURCE.test(item["src"])) {
    return "";
  }
  // A data: sample plays on any page; a file plays only from the package's own origin.
  if (!packageFiles && !item["src"].startsWith("data:")) {
    return `<p data-testid="view-media-elsewhere">${SAMPLE_PLAYS_ELSEWHERE}</p>`;
  }
  const label =
    typeof item["label"] === "string" && item["label"] !== "" ? item["label"] : "Listen";
  return (
    '<button type="button" data-listen="1" data-testid="view-listen" data-component="button" ' +
    'data-variant="kind=secondary;size=default;state=default">' +
    `${PLAY_ICON}<span data-listen-label="${escape(label)}">${escape(label)}</span>` +
    `<audio data-testid="view-audio" preload="none" src="${escape(item["src"])}"></audio></button>`
  );
}

function mediaHtml(media: unknown, packageFiles: boolean): string {
  const items = Array.isArray(media) ? media : [media];
  return items
    .filter(isRecord)
    .map((item) => {
      // An item with `type: "image"` is an image whatever its `kind`, as before audio existed.
      if (item["kind"] === "audio" && item["type"] !== "image") {
        return audioHtml(item, packageFiles);
      }
      if (
        item["type"] !== "image" ||
        typeof item["src"] !== "string" ||
        !IMAGE_SOURCE.test(item["src"])
      ) {
        return "";
      }
      const alt = typeof item["alt"] === "string" ? item["alt"] : "";
      return `<img data-testid="view-media" src="${escape(item["src"])}" alt="${escape(alt)}">`;
    })
    .join("");
}

/** A drawn sample, as far as playing it once goes. */
interface Sample {
  readonly paused: boolean;
  currentTime: number;
  loop: boolean;
  play(): Promise<void> | void;
  pause(): void;
  addEventListener(
    type: "ended" | "pause",
    listener: () => void,
    options?: { once: boolean },
  ): void;
}

/** A Listen control, as far as pressing it goes. */
interface ListenControl {
  querySelector(selector: "audio"): Sample | null;
  querySelector(
    selector: "[data-listen-label]",
  ): { textContent: string | null; getAttribute(name: string): string | null } | null;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
}

/**
 * A press on a Listen control, from a click anywhere in it: play its sample once from the start,
 * reading "Listening…" until it ends; a press while it plays stops it (D3: play and stop only).
 * Answers whether the click was on a Listen control.
 */
export function listenTo(target: unknown): boolean {
  const closest = isRecord(target) ? (target as { closest?: unknown }).closest : undefined;
  const control =
    typeof closest === "function"
      ? (closest.call(target, "[data-listen]") as ListenControl | null)
      : null;
  const sample = control?.querySelector("audio") ?? null;
  const text = control?.querySelector("[data-listen-label]") ?? null;
  if (control === null || sample === null || text === null) {
    return false;
  }
  if (!sample.paused) {
    sample.pause();
    return true;
  }
  const label = text.getAttribute("data-listen-label") ?? "";
  const rest = (): void => {
    text.textContent = label;
    control.setAttribute("aria-pressed", "false");
  };
  sample.loop = false;
  sample.currentTime = 0;
  sample.addEventListener("ended", rest, { once: true });
  sample.addEventListener("pause", rest, { once: true });
  text.textContent = LISTENING;
  control.setAttribute("aria-pressed", "true");
  void Promise.resolve(sample.play()).catch(rest);
  return true;
}

const ANYTYPE_ID = /^[A-Za-z0-9._-]+$/;

function anytypeHtml(link: Fields): string {
  const { objectId, spaceId, name } = link;
  if (typeof objectId !== "string" || typeof spaceId !== "string") {
    return "";
  }
  if (!ANYTYPE_ID.test(objectId) || !ANYTYPE_ID.test(spaceId)) {
    return "";
  }
  const href = `anytype://object?objectId=${objectId}&spaceId=${spaceId}`;
  const label = typeof name === "string" && name !== "" ? name : "Open in Anytype";
  return `<p><a data-testid="view-anytype" href="${escape(href)}">${escape(label)}</a></p>`;
}

/** One input per JSON Schema property (spec 8.1.3 `form`), labelled with its title. */
export function formFieldsHtml(schema: unknown): string {
  const properties = isRecord(schema) && isRecord(schema["properties"]) ? schema["properties"] : {};
  return Object.entries(properties)
    .filter((entry): entry is [string, Fields] => isRecord(entry[1]))
    .map(([name, property]) => {
      const label = escape(typeof property["title"] === "string" ? property["title"] : name);
      const field = escape(name);
      const testid = `data-testid="field-${field}"`;
      let control: string;
      if (Array.isArray(property["enum"])) {
        const options = property["enum"]
          .map((option) => `<option value="${cell(option)}">${cell(option)}</option>`)
          .join("");
        control = `<select name="${field}" ${testid}>${options}</select>`;
      } else if (property["type"] === "boolean") {
        control = `<input type="checkbox" name="${field}" data-kind="boolean" ${testid}>`;
      } else if (property["type"] === "number" || property["type"] === "integer") {
        control = `<input type="number" name="${field}" data-kind="number" ${testid}>`;
      } else {
        control = `<input type="text" name="${field}" ${testid}>`;
      }
      return `<label>${label} ${control}</label>`;
    })
    .join("");
}

/**
 * The content's parts, in a fixed order; unknown parts are left out. `packageFiles`: whether
 * the page holds the view's package files (true only on a package's own pop-out origin).
 */
export function contentHtml(content: unknown, packageFiles: boolean): string {
  if (!isRecord(content)) {
    return "";
  }
  const parts: string[] = [];
  if (typeof content["title"] === "string") {
    parts.push(`<h2 data-testid="view-title">${escape(content["title"])}</h2>`);
  }
  if (typeof content["text"] === "string") {
    parts.push(`<pre data-testid="view-text">${escape(content["text"])}</pre>`);
  }
  if (isRecord(content["fields"])) {
    parts.push(fieldsHtml(content["fields"]));
  }
  if (isRecord(content["table"])) {
    parts.push(tableHtml(content["table"]));
  }
  if (content["media"] !== undefined) {
    parts.push(mediaHtml(content["media"], packageFiles));
  }
  if (isRecord(content["anytype"])) {
    parts.push(anytypeHtml(content["anytype"]));
  }
  if (isRecord(content["component"])) {
    parts.push('<div data-testid="view-component" data-slot="component"></div>');
  }
  return parts.join("");
}

/** A judged snapshot action (spec 8.4): pressable, or disabled with the reason. */
function actionHtml(action: unknown): string {
  if (!isRecord(action) || typeof action["id"] !== "string") {
    return "";
  }
  const id = escape(action["id"]);
  const label = escape(typeof action["label"] === "string" ? action["label"] : action["id"]);
  const enabled = action["enabled"] !== false;
  const reason =
    !enabled && typeof action["reason"] === "string"
      ? `<span data-testid="action-reason-${id}">${escape(action["reason"])}</span>`
      : "";
  return (
    `<form data-form="action" data-action-id="${id}" data-testid="action-form-${id}">` +
    formFieldsHtml(action["form"]) +
    `<button type="submit" data-testid="action-${id}"${enabled ? "" : " disabled"}>${label}</button>` +
    `${reason}</form>`
  );
}

/**
 * The chrome under a view its package's component draws (spec 8.5.6): InnyTypes', never the
 * component's. Continue starts disabled; the component's `setValid(true)` enables it. Only the
 * pop-out page puts it in place, and only once the component is drawn (view.ts): everywhere
 * else a view keeps VIEW_BUTTONS, which work without a component.
 */
export const WIDGET_CHROME =
  '<button type="submit" data-testid="view-continue" disabled>Continue</button>' +
  '<button type="button" data-later="1" data-testid="view-later">Later</button>' +
  '<button type="button" data-dismiss="1" data-testid="view-dismiss">Skip this step</button>';

/** An action view's own buttons, in the slot WIDGET_CHROME replaces under a drawn component. */
const VIEW_BUTTONS =
  '<button type="submit" data-testid="view-submit">Submit</button>' +
  '<button type="button" data-dismiss="1" data-testid="view-dismiss">Dismiss</button>';

/** The slot of an action view's buttons, which the pop-out page fills with WIDGET_CHROME. */
export const BUTTONS_SLOT = '[data-slot="view-buttons"]';

/**
 * A `view.get` or `snapshot.get` value, drawn: the content, then an action view's form with
 * Submit and Dismiss, or a snapshot's actions. A view no longer waiting says so.
 * `packageFiles` as for contentHtml.
 */
export function viewHtml(value: unknown, packageFiles: boolean): string {
  if (!isRecord(value) || value["kind"] === "gone" || !isRecord(value["content"])) {
    return '<p data-testid="view-gone">This is no longer waiting for you.</p>';
  }
  const content = value["content"];
  const body = contentHtml(content, packageFiles);
  if (value["kind"] === "snapshot") {
    const actions = Array.isArray(value["actions"]) ? value["actions"] : [];
    return `${body}<div data-testid="view-actions">${actions.map(actionHtml).join("")}</div>`;
  }
  return (
    body +
    `<form data-form="view" data-testid="view-form">${formFieldsHtml(content["form"])}` +
    `<div data-slot="view-buttons">${VIEW_BUTTONS}</div></form>`
  );
}

/** The custom element a view's content names for its package's component; null when none. */
export function componentElementOf(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value["content"])) {
    return null;
  }
  const component = value["content"]["component"];
  const element = isRecord(component) ? component["element"] : undefined;
  return typeof element === "string" && /^[a-z][a-z0-9]*-[a-z0-9-]*$/.test(element)
    ? element
    : null;
}

/** A form control, as far as reading its value goes. */
interface Control {
  readonly name?: unknown;
  readonly type?: unknown;
  readonly value?: unknown;
  readonly checked?: unknown;
  getAttribute?(name: string): string | null;
}

/**
 * The values of a form's named controls: checkboxes as booleans, number inputs as numbers
 * (left out when empty), everything else as text. What crosses the bridge is limited again
 * by the runtime (spec 8.5.7).
 */
export function formValues(form: unknown): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  const elements = isRecord(form) ? (form as { elements?: Iterable<unknown> }).elements : undefined;
  if (elements === undefined) {
    return values;
  }
  for (const element of Array.from(elements) as Control[]) {
    const name = element.name;
    if (typeof name !== "string" || name === "") {
      continue;
    }
    if (element.type === "checkbox") {
      values[name] = element.checked === true;
    } else if (element.getAttribute?.("data-kind") === "number") {
      const text = typeof element.value === "string" ? element.value : "";
      if (text !== "") {
        values[name] = Number(text);
      }
    } else {
      values[name] = typeof element.value === "string" ? element.value : "";
    }
  }
  return values;
}

/** What a submission or a press answered, in words for the person. */
export function resultText(result: ViewResult): string {
  return result.ok ? "Sent." : result.error;
}

/** The attribute `name` of an event target, when it is an element that has it. */
export function attributeOf(target: unknown, name: string): string | null {
  if (typeof target !== "object" || target === null || !("getAttribute" in target)) {
    return null;
  }
  const { getAttribute } = target;
  if (typeof getAttribute !== "function") {
    return null;
  }
  const value: unknown = getAttribute.call(target, name);
  return typeof value === "string" ? value : null;
}
