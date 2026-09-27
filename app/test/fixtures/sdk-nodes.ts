// The two SDK reference node packages -- sdk-py (Python, built on innytypes-node) and sdk-ts
// (TypeScript, built on @innytypes/node) -- and how the conformance tests start them
// (WI-0018-26). Unlike raw-node and view{py,ts}, which are deliberately hand-rolled and share
// no code with any SDK, these ARE built through the SDKs: this is what "run the conformance
// suite against a reference node built on each SDK" (not only the raw fixtures) means.

import fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveCommand } from "../../src/adapters/process/command";
import type { DeclaredType } from "../../src/domain/packages/declaration";

const FIXTURES = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY = path.resolve(FIXTURES, "..", "..", "..");

export type SdkLanguage = "py" | "ts";
export const SDK_LANGUAGES: readonly SdkLanguage[] = ["py", "ts"];
export type SdkTypeId = "kitchen" | "ask" | "record";

/** The package folder of an SDK reference node. */
export function sdkPackageDir(language: SdkLanguage): string {
  return path.join(FIXTURES, `sdk-${language}`);
}

/** The Python the gate built (uv sync --frozen), else PATH's; only used for the {python}
 * placeholder. The SDK itself is imported from source (sdk/python/src), never installed, so
 * any Python 3.13 works -- there is nothing to `pip install` for a test fixture. */
function python(): string {
  const venv = path.join(REPOSITORY, ".venv", "bin", "python3");
  return fs.existsSync(venv) ? venv : "python3";
}

interface Declaration {
  readonly package: string;
  readonly types: readonly DeclaredType[];
}

function declarationOf(language: SdkLanguage): Declaration {
  const text = fs.readFileSync(path.join(sdkPackageDir(language), "inny-package.json"), "utf8");
  return JSON.parse(text) as Declaration;
}

/** A type of an SDK reference node, as declared. */
export function sdkType(language: SdkLanguage, typeId: SdkTypeId): DeclaredType {
  const type = declarationOf(language).types.find((declared) => declared.id === typeId);
  if (type === undefined) {
    throw new Error(`sdk-${language} declares no ${typeId}`);
  }
  return type;
}

/** The argv and cwd of an SDK reference node: {node} is this test's own Node. */
export function sdkCommand(
  language: SdkLanguage,
  typeId: SdkTypeId,
): { argv: string[]; cwd: string } {
  return resolveCommand(sdkType(language, typeId).command, process.platform, {
    python: python(),
    node: process.execPath,
    package: sdkPackageDir(language),
  });
}
