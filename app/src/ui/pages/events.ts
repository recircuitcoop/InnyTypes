// The Events page (spec §9; arch_pivot P9, P11b; WI-0018-13): the event types created in the
// app. A field editor makes each payload's JSON Schema 2020-12, enums and nested objects
// included; each version can be fired, versioned again with a changed schema, or deleted while
// nothing uses it. The list says which nodes use each version: deployed, or only in the editor.
//
// A field is named by its path: `where.room` is the field `room` of the object field `where`.
//
// Plain on purpose: the owner will redesign the UI. Tests find everything by `data-testid`.

import type { AppApi, EventTypeSummary } from "../contract";
import { attributeOf, escape, formValues } from "../view/render";
import { unavailable, type Region, type Section } from "./page";

export const SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

/** The types the field editor offers. */
export const FIELD_TYPES = ["string", "number", "integer", "boolean", "object"] as const;

/** One row of the field editor. `options` is the enum, comma-separated; empty for none. */
export interface FieldRow {
  readonly path: string;
  readonly type: string;
  readonly required: boolean;
  readonly options: string;
}

type Schema = Record<string, unknown>;
type Fields = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const EMPTY_ROW: FieldRow = { path: "", type: "string", required: false, options: "" };

/** An empty object schema, as every object in a payload is: more fields are allowed. */
const objectSchema = (): Schema => ({ type: "object", properties: {}, additionalProperties: true });

/** A row's list of values, typed as its field is; a string with why when one is not. */
function optionsOf(row: FieldRow): unknown[] | string {
  const texts = row.options
    .split(",")
    .map((text) => text.trim())
    .filter((text) => text !== "");
  if (row.type !== "number" && row.type !== "integer") {
    return texts;
  }
  const numbers = texts.map(Number);
  const bad = numbers.findIndex(
    (n) => !Number.isFinite(n) || (row.type === "integer" && !Number.isInteger(n)),
  );
  return bad < 0
    ? numbers
    : `Field ${row.path}: "${String(texts[bad])}" is not ${row.type === "integer" ? "an integer" : "a number"}.`;
}

/**
 * The payload's JSON Schema 2020-12 from the field editor's rows; a sentence when the rows
 * cannot make one. Rows with no name are left out. The runtime judges the result again.
 */
export function schemaFromRows(rows: readonly FieldRow[]): Schema | string {
  const root: Schema = { $schema: SCHEMA_DIALECT, ...objectSchema() };
  const objects = new Map<string, Schema>([["", root]]);
  const named = rows
    .map((row) => ({ ...row, path: row.path.trim() }))
    .filter((row) => row.path !== "")
    // Parents before their fields.
    .sort((a, b) => a.path.split(".").length - b.path.split(".").length);
  for (const row of named) {
    const at = row.path.lastIndexOf(".");
    const parentPath = at < 0 ? "" : row.path.slice(0, at);
    const name = row.path.slice(at + 1);
    const parent = objects.get(parentPath);
    if (parent === undefined) {
      return `Field ${row.path}: ${parentPath} is not an object field above it.`;
    }
    const properties = parent["properties"] as Schema;
    if (name in properties) {
      return `Field ${row.path} is given twice.`;
    }
    let field: Schema;
    if (row.type === "object") {
      field = objectSchema();
      objects.set(row.path, field);
    } else {
      field = { type: row.type };
      const options = optionsOf(row);
      if (typeof options === "string") {
        return options;
      }
      if (options.length > 0) {
        field["enum"] = options;
      }
    }
    properties[name] = field;
    if (row.required) {
      parent["required"] = [...((parent["required"] as string[] | undefined) ?? []), name];
    }
  }
  return root;
}

/** The rows that make `schema` again: the field editor, filled for a new version. */
export function rowsFromSchema(schema: unknown, prefix = ""): FieldRow[] {
  if (!isRecord(schema) || !isRecord(schema["properties"])) {
    return [];
  }
  const required = Array.isArray(schema["required"]) ? (schema["required"] as unknown[]) : [];
  return Object.entries(schema["properties"]).flatMap(([name, field]) => {
    const path = prefix === "" ? name : `${prefix}.${name}`;
    const type = isRecord(field) && typeof field["type"] === "string" ? field["type"] : "string";
    const options =
      isRecord(field) && Array.isArray(field["enum"]) ? field["enum"].map(String).join(", ") : "";
    const row: FieldRow = { path, type, required: required.includes(name), options };
    return type === "object" ? [row, ...rowsFromSchema(field, path)] : [row];
  });
}

/** The rows as the form holds them now. */
export function rowsOf(values: Fields, count: number): FieldRow[] {
  return Array.from({ length: count }, (_, i) => ({
    path:
      typeof values[`path-${String(i)}`] === "string"
        ? (values[`path-${String(i)}`] as string)
        : "",
    type:
      typeof values[`type-${String(i)}`] === "string"
        ? (values[`type-${String(i)}`] as string)
        : "string",
    required: values[`required-${String(i)}`] === true,
    options:
      typeof values[`options-${String(i)}`] === "string"
        ? (values[`options-${String(i)}`] as string)
        : "",
  }));
}

function rowHtml(row: FieldRow, i: number): string {
  const n = String(i);
  const types = FIELD_TYPES.map(
    (type) => `<option value="${type}"${type === row.type ? " selected" : ""}>${type}</option>`,
  ).join("");
  return (
    `<tr data-testid="field-row">` +
    `<td><input type="text" name="path-${n}" value="${escape(row.path)}" data-testid="field-path-${n}"></td>` +
    `<td><select name="type-${n}" data-testid="field-type-${n}">${types}</select></td>` +
    `<td><input type="checkbox" name="required-${n}"${row.required ? " checked" : ""} data-testid="field-required-${n}"></td>` +
    `<td><input type="text" name="options-${n}" value="${escape(row.options)}" data-testid="field-options-${n}"></td>` +
    "</tr>"
  );
}

/** What the field editor is for: a new type, or a new version of `name`. */
export type EditorMode =
  { readonly kind: "create" } | { readonly kind: "version"; readonly name: string };

/** The field editor: the name and label for a new type, then one row per field. */
export function editorHtml(
  mode: EditorMode,
  rows: readonly FieldRow[],
  name = "",
  label = "",
): string {
  const head =
    mode.kind === "create"
      ? "<h2>New event type</h2>" +
        `<label>Name <input type="text" name="name" value="${escape(name)}" data-testid="event-name"></label> ` +
        `<label>Label <input type="text" name="label" value="${escape(label)}" data-testid="event-label"></label>`
      : `<h2 data-testid="event-version-of">New version of user.${escape(mode.name)}</h2>`;
  return (
    `<form data-form="event-type" data-testid="event-type-form">${head}` +
    "<table><thead><tr><th>Field (a.b for a field of object a)</th><th>Type</th><th>Required</th>" +
    "<th>Values (comma-separated, optional)</th></tr></thead>" +
    `<tbody>${rows.map(rowHtml).join("")}</tbody></table>` +
    '<button type="button" data-add-field="1" data-testid="event-add-field">Add field</button> ' +
    `<button type="submit" data-testid="event-submit">${mode.kind === "create" ? "Create" : "Make the new version"}</button>` +
    (mode.kind === "version"
      ? ' <button type="button" data-cancel-edit="1" data-testid="event-cancel">Cancel</button>'
      : "") +
    "</form>"
  );
}

/** One input per payload field, nested objects as their fields with dotted names. */
function fireFieldsHtml(schema: unknown, prefix = ""): string {
  if (!isRecord(schema) || !isRecord(schema["properties"])) {
    return "";
  }
  const required = Array.isArray(schema["required"]) ? (schema["required"] as unknown[]) : [];
  return Object.entries(schema["properties"])
    .map(([name, field]) => {
      const path = prefix === "" ? name : `${prefix}.${name}`;
      const f = isRecord(field) ? field : {};
      if (f["type"] === "object") {
        return `<fieldset><legend>${escape(path)}</legend>${fireFieldsHtml(f, path)}</fieldset>`;
      }
      const mark = required.includes(name) ? " *" : "";
      const id = `data-testid="fire-${escape(path)}"`;
      const kind = f["type"] === "number" || f["type"] === "integer" ? ' data-kind="number"' : "";
      let control: string;
      if (Array.isArray(f["enum"])) {
        const options = f["enum"]
          .map((v) => `<option value="${escape(String(v))}">${escape(String(v))}</option>`)
          .join("");
        control = `<select name="${escape(path)}"${kind} ${id}><option value=""></option>${options}</select>`;
      } else if (f["type"] === "boolean") {
        control = `<input type="checkbox" name="${escape(path)}" ${id}>`;
      } else {
        control = `<input type="${kind === "" ? "text" : "number"}" name="${escape(path)}"${kind} ${id}>`;
      }
      return `<label>${escape(path)}${mark} ${control}</label> `;
    })
    .join("");
}

/** The form that fires a version (spec 9.6): its fields, from its payload schema. */
export function fireHtml(summary: EventTypeSummary): string {
  return (
    `<form data-form="fire" data-type="${escape(summary.type)}" data-testid="fire-form">` +
    `<h2>Fire ${escape(summary.type)}</h2>${fireFieldsHtml(summary.schema)}` +
    '<button type="submit" data-testid="fire-submit">Fire</button></form>'
  );
}

/**
 * The fire form's values as the payload: dotted names nested, an empty text or choice left
 * out (a required field then says so), a number field as a number (from its select too).
 */
export function payloadOf(values: Fields, form: unknown): Record<string, unknown> {
  const numbers = new Set<string>();
  const elements = isRecord(form) ? (form as { elements?: Iterable<unknown> }).elements : undefined;
  for (const element of Array.from(elements ?? []) as {
    name?: unknown;
    getAttribute?(n: string): string | null;
  }[]) {
    if (typeof element.name === "string" && element.getAttribute?.("data-kind") === "number") {
      numbers.add(element.name);
    }
  }
  const payload: Record<string, unknown> = {};
  for (const [path, raw] of Object.entries(values)) {
    if (raw === "") {
      continue;
    }
    const value = numbers.has(path) && typeof raw === "string" ? Number(raw) : raw;
    const parts = path.split(".");
    let at = payload;
    for (const part of parts.slice(0, -1)) {
      const inner = isRecord(at[part]) ? (at[part] as Record<string, unknown>) : {};
      at[part] = inner;
      at = inner;
    }
    at[parts.at(-1) as string] = value;
  }
  return payload;
}

/** The versions, each with who uses it and what can be done with it. */
export function eventListHtml(types: readonly EventTypeSummary[]): string {
  if (types.length === 0) {
    return '<p data-testid="events-empty">No event types yet. Create one below.</p>';
  }
  const latest = new Map<string, number>();
  for (const t of types) {
    latest.set(t.name, Math.max(latest.get(t.name) ?? 0, t.version));
  }
  const items = types.map((t) => {
    const used = [
      t.deployed.length > 0 ? `Deployed in ${t.deployed.map(escape).join(", ")}.` : "",
      t.undeployed.length > 0
        ? `In the editor, not deployed: ${t.undeployed.map(escape).join(", ")}.`
        : "",
    ].join(" ");
    const version =
      latest.get(t.name) === t.version
        ? ` <button type="button" data-new-version="${escape(t.name)}" data-testid="event-new-version">New version</button>`
        : "";
    return (
      `<li data-testid="event-type" data-type="${escape(t.type)}">` +
      `<strong>${escape(t.label)}</strong> <code>${escape(t.type)}</code> ` +
      `<span data-testid="event-usage">${used.trim() === "" ? "Not used." : used.trim()}</span>` +
      `<pre data-testid="event-schema">${escape(JSON.stringify(t.schema))}</pre>` +
      `<button type="button" data-fire="${escape(t.type)}" data-testid="event-fire">Fire</button>${version} ` +
      `<button type="button" data-delete="${escape(t.type)}" data-testid="event-delete">Delete</button>` +
      "</li>"
    );
  });
  return `<ul data-testid="event-list">${items.join("")}</ul>`;
}

export interface EventsPage {
  readonly section: Section;
  readonly list: Region;
  /** The field editor: a new type, or a new version. */
  readonly editor: Region;
  /** The fire form of the version chosen. */
  readonly fire: Region;
  readonly message: Region;
}

/** Mount the page; the returned function draws the list again (when the page is shown). */
export function mountEvents(page: EventsPage, api: AppApi): () => Promise<void> {
  let types: readonly EventTypeSummary[] = [];
  let mode: EditorMode = { kind: "create" };
  let rowCount = 3;
  const say = (text: string): void => {
    page.message.innerHTML = escape(text);
  };
  const drawEditor = (rows: readonly FieldRow[], name = "", label = ""): void => {
    rowCount = rows.length;
    page.editor.innerHTML = editorHtml(mode, rows, name, label);
  };
  const refresh = async (): Promise<void> => {
    const result = await api.eventTypes();
    if (result.ok) {
      types = result.value;
      page.list.innerHTML = eventListHtml(types);
    } else {
      say(unavailable(result.error));
    }
  };
  drawEditor(Array.from({ length: rowCount }, () => EMPTY_ROW));

  page.section.on("click", (event) => {
    const { target } = event;
    const fire = attributeOf(target, "data-fire");
    const version = attributeOf(target, "data-new-version");
    const remove = attributeOf(target, "data-delete");
    if (fire !== null) {
      const summary = types.find((t) => t.type === fire);
      page.fire.innerHTML = summary === undefined ? "" : fireHtml(summary);
    } else if (version !== null) {
      const latest = types
        .filter((t) => t.name === version)
        .sort((a, b) => b.version - a.version)[0];
      mode = { kind: "version", name: version };
      drawEditor([...rowsFromSchema(latest?.schema), EMPTY_ROW]);
    } else if (attributeOf(target, "data-cancel-edit") !== null) {
      mode = { kind: "create" };
      drawEditor(Array.from({ length: 3 }, () => EMPTY_ROW));
    } else if (remove !== null) {
      void api.deleteEventType(remove).then(async (result) => {
        if (result.ok) {
          // The runtime restarts now; the page is drawn again once it runs (app.ts).
          say(`Deleted ${remove}. The runtime restarts for it; the editor keeps its edits.`);
          return;
        }
        say(result.error);
        await refresh();
      });
    } else if (attributeOf(target, "data-refresh") !== null) {
      void refresh();
    } else if (attributeOf(target, "data-add-field") !== null) {
      const form = isRecord(target) ? (target as { form?: unknown }).form : undefined;
      const values = formValues(form);
      const name = typeof values["name"] === "string" ? values["name"] : "";
      const label = typeof values["label"] === "string" ? values["label"] : "";
      drawEditor([...rowsOf(values, rowCount), EMPTY_ROW], name, label);
    }
  });

  page.section.on("submit", (event) => {
    event.preventDefault();
    const form = event.target;
    const kind = attributeOf(form, "data-form");
    const values = formValues(form);
    if (kind === "fire") {
      const type = attributeOf(form, "data-type") ?? "";
      void api.fireEvent(type, payloadOf(values, form)).then((result) => {
        const fired = result.ok && isRecord(result.value) ? result.value["fired"] : null;
        say(
          result.ok
            ? `Fired from ${Array.isArray(fired) ? fired.join(", ") : "its sources"}.`
            : result.error,
        );
      });
      return;
    }
    if (kind !== "event-type") {
      return;
    }
    const schema = schemaFromRows(rowsOf(values, rowCount));
    if (typeof schema === "string") {
      say(schema);
      return;
    }
    const current = mode;
    const answered =
      current.kind === "create"
        ? api.createEventType(
            typeof values["name"] === "string" ? values["name"] : "",
            typeof values["label"] === "string" ? values["label"] : "",
            schema,
          )
        : api.versionEventType(current.name, schema);
    void answered.then((result) => {
      if (!result.ok) {
        say(result.error);
        return;
      }
      const type = isRecord(result.value) ? String(result.value["type"]) : "";
      say(`Created ${type}. The runtime restarts for it; the editor keeps its edits.`);
      mode = { kind: "create" };
      // The runtime restarts now; the page is drawn again once it runs (app.ts).
      drawEditor(Array.from({ length: 3 }, () => EMPTY_ROW));
    });
  });
  return refresh;
}
