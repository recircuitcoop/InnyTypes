// The tokens in the sandbox (plan 0021 §7): the shell serves tokens.css (the design tokens as
// CSS custom properties, light and dark, built from docs/ux/tokens) and view-kit.css (written
// only against them) beside view.js, on every view origin, under the pop-out CSP, which stays
// byte-identical to spec 8.5.5. Nothing new is allowed, directive by directive.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { viewPageResponse, type ViewFiles } from "../../src/adapters/electron/schemes";
import { VIEW_CSP, VIEW_PAGE_FILES } from "../../src/domain/views/popout";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO = path.resolve(APP, "..");
const VIEW_SOURCES = path.join(APP, "src", "ui", "view");

/** Spec 8.5.5's CSP, read from the spec itself: the code block's lines, joined by a space. */
function specCsp(): string {
  const spec = fs.readFileSync(path.join(REPO, "docs", "specs", "node-protocol-v2.md"), "utf8");
  const section = spec.slice(spec.indexOf("5. **CSP**, sent as a response header:"));
  const block = /```\n([\s\S]*?)\n\s*```/.exec(section)?.[1] ?? "";
  return block
    .split("\n")
    .map((line) => line.trim())
    .join(" ");
}

/** The CSP before plan 0021 (plan 0020's, media-src its last addition). */
const CSP_BEFORE_0021 =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "media-src 'self' data:; connect-src 'none'; form-action 'none'; frame-ancestors 'none'; " +
  "base-uri 'none'";

const directives = (csp: string): string[] => csp.split(";").map((part) => part.trim());

let scratch: string;
let viewDir: string;
let files: ViewFiles;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "inny-view-tokens-"));
  viewDir = path.join(scratch, "view");
  const kit = path.join(scratch, "packages", "kit");
  fs.mkdirSync(path.join(kit, "view"), { recursive: true });
  fs.mkdirSync(viewDir, { recursive: true });
  // The view folder as the build leaves it: tokens.css by the build:styles command itself.
  const scripts = (
    JSON.parse(fs.readFileSync(path.join(APP, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    }
  ).scripts;
  const command = (scripts["build:styles"] ?? "")
    .split("&&")
    .map((part) => part.trim())
    .find((part) => part.endsWith("--out dist/ui/view/tokens.css"));
  expect(command).toBe("node ../tools/tokens/build.mjs --out dist/ui/view/tokens.css");
  execFileSync(process.execPath, [
    path.join(REPO, "tools", "tokens", "build.mjs"),
    "--out",
    path.join(viewDir, "tokens.css"),
  ]);
  // build:pages bundles view-kit.css beside view.js; a plain stylesheet bundles to itself.
  expect(scripts["build:pages"]).toContain("src/ui/view/view-kit.css");
  fs.copyFileSync(path.join(VIEW_SOURCES, "view-kit.css"), path.join(viewDir, "view-kit.css"));
  fs.copyFileSync(path.join(VIEW_SOURCES, "view.html"), path.join(viewDir, "view.html"));
  fs.writeFileSync(path.join(viewDir, "view.js"), "/* view */");
  // build:styles copies the chrome's compiled classes (app.css) beside them.
  expect(scripts["build:styles"]).toContain(
    "copyFileSync('dist/ui/app.css', 'dist/ui/view/app.css')",
  );
  fs.writeFileSync(path.join(viewDir, "app.css"), ".p-4{padding:var(--inny-space-4)}");
  // A package's own files can never stand in for the page's.
  fs.writeFileSync(path.join(kit, "view", "component.js"), "/* kit */");
  fs.writeFileSync(path.join(kit, "view", "tokens.css"), "/* the kit's own tokens */");
  fs.writeFileSync(path.join(kit, "view", "view-kit.css"), "/* the kit's own kit */");
  fs.writeFileSync(path.join(kit, "view", "app.css"), "/* the kit's own classes */");
  files = { viewDir, packageFolder: (name) => (name === "kit" ? kit : null) };
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("the tokens in the sandbox", () => {
  it("tokens served, CSP unchanged", async () => {
    // The CSP is byte-identical to the spec's text, and allows nothing new, directive by directive.
    expect(specCsp()).toBe(VIEW_CSP);
    const added = directives(VIEW_CSP).filter(
      (part) => !directives(CSP_BEFORE_0021).includes(part),
    );
    const removed = directives(CSP_BEFORE_0021).filter(
      (part) => !directives(VIEW_CSP).includes(part),
    );
    expect(added).toEqual([]);
    expect(removed).toEqual([]);
    // `style-src 'self'` is what lets the page's own stylesheets in; no inline style is allowed.
    expect(directives(VIEW_CSP)).toContain("style-src 'self'");

    expect(VIEW_PAGE_FILES).toEqual([
      "view.html",
      "view.js",
      "tokens.css",
      "view-kit.css",
      "app.css",
    ]);
    const shells = {
      "tokens.css": fs.readFileSync(path.join(viewDir, "tokens.css"), "utf8"),
      "view-kit.css": fs.readFileSync(path.join(viewDir, "view-kit.css"), "utf8"),
      "app.css": fs.readFileSync(path.join(viewDir, "app.css"), "utf8"),
    };
    for (const origin of ["inny-view://app", "inny-view://kit"]) {
      for (const [name, body] of Object.entries(shells)) {
        const url = `${origin}/${name}`;
        const response = viewPageResponse(url, files);
        expect(response.status, url).toBe(200);
        expect(response.headers.get("content-security-policy"), url).toBe(specCsp());
        expect(response.headers.get("content-type"), url).toBe("text/css; charset=utf-8");
        // Always the shell's file, never a package's of the same name.
        expect(await response.text(), url).toBe(body);
      }
      // The page links both, on either origin, under the same header.
      const page = viewPageResponse(`${origin}/view.html`, files);
      expect(page.headers.get("content-security-policy")).toBe(specCsp());
      const html = await page.text();
      expect(html).toContain('<link rel="stylesheet" href="tokens.css" />');
      expect(html).toContain('<link rel="stylesheet" href="view-kit.css" />');
      expect(html).toContain('<link rel="stylesheet" href="app.css" />');
      expect(html.indexOf("tokens.css")).toBeLessThan(html.indexOf("view-kit.css"));
    }
    // A package's component loads after view.js, so the page sees its load failures (plan 0021 §5).
    const kitPage = await viewPageResponse("inny-view://kit/view.html", files).text();
    expect(kitPage.indexOf('<script src="view.js"></script>')).toBeLessThan(
      kitPage.indexOf('<script src="component.js"></script>'),
    );
    expect(viewPageResponse("inny-view://nobody/tokens.css", files).status).toBe(404);

    // tokens.css: the semantic tokens as custom properties, light by default and dark both ways.
    const tokens = shells["tokens.css"];
    const defined = new Set([...tokens.matchAll(/^\s*(--inny-[a-z0-9-]+):/gm)].map((m) => m[1]));
    expect(defined.has("--inny-surface-canvas")).toBe(true);
    expect(tokens).toContain("@media (prefers-color-scheme: dark)");
    expect(tokens).toContain(':root[data-theme="dark"]');

    // view-kit.css: button, field, list row, drag handle; every custom property it uses is a token.
    const kit = shells["view-kit.css"];
    for (const rule of [".inny-button", ".inny-field", ".inny-list-row", ".inny-drag-handle"]) {
      expect(kit, rule).toContain(`${rule} {`);
    }
    const used = [...kit.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1] as string);
    expect(used.length).toBeGreaterThan(10);
    expect(used.filter((name) => !defined.has(name))).toEqual([]);
  });
});
