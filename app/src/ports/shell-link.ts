// The child's side of the channel (spec 10.2) and the process it runs in. In the app these
// are Electron's `process.parentPort` and `process`; in a test they are fakes.

import type { ChildMessage } from "../domain/channel/messages";
import type { PeerMessage } from "../domain/channel/peer-messages";

/** The child's end of the channel to the shell. */
export interface ShellLink {
  post(message: ChildMessage): void;
  /** Everything the shell posts, unparsed: the child parses it. */
  onMessage(listener: (raw: unknown) => void): void;
  /**
   * A new end of the runtime ↔ services channel (plan 0018 §2.2), each time the shell hands
   * one over. It replaces the one before, which the other side no longer holds.
   */
  onPeer(listener: (peer: PeerLink) => void): void;
}

/** One end of the runtime ↔ services channel. */
export interface PeerLink {
  post(message: PeerMessage): void;
  /** Everything the other side posts, unparsed. */
  onMessage(listener: (raw: unknown) => void): void;
  close(): void;
}

/** The process a child runs in. */
export interface ProcessHost {
  readonly pid: number;
  /** The current parent pid; it changes when the parent dies and the child is re-parented. */
  parentPid(): number;
  exit(code: number): void;
}
