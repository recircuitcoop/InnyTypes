// The raw fixture node (node.py, the standard library only) and the runtime-side recorders the
// integration and conformance tests start it with.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveCommand, minimalEnvironment } from "../../../src/adapters/process/command";
import {
  DEFAULT_NODE_PROCESS,
  nodeProcessLauncher,
  type NodeProcessSettings,
} from "../../../src/adapters/process/node-process";
import { processTreeFor, type ProcessTree } from "../../../src/adapters/process/process-tree";
import { systemClock } from "../../../src/adapters/system/clock";
import type { Clock } from "../../../src/ports/clock";
import type { JournalStore } from "../../../src/ports/journal-store";
import type { Logger, NodeLineLevel, NodeSource, SecretSink } from "../../../src/ports/logger";
import type {
  InputDelivery,
  NodeOutput,
  NodeProcess,
  NodeProcessHost,
  NodeProcessSpec,
  NodeStatus,
  StepOutcome,
  StepStatus,
  ViewContent,
} from "../../../src/ports/node-process";
import type { Notice, Notifier } from "../../../src/ports/notifier";
import { MemoryJournal } from "../../fakes/journal";

export const RAW_NODE_DIR = path.dirname(fileURLToPath(import.meta.url));

const REPOSITORY = path.resolve(RAW_NODE_DIR, "..", "..", "..", "..");

/** The gate's own interpreter when it exists (uv sync --frozen made it), else PATH's. */
function pythonDir(): string | null {
  const venv = path.join(REPOSITORY, ".venv", "bin");
  return fs.existsSync(path.join(venv, "python3")) ? venv : null;
}

/** The node's environment: minimal, with the interpreter its shebang names first on PATH. */
export function rawNodeEnv(): Record<string, string> {
  const dir = pythonDir();
  const inherited = process.env["PATH"] ?? "/usr/bin:/bin";
  return minimalEnvironment(process.env, {
    PATH: dir === null ? inherited : `${dir}:${inherited}`,
  });
}

interface Declaration {
  types: { command: string[] }[];
}

/** The fixture's argv and cwd, resolved from its own inny-package.json. */
export function rawNodeCommand(): { argv: string[]; cwd: string } {
  const text = fs.readFileSync(path.join(RAW_NODE_DIR, "inny-package.json"), "utf8");
  const declaration = JSON.parse(text) as Declaration;
  const command = (declaration.types[0] as { command: string[] }).command;
  return resolveCommand(command, process.platform, {
    python: "python3",
    node: process.execPath,
    package: RAW_NODE_DIR,
  });
}

export function rawNodeSpec(
  config: Record<string, unknown> = {},
  credentials: Record<string, string> = {},
): NodeProcessSpec {
  const { argv, cwd } = rawNodeCommand();
  return {
    identity: {
      id: `n${randomUUID().slice(0, 8)}`,
      package: "rawnode",
      typeId: "raw",
      type: "inny-rawnode-raw",
      name: "",
      kind: "node",
    },
    argv,
    cwd,
    env: rawNodeEnv(),
    config,
    credentials,
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "inny-node-data-")),
    ports: [{ port: "out", event: "rawnode.out.v1" }],
  };
}

// ── recorders ────────────────────────────────────────────────────────────────────────────

export interface LoggedLine {
  readonly level: string;
  readonly text: string;
}

export class RecordingLogger implements Logger {
  readonly lines: LoggedLine[] = [];
  readonly nodeLines: { source: NodeSource; level: NodeLineLevel; line: string }[] = [];
  info(message: string): void {
    this.lines.push({ level: "info", text: message });
  }
  warn(message: string): void {
    this.lines.push({ level: "warn", text: message });
  }
  error(message: string): void {
    this.lines.push({ level: "error", text: message });
  }
  nodeLine(source: NodeSource, level: NodeLineLevel, line: string): void {
    this.nodeLines.push({ source, level, line });
  }
  has(pattern: RegExp): boolean {
    return this.lines.some((line) => pattern.test(line.text));
  }
}

export class RecordingSecrets implements SecretSink {
  readonly protected: string[] = [];
  protect(secret: string): void {
    this.protected.push(secret);
  }
}

export class RecordingNotifier implements Notifier {
  readonly notices: Notice[] = [];
  readonly cleared: string[] = [];
  raise(notice: Notice): void {
    this.notices.push(notice);
  }
  clear(kind: Notice["kind"], subject: string): void {
    this.cleared.push(`${kind} ${subject}`);
  }
}

export class RecordingHost implements NodeProcessHost {
  readonly statuses: NodeStatus[] = [];
  readonly sent: NodeOutput[] = [];
  readonly presented: { inputId: string; content: ViewContent; first: boolean }[] = [];
  readonly snapshots: { content: ViewContent; state: unknown; inputId: string | null }[] = [];
  readonly errors: string[] = [];
  status(status: NodeStatus): void {
    this.statuses.push(status);
  }
  send(output: NodeOutput): void {
    this.sent.push(output);
  }
  present(inputId: string, content: ViewContent, first: boolean): void {
    this.presented.push({ inputId, content, first });
  }
  snapshot(content: ViewContent, state: unknown, inputId: string | null): void {
    this.snapshots.push({ content, state, inputId });
  }
  nodeError(message: string): void {
    this.errors.push(message);
  }
}

/** One input's `send`, `done` and step line, recorded. */
export class RecordingDelivery implements InputDelivery {
  readonly outputs: NodeOutput[] = [];
  readonly ends: (Error | undefined)[] = [];
  /** The protocol 2.1 report each `done` carried; undefined for a 2.0 `done`. */
  readonly outcomes: (StepOutcome | undefined)[] = [];
  /** Every `status` that named this input (protocol 2.1). */
  readonly statuses: StepStatus[] = [];
  send(output: NodeOutput): void {
    this.outputs.push(output);
  }
  done(error?: Error, outcome?: StepOutcome): void {
    this.ends.push(error);
    this.outcomes.push(outcome);
  }
  status(status: StepStatus): void {
    this.statuses.push(status);
  }
  get finished(): boolean {
    return this.ends.length > 0;
  }
}

export interface RawNode {
  readonly node: NodeProcess;
  readonly host: RecordingHost;
  readonly logger: RecordingLogger;
  readonly notifier: RecordingNotifier;
  readonly secrets: RecordingSecrets;
  readonly spec: NodeProcessSpec;
  readonly journal: JournalStore;
  /** Every unexpected exit the process told of, for the crash reports: true once it stopped. */
  readonly crashes: readonly boolean[];
}

export interface StartOptions {
  readonly config?: Record<string, unknown>;
  readonly credentials?: Record<string, string>;
  readonly clock?: Clock;
  readonly tree?: ProcessTree;
  readonly settings?: Partial<NodeProcessSettings>;
  /** Replaces the fixture's argv, for a command that cannot run. */
  readonly argv?: string[];
  /** The journal it writes to; a fresh MemoryJournal when omitted. */
  readonly journal?: JournalStore;
  /** The instance id, to start "the same instance" again after a restart. */
  readonly id?: string;
}

/** Start the raw node through the real adapter, as the runtime would. */
export function startRaw(options: StartOptions = {}): RawNode {
  const base = rawNodeSpec(options.config, options.credentials);
  const withId =
    options.id === undefined ? base : { ...base, identity: { ...base.identity, id: options.id } };
  const spec = options.argv === undefined ? withId : { ...withId, argv: options.argv };
  const journal = options.journal ?? new MemoryJournal();
  const host = new RecordingHost();
  const logger = new RecordingLogger();
  const notifier = new RecordingNotifier();
  const secrets = new RecordingSecrets();
  const crashes: boolean[] = [];
  const launcher = nodeProcessLauncher({
    clock: options.clock ?? systemClock,
    logger,
    secrets,
    notifier,
    crashes: { nodeCrashed: (stopped) => crashes.push(stopped) },
    tree: options.tree ?? processTreeFor(process.platform),
    newId: randomUUID,
    journal,
    settings: { ...DEFAULT_NODE_PROCESS, ...options.settings },
  });
  const node = launcher.start(spec, host);
  return { node, host, logger, notifier, secrets, spec, journal, crashes };
}

/** Wait until `condition` holds, polling; fail with `what` after `timeoutMs`. */
export async function waitFor(
  what: string,
  condition: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${String(timeoutMs)} ms waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Whether a process with this pid exists (a zombie counts as gone once reaped). */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
