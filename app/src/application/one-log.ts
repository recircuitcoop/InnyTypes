// The shell's side of the one log (plan 0018 §2.2, the §3 row for logs.py): the only writer.
//
// Three kinds of line reach the file, and all three pass through `#append`, which is the one
// place the level is applied and the one place redaction happens in the shell:
// * the shell's own records, through `logger()`;
// * the runtime's and the services process's records, as JSON lines on their stdout pipes,
//   through `ingest()`. A `protect` line registers a credential the child holds;
// * whatever a child printed outside its log: non-JSON stdout at level stdout and stderr at
//   level STDERR, cut to MAX_OUTPUT_LINE so a flood cannot rotate the log away.

import type { Line } from "../domain/logging/lines";
import {
  formatLine,
  levelLabel,
  LEVELS,
  parseWireLine,
  truncateLine,
  type LevelName,
  type LogRecord,
} from "../domain/logging/record";
import type { SecretRegistry } from "../domain/redaction/registry";
import type { LeveledLogger, LogFile, SecretSink } from "../ports/logger";

export interface OneLogDeps {
  readonly registry: SecretRegistry;
  /** Records below this level number are dropped. */
  readonly level: number;
  /** The file, or null when none could be opened: then records go nowhere (logs.py:426). */
  readonly file: LogFile | null;
  /** Each line written is also shown here (the shell's terminal), after redaction. */
  readonly echo?: (line: string) => void;
  readonly now: () => number;
}

/** Which pipe of a child a line came from. */
export type ChildStream = "stdout" | "stderr";

export class OneLog implements SecretSink {
  readonly #deps: OneLogDeps;

  constructor(deps: OneLogDeps) {
    this.#deps = deps;
  }

  protect(secret: string): void {
    this.#deps.registry.protect(secret);
  }

  /** A logger for records this process writes itself. */
  logger(name: string, pid: number): LeveledLogger & SecretSink {
    const record = (level: LevelName, msg: string): void => {
      this.#append({ time: this.#deps.now(), level, pid, name, msg });
    };
    return {
      debug: (message) => {
        record("DEBUG", message);
      },
      info: (message) => {
        record("INFO", message);
      },
      warn: (message) => {
        record("WARNING", message);
      },
      error: (message) => {
        record("ERROR", message);
      },
      protect: (secret) => {
        this.protect(secret);
      },
    };
  }

  /** One line of `child`'s stdout or stderr pipe. `pid` is the child's, when it is known. */
  ingest(child: string, pid: number | null, stream: ChildStream, line: Line): void {
    const name = `innytypes.${child}`;
    const printed = (level: LevelName, text: string): void => {
      if (text === "" && !line.cut) {
        return; // a blank line says nothing (children.py skips them too)
      }
      // Redacted before it is cut, so a cut can never leave half a credential behind.
      const msg = truncateLine(this.#deps.registry.redact(text));
      this.#append({ time: this.#deps.now(), level, pid: pid ?? 0, name, msg });
    };

    if (stream === "stderr") {
      printed("STDERR", line.text);
      return;
    }
    // A line cut short is not JSON any more, whatever it started as.
    const wire = line.cut ? { kind: "text" as const, text: line.text } : parseWireLine(line.text);
    switch (wire.kind) {
      case "protect":
        this.protect(wire.secret);
        return;
      case "log":
        this.#append(wire.record);
        return;
      case "text":
        printed("stdout", wire.text);
        return;
    }
  }

  /**
   * The line that opens a process's part of the log (logs.py:477-486): which process, which
   * file, which level. A verbosity that could not be read is said first, at WARNING.
   */
  announce(options: {
    readonly role: string;
    readonly pid: number;
    readonly destination: string | null;
    readonly levelProblem: string | null;
  }): void {
    const logger = this.logger("innytypes.logs", options.pid);
    const level = levelLabel(this.#deps.level);
    if (options.levelProblem !== null) {
      logger.warn(`${options.levelProblem}; logging at ${level} instead`);
    }
    logger.info(
      `innytypes ${options.role} (process ${String(options.pid)}) is logging to ` +
        `${options.destination ?? "nowhere"} at ${level}`,
    );
  }

  #append(record: LogRecord): void {
    if (LEVELS[record.level] < this.#deps.level) {
      return;
    }
    const { registry } = this.#deps;
    const line = formatLine({
      ...record,
      name: registry.redact(record.name),
      msg: registry.redact(record.msg),
    });
    this.#deps.file?.append(line);
    this.#deps.echo?.(line);
  }
}
