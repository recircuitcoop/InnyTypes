// The Logger port as lines on the process's own output, until the one log writer
// (WI-0018-04) replaces it. Each line names the process, so the shell's and the children's
// lines can be told apart in one terminal.

import type { Logger } from "../../ports/logger";
import type { Notice, Notifier } from "../../ports/notifier";

export interface LineSink {
  log(line: string): void;
  error(line: string): void;
}

export function consoleLogger(name: string, pid: number, sink: LineSink = console): Logger {
  const line = (level: string, message: string): string =>
    `${new Date().toISOString()} ${level.padEnd(5)} [${name} ${String(pid)}] ${message}`;
  return {
    info: (message) => {
      sink.log(line("INFO", message));
    },
    warn: (message) => {
      sink.error(line("WARN", message));
    },
    error: (message) => {
      sink.error(line("ERROR", message));
    },
  };
}

/** Notices as log lines, until desktop notices arrive with WI-0018-21. */
export function logNotifier(logger: Logger): Notifier {
  return {
    raise: (notice: Notice) => {
      logger.error(`notice: ${notice.title}: ${notice.body}`);
    },
  };
}
