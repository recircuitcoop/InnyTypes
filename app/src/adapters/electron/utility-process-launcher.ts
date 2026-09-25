// ProcessLauncher over Electron's utilityProcess (plan 0018 §2.2, arch_pivot P11).
//
// The shell passes `utilityProcess.fork` in, so this file imports only Electron's types and a
// test can hand it a fake. The child gets exactly the environment in its ForkSpec: Electron's
// default is the shell's whole `process.env`, which is how the spike leaked settings into
// every generation (arch_pivot P9 surprise 5).

import type { ForkOptions, UtilityProcess } from "electron";
import type { ShellMessage } from "../../domain/channel/messages";
import type { ChildHandle, ForkSpec, ProcessLauncher } from "../../ports/process-launcher";

export type ForkFunction = (
  modulePath: string,
  args: string[],
  options: ForkOptions,
) => UtilityProcess;

class UtilityProcessHandle implements ChildHandle {
  readonly #process: UtilityProcess;

  constructor(process: UtilityProcess) {
    this.#process = process;
  }

  get pid(): number | null {
    return this.#process.pid ?? null;
  }

  post(message: ShellMessage): void {
    this.#process.postMessage(message);
  }

  kill(): void {
    this.#process.kill();
  }

  onMessage(listener: (raw: unknown) => void): void {
    this.#process.on("message", (message: unknown) => {
      listener(message);
    });
  }

  onExit(listener: (code: number) => void): void {
    this.#process.on("exit", listener);
  }
}

export class UtilityProcessLauncher implements ProcessLauncher {
  readonly #fork: ForkFunction;

  constructor(fork: ForkFunction) {
    this.#fork = fork;
  }

  fork(spec: ForkSpec): ChildHandle {
    const process = this.#fork(spec.modulePath, [], {
      env: { ...spec.env },
      serviceName: spec.serviceName,
      // The child's output goes where the shell's goes, until the one log (WI-0018-04).
      stdio: "inherit",
    });
    return new UtilityProcessHandle(process);
  }
}
