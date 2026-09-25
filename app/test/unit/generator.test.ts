// adapters/nodered/generator.ts: one Node-RED module per declared type (spec 2.1.4, 2.2, 2.5).
// Each generated editor definition is run as the Node-RED editor runs it (in a VM with a
// recording RED), and each module as Node-RED loads it, so what is asserted is what Node-RED
// is given, not the text of a template.

import fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CATEGORY,
  DEFAULT_ICON,
  FORMS_FILE,
  generateTypes,
  REGISTER_GLOBAL,
} from "../../src/adapters/nodered/generator";
import type { Declaration, DeclaredType } from "../../src/domain/packages/declaration";

let dir: string;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "inny-generated-")));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const SNAPSHOT: DeclaredType = {
  id: "board",
  kind: "view",
  view: "snapshot",
  label: "Board",
  description: "Shows the <latest> state.",
  command: ["{package}/board.py"],
  config: {
    type: "object",
    required: ["title", "token"],
    properties: {
      title: { type: "string", title: "Title" },
      limit: { type: "integer", default: 10 },
      token: { type: "string", writeOnly: true, title: "Token" },
      key: { type: "string", "x-secret": true },
      rows: { type: "array", items: { type: "object", properties: {} } },
      nested: { type: "object", properties: {} },
    },
  },
  outputs: [
    { port: "shown", event: "demo.shown.v1" },
    { port: "kept", event: "demo.kept.v1" },
  ],
  actions: [
    { id: "redo", label: "Redo", event: "demo.redo.v1" },
    { id: "undo", label: "Undo", event: "demo.undo.v1" },
  ],
};

const SOURCE: DeclaredType = {
  id: "watch",
  kind: "source",
  label: "Watch",
  icon: "file.svg",
  command: ["{package}/watch.py"],
  config: { type: "object" },
  outputs: [{ port: "new", event: "demo.new.v1" }],
};

function withoutIcon(type: DeclaredType): DeclaredType {
  return Object.fromEntries(
    Object.entries(type).filter(([key]) => key !== "icon"),
  ) as unknown as DeclaredType;
}

const DECLARATION: Declaration = {
  protocol: 2,
  package: "demo",
  version: "1.2.3",
  types: [SNAPSHOT, SOURCE, { ...withoutIcon(SOURCE), id: "fed", input: true }],
};

interface Registered {
  type: string;
  definition: Record<string, unknown>;
}

/** Run a generated editor file's definition script as the editor would; what it registered. */
function editorDefinition(file: string): { registered: Registered; defined: [string, unknown][] } {
  const html = fs.readFileSync(path.join(dir, file), "utf8");
  const script = /<script type="text\/javascript">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
  const registered: Registered[] = [];
  const defined: [string, unknown][] = [];
  const window = {
    InnyForms: {
      define: (type: string, schema: unknown) => defined.push([type, schema]),
      validate: () => true,
    },
  };
  const RED = {
    nodes: {
      registerType: (type: string, definition: Record<string, unknown>) =>
        registered.push({ type, definition }),
    },
  };
  vm.runInNewContext(script, { window, RED });
  expect(registered).toHaveLength(1);
  return { registered: registered[0] as Registered, defined };
}

describe("generateTypes", () => {
  it("writes one module and one editor file per type, and the form code once", () => {
    const written = generateTypes(
      [SNAPSHOT, SOURCE].map((type) => ({ declaration: DECLARATION, type })),
      dir,
      "window.InnyForms = {};",
    );
    expect(written).toEqual(["inny-demo-board", "inny-demo-watch"]);
    expect(fs.readdirSync(dir).sort()).toEqual([
      "inny-demo-board.html",
      "inny-demo-board.js",
      "inny-demo-watch.html",
      "inny-demo-watch.js",
      `${FORMS_FILE}.html`,
      `${FORMS_FILE}.js`,
    ]);
    expect(fs.readFileSync(path.join(dir, `${FORMS_FILE}.html`), "utf8")).toContain(
      "window.InnyForms = {};",
    );
  });

  it("removes every module a previous run generated, and nothing it did not", () => {
    fs.writeFileSync(path.join(dir, "inny-demo-gone.js"), "");
    fs.writeFileSync(path.join(dir, "inny-demo-gone.html"), "");
    fs.writeFileSync(path.join(dir, "sleeper.js"), "hand-written");
    generateTypes([{ declaration: DECLARATION, type: SOURCE }], dir, "");
    expect(fs.readdirSync(dir).sort()).toEqual([
      "inny-demo-watch.html",
      "inny-demo-watch.js",
      `${FORMS_FILE}.html`,
      `${FORMS_FILE}.js`,
      "sleeper.js",
    ]);
  });

  it("keeps a </script> in the form code from ending its element", () => {
    generateTypes([], dir, 'var s = "</script><b>";');
    const html = fs.readFileSync(path.join(dir, `${FORMS_FILE}.html`), "utf8");
    expect(html.match(/<\/script>/g)).toHaveLength(1);
  });
});

describe("a generated editor definition", () => {
  beforeEach(() => {
    generateTypes(
      DECLARATION.types.map((type) => ({ declaration: DECLARATION, type })),
      dir,
      "",
    );
  });

  it("puts each kind in its own palette category, with its label", () => {
    expect(editorDefinition("inny-demo-board.html").registered.definition).toMatchObject({
      category: CATEGORY.view,
      paletteLabel: "Board",
    });
    expect(editorDefinition("inny-demo-watch.html").registered.definition).toMatchObject({
      category: CATEGORY.source,
    });
    expect(CATEGORY).toEqual({
      source: "InnyTypes sources",
      node: "InnyTypes nodes",
      view: "InnyTypes views",
    });
  });

  it("uses the declared icon, and the kind's own when none is declared", () => {
    expect(editorDefinition("inny-demo-watch.html").registered.definition["icon"]).toBe("file.svg");
    expect(editorDefinition("inny-demo-board.html").registered.definition["icon"]).toBe(
      DEFAULT_ICON.view,
    );
    expect(editorDefinition("inny-demo-fed.html").registered.definition["icon"]).toBe(
      DEFAULT_ICON.source,
    );
  });

  it("has one output per port, pass-through ports before action ports, each labelled", () => {
    const { definition } = editorDefinition("inny-demo-board.html").registered;
    expect(definition["outputs"]).toBe(4);
    expect(definition["outputLabels"]).toEqual([
      "shown (demo.shown.v1)",
      "kept (demo.kept.v1)",
      "action: Redo",
      "action: Undo",
    ]);
  });

  it("gives a source no input unless it declares one", () => {
    expect(editorDefinition("inny-demo-watch.html").registered.definition["inputs"]).toBe(0);
    expect(editorDefinition("inny-demo-fed.html").registered.definition["inputs"]).toBe(1);
    expect(editorDefinition("inny-demo-board.html").registered.definition["inputs"]).toBe(1);
  });

  it("makes every writeOnly or x-secret property a credential, and never a default", () => {
    const { definition } = editorDefinition("inny-demo-board.html").registered;
    expect(definition["credentials"]).toEqual({
      token: { type: "password" },
      key: { type: "password" },
    });
    const defaults = definition["defaults"] as Record<string, { value: unknown }>;
    expect(Object.keys(defaults)).toEqual(["name", "title", "limit", "rows", "nested"]);
    expect(defaults["limit"]?.value).toBe(10);
    expect(defaults["rows"]?.value).toEqual([]);
    expect(defaults["nested"]?.value).toEqual({});
    expect(defaults["title"]?.value).toBe("");
  });

  it("validates every property through the form code, and defines its schema there", () => {
    const { registered, defined } = editorDefinition("inny-demo-board.html");
    const defaults = registered.definition["defaults"] as Record<string, { validate?: unknown }>;
    expect(defaults["name"]?.validate).toBeUndefined();
    for (const key of ["title", "limit", "rows", "nested"]) {
      expect(typeof defaults[key]?.validate).toBe("function");
    }
    expect(defined).toEqual([["inny-demo-board", SNAPSHOT.config]]);
  });

  it("draws the secrets as password inputs Node-RED fills, the required one marked", () => {
    const html = fs.readFileSync(path.join(dir, "inny-demo-board.html"), "utf8");
    expect(html).toContain(
      '<label for="node-input-token">Token <span class="inny-required">*</span></label>' +
        '<input type="password" id="node-input-token"',
    );
    expect(html).toContain('<input type="password" id="node-input-key"');
    expect(html).toContain('<div class="inny-form" data-inny-type="inny-demo-board"></div>');
    // The help escapes what the author wrote.
    expect(html).toContain("Shows the &lt;latest&gt; state.");
  });

  it("queues its schema when the form code is not in the page yet", () => {
    const html = fs.readFileSync(path.join(dir, "inny-demo-watch.html"), "utf8");
    const script = /<script type="text\/javascript">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
    const window: Record<string, unknown> = {};
    vm.runInNewContext(script, { window, RED: { nodes: { registerType: () => undefined } } });
    expect(window["InnyFormsPending"]).toEqual([["inny-demo-watch", SOURCE.config]]);
  });
});

describe("a generated module", () => {
  it("registers its type through the runtime's global, and refuses to load without it", () => {
    generateTypes([{ declaration: DECLARATION, type: SOURCE }], dir, "");
    const load = (): void => {
      const module: unknown = createRequire(import.meta.url)(path.join(dir, "inny-demo-watch.js"));
      (module as (RED: unknown) => void)("the RED");
    };
    const key = Symbol.for(REGISTER_GLOBAL);
    const global = globalThis as Record<symbol, unknown>;
    expect(load).toThrow("inny-demo-watch is loaded only by the InnyTypes runtime");
    const calls: unknown[][] = [];
    global[key] = (...args: unknown[]) => {
      calls.push(args);
    };
    try {
      load();
    } finally {
      Reflect.deleteProperty(global, key);
    }
    expect(calls).toEqual([["the RED", "inny-demo-watch"]]);
  });
});
