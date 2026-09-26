// The version check and the update of installed packages (helper/versions.py and rollout.py,
// ported and reshaped; plan 0013; plan 0018 §3; WI-0018-17).
//
// Plan 0013 is why this is built the way it is: a version moved, nothing said so, and the
// window showed no "update available". So:
//
// - The check asks where each package came from: its catalogue's entry for a newer version, or
//   its folder (a path install) for a newer version AND for content that changed under the same
//   version (domain/packages/versions.ts). What it finds is on the Packages page, and each
//   newer version is told in one notice, once (the NoticeBoard's rule, application/notices.ts).
// - The mode decides what happens next: `auto` applies, `manual` waits for Apply, `pinned`
//   holds even against a press. A version that failed here is held until a newer one appears.
// - Apply builds the new version in staging and swaps it in (application/package-environment.ts,
//   which keeps the old one), then restarts ONLY the runtime. If every deployed instance of the
//   package's types does not send `ready` within 30 s, the old version is swapped back, the
//   runtime restarted again, the version blocked, and a notice names the package and the reason.
//
// There are no groups any more: the old rollout moved plugins that depended on each other's
// events together. Packages are joined by wires in a flow now, never by one requiring another,
// so each package updates on its own (reason code event-bus-replaced-by-wires).

import { entryFor } from "../domain/packages/catalogue";
import { PackageRefusal } from "../domain/packages/archive";
import type { Declaration } from "../domain/packages/declaration";
import {
  actionFor,
  compareVersions,
  judgeCatalogueVersion,
  judgeFolder,
  modeFor,
  type PackagePolicy,
  type UpdateMode,
  type VersionFinding,
} from "../domain/packages/versions";
import type { BlockedUpdates } from "../ports/blocked-updates";
import type { Clock } from "../ports/clock";
import type { Logger } from "../ports/logger";
import type { Notifier } from "../ports/notifier";
import type { InstalledOrigin, InstalledRecord } from "../ports/package-roots";
import {
  isArchiveFile,
  type ListedPackage,
  type OneAtATime,
  type PackageOutcome,
  type PackagesState,
  type RestartRuntime,
  type UpdateLine,
} from "./install-package";
import { PackageCatalogues, type CatalogueReads } from "./package-catalogues";
import {
  buildPackageEnvironment,
  inspectPackage,
  type PackageEnvironmentPorts,
  type PackageOrigin,
} from "./package-environment";

/** How long every instance of an updated package's types has to send `ready`. */
export const READY_WINDOW_MS = 30_000;
/** How often the runtime is asked, within that window, which instances are ready. */
export const READY_POLL_MS = 500;

/**
 * The instances of some packages' types: deployed (every one the running flows hold) and ready
 * (their node process sent `ready`). Rejects while the runtime cannot answer.
 */
export interface Readiness {
  readonly deployed: readonly string[];
  readonly ready: readonly string[];
}

export interface PackageUpdatesPorts extends CatalogueReads {
  readonly environment: PackageEnvironmentPorts;
  /** The `packages` settings, read at the moment they are needed; throws when unreadable. */
  readonly policy: () => PackagePolicy;
  readonly restartRuntime: RestartRuntime;
  readonly readiness: (packages: readonly string[]) => Promise<Readiness>;
  readonly blocked: BlockedUpdates;
  readonly notifier: Notifier;
  readonly clock: Clock;
  /** Wall-clock time, epoch ms: when the last check ran, as the page says it. */
  readonly now: () => number;
  readonly logger: Logger;
}

/** What the last check found about one package. */
interface Found {
  readonly finding: VersionFinding;
  /** The version the check found installed: a finding about another is stale. */
  readonly installed: string;
}

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class PackageUpdates {
  readonly #ports: PackageUpdatesPorts;
  readonly #one: OneAtATime;
  readonly #catalogues: PackageCatalogues;
  readonly #found = new Map<string, Found>();
  #checkedAt: number | null = null;
  #cancelSchedule: (() => void) | null = null;

  constructor(ports: PackageUpdatesPorts, one: OneAtATime) {
    this.#ports = ports;
    this.#one = one;
    this.#catalogues = new PackageCatalogues(ports);
  }

  // ── the check ────────────────────────────────────────────────────────────────────────────

  /**
   * Check every installed package against where it came from, show what was found, tell each
   * newer version once, and apply those whose mode is `auto`. Asks nothing at all when the
   * settings turn checking off (D14).
   */
  async check(): Promise<PackageOutcome> {
    let policy: PackagePolicy;
    try {
      policy = this.#ports.policy();
    } catch (error) {
      return this.#failed(
        "Not checked",
        `the packages settings cannot be read: ${reasonOf(error)}`,
      );
    }
    if (!policy.autoCheck) {
      return {
        ok: false,
        error:
          "Not checked: checking for updates is off in the settings " +
          "(packages.auto_check_versions), so no catalogue and no folder was asked.",
      };
    }
    const installed = this.#ports.environment.roots.list().map((live) => live.record);
    for (const record of installed) {
      const finding = await this.#checkOne(record);
      this.#found.set(record.package, { finding, installed: record.version });
      this.#tell(record, finding, policy);
    }
    // A package removed since the last check has nothing to say any more.
    const names = new Set(installed.map((record) => record.package));
    for (const name of [...this.#found.keys()].filter((known) => !names.has(known))) {
      this.#found.delete(name);
    }
    this.#checkedAt = this.#ports.now();

    const newer = installed.filter(
      (record) => this.#found.get(record.package)?.finding.kind === "newer",
    );
    this.#ports.logger.info(
      `update check: ${String(installed.length)} installed, ` +
        `${newer.map((record) => record.package).join(", ") || "none"} with a newer version`,
    );
    for (const record of newer) {
      if (this.#actionOf(record, policy) === "apply") {
        await this.apply(record.package, "auto");
      }
    }
    return {
      ok: true,
      message:
        newer.length === 0
          ? "Checked: every installed package is up to date."
          : `Checked: ${newer.map((record) => record.package).join(", ")} ` +
            `${newer.length === 1 ? "has" : "have"} a newer version.`,
    };
  }

  /** Check now after `firstMs`, then every interval the settings name, read each time. */
  schedule(firstMs: number): void {
    const tick = (): void => {
      let interval = 24 * 60 * 60;
      let on = true;
      try {
        const policy = this.#ports.policy();
        interval = policy.checkIntervalSeconds;
        on = policy.autoCheck;
      } catch (error) {
        this.#ports.logger.warn(`update check: the packages settings: ${reasonOf(error)}`);
      }
      const next = (): void => {
        this.#cancelSchedule = this.#ports.clock.after(interval * 1000, tick);
      };
      if (!on) {
        this.#ports.logger.info("update check: off in the settings; nothing is asked");
        next();
        return;
      }
      void this.check().then((outcome) => {
        if (!outcome.ok) {
          this.#ports.logger.warn(`update check: ${outcome.error}`);
        }
        next();
      });
    };
    this.#cancelSchedule = this.#ports.clock.after(firstMs, tick);
  }

  /** Stop the scheduled checks. */
  stop(): void {
    this.#cancelSchedule?.();
    this.#cancelSchedule = null;
  }

  async #checkOne(record: InstalledRecord): Promise<VersionFinding> {
    const origin = record.origin;
    if (origin === undefined) {
      return {
        kind: "unchecked",
        reason:
          "it was installed before InnyTypes recorded where from; install it again to check it",
      };
    }
    if (origin.kind === "catalogue") {
      try {
        const { catalogue } = await this.#catalogues.resolve(origin.source);
        const entry = entryFor(catalogue, origin.id);
        return entry === null
          ? { kind: "unchecked", reason: `the ${origin.source} catalogue no longer lists it` }
          : judgeCatalogueVersion(record.version, entry.version);
      } catch (error) {
        return {
          kind: "unchecked",
          reason: `the ${origin.source} catalogue cannot be read: ${reasonOf(error)}`,
        };
      }
    }
    try {
      const now = await inspectPackage(fileOrigin(origin.path), this.#ports.environment);
      if (now.declaration.package !== record.package) {
        return {
          kind: "unchecked",
          reason: `${origin.path} now declares ${now.declaration.package}, not ${record.package}`,
        };
      }
      return judgeFolder(record, {
        version: now.declaration.version,
        contentHash: now.contentHash,
      });
    } catch (error) {
      return { kind: "unchecked", reason: `${origin.path} cannot be read: ${reasonOf(error)}` };
    }
  }

  /**
   * One notice per condition: a newer version waiting for the person, or content that moved
   * (plan 0013). Only a `manual` package's newer version is news (notification.py rule 4): an
   * `auto` one is applied now, and a pinned or blocked one is shown on the page and held.
   */
  #tell(record: InstalledRecord, finding: VersionFinding, policy: PackagePolicy): void {
    const { notifier } = this.#ports;
    const name = record.package;
    if (finding.kind === "newer") {
      if (this.#actionOf(record, policy) === "ask") {
        notifier.raise({
          kind: "package-update-available",
          subject: name,
          version: finding.version,
        });
      }
      return;
    }
    if (finding.kind === "moved") {
      notifier.raise({
        kind: "package-update-refused",
        subject: name,
        version: finding.version,
        detail: movedDetail(record),
      });
      return;
    }
    if (finding.kind === "current") {
      notifier.clear("package-update-available", name);
      notifier.clear("package-update-refused", name);
    }
  }

  // ── apply ────────────────────────────────────────────────────────────────────────────────

  /**
   * Apply the newer version the last check found for `name`: `person` when Apply was pressed,
   * `auto` when the check applies it by itself. A pinned package is never updated.
   */
  apply(name: string, by: "person" | "auto"): Promise<PackageOutcome> {
    return this.#one.run(`The update of ${name}`, async () => {
      let record: InstalledRecord | undefined;
      let policy: PackagePolicy;
      try {
        record = this.#ports.environment.roots.installed(name);
        policy = this.#ports.policy();
      } catch (error) {
        return this.#failed("Not updated", reasonOf(error));
      }
      if (record?.origin === undefined) {
        return this.#failed(
          "Not updated",
          `${name} is not installed from anywhere it can be updated from`,
        );
      }
      const found = this.#found.get(name);
      if (found?.installed !== record.version || found.finding.kind !== "newer") {
        return this.#failed(
          "Not updated",
          found?.finding.kind === "moved"
            ? movedDetail(record)
            : `no newer version of ${name} is known; check for updates first`,
        );
      }
      const version = found.finding.version;
      const action = this.#actionOf(record, policy);
      if (action === "hold") {
        const blocked = this.#blockedReason(name, version);
        return this.#failed(
          "Not updated",
          blocked === null
            ? `${name} is pinned at ${record.version}; its mode must change before it is updated`
            : `${name} ${version} failed here before (${blocked}), and is held back`,
        );
      }
      if (by === "auto" && action !== "apply") {
        return this.#failed("Not updated", `${name} is updated only when you press Apply`);
      }
      return this.#update(record, record.origin, version);
    });
  }

  async #update(
    record: InstalledRecord,
    from: InstalledOrigin,
    version: string,
  ): Promise<PackageOutcome> {
    const { environment, logger } = this.#ports;
    const name = record.package;
    let origin: PackageOrigin;
    try {
      origin = await this.#fetch(name, from, version);
    } catch (error) {
      return this.#failed("Not updated", reasonOf(error));
    }
    const admit = (declaration: Declaration): void => {
      if (declaration.package !== name) {
        throw new PackageRefusal("declaration", `it declares ${declaration.package}, not ${name}`);
      }
      if ((compareVersions(declaration.version, record.version) ?? 0) <= 0) {
        throw new PackageRefusal(
          "declaration",
          `it declares version ${declaration.version}, which is not newer than ${record.version}`,
        );
      }
    };
    try {
      // Built in staging and swapped in; the old version is kept to be swapped back.
      await buildPackageEnvironment(origin, environment, admit, from);
    } catch (error) {
      // Nothing was stopped, and the old version still runs.
      return this.#failed("Not updated", reasonOf(error));
    }
    const built = environment.roots.installed(name)?.version ?? version;
    const took = await this.#ports.restartRuntime(`${name} was updated to ${built}`);
    const problem =
      took === null
        ? "the runtime did not come back running, so its instances could not be confirmed"
        : await this.#waitForReady(name);
    if (problem === null) {
      logger.info(
        `update: ${name} ${record.version} → ${built} is live; only the runtime restarted, in ` +
          `${String(took)} ms`,
      );
      this.#found.set(name, { finding: { kind: "current" }, installed: built });
      this.#ports.notifier.clear("package-update-available", name);
      this.#ports.notifier.clear("package-update-refused", name);
      return { ok: true, message: `${name} is updated from ${record.version} to ${built}.` };
    }
    return this.#rollBack(record, built, problem, took !== null);
  }

  /** Where the new version is read from: the downloaded archive, or the file it came from. */
  async #fetch(name: string, from: InstalledOrigin, version: string): Promise<PackageOrigin> {
    if (from.kind === "file") {
      return fileOrigin(from.path);
    }
    const { catalogue, key } = await this.#catalogues.resolve(from.source);
    const entry = entryFor(catalogue, from.id);
    if (entry === null) {
      throw new Error(`the ${from.source} catalogue no longer lists ${from.id}`);
    }
    if (entry.version !== version) {
      throw new Error(
        `the ${from.source} catalogue now offers ${entry.version ?? "no version"}, not ${version}; ` +
          "check for updates again",
      );
    }
    return { kind: "archive", path: await this.#catalogues.download(name, entry), publicKey: key };
  }

  /**
   * Null once every deployed instance of `name`'s types sent `ready`; otherwise, at the end of
   * the window, why not.
   */
  #waitForReady(name: string): Promise<string | null> {
    const { clock, readiness } = this.#ports;
    const deadline = clock.now() + READY_WINDOW_MS;
    let last = "the runtime did not say which of its instances are ready";
    return new Promise((resolve) => {
      const poll = (): void => {
        readiness([name]).then(
          ({ deployed, ready }) => {
            const waiting = deployed.filter((id) => !ready.includes(id));
            if (waiting.length === 0) {
              resolve(null);
              return;
            }
            last =
              `${waiting.length === 1 ? "instance" : "instances"} ${waiting.join(", ")} of its ` +
              `types sent no ready within ${String(READY_WINDOW_MS / 1000)} s`;
            again();
          },
          (error: unknown) => {
            last = `the runtime could not say which instances are ready: ${reasonOf(error)}`;
            again();
          },
        );
      };
      const again = (): void => {
        if (clock.now() >= deadline) {
          resolve(last);
          return;
        }
        clock.after(Math.min(READY_POLL_MS, deadline - clock.now()), poll);
      };
      poll();
    });
  }

  /** Swap the old version back, restart again, block the version, and say so. */
  async #rollBack(
    record: InstalledRecord,
    failed: string,
    problem: string,
    block: boolean,
  ): Promise<PackageOutcome> {
    const { environment, logger, notifier } = this.#ports;
    const name = record.package;
    try {
      environment.roots.rollBack(name);
    } catch (error) {
      logger.error(
        `update: ${name} ${failed} failed (${problem}) and could not be swapped back: ${reasonOf(error)}`,
      );
      return this.#failed(
        "Not updated",
        `${name} ${failed} failed (${problem}), and ${record.version} could not be put back: ` +
          reasonOf(error),
      );
    }
    await this.#ports.restartRuntime(`${name} ${failed} was rolled back to ${record.version}`);
    const reason = `it was rolled back to ${record.version}: ${problem}`;
    if (block) {
      try {
        this.#ports.blocked.block(name, failed, problem);
      } catch (error) {
        logger.error(
          `update: ${name} ${failed} could not be recorded as blocked: ${reasonOf(error)}`,
        );
      }
    }
    this.#found.set(name, {
      finding: { kind: "newer", version: failed },
      installed: record.version,
    });
    logger.warn(`update: ${name} ${failed} ${reason}`);
    notifier.clear("package-update-available", name);
    notifier.raise({
      kind: "package-update-refused",
      subject: name,
      version: failed,
      detail: reason,
    });
    return { ok: false, error: `Not updated: ${name} ${failed} ${reason}.` };
  }

  // ── the page ─────────────────────────────────────────────────────────────────────────────

  /** The Packages page's state with each installed package's mode and update line filled in. */
  decorate(state: PackagesState): PackagesState {
    let policy: PackagePolicy | null = null;
    try {
      policy = this.#ports.policy();
    } catch (error) {
      this.#ports.logger.warn(`the packages settings cannot be read: ${reasonOf(error)}`);
    }
    const records = new Map(
      this.#ports.environment.roots.list().map((live) => [live.record.package, live.record]),
    );
    return {
      ...state,
      checkedAt: this.#checkedAt,
      packages: state.packages.map((listed): ListedPackage => {
        const record = records.get(listed.name);
        if (listed.kind !== "installed" || record === undefined || policy === null) {
          return listed;
        }
        const mode = this.#modeOf(record, policy);
        return { ...listed, mode, update: this.#lineFor(record, mode) };
      }),
    };
  }

  #lineFor(record: InstalledRecord, mode: UpdateMode): UpdateLine | null {
    const found = this.#found.get(record.package);
    if (found?.installed !== record.version) {
      return null;
    }
    const { finding } = found;
    switch (finding.kind) {
      case "current":
        return null;
      case "unchecked":
        return { kind: "unchecked", version: null, detail: finding.reason, apply: false };
      case "moved":
        return {
          kind: "moved",
          version: finding.version,
          detail: movedDetail(record),
          apply: false,
        };
      case "newer": {
        const blocked = this.#blockedReason(record.package, finding.version);
        if (blocked !== null) {
          return { kind: "failed", version: finding.version, detail: blocked, apply: false };
        }
        return {
          kind: "newer",
          version: finding.version,
          detail: mode === "pinned" ? `${record.package} is pinned at ${record.version}` : null,
          // One rule for "waiting for the person": manual only. An auto one is the machine's to
          // apply at its next check, and a pinned one nobody's (window.py pending_update_row).
          apply: mode === "manual",
        };
      }
    }
  }

  #modeOf(record: InstalledRecord, policy: PackagePolicy): UpdateMode {
    let sources: Parameters<typeof modeFor>[1] = [];
    try {
      sources = this.#ports.sources();
    } catch {
      // The sources cannot be read: no source level, the package's own mode or the default.
    }
    const source = record.origin?.kind === "catalogue" ? record.origin.source : null;
    return modeFor(policy, sources, record.package, source).mode;
  }

  #actionOf(record: InstalledRecord, policy: PackagePolicy): ReturnType<typeof actionFor> {
    const found = this.#found.get(record.package);
    const version = found?.finding.kind === "newer" ? found.finding.version : null;
    const blocked = version !== null && this.#blockedReason(record.package, version) !== null;
    return actionFor(this.#modeOf(record, policy), blocked);
  }

  /** Why `name` at `version` is blocked; a record that cannot be read blocks, and says so. */
  #blockedReason(name: string, version: string): string | null {
    try {
      return this.#ports.blocked.reason(name, version);
    } catch (error) {
      return `the record of failed updates cannot be read (${reasonOf(error)})`;
    }
  }

  #failed(what: string, why: string): PackageOutcome {
    this.#ports.logger.warn(`update: ${what.toLowerCase()}: ${why}`);
    return { ok: false, error: `${what}: ${why}.` };
  }
}

/** A path install's folder or `.tgz`, read as it was installed: unsigned. */
function fileOrigin(path: string): PackageOrigin {
  return isArchiveFile(path)
    ? { kind: "archive", path, publicKey: null }
    : { kind: "path", folder: path };
}

function movedDetail(record: InstalledRecord): string {
  const where = record.origin?.kind === "file" ? record.origin.path : "its source";
  return (
    `the content at ${where} changed and its version did not; the same version cannot hold ` +
    "other content, so it is not applied until its publisher gives it a new version"
  );
}
