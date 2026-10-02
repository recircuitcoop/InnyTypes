// The generated types' forms, inside the Node-RED editor (spec 2.5, WI-0018-09).
//
// Bundled on its own for the browser (`npm run build:editor`) and written once into the
// generated folder as inny-forms.html, which Node-RED puts in the editor page with every node
// definition. Each generated type calls `window.InnyForms` from its oneditprepare, oneditsave
// and property validators. It draws the form model of domain/forms (text, number, integer,
// checkbox, select, nested groups and tables whose rows are added, removed and reordered),
// marks the required fields, and validates the node with ajv before it can be deployed
// cleanly: a node whose values the schema refuses is shown invalid, with the reason.
//
// Secrets are not drawn here: they are Node-RED credential inputs in the type's own template,
// which Node-RED fills and saves itself, and never hands back to the editor (spec 2.5.2).
//
// This file runs only in the editor's browser page, so no unit test loads it; it is excluded
// from coverage like the preload bridge, and the e2e drives it in the real editor.

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

import { coerceObject } from "../../domain/forms/coerce";
import { INNYTYPE_ANNOTATION } from "../../domain/forms/innytype";
import {
  addRow,
  formModel,
  moveRow,
  removeRow,
  withoutSecrets,
  type Field,
} from "../../domain/forms/form-model";
import type { JsonSchema } from "../../domain/packages/declaration";

type Values = Record<string, unknown>;

interface Registered {
  /** The config schema without its secrets: what the node's own properties must satisfy. */
  readonly schema: JsonSchema;
  readonly fields: readonly Field[];
  readonly validate: ValidateFunction;
}

// `innytype` (spec 2.4.1) is a known annotation: it never changes what validates.
const ajv = new Ajv2020({ allErrors: true, strict: false }).addKeyword(INNYTYPE_ANNOTATION);
const types = new Map<string, Registered>();

function registered(type: string): Registered {
  const found = types.get(type);
  if (found === undefined) {
    throw new Error(`InnyTypes: no form is defined for ${type}`);
  }
  return found;
}

/** A generated type's definition: its full config schema (secrets are left out here). */
function define(type: string, schema: JsonSchema): void {
  const plain = withoutSecrets(schema);
  const fields = formModel(plain).fields;
  types.set(type, { schema: plain, fields, validate: ajv.compile(plain) });
}

/** The node's values for its declared properties, coerced as the runtime will coerce them. */
function valuesOf(entry: Registered, node: Values): Values {
  const own = Object.fromEntries(entry.fields.map((field) => [field.key, node[field.key]]));
  return coerceObject(entry.schema, own);
}

/** Each ajv error as the field it is about and what is wrong with it. */
function problems(validate: ValidateFunction): { path: string; message: string }[] {
  return (validate.errors ?? []).map((error) => {
    const params = error.params as Record<string, unknown>;
    const missing = params["missingProperty"];
    return error.keyword === "required" && typeof missing === "string"
      ? { path: `${error.instancePath}/${missing}`, message: "is required" }
      : { path: error.instancePath, message: error.message ?? error.keyword };
  });
}

/**
 * Node-RED's validator for one property: true, or the reason it is refused. Every property
 * is judged against the whole schema, and answers for the errors under its own name.
 */
function validate(type: string, node: Values, key: string): true | string {
  const entry = registered(type);
  if (entry.validate(valuesOf(entry, node))) {
    return true;
  }
  const mine = problems(entry.validate).filter(
    ({ path }) => path === `/${key}` || path.startsWith(`/${key}/`),
  );
  return mine.length === 0
    ? true
    : mine.map(({ path, message }) => `${path.slice(1)} ${message}`).join("; ");
}

// ── drawing ──────────────────────────────────────────────────────────────────────────────

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const made = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    made.setAttribute(name, value);
  }
  if (text !== undefined) {
    made.textContent = text;
  }
  return made;
}

/** A field's label; a required one is marked with an asterisk and a class. */
function labelFor(field: Field, path: string): HTMLLabelElement {
  const label = element("label", { for: `inny-input-${path}` }, field.label);
  if (field.required) {
    label.classList.add("inny-required");
    label.append(element("span", { "aria-hidden": "true" }, " *"));
  }
  return label;
}

function textOf(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** One scalar control, holding `value`. */
function scalar(field: Field, path: string, value: unknown): HTMLElement {
  const id = `inny-input-${path}`;
  const common = { id, "data-inny-field": path };
  switch (field.control) {
    case "checkbox": {
      const box = element("input", { ...common, type: "checkbox", style: "width:auto" });
      box.checked = value === true || value === "true";
      return box;
    }
    case "select": {
      const select = element("select", { ...common, style: "width:70%" });
      if (!field.required) {
        select.append(element("option", { value: "" }, ""));
      }
      for (const option of field.options ?? []) {
        select.append(element("option", { value: String(option) }, String(option)));
      }
      const option =
        typeof value === "string" || typeof value === "number" || typeof value === "boolean";
      select.value = option ? String(value) : "";
      return select;
    }
    case "number":
    case "integer": {
      const step = field.control === "integer" ? "1" : "any";
      const input = element("input", { ...common, type: "number", step, style: "width:70%" });
      input.value = textOf(value);
      return input;
    }
    default: {
      const input = element("input", { ...common, type: "text", style: "width:70%" });
      input.value = textOf(value);
      return input;
    }
  }
}

/** The controls of `fields`, holding `values`, under `container`. */
function draw(container: HTMLElement, fields: readonly Field[], values: Values, prefix: string) {
  for (const field of fields) {
    if (field.control === "password") {
      continue;
    }
    const path = prefix === "" ? field.key : `${prefix}.${field.key}`;
    const value = values[field.key] ?? field.default;
    const row = element("div", { class: "form-row", "data-inny-key": field.key });
    row.append(labelFor(field, path));
    if (field.control === "group") {
      const group = element("fieldset", { "data-inny-group": path });
      draw(group, field.fields ?? [], isRecord(value) ? value : {}, path);
      row.append(group);
    } else if (field.control === "table") {
      row.append(table(field, path, Array.isArray(value) ? (value as Values[]) : []));
    } else {
      row.append(scalar(field, path, value));
    }
    if (field.help !== null) {
      row.append(element("div", { class: "form-tips" }, field.help));
    }
    container.append(row);
  }
}

/** A table: one row of the columns per element, and buttons to add, remove and reorder. */
function table(field: Field, path: string, rows: readonly Values[]): HTMLElement {
  const columns = field.fields ?? [];
  const holder = element("div", { class: "inny-table", "data-inny-table": path });
  const redraw = (next: readonly Values[]): void => {
    holder.replaceChildren();
    next.forEach((row, index) => {
      const rowPath = `${path}.${String(index)}`;
      const line = element("div", { class: "inny-row", "data-inny-row": rowPath });
      draw(line, columns, row, rowPath);
      const button = (action: string, text: string, change: () => Values[]): void => {
        const pressed = element("button", { type: "button", "data-inny-action": action }, text);
        pressed.addEventListener("click", () => {
          redraw(change());
        });
        line.append(pressed);
      };
      button("up", "↑", () => moveRow(readRows(holder, columns), index, index - 1));
      button("down", "↓", () => moveRow(readRows(holder, columns), index, index + 1));
      button("remove", "Remove", () => removeRow(readRows(holder, columns), index));
      holder.append(line);
    });
    const add = element("button", { type: "button", "data-inny-action": "add" }, "Add row");
    add.addEventListener("click", () => {
      redraw(addRow(readRows(holder, columns), columns));
    });
    holder.append(add);
  };
  redraw(rows);
  return holder;
}

// ── reading back ─────────────────────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Values =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The direct child of `parent` carrying `attribute` = `value`, never one nested deeper. */
function own(parent: Element, attribute: string, value: string): Element | null {
  return [...parent.children].find((child) => child.getAttribute(attribute) === value) ?? null;
}

/** The values of `fields` as drawn under `container`: text as text, as Node-RED keeps it. */
function read(container: Element, fields: readonly Field[]): Values {
  const values: Values = {};
  for (const field of fields) {
    const row = own(container, "data-inny-key", field.key);
    if (row === null) {
      continue;
    }
    const control = row.children[1];
    if (field.control === "group" && control !== undefined) {
      values[field.key] = read(control, field.fields ?? []);
    } else if (field.control === "table" && control !== undefined) {
      values[field.key] = readRows(control, field.fields ?? []);
    } else if (control instanceof HTMLInputElement && control.type === "checkbox") {
      values[field.key] = control.checked;
    } else if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement) {
      values[field.key] = control.value;
    }
  }
  return values;
}

function readRows(holder: Element, columns: readonly Field[]): Values[] {
  return [...holder.children]
    .filter((child) => child.hasAttribute("data-inny-row"))
    .map((line) => read(line, columns));
}

/** The form container of the open edit dialog for `type`. */
function containerOf(type: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`.inny-form[data-inny-type="${type}"]`);
  if (found === null) {
    throw new Error(`InnyTypes: the edit dialog of ${type} has no form container`);
  }
  return found;
}

/** oneditprepare: draw the form with the node's values. */
function prepare(type: string, node: Values): void {
  const container = containerOf(type);
  container.replaceChildren();
  draw(container, registered(type).fields, node, "");
}

/** oneditsave: the drawn values back onto the node. */
function save(type: string, node: Values): void {
  const values = read(containerOf(type), registered(type).fields);
  for (const [key, value] of Object.entries(values)) {
    node[key] = value;
  }
}

declare global {
  interface Window {
    InnyForms?: {
      define: typeof define;
      validate: typeof validate;
      prepare: typeof prepare;
      save: typeof save;
    };
    /** Definitions Node-RED put in the page before this code: defined now. */
    InnyFormsPending?: [string, JsonSchema][];
  }
}

window.InnyForms = { define, validate, prepare, save };
for (const [type, schema] of window.InnyFormsPending ?? []) {
  define(type, schema);
}
