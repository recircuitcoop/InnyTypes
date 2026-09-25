// What environment a package gets, judged before anything is built (spec 2.3.3; plan 0018 §1;
// WI-0018-15). Each package runs in its own verified environment, one of three kinds:
//
// - `uv-python`: a uv venv on the bundled Python 3.13, holding exactly the package's hash
//   lock (lock.ts). Any other Python version is refused with a reason.
// - `node`: the package ships pre-bundled JavaScript and runs on the bundled Node. Nothing
//   ever runs npm: a package that needs an install step is refused, and none is attempted.
// - `executable`: a per-platform binary, whose sha256 the declaration states.
//
// Everything is judged on the verified files in memory; the builders (adapters/process) only
// carry out a plan this file made. Pure: the sha256 primitive is handed in.

import { PackageRefusal, type Sha256 } from "./archive";
import type { DeclaredCommand, Declaration } from "./declaration";
import { LOCK_FILENAME, LockError, parseLock, type EnvironmentLock } from "./lock";

/** The one Python the app bundles (plan 0018 §1). */
export const BUNDLED_PYTHON = "3.13";

/** The platform and CPU a binary is chosen for, as Node names them (`darwin`, `arm64`). */
export interface Target {
  readonly platform: string;
  readonly arch: string;
}

/** What to build, once every rule has been judged. */
export type EnvironmentPlan =
  | {
      readonly kind: "uv-python";
      readonly python: string;
      /** The parsed lock; null for a package with no dependencies (it ships no lock). */
      readonly lock: EnvironmentLock | null;
    }
  | { readonly kind: "node" }
  | { readonly kind: "executable"; readonly binary: string };

/** The package managers a node package's commands may never run (plan 0018 §1). */
const PACKAGE_MANAGERS = new Set(["npm", "npx", "pnpm", "pnpx", "yarn", "yarnpkg", "corepack"]);
/** npm's own entry points, reachable as `{node} .../npm-cli.js`. */
const PACKAGE_MANAGER_SCRIPTS = new Set(["npm-cli.js", "npx-cli.js"]);
/** package.json fields npm would install from. */
const DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"];
/** package.json scripts npm runs at install. */
const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall", "prepare"];

function refuse(declaration: Declaration, message: string): never {
  throw new PackageRefusal("environment", `${declaration.package}: ${message}`);
}

/** Every argv a type declares, whatever platform it is for. */
function everyArgv(command: DeclaredCommand): (readonly string[])[] {
  if (Array.isArray(command)) {
    return [command as readonly string[]];
  }
  return Object.values(command as Record<string, readonly string[] | undefined>).filter(
    (argv): argv is readonly string[] => argv !== undefined,
  );
}

/** The last path segment of an argv element, without a Windows launcher extension. */
function programName(element: string): string {
  const base = element.split(/[/\\]/).pop() ?? "";
  return base.replace(/\.(cmd|exe|ps1|bat)$/i, "").toLowerCase();
}

/** Why a declared command would run a package manager, one reason per offending element. */
export function packageManagerCommands(declaration: Declaration): string[] {
  const reasons: string[] = [];
  for (const type of declaration.types) {
    for (const argv of everyArgv(type.command)) {
      for (const element of argv) {
        const name = programName(element);
        if (PACKAGE_MANAGERS.has(name) || PACKAGE_MANAGER_SCRIPTS.has(name)) {
          reasons.push(`type ${type.id}'s command runs ${JSON.stringify(element)}`);
        }
      }
    }
  }
  return reasons;
}

/** Why a package.json would need an install step, one reason per field or script. */
export function installSteps(packageJson: unknown): string[] {
  if (typeof packageJson !== "object" || packageJson === null || Array.isArray(packageJson)) {
    return [];
  }
  const fields = packageJson as Record<string, unknown>;
  const reasons: string[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    const value = fields[field];
    if (typeof value === "object" && value !== null && Object.keys(value).length > 0) {
      reasons.push(`package.json declares ${field}, which npm would install`);
    }
  }
  const scripts = fields["scripts"];
  if (typeof scripts === "object" && scripts !== null) {
    for (const script of INSTALL_SCRIPTS) {
      if (script in scripts) {
        reasons.push(`package.json has a ${script} script, which npm would run`);
      }
    }
  }
  return reasons;
}

/** The files the commands name inside the package (`{package}/…`), which must be shipped. */
function packageFilesNamed(declaration: Declaration): string[] {
  const named = new Set<string>();
  for (const type of declaration.types) {
    for (const argv of everyArgv(type.command)) {
      for (const element of argv) {
        if (element.startsWith("{package}/")) {
          named.add(element.slice("{package}/".length));
        }
      }
    }
  }
  return [...named].sort();
}

function planPython(
  declaration: Declaration,
  files: ReadonlyMap<string, Uint8Array>,
): EnvironmentPlan {
  const asked = declaration.environment?.python ?? BUNDLED_PYTHON;
  if (asked !== BUNDLED_PYTHON) {
    refuse(
      declaration,
      `it asks for Python ${asked}, and InnyTypes provides Python ${BUNDLED_PYTHON} only; ` +
        `declare "python": "${BUNDLED_PYTHON}"`,
    );
  }
  const bytes = files.get(LOCK_FILENAME);
  if (bytes === undefined) {
    return { kind: "uv-python", python: asked, lock: null };
  }
  try {
    return {
      kind: "uv-python",
      python: asked,
      lock: parseLock(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    };
  } catch (error) {
    const message = error instanceof LockError ? error.message : `not UTF-8 text`;
    return refuse(declaration, `${LOCK_FILENAME}: ${message}`);
  }
}

function planNode(
  declaration: Declaration,
  files: ReadonlyMap<string, Uint8Array>,
): EnvironmentPlan {
  const reasons = packageManagerCommands(declaration);
  const manifest = files.get("package.json");
  if (manifest !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifest));
    } catch {
      reasons.push("package.json is not JSON");
    }
    reasons.push(...installSteps(parsed));
  }
  if (files.has("binding.gyp")) {
    reasons.push("binding.gyp asks for a native build");
  }
  for (const file of packageFilesNamed(declaration)) {
    if (!files.has(file)) {
      reasons.push(`the command names ${file}, which the package does not ship`);
    }
  }
  if (reasons.length > 0) {
    refuse(
      declaration,
      `it needs an install step, and a node package must ship pre-bundled JavaScript that ` +
        `runs as it is (nothing ever runs npm): ${reasons.join("; ")}`,
    );
  }
  return { kind: "node" };
}

function planExecutable(
  declaration: Declaration,
  files: ReadonlyMap<string, Uint8Array>,
  target: Target,
  sha256: Sha256,
): EnvironmentPlan {
  const key = `${target.platform}-${target.arch}`;
  const binaries = declaration.environment?.binaries ?? {};
  const binary = binaries[key];
  if (binary === undefined) {
    const offered = Object.keys(binaries).sort();
    refuse(
      declaration,
      `it declares no binary for ${key}` +
        (offered.length > 0 ? `; it has ${offered.join(", ")}` : "; it declares none at all"),
    );
  }
  const bytes = files.get(binary.path);
  if (bytes === undefined) {
    refuse(declaration, `its ${key} binary ${binary.path} is not in the package`);
  }
  if (sha256(bytes) !== binary.sha256) {
    refuse(
      declaration,
      `its ${key} binary ${binary.path} does not match the sha256 its declaration states`,
    );
  }
  return { kind: "executable", binary: binary.path };
}

/**
 * The environment a verified package gets, or a refusal naming why it can get none. `files`
 * are the package's verified files, by relative path.
 */
export function planEnvironment(
  declaration: Declaration,
  files: ReadonlyMap<string, Uint8Array>,
  target: Target,
  sha256: Sha256,
): EnvironmentPlan {
  const kind = declaration.environment?.kind;
  switch (kind) {
    case "uv-python":
      return planPython(declaration, files);
    case "node":
      return planNode(declaration, files);
    case "executable":
      return planExecutable(declaration, files, target, sha256);
    default:
      return refuse(
        declaration,
        "it declares no environment; an installed package declares one (spec 2.3.3)",
      );
  }
}
