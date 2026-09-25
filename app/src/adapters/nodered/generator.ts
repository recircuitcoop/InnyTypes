// One Node-RED node module per declared type (spec 2.1.4, 2.2, 2.5; arch_pivot P1).
//
// Each type becomes a pair of files in the folder Node-RED loads through `nodesDir`:
//   inny-<package>-<id>.js    registers the type with the runtime (registration.ts)
//   inny-<package>-<id>.html  its editor definition: palette entry, ports, labels, form
// and the folder also gets inny-forms.js/.html once: the form code every type's editor uses
// (editor-forms.ts). What is written is exactly what a hand-written node module looks like,
// so Node-RED cannot tell a generated type from any other. Ported from the spike's
// `runtime/generate.js`; the differences are the credentials check, the form code and the
// registration through the runtime rather than a require of a file path.

import * as fs from "node:fs";
import * as path from "node:path";

import { isSecret, propertiesOf, secretKeys } from "../../domain/forms/form-model";
import {
  inputsOf,
  nodeTypeName,
  portsOf,
  type Declaration,
  type DeclaredType,
  type Kind,
} from "../../domain/packages/declaration";

/** Every file the generator owns starts with this; nothing else in the folder is touched. */
export const GENERATED_PREFIX = "inny-";

/** The global the runtime puts its registration on, which each generated module calls. */
export const REGISTER_GLOBAL = "innytypes.registerType";

/** The file of the shared form code. */
export const FORMS_FILE = "inny-forms";

/** Palette categories by kind (spec 2.2). */
export const CATEGORY: Readonly<Record<Kind, string>> = {
  source: "InnyTypes sources",
  node: "InnyTypes nodes",
  view: "InnyTypes views",
};

const COLOR: Readonly<Record<Kind, string>> = {
  source: "#9fd3f5",
  node: "#c7e9c0",
  view: "#f3d38b",
};

/** The icon a type that declares none is drawn with: one of Node-RED's own, by kind. */
export const DEFAULT_ICON: Readonly<Record<Kind, string>> = {
  source: "inject.svg",
  node: "cog.svg",
  view: "font-awesome/fa-eye",
};

/** One type to generate: its package and its declaration. */
export interface TypeToGenerate {
  readonly declaration: Declaration;
  readonly type: DeclaredType;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** JSON for inside a <script>: `</script>` in a string cannot end the element early. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** Node-RED's `defaults`: the name, then every non-secret property with its default. */
function defaultsOf(type: DeclaredType): Record<string, { value: unknown }> {
  const defaults: Record<string, { value: unknown }> = { name: { value: "" } };
  for (const [key, property] of propertiesOf(type.config)) {
    if (isSecret(property)) {
      continue;
    }
    const empty = property["type"] === "array" ? [] : property["type"] === "object" ? {} : "";
    defaults[key] = { value: "default" in property ? property["default"] : empty };
  }
  return defaults;
}

/** Node-RED's `credentials`: every secret, as a password (spec 2.5.2). */
export function credentialsOf(type: DeclaredType): Record<string, { type: "password" }> {
  return Object.fromEntries(secretKeys(type.config).map((key) => [key, { type: "password" }]));
}

/** The editor definition of one type. */
export function editorHtml(declaration: Declaration, type: DeclaredType): string {
  const name = nodeTypeName(declaration.package, type.id);
  const ports = portsOf(type);
  const defaults = defaultsOf(type);
  const validated = Object.keys(defaults).filter((key) => key !== "name");
  const required = new Set(
    Array.isArray(type.config["required"]) ? (type.config["required"] as unknown[]) : [],
  );
  // The definition is data, then the functions that call the form code; the validators are
  // spliced in by property name, as Node-RED wants a function for each.
  const definition = `{
    category: ${scriptJson(CATEGORY[type.kind])},
    color: ${scriptJson(COLOR[type.kind])},
    defaults: defaults,
    credentials: ${scriptJson(credentialsOf(type))},
    inputs: ${String(inputsOf(type))},
    outputs: ${String(ports.length)},
    outputLabels: ${scriptJson(ports.map((port) => port.label))},
    icon: ${scriptJson(type.icon ?? DEFAULT_ICON[type.kind])},
    paletteLabel: ${scriptJson(type.label)},
    label: function () { return this.name || ${scriptJson(type.label)}; },
    oneditprepare: function () { window.InnyForms.prepare(TYPE, this); },
    oneditsave: function () { window.InnyForms.save(TYPE, this); }
  }`;
  const secretRows = secretKeys(type.config).map((key) => {
    const property = (type.config["properties"] as Record<string, Record<string, unknown>>)[key];
    const title = typeof property?.["title"] === "string" ? property["title"] : key;
    const mark = required.has(key) ? ' <span class="inny-required">*</span>' : "";
    return (
      `<div class="form-row"><label for="node-input-${escapeHtml(key)}">${escapeHtml(title)}` +
      `${mark}</label><input type="password" id="node-input-${escapeHtml(key)}" ` +
      `style="width:70%"></div>`
    );
  });
  const outputs = ports
    .map((port) => `<li>${escapeHtml(port.label)}: <code>${escapeHtml(port.event)}</code></li>`)
    .join("");
  return `<script type="text/javascript">
(function () {
  var TYPE = ${scriptJson(name)};
  var schema = ${scriptJson(type.config)};
  // Node-RED may put this definition in the page before or after the form code.
  if (window.InnyForms) { window.InnyForms.define(TYPE, schema); }
  else { (window.InnyFormsPending = window.InnyFormsPending || []).push([TYPE, schema]); }
  var defaults = ${scriptJson(defaults)};
  ${scriptJson(validated)}.forEach(function (key) {
    defaults[key].validate = function (value, opt) { return window.InnyForms.validate(TYPE, this, key); };
  });
  RED.nodes.registerType(TYPE, ${definition});
})();
</script>
<script type="text/html" data-template-name=${scriptJson(name)}>
  <div class="form-row"><label for="node-input-name">Name</label><input type="text" id="node-input-name" style="width:70%"></div>
  ${secretRows.join("\n  ")}
  <div class="inny-form" data-inny-type=${scriptJson(name)}></div>
</script>
<script type="text/html" data-help-name=${scriptJson(name)}>
  <p>${escapeHtml(type.description ?? type.label)}</p>
  <p>From node package <code>${escapeHtml(declaration.package)}</code> ${escapeHtml(declaration.version)}. Each instance runs in its own process.</p>
  <h3>Outputs</h3>
  <ol>${outputs}</ol>
</script>
`;
}

/** The node module of one type: it asks the runtime to register it, and nothing else. */
export function moduleJs(typeName: string): string {
  return `// Generated by InnyTypes. Registers ${typeName} with the runtime that loaded it.
module.exports = function (RED) {
  var register = globalThis[Symbol.for(${JSON.stringify(REGISTER_GLOBAL)})];
  if (typeof register !== "function") {
    throw new Error("${typeName} is loaded only by the InnyTypes runtime");
  }
  register(RED, ${JSON.stringify(typeName)});
};
`;
}

/**
 * Write every type's module into `outDir`, and the shared form code. Every file a previous
 * run generated is removed first, so a type no longer declared leaves no module; files the
 * generator does not own are left alone. Returns the type names written.
 */
export function generateTypes(
  types: readonly TypeToGenerate[],
  outDir: string,
  formsScript: string,
): string[] {
  fs.mkdirSync(outDir, { recursive: true });
  for (const file of fs.readdirSync(outDir)) {
    if (file.startsWith(GENERATED_PREFIX)) {
      fs.rmSync(path.join(outDir, file), { force: true });
    }
  }
  // The form code first registers nothing with Node-RED; its editor half defines InnyForms.
  fs.writeFileSync(
    path.join(outDir, `${FORMS_FILE}.js`),
    "// Generated by InnyTypes: the form code of every generated type's editor.\n" +
      "module.exports = function () {};\n",
  );
  fs.writeFileSync(
    path.join(outDir, `${FORMS_FILE}.html`),
    `<script type="text/javascript">\n${formsScript.replace(/<\/script/gi, "<\\/script")}\n</script>\n`,
  );
  const written: string[] = [];
  for (const { declaration, type } of types) {
    const name = nodeTypeName(declaration.package, type.id);
    fs.writeFileSync(path.join(outDir, `${name}.js`), moduleJs(name));
    fs.writeFileSync(path.join(outDir, `${name}.html`), editorHtml(declaration, type));
    written.push(name);
  }
  return written;
}
