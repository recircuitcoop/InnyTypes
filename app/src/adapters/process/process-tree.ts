// "No orphan" (plan 0018 §3, kept from `children.py:544-700`): a node process and everything
// it started end together.
//
// POSIX: the node process is started detached, which makes it the leader of a new session
// and process group whose id is its pid. Killing the negative pid signals the whole group,
// so a grandchild the node started (a `sleep`, a model server) goes with it, on close and on
// crash. The group outlives its leader while any member is alive, so it can still be killed
// after the node itself has exited.
//
// Windows: BLOCKED(WI-0025-01). The equivalent is a Job Object with
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, which needs native code Node does not ship. Until then
// only the node process itself is killed, and a grandchild can outlive it.

/** How a node process is spawned and ended as one tree. */
export interface ProcessTree {
  /** Pass to `spawn` as `detached`. */
  readonly detached: boolean;
  /** End the whole tree now. Safe when it is already gone. */
  kill(pid: number): void;
  /** Why this platform cannot end the whole tree, or null when it can. */
  readonly blocked: string | null;
}

/** `process.kill`, injected so both platforms' trees can be exercised on either. */
export type Signaller = (pid: number, signal: NodeJS.Signals) => void;

const WINDOWS_BLOCKED =
  "BLOCKED(WI-0025-01): Windows Job Objects are not built, so a grandchild of a node " +
  "process can outlive it";

function quietly(action: () => void): void {
  try {
    action();
  } catch {
    // ESRCH: the tree is already gone, which is what was asked for.
  }
}

export function processTreeFor(
  platform: NodeJS.Platform,
  signal: Signaller = (pid, name) => process.kill(pid, name),
): ProcessTree {
  if (platform === "win32") {
    return {
      detached: false,
      blocked: WINDOWS_BLOCKED,
      kill: (pid) => {
        quietly(() => {
          signal(pid, "SIGKILL");
        });
      },
    };
  }
  return {
    detached: true,
    blocked: null,
    kill: (pid) => {
      quietly(() => {
        signal(-pid, "SIGKILL");
      });
    },
  };
}
