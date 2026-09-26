// Which instances of a package's types are running and have sent `ready` (WI-0018-17). The
// shell's package update asks this of the runtime (`package.ready`) after it restarted the
// runtime for a new version: every deployed instance of the package's types must be ready
// within 30 s, or the old version goes back.
//
// The runtime wraps its node-process launcher in this: every process started is kept under its
// instance id until it is closed, so the answer is about the processes of this generation only.

import type { OpResult } from "../domain/channel/messages";
import type { NodeProcess, NodeProcessLauncher } from "../ports/node-process";

/**
 * The nodes of the deployed flows that Node-RED actually runs: not a disabled node (`d: true`)
 * and not a node on a disabled flow tab (`disabled: true`). A disabled node is never
 * constructed, so it never sends `ready`; counting it would roll back every update of its
 * package (WI-0018-17).
 */
export function enabledNodes(flows: readonly unknown[]): { id: string; type: string }[] {
  const records = flows.filter(
    (node): node is Readonly<Record<string, unknown>> =>
      typeof node === "object" && node !== null && !Array.isArray(node),
  );
  const disabledTabs = new Set(
    records
      .filter((node) => node["type"] === "tab" && node["disabled"] === true)
      .map((node) => node["id"]),
  );
  return records.flatMap((node) => {
    const { id, type, z } = node;
    if (typeof id !== "string" || typeof type !== "string") {
      return [];
    }
    return node["d"] === true || disabledTabs.has(z) ? [] : [{ id, type }];
  });
}

interface Tracked {
  readonly package: string;
  readonly process: NodeProcess;
}

/** A node process that says when it has been closed; everything else is the process's own. */
class Closing implements NodeProcess {
  readonly #process: NodeProcess;
  readonly #closed: () => void;

  constructor(process: NodeProcess, closed: () => void) {
    this.#process = process;
    this.#closed = closed;
  }

  get pid(): number | null {
    return this.#process.pid;
  }

  get ready(): boolean {
    return this.#process.ready === true;
  }

  input(...args: Parameters<NodeProcess["input"]>): string | null {
    return this.#process.input(...args);
  }

  cancel(inputId: string): void {
    this.#process.cancel(inputId);
  }

  action(...args: Parameters<NodeProcess["action"]>): boolean {
    return this.#process.action(...args);
  }

  trigger(...args: Parameters<NodeProcess["trigger"]>): boolean {
    return this.#process.trigger(...args);
  }

  fire(data: Readonly<Record<string, unknown>>): void {
    this.#process.fire(data);
  }

  async close(reason: Parameters<NodeProcess["close"]>[0]): Promise<void> {
    try {
      await this.#process.close(reason);
    } finally {
      this.#closed();
    }
  }

  replay(redeliver: Parameters<NodeProcess["replay"]>[0]): number {
    return this.#process.replay(redeliver);
  }

  queue(): ReturnType<NodeProcess["queue"]> {
    return this.#process.queue();
  }
}

export class InstanceReadiness {
  readonly #running = new Map<string, Tracked>();

  /** The launcher, with every process it starts tracked until it is closed. */
  wrap(launcher: NodeProcessLauncher): NodeProcessLauncher {
    return {
      start: (spec, host) => {
        const process = launcher.start(spec, host);
        const id = spec.identity.id;
        const tracked: Tracked = { package: spec.identity.package, process };
        this.#running.set(id, tracked);
        return new Closing(process, () => {
          if (this.#running.get(id) === tracked) {
            this.#running.delete(id);
          }
        });
      },
    };
  }

  /**
   * The `package.ready` call: `{packages}` in, the deployed instances of their types and those
   * whose process sent `ready` out. `deployed` is the flow's own list: an instance Node-RED has
   * not constructed yet is deployed and not ready.
   */
  answer(
    args: unknown,
    deployed: readonly { readonly id: string; readonly package: string | undefined }[],
  ): OpResult {
    const packages =
      typeof args === "object" && args !== null ? (args as { packages?: unknown }).packages : null;
    if (!Array.isArray(packages) || !packages.every((name) => typeof name === "string")) {
      return { ok: false, error: "package.ready takes {packages: [names]}" };
    }
    const wanted = new Set<unknown>(packages);
    const ids = deployed
      .filter((node) => wanted.has(node.package))
      .map((node) => node.id)
      .sort();
    const ready = [...this.#running.entries()]
      .filter(([, tracked]) => wanted.has(tracked.package) && tracked.process.ready === true)
      .map(([id]) => id)
      .sort();
    return { ok: true, value: { deployed: ids, ready } };
  }
}
