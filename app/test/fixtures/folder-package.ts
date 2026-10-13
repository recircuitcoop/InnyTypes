// The first-party folder package (packages/folder, WI-0022-25) as the tests run it: bundled by
// esbuild exactly as `npm run build:packages` bundles it, beside a copy of its declaration, in
// a scratch folder, so a test never depends on a build having run and never writes into the
// repository.

import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { build } from "esbuild";

import { resolveCommand } from "../../src/adapters/process/command";
import type { DeclaredType } from "../../src/domain/packages/declaration";

const REPOSITORY = path.resolve(import.meta.dirname, "..", "..", "..");
export const FOLDER_PACKAGE_SOURCE = path.join(REPOSITORY, "packages", "folder");

export interface BuiltFolderPackage {
  /** The scratch folder holding inny-package.json and dist/folder.cjs. */
  readonly dir: string;
  /** The `watch` type, as declared. */
  readonly type: DeclaredType;
  /** Its command resolved for this platform, {node} being this test's own Node. */
  readonly argv: string[];
  readonly cwd: string;
  remove(): void;
}

/** Bundle packages/folder into a new scratch folder. */
export async function buildFolderPackage(): Promise<BuiltFolderPackage> {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "inny-folder-package-")));
  fs.copyFileSync(
    path.join(FOLDER_PACKAGE_SOURCE, "inny-package.json"),
    path.join(dir, "inny-package.json"),
  );
  await build({
    entryPoints: [path.join(FOLDER_PACKAGE_SOURCE, "src", "main.ts")],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    outfile: path.join(dir, "dist", "folder.cjs"),
    logLevel: "warning",
  });
  const declaration = JSON.parse(
    fs.readFileSync(path.join(dir, "inny-package.json"), "utf8"),
  ) as { types: DeclaredType[] };
  const type = declaration.types.find((declared) => declared.id === "watch");
  if (type === undefined) {
    throw new Error("packages/folder declares no watch type");
  }
  const { argv, cwd } = resolveCommand(type.command, process.platform, {
    python: "python3",
    node: process.execPath,
    package: dir,
  });
  return {
    dir,
    type,
    argv,
    cwd,
    remove: () => {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
