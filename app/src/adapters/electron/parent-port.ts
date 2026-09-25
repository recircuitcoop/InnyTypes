// The child's ports over what a utilityProcess is given: `process.parentPort` for the channel
// and `process` itself for its pid, parent pid and exit. The composition roots pass both in,
// so a test can hand fakes.

import type { ParentPort } from "electron";
import type { ChildMessage } from "../../domain/channel/messages";
import type { ProcessHost, ShellLink } from "../../ports/shell-link";

export function shellLinkOver(port: Pick<ParentPort, "postMessage" | "on">): ShellLink {
  return {
    post(message: ChildMessage): void {
      port.postMessage(message);
    },
    onMessage(listener: (raw: unknown) => void): void {
      port.on("message", (event) => {
        listener(event.data);
      });
    },
  };
}

/** The process a child runs in, read live: the parent pid changes when the parent dies. */
export function processHostOver(proc: Pick<NodeJS.Process, "pid" | "ppid" | "exit">): ProcessHost {
  return {
    pid: proc.pid,
    parentPid: () => proc.ppid,
    exit: (code: number) => {
      proc.exit(code);
    },
  };
}
