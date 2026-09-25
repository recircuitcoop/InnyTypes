// Node-RED's own log, routed through a logging handler into the one log (WI-0018-04).
//
// The value is Node-RED's `settings.logging`. It names one custom logger and no `console`, so
// Node-RED prints nothing to the runtime's stdout of its own: every line it writes reaches the
// runtime's logger, is redacted there, and is handed to the shell like any other record.
// WI-0018-08, which starts Node-RED, passes this in its settings.

import type { LeveledLogger } from "../../ports/logger";

/** Node-RED's level numbers (@node-red/util log.js). */
const FATAL = 10;
const ERROR = 20;
const WARN = 30;
const INFO = 40;

/** One message a Node-RED log handler is given. */
export interface NodeRedLogMessage {
  readonly level: number;
  readonly msg?: unknown;
  readonly type?: string;
  readonly id?: string;
  readonly name?: string;
}

export interface NodeRedLoggingSettings {
  readonly innytypes: {
    readonly level: "debug";
    readonly metrics: false;
    readonly audit: false;
    readonly handler: () => (message: NodeRedLogMessage) => void;
  };
}

function text(message: NodeRedLogMessage): string {
  const body =
    message.msg instanceof Error
      ? (message.msg.stack ?? message.msg.message)
      : typeof message.msg === "string"
        ? message.msg
        : JSON.stringify(message.msg);
  // Node-RED's console logger prefixes a node's lines with `[type:name]`; so does this one.
  if (message.type === undefined) {
    return body;
  }
  return `[${message.type}:${message.name ?? message.id ?? ""}] ${body}`;
}

/** Node-RED's `settings.logging`, writing every line through `logger`. */
export function nodeRedLogging(logger: LeveledLogger): NodeRedLoggingSettings {
  const write = (message: NodeRedLogMessage): void => {
    const line = text(message);
    if (message.level <= ERROR) {
      logger.error(message.level <= FATAL ? `fatal: ${line}` : line);
    } else if (message.level <= WARN) {
      logger.warn(line);
    } else if (message.level <= INFO) {
      logger.info(line);
    } else {
      logger.debug(line); // debug and trace
    }
  };
  return {
    innytypes: { level: "debug", metrics: false, audit: false, handler: () => write },
  };
}
