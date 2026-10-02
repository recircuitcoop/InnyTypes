// The flow templates' build check (plan 0022 §D, WI-0022-08), run by app's `build`.
//
//   node ../tools/templates/check.mjs [templatesDir] [--out dir]
//
// Each entry of `<templatesDir>/index.json` (`[{id, name, line, packages[], official}]`) and its
// `<id>.json`, a tab export, is checked the way the deploy guard would judge it
// (app/src/application/deploy-guard.ts), before it ships:
// - the file parses, and holds exactly one tab, and every other node is on that tab (`z`);
// - no node id is used twice, and no `credentials` key appears anywhere;
// - every type is one of Node-RED's own `core/common` nodes (the only core nodes the palette
//   lock keeps, spec 11.5), or an InnyTypes type `inny-<package>-<id>` whose package the entry
//   declares in `packages`; for a package that lives in this repository, the type must also be
//   one its declaration has;
// - no template file is left out of the index.
// Every problem is printed; any problem exits 1. With `--out`, the checked files are copied
// there (the build's dist/templates, which the runtime reads and the app ships).

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const STRUCTURAL = new Set(["tab", "group"]);
/** As app/src/application/deploy-guard.ts: a package name has no hyphen. */
const INNY_TYPE = /^inny-([a-z][a-z0-9_]{1,39})-([a-z][a-z0-9_-]{0,63})$/;
const TEMPLATE_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Node-RED's `core/common` types, read from its own editor files. */
export function coreCommonTypes() {
  const require = createRequire(path.join(REPO, "app", "package.json"));
  const common = path.join(
    path.dirname(require.resolve("@node-red/nodes/package.json")),
    "core",
    "common",
  );
  const types = new Set();
  for (const file of fs.readdirSync(common).filter((name) => name.endsWith(".html"))) {
    const text = fs.readFileSync(path.join(common, file), "utf8");
    for (const match of text.matchAll(/RED\.nodes\.registerType\(\s*["']([^"']+)["']/g)) {
      types.add(match[1]);
    }
  }
  return types;
}

/** The node types each package in this repository declares, by package name. */
export function repositoryPackages() {
  const packages = new Map();
  const root = path.join(REPO, "packages");
  for (const name of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const file = path.join(root, name, "inny-package.json");
    if (fs.existsSync(file)) {
      const declaration = JSON.parse(fs.readFileSync(file, "utf8"));
      packages.set(declaration.package, new Set(declaration.types.map((type) => type.id)));
    }
  }
  return packages;
}

function hasCredentials(value) {
  if (Array.isArray(value)) {
    return value.some(hasCredentials);
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return Object.entries(value).some(
    ([key, field]) => key === "credentials" || hasCredentials(field),
  );
}

function readJson(file, problems, who) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    problems.push(`${who}: cannot be read as JSON (${error.message})`);
    return undefined;
  }
}

/** One template's tab export, against its index entry. */
function checkTemplate(entry, nodes, known, problems) {
  const who = `template ${entry.id}`;
  if (!Array.isArray(nodes)) {
    problems.push(`${who}: is not a list of nodes`);
    return;
  }
  const tabs = nodes.filter((node) => node?.type === "tab");
  if (tabs.length !== 1) {
    problems.push(`${who}: holds ${tabs.length} tabs; a template is exactly one`);
    return;
  }
  const tab = tabs[0];
  const ids = new Set();
  for (const node of nodes) {
    if (typeof node?.id !== "string" || typeof node?.type !== "string") {
      problems.push(`${who}: a node has no id or no type`);
      continue;
    }
    if (ids.has(node.id)) {
      problems.push(`${who}: the id ${node.id} is used twice`);
    }
    ids.add(node.id);
    if (node !== tab && node.z !== tab.id) {
      problems.push(`${who}: ${node.id} is not on the template's tab`);
    }
    problems.push(...typeProblems(who, node, entry, known));
  }
  if (hasCredentials(nodes)) {
    problems.push(`${who}: holds credentials; a template never does`);
  }
}

function typeProblems(who, node, entry, { core, packages }) {
  const { type } = node;
  if (STRUCTURAL.has(type) || core.has(type)) {
    return [];
  }
  const inny = INNY_TYPE.exec(type);
  if (inny === null) {
    return [
      `${who}: ${node.id} is of type ${type}, which is neither Node-RED's core/common nor InnyTypes'`,
    ];
  }
  const [, name, id] = inny;
  if (!entry.packages.includes(name)) {
    return [`${who}: ${node.id} is of type ${type}, from the package ${name} it does not declare`];
  }
  const declared = packages.get(name);
  if (declared !== undefined && !declared.has(id)) {
    return [`${who}: ${node.id} is of type ${type}, which the package ${name} does not have`];
  }
  return [];
}

function checkEntry(entry, seen, problems) {
  const ok =
    typeof entry === "object" &&
    entry !== null &&
    typeof entry.id === "string" &&
    TEMPLATE_ID.test(entry.id) &&
    typeof entry.name === "string" &&
    entry.name.trim() !== "" &&
    typeof entry.line === "string" &&
    entry.line.trim() !== "" &&
    Array.isArray(entry.packages) &&
    entry.packages.every((name) => typeof name === "string") &&
    typeof entry.official === "boolean";
  if (!ok) {
    problems.push(`index: ${JSON.stringify(entry)} is not {id, name, line, packages, official}`);
    return false;
  }
  if (seen.has(entry.id)) {
    problems.push(`index: the id ${entry.id} is listed twice`);
    return false;
  }
  seen.add(entry.id);
  return true;
}

/** Every problem of the templates in `dir`; empty when they all pass. */
export function checkTemplates(
  dir,
  known = { core: coreCommonTypes(), packages: repositoryPackages() },
) {
  const problems = [];
  const index = readJson(path.join(dir, "index.json"), problems, "index");
  if (index === undefined) {
    return problems;
  }
  if (!Array.isArray(index)) {
    return ["index: is not a list of templates"];
  }
  const seen = new Set();
  for (const entry of index) {
    if (checkEntry(entry, seen, problems)) {
      const nodes = readJson(path.join(dir, `${entry.id}.json`), problems, `template ${entry.id}`);
      if (nodes !== undefined) {
        checkTemplate(entry, nodes, known, problems);
      }
    }
  }
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".json"))) {
    if (file !== "index.json" && !seen.has(file.slice(0, -".json".length))) {
      problems.push(`${file}: is not in the index`);
    }
  }
  return problems;
}

function main(argv) {
  const outAt = argv.indexOf("--out");
  const out = outAt === -1 ? null : argv[outAt + 1];
  const rest = argv.filter((_, index) => outAt === -1 || (index !== outAt && index !== outAt + 1));
  const dir = path.resolve(rest[0] ?? path.join(REPO, "app", "templates"));
  const problems = checkTemplates(dir);
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`templates: ${problem}`);
    }
    return 1;
  }
  const files = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  if (out !== null && out !== undefined) {
    const target = path.resolve(out);
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
    for (const file of files) {
      fs.copyFileSync(path.join(dir, file), path.join(target, file));
    }
  }
  console.log(`templates: ${files.length - 1} checked`);
  return 0;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main(process.argv.slice(2));
}
