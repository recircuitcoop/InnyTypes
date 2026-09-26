// The Events page (WI-0018-13) without a DOM: the field editor makes JSON Schema 2020-12 with
// enums and nested objects, a new version starts from the latest schema, the fire form's values
// become the payload, and every call answers on the page.

import { describe, expect, it } from "vitest";

import type { AppApi, EventTypeSummary, ListResult, ViewResult } from "../../src/ui/contract";
import {
  editorHtml,
  eventListHtml,
  fireHtml,
  mountEvents,
  payloadOf,
  rowsFromSchema,
  rowsOf,
  schemaFromRows,
  SCHEMA_DIALECT,
  type FieldRow,
} from "../../src/ui/pages/events";
import type { PageEvent, Section } from "../../src/ui/pages/page";
import { ANYTYPE_UNUSED } from "../fakes/anytype";
import { VIEWS_UNUSED } from "../fakes/views";

const row = (path: string, type = "string", required = false, options = ""): FieldRow => ({
  path,
  type,
  required,
  options,
});

const NOTE_ROWS = [
  row("title", "string", true),
  row("minutes", "integer"),
  row("kind", "string", false, "standup, review"),
  row("where", "object"),
  row("where.room", "string", true),
  row("where.floor", "integer", false, "1,2"),
  row(""),
];

const NOTE = {
  $schema: SCHEMA_DIALECT,
  type: "object",
  properties: {
    title: { type: "string" },
    minutes: { type: "integer" },
    kind: { type: "string", enum: ["standup", "review"] },
    where: {
      type: "object",
      properties: { room: { type: "string" }, floor: { type: "integer", enum: [1, 2] } },
      additionalProperties: true,
      required: ["room"],
    },
  },
  additionalProperties: true,
  required: ["title"],
};

describe("the field editor", () => {
  it("makes JSON Schema 2020-12 with enums and nested objects, and back again", () => {
    expect(schemaFromRows(NOTE_ROWS)).toEqual(NOTE);
    // Children before their parent in the rows: still nested under it.
    expect(schemaFromRows([row("where.room"), row("where", "object"), row("a")])).toMatchObject({
      properties: { where: { properties: { room: { type: "string" } } } },
    });
    expect(rowsFromSchema(NOTE)).toEqual(
      NOTE_ROWS.slice(0, -1).map((r) => ({ ...r, options: r.options.replace("1,2", "1, 2") })),
    );
    expect(rowsFromSchema("no")).toEqual([]);
    expect(rowsFromSchema({ properties: { x: {} } })).toEqual([row("x")]);
  });

  it("says why rows cannot make a schema", () => {
    expect(schemaFromRows([row("a.b")])).toBe("Field a.b: a is not an object field above it.");
    expect(schemaFromRows([row("a"), row("a")])).toBe("Field a is given twice.");
    expect(schemaFromRows([row("n", "integer", false, "1, x")])).toBe(
      'Field n: "x" is not an integer.',
    );
    expect(schemaFromRows([row("n", "number", false, "1.5")])).toMatchObject({
      properties: { n: { enum: [1.5] } },
    });
    expect(schemaFromRows([row("n", "number", false, "q")])).toBe('Field n: "q" is not a number.');
  });

  it("reads its rows from the form's values, and draws them", () => {
    const values = {
      "path-0": "a",
      "type-0": "integer",
      "required-0": true,
      "options-0": "1",
      "path-1": 3,
    };
    expect(rowsOf(values, 2)).toEqual([row("a", "integer", true, "1"), row("")]);
    const html = editorHtml({ kind: "create" }, [row("a<b", "boolean", true)], "n", "L");
    expect(html).toContain('value="a&lt;b"');
    expect(html).toContain('<option value="boolean" selected>');
    expect(html).toContain('data-testid="event-name"');
    expect(editorHtml({ kind: "version", name: "note" }, [])).toContain("New version of user.note");
  });
});

const SUMMARY: EventTypeSummary = {
  name: "note",
  version: 1,
  type: "user.note.v1",
  label: "Note",
  schema: NOTE,
  createdAt: 1,
  nodeType: "inny-user-events-note-v1",
  deployed: ["src1"],
  undeployed: ["draft"],
};

describe("the list and the fire form", () => {
  it("lists each version with the nodes that use it, and New version on the latest only", () => {
    const v2 = { ...SUMMARY, version: 2, type: "user.note.v2", deployed: [], undeployed: [] };
    const html = eventListHtml([SUMMARY, v2]);
    expect(html).toContain("Deployed in src1. In the editor, not deployed: draft.");
    expect(html).toContain("Not used.");
    expect(html.match(/data-new-version/g)).toHaveLength(1);
    expect(eventListHtml([])).toContain("events-empty");
  });

  it("draws one input per field, nested ones dotted, and reads them back as the payload", () => {
    const html = fireHtml(SUMMARY);
    expect(html).toContain('name="where.room"');
    expect(html).toContain('<select name="kind"');
    expect(html).toContain('name="minutes" data-kind="number"');
    expect(fireHtml({ ...SUMMARY, schema: { properties: { b: { type: "boolean" } } } })).toContain(
      'type="checkbox"',
    );
    const form = {
      elements: [
        { name: "minutes", getAttribute: (n: string) => (n === "data-kind" ? "number" : null) },
        { name: "where.floor", getAttribute: (n: string) => (n === "data-kind" ? "number" : null) },
        { name: "title", getAttribute: () => null },
      ],
    };
    expect(
      payloadOf({ title: "T", minutes: 45, "where.room": "A", "where.floor": "2", kind: "" }, form),
    ).toEqual({ title: "T", minutes: 45, where: { room: "A", floor: 2 } });
    expect(payloadOf({ a: "x" }, null)).toEqual({ a: "x" });
  });
});

class FakeSection implements Section {
  readonly listeners = new Map<string, ((event: PageEvent) => void)[]>();
  on(type: "click" | "submit", listener: (event: PageEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  fire(type: "click" | "submit", target: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ target, preventDefault: () => undefined });
    }
  }
}

const settle = async (): Promise<void> => {
  for (let n = 0; n < 10; n += 1) {
    await Promise.resolve();
  }
};

/** A control of a form, as formValues reads it. */
const control = (name: string, value: unknown, type = "text") => ({
  name,
  type,
  value: type === "checkbox" ? "on" : value,
  checked: value === true,
  getAttribute: () => null,
});

const element = (attributes: Record<string, string>, extra: object = {}) => ({
  getAttribute: (name: string) => attributes[name] ?? null,
  ...extra,
});

function mounted(answers: { list?: ListResult<EventTypeSummary>; result?: ViewResult }) {
  const calls: unknown[][] = [];
  const result = answers.result ?? { ok: true, value: { type: "user.note.v1" } };
  const api: AppApi = {
    ...ANYTYPE_UNUSED,
    ...VIEWS_UNUSED,
    secretStorage: () => Promise.reject(new Error("not used")),
    childStatus: () => Promise.resolve([]),
    onChildStatus: () => undefined,
    restartChild: () => Promise.resolve(),
    eventTypes: () => Promise.resolve(answers.list ?? { ok: true, value: [SUMMARY] }),
    createEventType: (...args) => (calls.push(["create", ...args]), Promise.resolve(result)),
    versionEventType: (...args) => (calls.push(["version", ...args]), Promise.resolve(result)),
    deleteEventType: (...args) => (calls.push(["delete", ...args]), Promise.resolve(result)),
    fireEvent: (...args) => (calls.push(["fire", ...args]), Promise.resolve(result)),
  };
  const page = {
    section: new FakeSection(),
    list: { innerHTML: "" },
    editor: { innerHTML: "" },
    fire: { innerHTML: "" },
    message: { innerHTML: "" },
  };
  const refresh = mountEvents(page, api);
  return { page, refresh, calls };
}

describe("the Events page", () => {
  it("creates a type from the field editor, and says so", async () => {
    const { page, refresh, calls } = mounted({});
    await refresh();
    expect(page.list.innerHTML).toContain("user.note.v1");
    expect(page.editor.innerHTML.match(/data-testid="field-row"/g)).toHaveLength(3);
    const form = element(
      { "data-form": "event-type" },
      {
        elements: [
          control("name", "note"),
          control("label", "Note"),
          control("path-0", "title"),
          control("type-0", "string"),
          control("required-0", true, "checkbox"),
          control("options-0", ""),
        ],
      },
    );
    // Add field keeps what was typed, and adds a row.
    page.section.fire("click", element({ "data-add-field": "1" }, { form }));
    expect(page.editor.innerHTML.match(/data-testid="field-row"/g)).toHaveLength(4);
    expect(page.editor.innerHTML).toContain('value="title"');
    page.section.fire("submit", form);
    await settle();
    expect(calls[0]).toEqual([
      "create",
      "note",
      "Note",
      {
        $schema: SCHEMA_DIALECT,
        type: "object",
        properties: { title: { type: "string" } },
        additionalProperties: true,
        required: ["title"],
      },
    ]);
    expect(page.message.innerHTML).toContain("Created user.note.v1. The runtime restarts for it");
  });

  it("a new version starts from the latest schema; Cancel goes back to a new type", async () => {
    const { page, refresh, calls } = mounted({});
    await refresh();
    page.section.fire("click", element({ "data-new-version": "note" }));
    expect(page.editor.innerHTML).toContain("New version of user.note");
    expect(page.editor.innerHTML).toContain('value="where.room"');
    const form = element({ "data-form": "event-type" }, { elements: [control("path-0", "x")] });
    page.section.fire("submit", form);
    await settle();
    expect(calls[0]?.[0]).toBe("version");
    expect(calls[0]?.[1]).toBe("note");
    page.section.fire("click", element({ "data-new-version": "note" }));
    page.section.fire("click", element({ "data-cancel-edit": "1" }));
    expect(page.editor.innerHTML).toContain("New event type");
  });

  it("says a refusal, a schema the rows cannot make, and ignores other forms", async () => {
    const { page, refresh, calls } = mounted({
      result: { ok: false, error: "The schema is unchanged", status: 409 },
    });
    await refresh();
    const bad = element({ "data-form": "event-type" }, { elements: [control("path-0", "a.b")] });
    page.section.fire("submit", bad);
    expect(page.message.innerHTML).toContain("a is not an object field above it");
    expect(calls).toEqual([]);
    const good = element(
      { "data-form": "event-type" },
      { elements: [control("name", "n"), control("path-0", "a")] },
    );
    page.section.fire("submit", good);
    await settle();
    expect(page.message.innerHTML).toBe("The schema is unchanged");
    page.section.fire("submit", element({ "data-form": "other" }));
    expect(calls).toHaveLength(1);
  });

  it("fires with the form's payload, and deletes, saying each answer", async () => {
    const { page, refresh, calls } = mounted({ result: { ok: true, value: { fired: ["src1"] } } });
    await refresh();
    page.section.fire("click", element({ "data-fire": "user.note.v1" }));
    expect(page.fire.innerHTML).toContain("Fire user.note.v1");
    page.section.fire("click", element({ "data-fire": "user.none.v1" }));
    expect(page.fire.innerHTML).toBe("");
    const form = element(
      { "data-form": "fire", "data-type": "user.note.v1" },
      { elements: [control("title", "T"), control("where.room", "A")] },
    );
    page.section.fire("submit", form);
    await settle();
    expect(calls[0]).toEqual(["fire", "user.note.v1", { title: "T", where: { room: "A" } }]);
    expect(page.message.innerHTML).toBe("Fired from src1.");
    page.section.fire("click", element({ "data-refresh": "1" }));
    page.section.fire("click", element({ "data-delete": "user.note.v1" }));
    await settle();
    expect(calls[1]).toEqual(["delete", "user.note.v1"]);
    expect(page.message.innerHTML).toContain("Deleted user.note.v1");
  });

  it("says when the runtime cannot answer, and a refused fire or delete", async () => {
    const down = mounted({ list: { ok: false, error: "restarting", code: "restarting" } });
    await down.refresh();
    expect(down.page.message.innerHTML).toContain("cannot answer now (restarting)");
    const refused = mounted({ result: { ok: false, error: "Refused: in use" } });
    await refused.refresh();
    refused.page.section.fire("click", element({ "data-delete": "user.note.v1" }));
    await settle();
    expect(refused.page.message.innerHTML).toBe("Refused: in use");
    refused.page.section.fire(
      "submit",
      element({ "data-form": "fire", "data-type": "t" }, { elements: [] }),
    );
    await settle();
    expect(refused.page.message.innerHTML).toBe("Refused: in use");
  });
});
