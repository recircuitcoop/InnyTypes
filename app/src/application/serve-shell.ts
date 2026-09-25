// The child's side of the channel (spec 10.2), shared by the runtime and the services process.
//
// For now a child only obeys the channel: it answers `init` with `ready`, `stop` with
// `stopped` and an exit, and every `call` with a reply. Node-RED (WI-0018-08) and Anytype
// (WI-0018-18) are started by the work items that bring them; until then no operation is
// served, and a call says so rather than hanging until its timeout.

import { parseShellMessage, type InitConfig } from "../domain/channel/messages";
import type { ChildName } from "../domain/supervision/child-state";
import type { Clock } from "../ports/clock";
import type { Logger } from "../ports/logger";
import type { ProcessHost, ShellLink } from "../ports/shell-link";

/** Time for `stopped` to leave the process before it exits. */
export const EXIT_FLUSH_MS = 50;

export interface ServeShellDeps {
  readonly child: ChildName;
  readonly link: ShellLink;
  readonly host: ProcessHost;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Called with the settings `init` carried, before `ready` is answered. */
  readonly onInit?: (config: InitConfig) => void;
}

/** Answer the shell, for as long as the process lives. */
export function serveShell(deps: ServeShellDeps): void {
  const { child, link, host, clock, logger } = deps;
  let stopping = false;

  link.onMessage((raw) => {
    const message = parseShellMessage(raw);
    if (message === null) {
      logger.warn(`the ${child} received a message this channel does not know`);
      return;
    }
    switch (message.t) {
      case "init": {
        const { generation, port } = message.config;
        logger.info(`${child} generation ${String(generation)} started as pid ${String(host.pid)}`);
        deps.onInit?.(message.config);
        link.post({ v: 1, t: "ready", pid: host.pid, generation, port });
        return;
      }
      case "stop":
        if (stopping) {
          return;
        }
        stopping = true;
        logger.info(`${child} stopping (${message.reason})`);
        link.post({ v: 1, t: "stopped", reason: message.reason });
        clock.after(EXIT_FLUSH_MS, () => {
          host.exit(0);
        });
        return;
      case "call":
        link.post({
          v: 1,
          t: "reply",
          rid: message.rid,
          result: { ok: false, error: `the InnyTypes ${child} does not serve ${message.op} yet` },
        });
        return;
    }
  });
}
