// The architecture stage must be able to fail. This builds a scratch tree shaped like app/src
// with one deliberate violation of each rule of plan 0018 §2.3, runs the stage's own two
// commands on it with the real configs, and expects every rule to be named. A clean tree of
// the same shape must pass, or the rules would be failing everything.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = path.resolve(APP, "..", "node_modules", ".bin");
const DEPCRUISE_CONFIG = path.join(APP, ".dependency-cruiser.cjs");
// A committed tree, not a scratch one: its npm imports must resolve through the workspace's
// node_modules for the ui rule to judge them by their resolved path (plan 0022 §J).
const UI_IMPORTS_FIXTURE = path.join(APP, "test", "architecture", "ui-imports");
const ESLINT_CONFIG = path.join(APP, "eslint.architecture.config.mjs");

// Every file a violating tree holds, and the files a clean tree holds.
const CLEAN: Record<string, string> = {
  "src/domain/rule.ts": "export const limit = 1;\n",
  "src/ports/clock.ts":
    'import type { limit } from "../domain/rule";\nexport type Clock = typeof limit;\n',
  "src/application/use-case.ts":
    'import { limit } from "../domain/rule";\nimport type { Clock } from "../ports/clock";\nexport const run = (clock: Clock) => clock + limit;\n',
  "src/adapters/fs/store.ts":
    'import { readFileSync } from "node:fs";\nimport type { Clock } from "../../ports/clock";\nexport const read = (c: Clock) => readFileSync(String(c));\n',
  "src/ui/contract.ts": "export type AppApi = Record<string, never>;\n",
  "src/ui/pages/inbox.ts":
    'import type { AppApi } from "../contract";\nexport const page = (api: AppApi) => api;\n',
  // WI-0022-10: the UI may import the domain's types, so AppApi carries the domain's own values.
  "src/ui/values.ts":
    'import type { limit } from "../domain/rule";\nexport type Limit = typeof limit;\n',
  // A component takes its words from ui/strings.ts by key.
  "src/ui/components/Card.tsx":
    'const words = { done: "Done" };\nexport const Card = () => <p className="card">{words.done}</p>;\n',
  "src/shell/main.ts":
    'import { read } from "../adapters/fs/store";\nread(Number(process.env["X"]));\n',
};

const VIOLATIONS: Record<string, string> = {
  // domain imports Node
  "src/domain/impure.ts":
    'import { readFileSync } from "node:fs";\nexport const f = readFileSync;\n',
  // application imports a library
  "src/application/leaky.ts":
    'import { readFileSync } from "node:fs";\nexport const g = readFileSync;\n',
  // one adapter family imports another
  "src/adapters/anytype/client.ts":
    'import { read } from "../nodered/editor";\nexport const client = read;\n',
  "src/adapters/nodered/editor.ts": "export const read = 1;\n",
  // an adapter imports a use case
  "src/adapters/sqlite/journal.ts":
    'import { run } from "../../application/use-case";\nexport const j = run;\n',
  // a file that is not a composition root imports an adapter
  "src/shell/supervisor.ts":
    'import { read } from "../adapters/fs/store";\nexport const s = read;\n',
  // ui imports the domain's code, not only its types
  "src/ui/pages/settings.ts":
    'import { limit } from "../../domain/rule";\nexport const p = limit;\n',
  // ui imports another layer
  "src/ui/pages/status.ts":
    'import type { Clock } from "../../ports/clock";\nexport type C = Clock;\n',
  // a component spells its own words, in text and in a worded attribute
  "src/ui/components/Spelled.tsx":
    'export const Spelled = () => <button aria-label="Close">Done</button>;\n',
  // a template literal in braces that spells words, with an expression in it
  "src/ui/components/Templated.tsx":
    "export const Templated = ({ n }: { n: number }) => <p>{`${String(n)} notes`}</p>;\n",
  // a .tsx god module
  "src/ui/components/god.tsx": "export const line = 0;\n".repeat(601),
  // process.env outside a composition root, three ways
  "src/runtime/env-reader.ts": 'export const a = process.env["A"];\n',
  "src/services/env-global.ts": 'export const b = globalThis.process.env["B"];\n',
  "src/services/env-import.ts": 'import { env } from "node:process";\nexport const c = env["C"];\n',
  // a god module: 601 lines
  "src/domain/god.ts": "export const line = 0;\n".repeat(601),
};

const scratchRoots: string[] = [];

function tree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inny-architecture-"));
  scratchRoots.push(root);
  fs.writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { module: "preserve", moduleResolution: "bundler" } }),
  );
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), content);
  }
  return root;
}

/** Run one stage command in `cwd`; its exit status and everything it printed. */
function stage(command: string, args: string[], cwd: string): { status: number; output: string } {
  try {
    const output = execFileSync(path.join(BIN, command), args, { cwd, encoding: "utf8" });
    return { status: 0, output };
  } catch (error) {
    const failed = error as { status: number | null; stdout: string; stderr: string };
    return { status: failed.status ?? -1, output: failed.stdout + failed.stderr };
  }
}

const depcruise = (cwd: string) =>
  stage("depcruise", ["src", "--config", DEPCRUISE_CONFIG, "--output-type", "err"], cwd);
const eslint = (cwd: string) =>
  stage("eslint", ["--config", ESLINT_CONFIG, "--format", "json", "src"], cwd);

afterAll(() => {
  for (const root of scratchRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("the architecture stage", () => {
  it("passes a tree that keeps every layer rule", () => {
    const root = tree(CLEAN);

    expect(depcruise(root)).toMatchObject({ status: 0 });
    expect(eslint(root)).toMatchObject({ status: 0 });
  });

  it("fails on each import rule of §2.3, naming it", () => {
    const result = depcruise(tree({ ...CLEAN, ...VIOLATIONS }));

    expect(result.status).not.toBe(0);
    for (const [rule, from] of [
      ["domain-imports-only-domain", "src/domain/impure.ts"],
      ["application-imports-only-domain-and-ports", "src/application/leaky.ts"],
      ["adapters-never-import-another-family", "src/adapters/anytype/client.ts"],
      ["adapters-import-only-ports-and-domain", "src/adapters/sqlite/journal.ts"],
      ["only-composition-roots-import-adapters", "src/shell/supervisor.ts"],
      ["ui-imports-only-ui-react-and-ark", "src/ui/pages/status.ts"],
      ["ui-imports-domain-types-only", "src/ui/pages/settings.ts"],
    ] as const) {
      expect(result.output).toMatch(new RegExp(`${rule}: ${from}`));
    }
  });

  it("lets ui import react, react-dom and Ark UI, and fails it on electron and Node built-ins", () => {
    const result = depcruise(UI_IMPORTS_FIXTURE);

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(
      /ui-imports-only-ui-react-and-ark: src\/ui\/electron-leak\.ts → \S*node_modules\/electron\//,
    );
    expect(result.output).toMatch(/ui-imports-only-ui-react-and-ark: src\/ui\/node-leak\.ts → fs/);
    // react, react/jsx-runtime, react-dom/client, @ark-ui/react and another ui file are allowed.
    expect(result.output).not.toContain("src/ui/allowed.ts");
  });

  it("fails on a file over 600 lines, on process.env outside a composition root, and on words a component spells", () => {
    const result = eslint(tree({ ...CLEAN, ...VIOLATIONS }));

    expect(result.status).not.toBe(0);
    const findings = (
      JSON.parse(result.output) as { filePath: string; messages: { ruleId: string | null }[] }[]
    ).flatMap((file) =>
      file.messages.map((message) => `${path.basename(file.filePath)} ${String(message.ruleId)}`),
    );
    expect(findings).toEqual(
      expect.arrayContaining([
        "god.ts max-lines",
        "god.tsx max-lines",
        "Spelled.tsx innytypes-words/no-jsx-text",
        "Templated.tsx innytypes-words/no-jsx-text",
        "env-reader.ts no-restricted-properties",
        "env-global.ts no-restricted-syntax",
        "env-import.ts no-restricted-imports",
      ]),
    );
    // Both of the component's spellings are findings: the text and the aria-label.
    expect(findings.filter((finding) => finding.startsWith("Spelled.tsx"))).toHaveLength(2);
    // The composition root reads process.env and is not a finding.
    expect(findings.filter((finding) => finding.startsWith("main.ts"))).toEqual([]);
  });

  it("cannot be silenced by an inline eslint-disable comment", () => {
    const result = eslint(
      tree({
        ...CLEAN,
        "src/runtime/sneaky.ts":
          '// eslint-disable-next-line no-restricted-properties\nexport const a = process.env["A"];\n',
      }),
    );

    expect(result.status).not.toBe(0);
    expect(result.output).toContain("no-restricted-properties");
  });
});
