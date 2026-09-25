// The layer rules of plan 0018 §2.3, as a failing gate check rather than a convention.
//
// The old app's debts (eight composition roots, hidden default factories, the engine
// importing Anytype) came from rules that were only written down. Every import rule of §2.3
// is here. The two rules that are not about imports, the 600-line limit and "process.env
// only in the composition roots", cannot be seen by dependency-cruiser; they live in
// eslint.architecture.config.mjs, which the same architecture stage runs.
//
// Paths are relative to app/, where the stage runs `depcruise src`.

/** The three composition roots (§2.2): the only files that wire adapters in. */
const COMPOSITION_ROOTS = "^src/(shell|runtime|services)/main\\.ts$";

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "domain-imports-only-domain",
      comment: "domain is pure logic: no I/O, no Node, Electron or Node-RED imports (§2.3).",
      severity: "error",
      from: { path: "^src/domain/" },
      to: { pathNot: "^src/domain/" },
    },
    {
      name: "application-imports-only-domain-and-ports",
      comment: "Use cases take ports as arguments; they import domain and ports only (§2.3).",
      severity: "error",
      from: { path: "^src/application/" },
      to: { pathNot: "^src/(domain|ports|application)/" },
    },
    {
      name: "adapters-never-import-another-family",
      comment: "An anytype adapter never imports a nodered one (§2.3).",
      severity: "error",
      from: { path: "^src/adapters/([^/]+)/" },
      to: { path: "^src/adapters/", pathNot: "^src/adapters/$1/" },
    },
    {
      name: "adapters-import-only-ports-and-domain",
      comment: "Adapters import ports and domain (and their own family, and libraries) (§2.3).",
      severity: "error",
      from: { path: "^src/adapters/" },
      to: { path: "^src/(application|shell|runtime|services|ui)/" },
    },
    {
      name: "only-composition-roots-import-adapters",
      comment: "Only the three main.ts files import adapters (§2.3).",
      severity: "error",
      from: { pathNot: `^src/adapters/|${COMPOSITION_ROOTS}` },
      to: { path: "^src/adapters/" },
    },
    {
      name: "ui-imports-only-the-contract",
      comment:
        "Pages use AppApi and nothing else, so the UI stays replaceable (§2.3, §2.4). The " +
        "pages and the view renderer (ui/pages, ui/view) may use each other; nothing outside ui/.",
      severity: "error",
      from: { path: "^src/ui/" },
      to: { pathNot: "^src/ui/(contract\\.ts|pages/[^/]+\\.ts|view/[^/]+\\.ts)$" },
    },
  ],
  options: {
    // Type-only imports count: a domain file importing a type from electron is still a leak.
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    doNotFollow: { path: "node_modules" },
  },
};
