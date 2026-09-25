// ProcessLauncher over Electron's utilityProcess (plan 0018 §2.2, arch_pivot P11).
//
// The shell passes `utilityProcess.fork` in, so this file imports only Electron's types and a
// test can hand it a fake. The child gets exactly the environment in its ForkSpec: Electron's
// default is the shell's whole `process.env`, which is how the spike leaked settings into
// every generation (arch_pivot P9 surprise 5).

//
// The child's stdout and stderr are pipes the shell reads to their end, line by line, into the
// one log (WI-0018-04): stdout carries the child's log records, stderr whatever it printed.
// A pipe outlives its writer, so what a child wrote just before a kill -9 is still read.

import type { ForkOptions, UtilityProcess } from "electron";
import type { ShellMessage } from "../../domain/channel/messages";
import { forEachLine, type Line } from "../../domain/logging/lines";
import type { ChildHandle, ForkSpec, ProcessLauncher } from "../../ports/process-launcher";

export type ForkFunction = (
  modulePath: string,
  args: string[],
  options: ForkOptions,
) => UtilityProcess;

/** One line a child printed, with the spec it was forked from and its pid if known. */
export type ChildOutput = (
  spec: ForkSpec,
  pid: number | null,
  stream: "stdout" | "stderr",
  line: Line,
) => void;

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
  readonly #output: ChildOutput;

  constructor(fork: ForkFunction, output: ChildOutput) {
    this.#fork = fork;
    this.#output = output;
  }

  fork(spec: ForkSpec): ChildHandle {
    const process = this.#fork(spec.modulePath, [], {
      env: { ...spec.env },
      serviceName: spec.serviceName,
      stdio: "pipe",
    });
    for (const stream of ["stdout", "stderr"] as const) {
      const pipe = process[stream];
      if (pipe === null) {
        continue;
      }
      pipe.setEncoding("utf8");
      forEachLine(pipe, (line) => {
        this.#output(spec, process.pid ?? null, stream, line);
      });
    }
    return new UtilityProcessHandle(process);
  }
}
