// The environment builders (plan 0018 §3, the helper/environments.py row; WI-0018-15). Each
// carries out a plan domain/packages/environment.ts already judged, in a staging folder:
//
// - uv-python: `uv venv` on the bundled Python, then `uv pip sync --require-hashes` from the
//   lock as parsed (re-emitted by lockText, never the package's own text). A venv starts
//   empty and `sync` removes anything the lock does not name, so the environment holds the
//   package's declared dependencies and nothing else: no host code, no other package's.
// - node: nothing to build. The package ships pre-bundled JavaScript; no process is started,
//   so nothing can run npm.
// - executable: the verified binary is made executable (a written file is 0644).
//
// uv runs with no user or project configuration, never downloads a Python, keeps its cache
// where the caller says, and gets only an allow-listed environment (command.ts).

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import type { EnvironmentPlan } from "../../domain/packages/environment";
import { LOCK_FILENAME, lockText } from "../../domain/packages/lock";
import type { BuiltEnvironment, EnvironmentBuilder } from "../../ports/environment-builder";
import type { RuntimeLocator } from "../../ports/runtime-locator";
import { BundledRuntimeLocator } from "./bundled-runtime-locator";
import { minimalEnvironment } from "./command";
import { SystemRuntimeLocator } from "./runtime-locator";

/** Where uv takes wheels from: the default index, another index, or a folder, offline. */
export type WheelSource =
  | { readonly kind: "default" }
  | { readonly kind: "index"; readonly url: string }
  | { readonly kind: "folder"; readonly findLinks: string };

export interface EnvironmentBuilderOptions {
  readonly locator: RuntimeLocator;
  /** The runtime's environment, from the composition root; only allow-listed names pass. */
  readonly parentEnvironment: Readonly<Record<string, string | undefined>>;
  /** uv's cache, which the app owns (never the user's). */
  readonly cacheDir: string;
  readonly wheels: WheelSource;
  /** Each uv command's deadline. */
  readonly timeoutMs: number;
  readonly platform: NodeJS.Platform;
}

/** The venv's interpreter, relative to the environment folder, with `/` separators. */
export function venvPython(platform: NodeJS.Platform): string {
  return platform === "win32" ? "venv/Scripts/python.exe" : "venv/bin/python";
}

export function wheelArguments(wheels: WheelSource): string[] {
  switch (wheels.kind) {
    case "index":
      return ["--index-url", wheels.url];
    case "folder":
      return ["--no-index", "--find-links", wheels.findLinks, "--offline"];
    default:
      return [];
  }
}

export class PackageEnvironmentBuilder implements EnvironmentBuilder {
  readonly #options: EnvironmentBuilderOptions;

  constructor(options: EnvironmentBuilderOptions) {
    this.#options = options;
  }

  async build(
    plan: EnvironmentPlan,
    packageDir: string,
    environmentDir: string,
  ): Promise<BuiltEnvironment> {
    switch (plan.kind) {
      case "uv-python":
        return this.#python(plan, environmentDir);
      case "executable":
        fs.chmodSync(path.join(packageDir, ...plan.binary.split("/")), 0o755);
        return {};
      default:
        return {};
    }
  }

  async #python(
    plan: Extract<EnvironmentPlan, { kind: "uv-python" }>,
    environmentDir: string,
  ): Promise<BuiltEnvironment> {
    const python = this.#options.locator.python(plan.python);
    if (python === undefined) {
      throw new Error(`no Python ${plan.python} is available to build it with`);
    }
    const venv = path.join(environmentDir, "venv");
    await this.#uv([
      "venv",
      "--no-project",
      "--no-config",
      "--no-python-downloads",
      "--relocatable",
      "--quiet",
      "--python",
      python,
      venv,
    ]);
    const interpreter = venvPython(this.#options.platform);
    if (plan.lock !== null) {
      const lockFile = path.join(environmentDir, LOCK_FILENAME);
      fs.writeFileSync(lockFile, lockText(plan.lock));
      await this.#uv([
        "pip",
        "sync",
        "--require-hashes",
        "--no-config",
        "--no-python-downloads",
        "--quiet",
        "--python",
        path.join(environmentDir, ...interpreter.split("/")),
        ...wheelArguments(this.#options.wheels),
        lockFile,
      ]);
    }
    return { python: interpreter };
  }

  #uv(args: readonly string[]): Promise<void> {
    const env = minimalEnvironment(this.#options.parentEnvironment, {
      UV_CACHE_DIR: this.#options.cacheDir,
      UV_PYTHON_DOWNLOADS: "never",
    });
    return new Promise((resolve, reject) => {
      execFile(
        this.#options.locator.uv(),
        args,
        { env, timeout: this.#options.timeoutMs, maxBuffer: 16 * 1024 * 1024 },
        (error, _stdout, stderr) => {
          if (error === null) {
            resolve();
            return;
          }
          const said = stderr.trim().split("\n").slice(-12).join("\n");
          const why = error.killed
            ? `was stopped after ${String(this.#options.timeoutMs)} ms`
            : "failed";
          reject(new Error(`uv ${args.slice(0, 2).join(" ")} ${why}: ${said || error.message}`));
        },
      );
    });
  }
}

/**
 * The builder the app uses until a target's bundled runtimes are fetched (WI-0018-23): the
 * system's (the runtime-locator's stand-in), wheels from the default index, five minutes per
 * uv command.
 */
export function systemEnvironmentBuilder(
  parentEnvironment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  cacheDir: string,
): PackageEnvironmentBuilder {
  return new PackageEnvironmentBuilder({
    locator: new SystemRuntimeLocator(parentEnvironment, platform, cacheDir),
    parentEnvironment,
    cacheDir,
    wheels: { kind: "default" },
    timeoutMs: 300_000,
    platform,
  });
}

/**
 * The builder the packaged app uses (plan 0018 §1; WI-0018-23): the bundled python-build-standalone
 * and uv under `runtimesDir` (BundledRuntimeLocator's layout), never the host's.
 */
export function bundledEnvironmentBuilder(
  parentEnvironment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  cacheDir: string,
  runtimesDir: string,
): PackageEnvironmentBuilder {
  return new PackageEnvironmentBuilder({
    locator: new BundledRuntimeLocator(runtimesDir, platform),
    parentEnvironment,
    cacheDir,
    wheels: { kind: "default" },
    timeoutMs: 300_000,
    platform,
  });
}
