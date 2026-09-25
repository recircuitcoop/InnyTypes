// The package store until verified installs exist (WI-0018-15, WI-0018-16): the packages
// found in fixed folders, by the `package` name their inny-package.json declares.
//
// The runtime gives it the first-party packages shipped with the app and the test fixtures.
// Each immediate subfolder of a root is one package. A folder whose declaration cannot be
// read is reported, with its reason, and leaves out only itself. The store reads; it never
// creates or writes anything.

import * as fs from "node:fs";
import * as path from "node:path";
import type { Logger } from "../../ports/logger";
import type { PackageStore } from "../../ports/package-store";

/** The declaration every node package holds at its root (spec 2.1). */
export const DECLARATION = "inny-package.json";

/** Spec 2.1: the package name. */
const PACKAGE_NAME = /^[a-z][a-z0-9_]{1,39}$/;

/** The package a folder declares, or the reason it declares none. */
function readDeclaredName(folder: string): { name: string } | { problem: string } {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(path.join(folder, DECLARATION));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      problem: code === "ENOENT" ? `has no ${DECLARATION}` : `${DECLARATION}: ${String(error)}`,
    };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { problem: `${DECLARATION} is not UTF-8 text` };
  }
  let declaration: unknown;
  try {
    declaration = JSON.parse(text);
  } catch (error) {
    return { problem: `${DECLARATION} is not JSON: ${(error as Error).message}` };
  }
  const name =
    typeof declaration === "object" && declaration !== null && "package" in declaration
      ? declaration.package
      : undefined;
  if (typeof name !== "string" || !PACKAGE_NAME.test(name)) {
    return { problem: `${DECLARATION} names no valid package` };
  }
  return { name };
}

export class DeclaredPackageStore implements PackageStore {
  readonly #roots: readonly string[];
  readonly #logger: Logger;
  /** Problems already reported: the store is read on every deploy, and each is said once. */
  readonly #said = new Set<string>();

  constructor(roots: readonly string[], logger: Logger) {
    this.#roots = roots;
    this.#logger = logger;
  }

  packages(): readonly string[] {
    const found = new Map<string, string>();
    for (const root of this.#roots) {
      for (const folder of this.#folders(root)) {
        const read = readDeclaredName(folder);
        if ("problem" in read) {
          this.#warnOnce(`node package ${folder} ${read.problem}; it is left out`);
          continue;
        }
        const first = found.get(read.name);
        if (first !== undefined) {
          // Spec 2.1: the one already found wins, and the second is said.
          this.#warnOnce(
            `node package ${folder} declares ${read.name}, already declared by ${first}; ` +
              "it is left out",
          );
          continue;
        }
        found.set(read.name, folder);
      }
    }
    return [...found.keys()].sort();
  }

  /** The root's immediate subfolders; an absent root has none. */
  #folders(root: string): string[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.#warnOnce(`node packages in ${root} could not be listed: ${String(error)}`);
      }
      return [];
    }
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name))
      .sort();
  }

  #warnOnce(message: string): void {
    if (!this.#said.has(message)) {
      this.#said.add(message);
      this.#logger.warn(message);
    }
  }
}
