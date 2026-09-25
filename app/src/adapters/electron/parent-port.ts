// The child's ports over what a utilityProcess is given: `process.parentPort` for the channel
// and `process` itself for its pid, parent pid and exit. The composition roots pass both in,
// so a test can hand fakes.

import type { MessagePortMain, ParentPort } from "electron";
import type { ChildMessage } from "../../domain/channel/messages";
import type { PeerMessage } from "../../domain/channel/peer-messages";
import type { PeerLink, ProcessHost, ShellLink } from "../../ports/shell-link";

/**
 * The shell link. A message that carries a channel end is the runtime ↔ services link (§2.2):
 * the end goes to the `onPeer` listeners, and the message itself to nobody else.
 */
export function shellLinkOver(port: Pick<ParentPort, "postMessage" | "on">): ShellLink {
  const peerListeners: ((peer: PeerLink) => void)[] = [];
  const messageListeners: ((raw: unknown) => void)[] = [];
  port.on("message", (event) => {
    const [end] = event.ports;
    if (end !== undefined) {
      const peer = peerLinkOver(end);
      for (const listener of peerListeners) {
        listener(peer);
      }
      return;
    }
    for (const listener of messageListeners) {
      listener(event.data);
    }
  });
  return {
    post(message: ChildMessage): void {
      port.postMessage(message);
    },
    onMessage(listener: (raw: unknown) => void): void {
      messageListeners.push(listener);
    },
    onPeer(listener: (peer: PeerLink) => void): void {
      peerListeners.push(listener);
    },
  };
}

/** One end of the runtime ↔ services channel, started so its messages flow. */
export function peerLinkOver(
  end: Pick<MessagePortMain, "postMessage" | "on" | "start" | "close">,
): PeerLink {
  const listeners: ((raw: unknown) => void)[] = [];
  end.on("message", (event) => {
    for (const listener of listeners) {
      listener(event.data);
    }
  });
  end.start();
  return {
    post(message: PeerMessage): void {
      end.postMessage(message);
    },
    onMessage(listener: (raw: unknown) => void): void {
      listeners.push(listener);
    },
    close(): void {
      end.close();
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
