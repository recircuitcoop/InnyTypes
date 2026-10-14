// Configuration › General's Packages (plan 0022 §F; owner decisions D5 and D6; plan 0013): every
// package as its row knows it, each facet a state InnyTypes verified and when, and the row's
// actions. It reuses what already does the work: the installer, the remover, the update check
// and its Apply (application/install-package.ts, remove-package.ts, update-package.ts), and the
// one-at-a-time rule they share. What it adds is the person's side of §F:
//
// - Register / unregister (D6): `packages.unregistered` in the settings; the runtime leaves an
//   unregistered package's types out (application/load-node-types.ts), its files stay, and only
//   the runtime restarts. Refused while a flow uses it: the caller names every flow and step.
// - Verified states: registered is read from the running runtime's types; installed is the live
//   copy's content hash (a shipped package's folder's too) re-checked at start and on demand
//   against the one recorded; update is when its source was last asked, at start and on demand,
//   or the update's own time. An install's phases are pushed as they happen, with a percentage.
// - From a folder (plan 0013): "Check for changes" re-hashes the folder and judges it against
//   what was installed, at start and on demand. Content that changed under the same version is
//   shown as changed and never applied.
// - Go back (D5): what an update replaced is kept seven days from its `installedAt`, and pruned
//   at start after that. A record from before `installedAt` existed (0.2.x) is stamped at its
//   first start instead, so nothing kept is lost to it. Go back swaps the kept one back, restarts
//   the runtime, waits for its instances as an update does, and never blocks the version it
//   left: that one is written into the record put back, and offered again.
//
// Nothing here words anything: the outcomes are values the shell turns into refusal keys.

import { OFFICIAL_SOURCE_NAME } from "../domain/packages/catalogue";
import {
  register as judgeRegister,
  remove as judgeRemove,
  unregister as judgeUnregister,
  ROLLBACK_WINDOW_MS,
  type Installation,
  type Package,
  type PackageUpdate,
  type Refusal,
  type StepUse,
} from "../domain/packages/states";
import { unregisteredOf, withRegistration } from "../domain/packages/versions";
import type { Logger } from "../ports/logger";
import type { InstalledRecord, LivePackage, PackageRoots } from "../ports/package-roots";
import type { PackageSettingsStore } from "../ports/settings-store";
import type {
  ListedPackage,
  OneAtATime,
  PackageInstaller,
  PackageOutcome,
  RestartRuntime,
} from "./install-package";
import {
  inspectPackage,
  PHASE_PERCENT,
  type InstallPhase,
  type PackageEnvironmentPorts,
} from "./package-environment";
import {
  checkFacet,
  contentCheck,
  findingFacet,
  goBackOffer,
  leftFacet,
  registrationOf,
} from "./package-facets";
import type { PackageRemover } from "./remove-package";
import type { PackageUpdates } from "./update-package";

/** Who publishes what InnyTypes ships, and its official catalogue's packages. */
export const OWN_PUBLISHER = "InnyTypes";

export interface PackageBoardPorts {
  readonly roots: PackageRoots;
  readonly environment: Pick<
    PackageEnvironmentPorts,
    "source" | "verifier" | "validator" | "sha256" | "contentHashes"
  >;
  /** The packages shipped with the app, and the folder each is read from. */
  readonly shipped: () => readonly {
    readonly name: string;
    readonly version: string;
    readonly folder: string;
  }[];
  readonly installer: Pick<PackageInstaller, "state" | "installFromSource" | "installFromFile">;
  readonly updates: Pick<PackageUpdates, "decorate" | "checkOne" | "apply" | "waitForReady">;
  readonly remover: Pick<PackageRemover, "remove">;
  readonly settings: Pick<PackageSettingsStore, "readPackages" | "writePackages">;
  /** The node types the running runtime generated; null while it is not running to ask. */
  readonly loadedTypes: () => Promise<readonly string[] | null>;
  readonly restartRuntime: RestartRuntime;
  readonly one: OneAtATime;
  /** Told each phase of an install as it starts (the `packages` push). */
  readonly onProgress: (progress: InstallProgress) => void;
  /** Wall-clock time, epoch ms. */
  readonly now: () => number;
  readonly logger: Logger;
}

/** An install's phase as it starts: `name` is null until its declaration has been read. */
export interface InstallProgress {
  readonly name: string | null;
  readonly phase: InstallPhase;
  readonly percent: number;
  readonly verifiedAt: Date;
}

/** One row: the package, and who publishes it (null for a folder nobody vouches for). */
export interface BoardRow {
  readonly package: Package;
  readonly publisher: string | null;
}

/** A catalogue entry "Add a package… › From the catalogue" offers. */
export interface BoardOffer {
  readonly source: string;
  readonly id: string;
  readonly name: string;
  readonly version: string | null;
  readonly summary: string;
}

export interface Board {
  readonly rows: readonly BoardRow[];
  readonly offers: readonly BoardOffer[];
}

/** What an action came to: done, refused by the domain's rules, or failed on the way. */
export type BoardOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly refusal: Refusal }
  | {
      readonly ok: false;
      readonly failed: "install" | "remove" | "update" | "go-back";
      /** go-back: the version it went back to. */
      readonly version?: string;
    };

const DONE: BoardOutcome = { ok: true };
const refused = (refusal: Refusal): BoardOutcome => ({ ok: false, refusal });

/** A verified fact, with what it was verified against: a newer install makes it stale. */
interface Checked<T> {
  readonly key: string;
  readonly value: T;
}

/** What a record's facts are judged against: its version, content and swap. */
const keyOf = (record: InstalledRecord): string =>
  `${record.version}:${record.contentHash}:${String(record.installedAt)}`;

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class PackageBoard {
  readonly #ports: PackageBoardPorts;
  /** Each package's re-checked content, by name: live copies and shipped folders alike. */
  readonly #installed = new Map<string, Checked<Installation>>();
  /** What asking each installed package's source last found, and when. */
  readonly #asked = new Map<string, Checked<PackageUpdate | null>>();
  /** The install under way, by name once it is known, at its latest phase. */
  readonly #installing = new Map<string, InstallProgress>();
  #started: Promise<void> = Promise.resolve();

  constructor(ports: PackageBoardPorts) {
    this.#ports = ports;
  }

  /**
   * At start: stamp a record from before `installedAt`, prune what a swap kept past its seven
   * days, re-check every shipped and live package's content, and ask every installed package's
   * source. The board waits for it before it answers.
   */
  start(): Promise<void> {
    this.#started = this.#start().catch((error: unknown) => {
      this.#ports.logger.warn(`packages: the start's checks did not finish: ${reasonOf(error)}`);
    });
    return this.#started;
  }

  async #start(): Promise<void> {
    const { roots, logger } = this.#ports;
    const now = this.#ports.now();
    for (const shipped of this.#ports.shipped()) {
      await this.#shippedCheck(shipped);
    }
    for (const { record } of roots.list()) {
      const name = record.package;
      if (roots.kept(name) === undefined) {
        continue;
      }
      if (record.installedAt === undefined) {
        // A 0.2.x record: its kept copy gets its seven days from this first start.
        roots.amend(name, { installedAt: now });
        logger.info(
          `packages: ${name}'s record had no install time; it is kept seven days from now`,
        );
      } else if (now >= record.installedAt + ROLLBACK_WINDOW_MS) {
        roots.discardKept(name);
        logger.info(`packages: what ${name}'s last update replaced is past its seven days: pruned`);
      }
    }
    for (const live of roots.list()) {
      await this.#installation(live);
      await this.#ask(live.record);
    }
  }

  /** An install's phase: kept for its row, and pushed to the page (plan 0022 §F). */
  progress(phase: InstallPhase, name: string | null): void {
    const progress = {
      name,
      phase,
      percent: PHASE_PERCENT[phase],
      verifiedAt: new Date(this.#ports.now()),
    };
    if (name !== null) {
      this.#installing.set(name, progress);
    }
    this.#ports.onProgress(progress);
  }

  /** Every package's row, and what the catalogues offer to install. */
  async board(): Promise<Board> {
    await this.#started;
    const { roots, updates, installer } = this.#ports;
    const now = new Date(this.#ports.now());
    const types = await this.#loadedTypes();
    const state = updates.decorate(await installer.state());
    const listed = new Map(state.packages.map((entry) => [entry.name, entry]));
    const rows: BoardRow[] = this.#ports.shipped().map(({ name, version }) => ({
      package: {
        name,
        version,
        source: { kind: "catalogue" },
        signed: true,
        shipped: true,
        registration: registrationOf(name, types, now),
        installation: this.#installed.get(name)?.value ?? null,
        update: null,
      },
      publisher: OWN_PUBLISHER,
    }));
    const live = roots.list();
    for (const { record, folder } of live) {
      const origin = record.origin;
      rows.push({
        package: {
          name: record.package,
          version: record.version,
          source:
            origin?.kind === "file" ? { kind: "folder", path: origin.path } : { kind: "catalogue" },
          signed: record.signed,
          shipped: false,
          registration: registrationOf(record.package, types, now),
          installation: await this.#installation({ record, folder }),
          update: this.#update(record, listed.get(record.package), state.checkedAt, now),
        },
        publisher:
          origin?.kind !== "catalogue"
            ? null
            : origin.source === OFFICIAL_SOURCE_NAME
              ? OWN_PUBLISHER
              : origin.source,
      });
    }
    // A package being installed has its row from its first phase with a name.
    for (const progress of this.#installing.values()) {
      if (progress.name === null || rows.some((row) => row.package.name === progress.name)) {
        continue;
      }
      rows.push({
        package: {
          name: progress.name,
          version: "",
          source: { kind: "catalogue" },
          signed: false,
          shipped: false,
          registration: null,
          installation: {
            state: "installing",
            progress: progress.percent,
            verifiedAt: progress.verifiedAt,
          },
          update: null,
        },
        publisher: null,
      });
    }
    const offers = [...state.catalogue, ...state.sources.flatMap((source) => source.offers)]
      .filter((offer) => offer.installable && offer.verified && !offer.installed)
      .filter((offer) => offer.shadowedBy === null)
      .map(({ source, id, name, version, summary }) => ({ source, id, name, version, summary }));
    return { rows, offers };
  }

  // ── register / unregister (D6) ─────────────────────────────────────────────────────────

  register(name: string): Promise<BoardOutcome> {
    return this.#registration(name, true, []);
  }

  /** `uses`: every flow and step, deployed or not, that uses the package (D6). */
  unregister(name: string, uses: readonly StepUse[]): Promise<BoardOutcome> {
    return this.#registration(name, false, uses);
  }

  async #registration(name: string, on: boolean, uses: readonly StepUse[]): Promise<BoardOutcome> {
    const pkg = await this.#row(name);
    if (pkg === null) {
      return refused({ reason: "not-installed" });
    }
    const now = new Date(this.#ports.now());
    const judged = on ? judgeRegister(pkg, now) : judgeUnregister(pkg, uses, now);
    if (judged.kind === "refused") {
      return refused(judged.refusal);
    }
    const { restartRuntime, logger } = this.#ports;
    const what = on ? "registered" : "unregistered";
    return this.#oneAtATime(`${name} being ${what}`, async () => {
      this.#setRegistered(name, on);
      const took = await restartRuntime(`${name} was ${what}`);
      logger.info(
        `packages: ${name} is ${what}; ` +
          (took === null
            ? "the runtime was not running"
            : `only the runtime restarted, in ${String(took)} ms`),
      );
      return DONE;
    });
  }

  #setRegistered(name: string, on: boolean): void {
    const { settings } = this.#ports;
    settings.writePackages(withRegistration(settings.readPackages(), name, on));
  }

  // ── install, remove, update ───────────────────────────────────────────────────────────────

  /** Install a catalogue entry from its signed archive; then ask its catalogue, once. */
  install(source: string, id: string): Promise<BoardOutcome> {
    return this.#installThen(() => this.#ports.installer.installFromSource(source, id, false));
  }

  /** Install a folder (or `.tgz`) the person chose and confirmed unsigned; then ask it, once. */
  installFolder(folder: string): Promise<BoardOutcome> {
    return this.#installThen(() => this.#ports.installer.installFromFile(folder, true));
  }

  async #installThen(work: () => Promise<PackageOutcome>): Promise<BoardOutcome> {
    const before = new Set(this.#ports.roots.list().map((live) => live.record.package));
    let outcome: PackageOutcome;
    try {
      outcome = await work();
    } finally {
      this.#installing.clear();
    }
    if (!outcome.ok) {
      return this.#ports.one.busy()
        ? refused({ reason: "busy" })
        : { ok: false, failed: "install" };
    }
    for (const { record } of this.#ports.roots.list()) {
      if (!before.has(record.package)) {
        await this.#ask(record);
      }
    }
    return DONE;
  }

  /** Remove a package: refused for a shipped one, and while a flow uses it, naming each use. */
  async remove(name: string, uses: readonly StepUse[]): Promise<BoardOutcome> {
    const pkg = await this.#row(name);
    if (pkg === null) {
      return refused({ reason: "not-installed" });
    }
    const judged = judgeRemove(pkg, uses, new Date(this.#ports.now()));
    if (judged.kind === "refused") {
      return refused(judged.refusal);
    }
    // The remover asks the open editor's undeployed nodes too, and keeps the hashes (plan 0013).
    const outcome = await this.#ports.remover.remove(name);
    if (!outcome.ok) {
      return { ok: false, failed: "remove" };
    }
    // Gone, so not "unregistered" either: a later install of the name is registered.
    if (unregisteredOf(this.#ports.settings.readPackages()).includes(name)) {
      this.#setRegistered(name, true);
    }
    return DONE;
  }

  /** Update to the newer version the package's source holds now: asked again, then applied. */
  async update(name: string): Promise<BoardOutcome> {
    if (this.#ports.one.busy()) {
      return refused({ reason: "busy" });
    }
    const record = this.#ports.roots.installed(name);
    if (record === undefined) {
      return refused({ reason: "not-installed" });
    }
    await this.#ask(record);
    const outcome = await this.#ports.updates.apply(name, "person");
    if (!outcome.ok) {
      return this.#ports.one.busy() ? refused({ reason: "busy" }) : { ok: false, failed: "update" };
    }
    return DONE;
  }

  // ── check for changes (plan 0013) ─────────────────────────────────────────────────────────

  /** Re-check the live copy and ask the folder again, now. */
  async checkFolder(name: string): Promise<BoardOutcome> {
    if (this.#ports.one.busy()) {
      return refused({ reason: "busy" });
    }
    const live = this.#ports.roots.list().find((found) => found.record.package === name);
    if (live === undefined) {
      return refused({ reason: "not-installed" });
    }
    if (live.record.origin?.kind !== "file") {
      return refused({ reason: "nothing-to-do" });
    }
    this.#installed.delete(name);
    await this.#installation(live);
    await this.#ask(live.record);
    return DONE;
  }

  // ── go back (D5) ────────────────────────────────────────────────────────────────────────

  async goBack(name: string): Promise<BoardOutcome> {
    const { roots, updates, restartRuntime, logger } = this.#ports;
    if (this.#ports.one.busy()) {
      return refused({ reason: "busy" });
    }
    const record = roots.installed(name);
    if (record === undefined) {
      return refused({ reason: "not-installed" });
    }
    const offer = goBackOffer(record, roots.kept(name), new Date(this.#ports.now()));
    if (offer === null) {
      return refused({ reason: "rollback-expired" });
    }
    return this.#oneAtATime(`${name} going back`, async () => {
      roots.rollBack(name);
      // The version it left is offered again, and never blocked; it outlives a restart.
      roots.amend(name, { left: { version: offer.version, at: this.#ports.now() } });
      const took = await restartRuntime(`${name} went back to ${offer.previous}`);
      const problem =
        took === null
          ? "the runtime did not come back running, so its instances could not be confirmed"
          : await updates.waitForReady(name);
      if (problem !== null) {
        logger.warn(`packages: ${name} went back to ${offer.previous}, but ${problem}`);
        return { ok: false, failed: "go-back", version: offer.previous };
      }
      logger.info(`packages: ${name} went back from ${offer.version} to ${offer.previous}`);
      return DONE;
    });
  }

  // ── the facts ─────────────────────────────────────────────────────────────────────────────

  /** One package's row: what a judgement needs. */
  async #row(name: string): Promise<Package | null> {
    return (await this.board()).rows.find((row) => row.package.name === name)?.package ?? null;
  }

  async #loadedTypes(): Promise<readonly string[] | null> {
    try {
      return await this.#ports.loadedTypes();
    } catch {
      // Not running, or restarting: registration is not verified, and the row says nothing.
      return null;
    }
  }

  /**
   * A shipped package's folder against the hash recorded for its version: the first start of
   * a version records it, every later one checks it.
   */
  async #shippedCheck(shipped: { name: string; version: string; folder: string }): Promise<void> {
    const { contentHashes } = this.#ports.environment;
    const { name, version, folder } = shipped;
    const at = new Date(this.#ports.now());
    let recorded = contentHashes.recorded(name, version);
    if (recorded === undefined) {
      try {
        recorded = (await inspectPackage({ kind: "path", folder }, this.#ports.environment))
          .contentHash;
        contentHashes.record(name, version, recorded);
      } catch (error) {
        this.#ports.logger.warn(`packages: shipped ${name} cannot be read: ${reasonOf(error)}`);
        recorded = "";
      }
    }
    const value = await contentCheck(folder, recorded, this.#ports.environment, at);
    this.#warnFailed(name, value);
    this.#installed.set(name, { key: version, value });
  }

  /** The live copy against the hash recorded at install: re-checked once per install. */
  async #installation(live: LivePackage): Promise<Installation> {
    const name = live.record.package;
    const key = keyOf(live.record);
    const known = this.#installed.get(name);
    if (known?.key === key) {
      return known.value;
    }
    const value = await contentCheck(
      live.folder.packageDir,
      live.record.contentHash,
      this.#ports.environment,
      new Date(this.#ports.now()),
    );
    this.#warnFailed(name, value);
    this.#installed.set(name, { key, value });
    return value;
  }

  #warnFailed(name: string, value: Installation): void {
    if (value.state === "failed-check") {
      this.#ports.logger.warn(`packages: ${name}'s files failed their check (${value.reason})`);
    }
  }

  /** Ask where the package came from, now; the answer is kept with when it was asked. */
  async #ask(record: InstalledRecord): Promise<void> {
    const finding = await this.#ports.updates.checkOne(record);
    this.#asked.set(record.package, {
      key: keyOf(record),
      value: findingFacet(finding, new Date(this.#ports.now())),
    });
  }

  #update(
    record: InstalledRecord,
    listed: ListedPackage | undefined,
    checkedAt: number | null,
    now: Date,
  ): PackageUpdate | null {
    const asked = this.#asked.get(record.package);
    const found = asked?.key === keyOf(record) ? asked.value : checkFacet(listed, checkedAt);
    if (found?.state === "available" || found?.state === "changed") {
      return found;
    }
    return (
      leftFacet(record) ?? goBackOffer(record, this.#ports.roots.kept(record.package), now) ?? found
    );
  }

  /** `work` while nothing else installs, removes or updates; refused as busy otherwise. */
  async #oneAtATime(what: string, work: () => Promise<BoardOutcome>): Promise<BoardOutcome> {
    let result: BoardOutcome = refused({ reason: "busy" });
    await this.#ports.one.run(what, async () => {
      result = await work();
      return { ok: true, message: "" };
    });
    return result;
  }
}
