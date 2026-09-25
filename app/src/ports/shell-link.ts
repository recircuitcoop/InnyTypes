// The child's side of the channel (spec 10.2) and the process it runs in. In the app these
// are Electron's `process.parentPort` and `process`; in a test they are fakes.

import type { ChildMessage } from "../domain/channel/messages";

/** The child's end of the channel to the shell. */
export interface ShellLink {
  post(message: ChildMessage): void;
  /** Everything the shell posts, unparsed: the child parses it. */
  onMessage(listener: (raw: unknown) => void): void;
}

/** The process a child runs in. */
export interface ProcessHost {
  readonly pid: number;
  /** The current parent pid; it changes when the parent dies and the child is re-parented. */
  parentPid(): number;
  exit(code: number): void;
}
