// How the shell starts a supervised child and speaks to it (plan 0018 §2.2). In the app this
// is Electron's utilityProcess; in a test it is a fake whose child does whatever the test
// needs, such as exiting at once.

import type { ShellMessage } from "../domain/channel/messages";

/** Everything a child is started with. Nothing is inherited that is not named here. */
export interface ForkSpec {
  /** The bundled entry the child runs. */
  readonly modulePath: string;
  /** The process name the OS and Electron's metrics show. */
  readonly serviceName: string;
  /** The child's whole environment: never the shell's own (arch_pivot P9 surprise 5). */
  readonly env: Readonly<Record<string, string>>;
}

/** One running child, as the supervisor holds it. Signalled only through this live handle. */
export interface ChildHandle {
  /** The OS pid once the child spawned; null before, or if it never did. */
  readonly pid: number | null;
  post(message: ShellMessage): void;
  /** Ask the OS to end the child now. */
  kill(): void;
  /** Everything the child posts, unparsed: the supervisor parses it. */
  onMessage(listener: (raw: unknown) => void): void;
  /** The child is gone, whatever the reason; `code` is its exit code. */
  onExit(listener: (code: number) => void): void;
}

export interface ProcessLauncher {
  fork(spec: ForkSpec): ChildHandle;
}
