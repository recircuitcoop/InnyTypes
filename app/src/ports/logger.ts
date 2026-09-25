// Where a process writes what it did (plan 0018 §2.2). The shell is the one log writer
// (WI-0018-04): it writes its own records, and the runtime and the services process hand
// theirs to it as JSON lines on their stdout (domain/logging/record.ts), redacted at the
// source and again in the shell.

/**
 * The levels of a line that came from a node process (spec 3.3, 3.4 and the `log` frame, 4.2):
 * `STDERR` for its stderr, `stdout` for a non-frame stdout line (a protocol violation), and
 * the four levels of a `log` frame.
 */
export type NodeLineLevel = "STDERR" | "stdout" | "debug" | "info" | "warn" | "error";

/** Which node process a line came from: its Node-RED type name and its instance id. */
export interface NodeSource {
  readonly type: string;
  readonly instance: string;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /**
   * A line from a node process, tagged with its type and instance (spec 3.4). Optional on the
   * port, but the runtime's logger implements it and node-process.ts calls it with no fallback:
   * a logger without it drops node lines.
   */
  nodeLine?(source: NodeSource, level: NodeLineLevel, line: string): void;
}

/** A Logger that also writes DEBUG, for a source with a verbosity of its own (Node-RED). */
export interface LeveledLogger extends Logger {
  debug(message: string): void;
}

/**
 * Registers a credential with the log redactor (spec 11.1): a node's credentials before any of
 * its lines are written, the Anytype key, the proxy token. From then on it is redacted in this
 * process, and in the shell too.
 */
export interface SecretSink {
  protect(secret: string): void;
}

/** The one log file: complete lines in, already formatted and redacted. */
export interface LogFile {
  append(line: string): void;
}
