// The gallery is a development page only (plan 0022 §L, decision D11): a production build of its
// entry must carry none of it. Built here with esbuild's own API and the exact flags of
// package.json's build:pages, once as production and once as development, so the test also
// proves the marker it looks for is really there when the gallery is.
import fs from "node:fs";
import * as path from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const APP = path.resolve(import.meta.dirname, "..", "..");
const ENTRY = path.join(APP, "src", "ui", "gallery", "main.tsx");
/** Set on the gallery's root element; nothing else in the UI says it. */
const MARKER = "innytypes-component-gallery";

const script = (): string => {
  const manifest = JSON.parse(fs.readFileSync(path.join(APP, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  return manifest.scripts["build:pages"] ?? "";
};

async function bundle(nodeEnv: "production" | "development"): Promise<string> {
  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    write: false,
    platform: "browser",
    target: "chrome140",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": JSON.stringify(nodeEnv) },
    logLevel: "silent",
  });
  return result.outputFiles.map((file) => file.text).join("\n");
}

describe("the gallery bundle", () => {
  it("is built by build:pages with the automatic JSX runtime and NODE_ENV defined at build time", () => {
    const pages = script();
    expect(pages).toContain("src/ui/gallery/main.tsx");
    expect(pages).toContain("--jsx=automatic");
    expect(pages).toContain('--define:process.env.NODE_ENV=\\"${NODE_ENV:-development}\\"');
  });

  it("carries no gallery code, no component and no React in a production build", async () => {
    const production = await bundle("production");
    expect(production).not.toContain(MARKER);
    expect(production).not.toContain("data-gallery-group");
    expect(production).not.toContain("src/ui/components/");
    expect(production).not.toContain("react-dom");
    expect(production).toContain('"data-refused", "gallery"');
    expect(production.length).toBeLessThan(10_000);
  });

  it("carries the gallery in a development build", async () => {
    const development = await bundle("development");
    expect(development).toContain(MARKER);
    expect(development).toContain("src/ui/components/atoms/Button.tsx");
  }, 30_000);
});

it("the packaged builds are production builds", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(APP, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  for (const name of ["package:mac", "package:linux"]) {
    expect(manifest.scripts[name], name).toMatch(/^NODE_ENV=production npm run build &&/);
  }
});
