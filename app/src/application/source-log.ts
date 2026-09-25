// A child's side of the one log (plan 0018 §2.2): the runtime and the services process write
// every record as one JSON line on their stdout pipe, redacted here at the source, and the
// shell redacts it again before it appends it.
//
// `write` must be synchronous: a line handed to it is in the pipe when it returns, so a
// kill -9 an instant later cannot take it with the process (the shell reads the pipe to its
// end after the child is gone).

import { SecretRegistry } from "../domain/redaction/registry";
import {
  encodeProtect,
  encodeRecord,
  truncateLine,
  type LevelName,
} from "../domain/logging/record";
import type { LeveledLogger, NodeLineLevel, NodeSource, SecretSink } from "../ports/logger";

export interface SourceLogDeps {
  /** The logger name every record of this process carries: `innytypes.runtime`. */
  readonly name: string;
  readonly pid: number;
  /** Writes text to stdout, synchronously. */
  readonly write: (text: string) => void;
  readonly now: () => number;
  readonly registry?: SecretRegistry;
}

/** Everything a child logs with: its own lines, its nodes' lines, and its credentials. */
export interface SourceLog extends LeveledLogger, SecretSink {
  nodeLine(source: NodeSource, level: NodeLineLevel, line: string): void;
}

const NODE_LEVELS: Readonly<Record<NodeLineLevel, LevelName>> = {
  STDERR: "STDERR",
  stdout: "stdout",
  debug: "DEBUG",
  info: "INFO",
  warn: "WARNING",
  error: "ERROR",
};

/** The logger name a node instance's lines are written under. */
export function nodeLoggerName(source: NodeSource): string {
  return `innytypes.node.${source.type}.${source.instance}`;
}

export function sourceLog(deps: SourceLogDeps): SourceLog {
  const registry = deps.registry ?? new SecretRegistry();
  const send = (text: string): void => {
    try {
      deps.write(text);
    } catch {
      // The shell is gone and the pipe with it. A process that cannot log must still run,
      // and its own exit is about to be noticed anyway.
    }
  };
  const record = (level: LevelName, name: string, msg: string): void => {
    send(
      encodeRecord({
        time: deps.now(),
        level,
        pid: deps.pid,
        name: registry.redact(name),
        msg: registry.redact(msg),
      }),
    );
  };
  return {
    debug: (message) => {
      record("DEBUG", deps.name, message);
    },
    info: (message) => {
      record("INFO", deps.name, message);
    },
    warn: (message) => {
      record("WARNING", deps.name, message);
    },
    error: (message) => {
      record("ERROR", deps.name, message);
    },
    nodeLine: (source, level, line) => {
      // What a node printed is cut after redaction, never before: a cut through the middle
      // of a credential would leave its first half behind.
      const redacted = registry.redact(line);
      const msg = level === "STDERR" || level === "stdout" ? truncateLine(redacted) : redacted;
      record(NODE_LEVELS[level], nodeLoggerName(source), msg);
    },
    protect: (secret) => {
      // The shell is told on the same pipe, before any line that could carry the secret.
      if (registry.protect(secret)) {
        send(encodeProtect(secret));
      }
    },
  };
}

/**
 * The log canary (plan 0018 §5.4 `log` proof, the e2e gate): a value registered as a secret
 * and then printed, so that reading the file shows the redaction working rather than
 * assuming it. Nothing is done when no canary was given, which is every ordinary run.
 */
export function printCanary(log: LeveledLogger & SecretSink, canary: string | undefined): void {
  if (canary === undefined || canary === "") {
    return;
  }
  log.protect(canary);
  log.info(`log canary: ${canary}`);
}
