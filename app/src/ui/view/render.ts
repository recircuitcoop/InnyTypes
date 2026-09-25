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
// | anytype    | `{objectId, spaceId, name}` as a link Anytype opens             |
// | form       | JSON Schema properties, as inputs                               |
// | component  | `{element}`: the view's own package's web component (view.ts)   |
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

function mediaHtml(media: unknown): string {
  const items = Array.isArray(media) ? media : [media];
  return items
    .filter(isRecord)
    .filter((item) => item["type"] === "image" && typeof item["src"] === "string")
    .filter((item) => IMAGE_SOURCE.test(item["src"] as string))
    .map((item) => {
      const alt = typeof item["alt"] === "string" ? item["alt"] : "";
      return `<img data-testid="view-media" src="${escape(item["src"] as string)}" alt="${escape(alt)}">`;
    })
    .join("");
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

/** The content's parts, in a fixed order; unknown parts are left out. */
export function contentHtml(content: unknown): string {
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
    parts.push(mediaHtml(content["media"]));
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
 * A `view.get` or `snapshot.get` value, drawn: the content, then an action view's form with
 * Submit and Dismiss, or a snapshot's actions. A view no longer waiting says so.
 */
export function viewHtml(value: unknown): string {
  if (!isRecord(value) || value["kind"] === "gone" || !isRecord(value["content"])) {
    return '<p data-testid="view-gone">This is no longer waiting for you.</p>';
  }
  const content = value["content"];
  const body = contentHtml(content);
  if (value["kind"] === "snapshot") {
    const actions = Array.isArray(value["actions"]) ? value["actions"] : [];
    return `${body}<div data-testid="view-actions">${actions.map(actionHtml).join("")}</div>`;
  }
  return (
    body +
    `<form data-form="view" data-testid="view-form">${formFieldsHtml(content["form"])}` +
    '<button type="submit" data-testid="view-submit">Submit</button>' +
    '<button type="button" data-dismiss="1" data-testid="view-dismiss">Dismiss</button></form>'
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
 * by the shell (spec 8.5.7).
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
