// The child's side of the channel (spec 10.2), shared by the runtime and the services process.
//
// A child answers `init` with `ready` once what it hosts has started (the runtime: Node-RED,
// WI-0018-08), or with `failed` and an exit when it could not; `stop` with `stopped` once what
// it hosts has stopped, then an exit; and every `call` with a reply. A child serves the calls
// its `onCall` answers (the services process's Anytype operations, WI-0018-18); any other call
// says it is not served rather than hanging until its timeout.

import {
  parseShellMessage,
  type CallOp,
  type InitConfig,
  type OpResult,
  type StopReason,
} from "../domain/channel/messages";
import type { ChildName } from "../domain/supervision/child-state";
import type { Clock } from "../ports/clock";
import type { Logger } from "../ports/logger";
import type { Notifier } from "../ports/notifier";
import type { ProcessHost, ShellLink } from "../ports/shell-link";

/** Time for `stopped` to leave the process before it exits. */
export const EXIT_FLUSH_MS = 50;

export interface ServeShellDeps {
  readonly child: ChildName;
  readonly link: ShellLink;
  readonly host: ProcessHost;
  readonly clock: Clock;
  readonly logger: Logger;
  /**
   * Called with the settings `init` carried. `ready` is answered once it has returned, or once
   * the promise it returned has resolved; a throw or a rejection answers `failed` and exits 1.
   */
  readonly onInit?: (config: InitConfig) => void | Promise<void>;
  /** Called on `stop`; `stopped` is answered once it has finished, whether or not it failed. */
  readonly onStop?: (reason: StopReason) => void | Promise<void>;
  /**
   * Answers a `call` (the services process's Anytype operations, WI-0018-18). Without it, or
   * when it rejects, the call is answered with a failure rather than left to time out.
   */
  readonly onCall?: (op: CallOp, args: unknown) => Promise<OpResult>;
}

/** Answer the shell, for as long as the process lives. */
export function serveShell(deps: ServeShellDeps): void {
  const { child, link, host, clock, logger } = deps;
  let stopping = false;

  const exitSoon = (code: number): void => {
    clock.after(EXIT_FLUSH_MS, () => {
      host.exit(code);
    });
  };

  // A hook that returns at once is answered at once; one that returns a promise, when it settles.
  const settle = (
    hook: () => void | Promise<void>,
    done: () => void,
    failed: (error: unknown) => void,
  ): void => {
    let result: void | Promise<void>;
    try {
      result = hook();
    } catch (error) {
      failed(error);
      return;
    }
    if (result instanceof Promise) {
      result.then(done, failed);
    } else {
      done();
    }
  };

  const init = (config: InitConfig): void => {
    const { generation, port } = config;
    logger.info(`${child} generation ${String(generation)} started as pid ${String(host.pid)}`);
    settle(
      () => deps.onInit?.(config),
      () => {
        if (!stopping) {
          // Told to stop while starting: `stopped` is then the answer, not `ready`.
          link.post({ v: 1, t: "ready", pid: host.pid, generation, port });
        }
      },
      (error) => {
        logger.error(`the ${child} could not start: ${String(error)}`);
        link.post({ v: 1, t: "failed", error: String(error) });
        exitSoon(1);
      },
    );
  };

  const stop = (reason: StopReason): void => {
    logger.info(`${child} stopping (${reason})`);
    const stopped = (): void => {
      link.post({ v: 1, t: "stopped", reason });
      exitSoon(0);
    };
    settle(
      () => deps.onStop?.(reason),
      stopped,
      (error) => {
        logger.error(`the ${child} did not stop cleanly: ${String(error)}`);
        stopped();
      },
    );
  };

  link.onMessage((raw) => {
    const message = parseShellMessage(raw);
    if (message === null) {
      logger.warn(`the ${child} received a message this channel does not know`);
      return;
    }
    switch (message.t) {
      case "init":
        init(message.config);
        return;
      case "stop":
        if (stopping) {
          return;
        }
        stopping = true;
        stop(message.reason);
        return;
      case "peer":
        // The channel end itself went to the link's onPeer listeners.
        return;
      case "call": {
        const { rid, op } = message;
        const reply = (result: OpResult): void => {
          link.post({ v: 1, t: "reply", rid, result });
        };
        if (deps.onCall === undefined) {
          reply({ ok: false, error: `the InnyTypes ${child} does not serve ${op} yet` });
          return;
        }
        deps.onCall(op, message.args).then(reply, (error: unknown) => {
          reply({ ok: false, error: String(error) });
        });
        return;
      }
    }
  });
}

/**
 * A child's notifier: every notice goes to the shell, whose NoticeBoard tells it once and shows
 * it (WI-0018-21). A child cannot show a notification itself, and its own "once" would end with
 * its generation.
 */
export function shellNotifier(link: ShellLink): Notifier {
  return {
    raise: (notice) => {
      link.post({ v: 1, t: "notice", notice });
    },
    clear: (kind, subject) => {
      link.post({ v: 1, t: "notice-clear", kind, subject });
    },
  };
}
