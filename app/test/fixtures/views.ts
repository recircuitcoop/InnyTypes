// The two reference view nodes (viewpy: Python, standard library only; viewts: TypeScript,
// run by a Node that strips types), and how the tests start them (WI-0018-10). Neither is an
// SDK: C10 and C11 are owed again against the SDKs proper by WI-0018-26.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveCommand } from "../../src/adapters/process/command";
import { portsOf, type DeclaredType } from "../../src/domain/packages/declaration";
import { timeoutOf } from "../../src/domain/views/views";
import type { NodeProcessSpec } from "../../src/ports/node-process";
import { rawNodeEnv } from "./raw-node/fixture";

const FIXTURES = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY = path.resolve(FIXTURES, "..", "..", "..");

export type ViewLanguage = "py" | "ts";
export const VIEW_LANGUAGES: readonly ViewLanguage[] = ["py", "ts"];

/** The package folder of a reference view node. */
export function viewPackageDir(language: ViewLanguage): string {
  return path.join(FIXTURES, `view${language}`);
}

/** The Python the gate built (uv sync --frozen), else PATH's. */
function python(): string {
  const venv = path.join(REPOSITORY, ".venv", "bin", "python3");
  return fs.existsSync(venv) ? venv : "python3";
}

interface Declaration {
  readonly package: string;
  readonly types: readonly DeclaredType[];
}

function declarationOf(language: ViewLanguage): Declaration {
  const text = fs.readFileSync(path.join(viewPackageDir(language), "inny-package.json"), "utf8");
  return JSON.parse(text) as Declaration;
}

/** A type of a reference view node, as declared. */
export function viewType(language: ViewLanguage, typeId: "ask" | "record"): DeclaredType {
  const type = declarationOf(language).types.find((declared) => declared.id === typeId);
  if (type === undefined) {
    throw new Error(`view${language} declares no ${typeId}`);
  }
  return type;
}

/** The argv and cwd of a reference view node: {node} is this test's own Node. */
export function viewCommand(
  language: ViewLanguage,
  typeId: "ask" | "record",
): { argv: string[]; cwd: string } {
  return resolveCommand(viewType(language, typeId).command, process.platform, {
    python: python(),
    node: process.execPath,
    package: viewPackageDir(language),
  });
}

/** A node process spec for one instance of a reference view type. */
export function viewSpec(
  language: ViewLanguage,
  typeId: "ask" | "record",
  options: { id?: string; config?: Record<string, unknown> } = {},
): NodeProcessSpec {
  const pkg = `view${language}`;
  const type = viewType(language, typeId);
  const ports = portsOf(type).map(({ port, event }) => ({ port, event }));
  const config = options.config ?? {};
  return {
    identity: {
      id: options.id ?? `v${randomUUID().slice(0, 8)}`,
      flowId: "flow-1",
      package: pkg,
      typeId,
      type: `inny-${pkg}-${typeId}`,
      name: "",
      kind: "view",
    },
    ...viewCommand(language, typeId),
    env: rawNodeEnv(),
    config,
    credentials: {},
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "inny-view-data-")),
    ports,
    viewTimeoutMs:
      typeId === "ask"
        ? timeoutOf(
            config,
            ports.map(({ port }) => port),
          )
        : null,
  };
}
