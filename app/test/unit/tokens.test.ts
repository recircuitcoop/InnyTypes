// Tokens to code (plan 0022 §K): tools/tokens/build.mjs turns the design tokens file into the
// CSS custom properties every screen uses, and tools/tokens/check.mjs fails the architecture
// stage on a raw colour in the UI. Both run as the build and the gate run them: as commands.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO = path.resolve(APP, "..");
const BUILD = path.join(REPO, "tools", "tokens", "build.mjs");
const CHECK = path.join(REPO, "tools", "tokens", "check.mjs");
const FIXTURES = path.join(APP, "test", "fixtures", "tokens");
const REAL_TOKENS = path.join(REPO, "docs", "ux", "tokens", "innytypes.tokens.json");

const scratchRoots: string[] = [];

function scratch(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inny-tokens-"));
  scratchRoots.push(root);
  return root;
}

/** Run one of the tools; its exit status and everything it printed. */
function run(script: string, args: string[]): { status: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [script, ...args], { encoding: "utf8" });
    return { status: 0, output };
  } catch (error) {
    const failed = error as { status: number | null; stdout: string; stderr: string };
    return { status: failed.status ?? -1, output: failed.stdout + failed.stderr };
  }
}

/** Build a tokens file (a path, or a document written to a scratch file) into CSS. */
function build(tokens: string | object): { status: number; output: string; css: string } {
  const root = scratch();
  const input = typeof tokens === "string" ? tokens : path.join(root, "in.tokens.json");
  if (typeof tokens !== "string") {
    fs.writeFileSync(input, JSON.stringify(tokens));
  }
  const out = path.join(root, "generated", "tokens.css");
  const result = run(BUILD, ["--tokens", input, "--out", out]);
  return { ...result, css: fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "" };
}

/** The declarations inside the first block that opens with `selector {`, by property name. */
function block(css: string, selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  expect(start, `no block for ${selector}`).toBeGreaterThanOrEqual(0);
  const body = css.slice(start + selector.length + 2, css.indexOf("}", start));
  return new Map(
    [...body.matchAll(/(--inny-[\w-]+):\s*([^;]+);/g)].map((match) => [
      match[1] ?? "",
      match[2] ?? "",
    ]),
  );
}

afterAll(() => {
  for (const root of scratchRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("tools/tokens/build.mjs", () => {
  it("builds the fixture tokens file to exactly its expected CSS", () => {
    const result = build(path.join(FIXTURES, "fixture.tokens.json"));

    expect(result.status).toBe(0);
    expect(result.css).toBe(fs.readFileSync(path.join(FIXTURES, "fixture.expected.css"), "utf8"));
  });

  it("builds the same file to the same bytes every time", () => {
    expect(build(REAL_TOKENS).css).toBe(build(REAL_TOKENS).css);
  });

  it("dark guarded by data-theme", () => {
    const { status, css } = build(REAL_TOKENS);
    expect(status).toBe(0);

    // The light set is the :root default, beside every base value.
    const root = block(css, ":root");
    expect(root.get("--inny-surface-canvas")).toBe("var(--inny-color-paper-1)");
    expect(root.get("--inny-color-paper-1")).toMatch(/^#[0-9a-f]{6}$/);

    // The dark set applies under the system preference unless the page pins light, and
    // whenever the page pins dark; both blocks carry every dark token, the same values.
    expect(css).toContain(
      '@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) {',
    );
    const preferred = block(css, '  :root:not([data-theme="light"])');
    const pinned = block(css, ':root[data-theme="dark"]');
    expect(preferred.get("--inny-surface-canvas")).toBe("var(--inny-color-night-1)");
    expect([...pinned]).toEqual([...preferred]);

    // Every semantic token of the light default is overridden in dark, so no light surface
    // survives a switch to dark.
    const semantic = [...root.keys()].filter(
      (name) => !/^--inny-(color|space|radius|stroke|size|font|opacity|duration)-/.test(name),
    );
    expect(semantic.length).toBeGreaterThan(0);
    expect([...preferred.keys()]).toEqual(semantic);
  });

  it("writes shadows as CSS box-shadow values and font families quoted where needed", () => {
    const root = block(build(REAL_TOKENS).css, ":root");

    expect(root.get("--inny-shadow-raised")).toMatch(/^0px 2px 8px 0px #[0-9a-f]{8}$/);
    expect(root.get("--inny-font-family-sans")).toBe('"IBM Plex Sans", system-ui, sans-serif');
  });

  it("refuses an alias to a token that does not exist", () => {
    const document = JSON.parse(
      fs.readFileSync(path.join(FIXTURES, "fixture.tokens.json"), "utf8"),
    ) as { light: { surface: { canvas: { $value: string } } } };
    document.light.surface.canvas.$value = "{base.color.paper.9}";

    const result = build(document);

    expect(result.status).toBe(1);
    expect(result.output).toContain("light.surface.canvas refers to base.color.paper.9");
    expect(result.css).toBe("");
  });

  it("refuses a semantic token that one theme lacks", () => {
    const document = JSON.parse(
      fs.readFileSync(path.join(FIXTURES, "fixture.tokens.json"), "utf8"),
    ) as { dark: Record<string, unknown> };
    delete document.dark["shadow"];

    const result = build(document);

    expect(result.status).toBe(1);
    expect(result.output).toContain("the light and dark sets differ");
  });
});

describe("tools/tokens/check.mjs", () => {
  it("fails on #fff in ui/", () => {
    const result = run(CHECK, [path.join(FIXTURES, "raw-colour", "ui")]);

    expect(result.status).toBe(1);
    expect(result.output).toMatch(/raw-colour\/ui\/card\.css:3:21: #fff/);
  });

  it("exempts no directory inside ui/, a generated one included", () => {
    const result = run(CHECK, [path.join(FIXTURES, "raw-colour", "ui")]);

    expect(result.output).toMatch(/raw-colour\/ui\/generated\/leak\.css:3:10: #fff/);
  });

  it("refuses an arbitrary colour property with no utility prefix", () => {
    const result = run(CHECK, [path.join(FIXTURES, "raw-colour", "ui")]);

    expect(result.output).toMatch(/raw-colour\/ui\/arbitrary\.ts:2:23: \[color:red\]/);
  });

  it("refuses a named colour in an inline style, in JSX and in TSX", () => {
    const result = run(CHECK, [path.join(FIXTURES, "raw-colour", "ui")]);

    expect(result.output).toMatch(/raw-colour\/ui\/inline-style\.jsx:2:47: white/);
    expect(result.output).toMatch(/raw-colour\/ui\/style-props\.tsx:2:55: white/);
  });

  it("refuses a named colour in an SVG fill", () => {
    const result = run(CHECK, [path.join(FIXTURES, "raw-colour", "ui")]);

    expect(result.output).toMatch(/raw-colour\/ui\/icon\.svg:2:15: red/);
  });

  it("passes token-only CSS, script and SVG", () => {
    const result = run(CHECK, [path.join(FIXTURES, "clean", "ui")]);

    expect(result).toMatchObject({ status: 0 });
  });

  it("refuses colour functions, named colours and arbitrary colour classes", () => {
    const ui = scratch();
    fs.writeFileSync(
      path.join(ui, "page.css"),
      ".a {\n  color: white;\n  fill: oklch(0.5 0.1 120);\n  border-color: var(--inny-color-red-3);\n}\n",
    );
    fs.writeFileSync(
      path.join(ui, "row.tsx"),
      'export const row = "bg-[red] text-[color:var(--x)] p-4";\nexport const s = "hsl(0 0% 0%)";\nexport const h = "hover:[background:var(--inny-accent-default)]";\n',
    );

    const result = run(CHECK, [ui]);

    expect(result.status).toBe(1);
    expect(result.output).toContain("page.css:2:10: white");
    expect(result.output).toContain("page.css:3:9: oklch(");
    expect(result.output).not.toContain("page.css:4");
    expect(result.output).toContain("row.tsx:1:21: bg-[red]");
    expect(result.output).toContain("row.tsx:1:30: text-[color:var(--x)]");
    expect(result.output).toContain("row.tsx:2:19: hsl(");
    // A colour property set by an arbitrary class is refused even when its value is a token.
    expect(result.output).toContain("row.tsx:3:25: [background:var(--inny-accent-default)]");
  });

  it("does not take a private class member or an anchor for a hex colour", () => {
    const ui = scratch();
    fs.writeFileSync(
      path.join(ui, "store.ts"),
      'export class Store {\n  #add = 1;\n  #bad(): number {\n    return this.#add;\n  }\n}\nexport const route = "#/gallery";\n',
    );

    expect(run(CHECK, [ui])).toMatchObject({ status: 0 });
  });

  it("passes the UI's own sources", () => {
    expect(run(CHECK, [])).toMatchObject({ status: 0 });
  });
});
