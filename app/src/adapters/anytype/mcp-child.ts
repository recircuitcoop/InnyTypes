// The MCP child: the pinned @anyproto/anytype-mcp run on a node the app provides, not npx
// (plan 0018 §3, the port of anytype_mcp/supervisor.py, changed as its row says).
//
// * The command is `<node> <package>/bin/cli.mjs`: the package is the one the workspace pins
//   and installs, found through the resolver the composition root hands in, and its version is
//   checked against PACKAGE_VERSION before anything runs. No network fetch at start.
// * Node itself comes through NodeRuntime: until WI-0018-23 bundles one, it is Electron's own
//   binary run as node (ELECTRON_RUN_AS_NODE), or the node running the tests.
// * The child gets exactly the environment it is given, never this process's.
// * stdout is the MCP stream (StdioMcpSession); each stderr line goes to `onStderr` with the
//   child's pid, which the composition root writes to the one log at WARNING (plan 0015).
// * The child's exit closes the session, which fails every pending call. Nothing is retried.

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import * as path from "node:path";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../domain/anytype/pins";
import { forEachLine } from "../../domain/logging/lines";
import type { McpChild, McpChildLauncher } from "../../ports/anytype";
import type { Clock } from "../../ports/clock";
import { StdioMcpSession } from "./mcp-session";

/** How a node script is run: the binary, and what its environment needs to act as node. */
export interface NodeRuntime {
  readonly command: string;
  readonly env: Readonly<Record<string, string>>;
}

/** The package the workspace installed is not the pinned one: a pin moved on one side only. */
export class PinnedPackageError extends Error {
  override name = "PinnedPackageError";
}

/**
 * The pinned package's entry script, found with `resolve` (require.resolve in the app). Its
 * version must be PACKAGE_VERSION exactly.
 */
export function pinnedPackageEntry(resolve: (id: string) => string): string {
  const manifestPath = resolve(`${PACKAGE_NAME}/package.json`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    version?: unknown;
    bin?: Record<string, string>;
  };
  if (manifest.version !== PACKAGE_VERSION) {
    throw new PinnedPackageError(
      `${PACKAGE_NAME} ${String(manifest.version)} is installed, but ${PACKAGE_VERSION} is pinned`,
    );
  }
  const bin = manifest.bin?.["anytype-mcp"];
  if (bin === undefined) {
    throw new PinnedPackageError(`${PACKAGE_NAME} ${PACKAGE_VERSION} names no anytype-mcp entry`);
  }
  return path.join(path.dirname(manifestPath), bin);
}

export interface NodeMcpChildLauncherOptions {
  readonly node: NodeRuntime;
  /** The script node runs: the pinned package's entry, or a test's fake child. */
  readonly entry: string;
  readonly args?: readonly string[];
  readonly clock: Clock;
  /** The committed surface the child must list. */
  readonly expected: Readonly<Record<string, string>>;
  /** How long a stopped child has before it is killed. */
  readonly stopDeadlineMs?: number;
  readonly requestTimeoutMs?: number;
}

export const STOP_DEADLINE_MS = 5_000;

export class NodeMcpChildLauncher implements McpChildLauncher {
  readonly #options: NodeMcpChildLauncherOptions;

  constructor(options: NodeMcpChildLauncherOptions) {
    this.#options = options;
  }

  /** The argv, for the log: it carries no credential, which lives only in the environment. */
  command(): readonly string[] {
    return [this.#options.node.command, this.#options.entry, ...(this.#options.args ?? [])];
  }

  launch(
    env: Readonly<Record<string, string>>,
    onStderr: (pid: number, line: string) => void,
  ): McpChild {
    const [command, ...args] = this.command() as [string, ...string[]];
    const process = spawn(command, args, {
      env: { ...this.#options.node.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    return new NodeMcpChild(process, this.#options, onStderr);
  }
}

class NodeMcpChild implements McpChild {
  readonly session: StdioMcpSession;
  readonly #process: ChildProcess;
  readonly #options: NodeMcpChildLauncherOptions;
  readonly #listeners: ((code: number | null, signal: string | null) => void)[] = [];
  #exited: { code: number | null; signal: string | null } | null = null;

  constructor(
    process: ChildProcess,
    options: NodeMcpChildLauncherOptions,
    onStderr: (pid: number, line: string) => void,
  ) {
    this.#process = process;
    this.#options = options;
    const { stdin, stdout, stderr } = process;
    if (stdin === null || stdout === null || stderr === null) {
      throw new Error("the Anytype MCP child was spawned without its pipes");
    }
    this.session = new StdioMcpSession({
      input: stdout,
      output: stdin,
      clock: options.clock,
      expected: options.expected,
      ...(options.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: options.requestTimeoutMs }),
    });
    stderr.setEncoding("utf8");
    forEachLine(stderr, (line) => {
      if (line.text !== "") {
        onStderr(this.pid ?? 0, line.text);
      }
    });
    process.on("exit", (code, signal) => {
      this.#gone(code, signal);
    });
    // A spawn that failed (no node there) emits `error` and may never emit `exit`.
    process.on("error", (error) => {
      this.#gone(null, null, `the Anytype MCP child could not be started: ${error.message}`);
    });
  }

  get pid(): number | null {
    return this.#process.pid ?? null;
  }

  onExit(listener: (code: number | null, signal: string | null) => void): void {
    if (this.#exited !== null) {
      listener(this.#exited.code, this.#exited.signal);
      return;
    }
    this.#listeners.push(listener);
  }

  /** Close stdin and ask politely; kill it if it has not gone by the deadline. */
  stop(): Promise<void> {
    const gone = new Promise<void>((resolve) => {
      this.onExit(() => {
        resolve();
      });
    });
    if (this.#exited !== null) {
      return gone;
    }
    this.session.close("the Anytype MCP child is being stopped");
    this.#process.stdin?.end();
    this.#process.kill("SIGTERM");
    const cancel = this.#options.clock.after(
      this.#options.stopDeadlineMs ?? STOP_DEADLINE_MS,
      () => {
        if (this.#exited === null) {
          this.#process.kill("SIGKILL");
        }
      },
    );
    return gone.then(cancel);
  }

  #gone(code: number | null, signal: string | null, reason?: string): void {
    if (this.#exited !== null) {
      return;
    }
    this.#exited = { code, signal };
    this.session.close(
      reason ??
        `the Anytype MCP child exited (${signal === null ? `code ${String(code)}` : signal})`,
    );
    for (const listener of this.#listeners.splice(0)) {
      listener(code, signal);
    }
  }
}
