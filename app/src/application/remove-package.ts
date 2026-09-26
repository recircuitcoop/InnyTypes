// Removing an installed node package (addons/removal.py, ported; plan 0018 §3; WI-0018-16).
//
// Refused while any flow uses one of its types: a deployed flow (Node-RED's saved flows), and
// an undeployed one (what the editor holds now, spike P9e plus the P11b gap). Removing it from
// under a deployed flow would stop every flow (spec 11.3); from under an undeployed one, it
// would leave the person's next deploy refused for a type they were never told was going.
//
// Otherwise it takes everything: the live folder with the environment and the record, what the
// last swap kept, and the generated Node-RED modules; then only the runtime restarts, which
// stops its types. The content hash recorded for its version is kept on purpose: a reinstall
// of the same version must still be the same content (plan 0013).

import type { Logger } from "../ports/logger";
import type { InstalledRecord, PackageRoots } from "../ports/package-roots";
import type { OneAtATime, PackageOutcome, RestartRuntime } from "./install-package";

/** The types the flows name now; `undeployed` is null when no editor is open to ask. */
export interface TypesInUse {
  readonly deployed: readonly string[];
  readonly undeployed: readonly string[] | null;
}

export interface PackageRemoverPorts {
  readonly roots: PackageRoots;
  /** The types the deployed flows and the open editor name; rejects when it cannot tell. */
  readonly typesInUse: () => Promise<TypesInUse>;
  /** Delete the Node-RED modules generated for the package's types. */
  readonly forgetGenerated: (name: string) => void;
  /** The names of the packages shipped with the app, which are never removed. */
  readonly shipped: () => readonly string[];
  readonly restartRuntime: RestartRuntime;
  readonly logger: Logger;
}

/** The types of `types` that belong to package `name` (`inny-<name>-<id>`, spec 2.1). */
export function typesOf(name: string, types: readonly string[]): string[] {
  // A package name holds no hyphen, so the prefix cannot match another package's types.
  return [...new Set(types.filter((type) => type.startsWith(`inny-${name}-`)))].sort();
}

export class PackageRemover {
  readonly #ports: PackageRemoverPorts;
  readonly #one: OneAtATime;

  constructor(ports: PackageRemoverPorts, one: OneAtATime) {
    this.#ports = ports;
    this.#one = one;
  }

  remove(name: string): Promise<PackageOutcome> {
    return this.#one.run(`The removal of ${name}`, async () => {
      const { roots, logger } = this.#ports;
      if (this.#ports.shipped().includes(name)) {
        return this.#refused(name, `${name} is shipped with InnyTypes and cannot be removed`);
      }
      let record: InstalledRecord | undefined;
      try {
        record = roots.installed(name);
      } catch (error) {
        // Nothing is removed blind: a record that cannot be read says nothing about the rest.
        return this.#refused(
          name,
          `its record cannot be read (${(error as Error).message}), so nothing is removed`,
        );
      }
      if (record === undefined) {
        return this.#refused(name, `${name} is not installed`);
      }
      let usage: TypesInUse;
      try {
        usage = await this.#ports.typesInUse();
      } catch (error) {
        return this.#refused(
          name,
          `it cannot be told whether a flow uses it: ${(error as Error).message}`,
        );
      }
      const deployed = typesOf(name, usage.deployed);
      const undeployed = typesOf(name, usage.undeployed ?? []);
      if (deployed.length > 0 || undeployed.length > 0) {
        const where = [
          ...(deployed.length > 0 ? [`the deployed flows use ${deployed.join(", ")}`] : []),
          ...(undeployed.length > 0
            ? [`the editor's undeployed flows use ${undeployed.join(", ")}`]
            : []),
        ];
        return this.#refused(
          name,
          `${where.join(", and ")}; delete those nodes (and deploy) before removing it`,
        );
      }

      roots.remove(name);
      this.#ports.forgetGenerated(name);
      const took = await this.#ports.restartRuntime(`${name} was removed`);
      logger.info(
        `remove: ${name} ${record.version} is gone, with its environment, record and generated ` +
          "modules; " +
          (took === null
            ? "the runtime was not running"
            : `only the runtime restarted, in ${String(took)} ms`),
      );
      return { ok: true, message: `${name} ${record.version} is removed.` };
    });
  }

  #refused(name: string, why: string): PackageOutcome {
    this.#ports.logger.warn(`remove: ${name} was refused: ${why}`);
    return { ok: false, error: `Not removed: ${why}.` };
  }
}
