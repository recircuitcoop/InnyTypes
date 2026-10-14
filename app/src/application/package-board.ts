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
//   copy's content hash re-checked at start and on demand; update is the last check's time, or
//   the update's own.
// - From a folder (plan 0013): "Check for changes" re-hashes the folder and judges it against
//   what was installed, at start and on demand. Content that changed under the same version is
//   shown as changed and never applied.
// - Go back (D5): what an update replaced is kept seven days from its `installedAt`, and pruned
//   at start after that. Go back swaps it back, restarts the runtime, waits for its instances as
//   an update does, and never blocks the version it left: that one is offered again.
//
// Nothing here words anything: the outcomes are values the shell turns into refusal keys.

import { PackageRefusal } from "../domain/packages/archive";
import { OFFICIAL_SOURCE_NAME } from "../domain/packages/catalogue";
import {
  register as judgeRegister,
  remove as judgeRemove,
  unregister as judgeUnregister,
  rollbackOffered,
  ROLLBACK_WINDOW_MS,
  type Installation,
  type Package,
  type PackageUpdate,
  type Refusal,
  type Registration,
  type StepUse,
} from "../domain/packages/states";
import { withRegistration, type VersionFinding } from "../domain/packages/versions";
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
import { inspectPackage, type PackageEnvironmentPorts } from "./package-environment";
import type { PackageRemover } from "./remove-package";
import type { PackageUpdates } from "./update-package";

/** Who publishes what InnyTypes ships, and its official catalogue's packages. */
export const OWN_PUBLISHER = "InnyTypes";

export interface PackageBoardPorts {
  readonly roots: PackageRoots;
  readonly environment: Pick<
    PackageEnvironmentPorts,
    "source" | "verifier" | "validator" | "sha256"
  >;
  /** The packages shipped with the app. */
  readonly shipped: () => readonly { readonly name: string; readonly version: string }[];
  readonly installer: Pick<PackageInstaller, "state" | "installFromSource" | "installFromFile">;
  readonly updates: Pick<PackageUpdates, "decorate" | "checkOne" | "apply" | "waitForReady">;
  readonly remover: Pick<PackageRemover, "remove">;
  readonly settings: Pick<PackageSettingsStore, "readPackages" | "writePackages">;
  /** The node types the running runtime generated; null while it is not running to ask. */
  readonly loadedTypes: () => Promise<readonly string[] | null>;
  readonly restartRuntime: RestartRuntime;
  readonly one: OneAtATime;
  /** Wall-clock time, epoch ms. */
  readonly now: () => number;
  readonly logger: Logger;
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
  /** The live copies' re-checked content, by package. */
  readonly #installed = new Map<string, Checked<Installation>>();
  /** What "Check for changes" last found in a folder package's folder. */
  readonly #folders = new Map<string, Checked<{ finding: VersionFinding; at: Date }>>();
  /** A version a Go back left: offered as an update again, never blocked. */
  readonly #left = new Map<string, Checked<{ version: string; at: Date }>>();
  #startedAt = new Date(0);
  #started: Promise<void> = Promise.resolve();

  constructor(ports: PackageBoardPorts) {
    this.#ports = ports;
  }

  /**
   * At start: prune what a swap kept past its seven days, re-check every live copy's content,
   * and ask every folder package's folder. The board waits for it before it answers.
   */
  start(): Promise<void> {
    this.#startedAt = new Date(this.#ports.now());
    this.#started = this.#start().catch((error: unknown) => {
      this.#ports.logger.warn(`packages: the start's checks did not finish: ${reasonOf(error)}`);
    });
    return this.#started;
  }

  async #start(): Promise<void> {
    const { roots, logger } = this.#ports;
    const now = this.#ports.now();
    for (const live of roots.list()) {
      const { record } = live;
      const name = record.package;
      const at = record.installedAt;
      if (roots.kept(name) !== undefined && (at === undefined || now >= at + ROLLBACK_WINDOW_MS)) {
        roots.discardKept(name);
        logger.info(`packages: what ${name}'s last update replaced is past its seven days: pruned`);
      }
      await this.#installation(live);
      if (record.origin?.kind === "file") {
        await this.#askFolder(record);
      }
    }
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
        // Verified with the app it ships in, when the app started.
        installation: { state: "installed", verifiedAt: this.#startedAt },
        update: null,
      },
      publisher: OWN_PUBLISHER,
    }));
    for (const live of roots.list()) {
      const { record } = live;
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
          installation: await this.#installation(live),
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

  /** `uses`: every flow and step that uses the package, which the refusal names (D6). */
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
    const { settings, restartRuntime, logger } = this.#ports;
    const what = on ? "registered" : "unregistered";
    return this.#oneAtATime(`${name} being ${what}`, async () => {
      settings.writePackages(withRegistration(settings.readPackages(), name, on));
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

  // ── install, remove, update ───────────────────────────────────────────────────────────────

  /** Install a catalogue entry from its signed archive. */
  async install(source: string, id: string): Promise<BoardOutcome> {
    return this.#afterInstall(await this.#ports.installer.installFromSource(source, id, false));
  }

  /** Install a folder (or `.tgz`) the person chose and confirmed unsigned. */
  async installFolder(folder: string): Promise<BoardOutcome> {
    return this.#afterInstall(await this.#ports.installer.installFromFile(folder, true));
  }

  #afterInstall(outcome: PackageOutcome): BoardOutcome {
    if (outcome.ok) {
      return DONE;
    }
    return this.#ports.one.busy() ? refused({ reason: "busy" }) : { ok: false, failed: "install" };
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
    return outcome.ok ? DONE : { ok: false, failed: "remove" };
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
    this.#left.delete(name);
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
    await this.#askFolder(live.record);
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
    const offer = this.#goBackOffer(record, new Date(this.#ports.now()));
    if (offer === null) {
      return refused({ reason: "rollback-expired" });
    }
    const outcome = await this.#oneAtATime(`${name} going back`, async () => {
      roots.rollBack(name);
      const back = roots.installed(name);
      if (back !== undefined) {
        // The version it left is offered again, and never blocked.
        this.#left.set(name, {
          key: keyOf(back),
          value: { version: offer.version, at: new Date(this.#ports.now()) },
        });
      }
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
    return outcome;
  }

  // ── the facets ────────────────────────────────────────────────────────────────────────────

  /** One package's row, without the catalogues: what a judgement needs. */
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

  /** The live copy against the hash recorded at install: re-checked once per install. */
  async #installation(live: LivePackage): Promise<Installation> {
    const name = live.record.package;
    const key = keyOf(live.record);
    const known = this.#installed.get(name);
    if (known?.key === key) {
      return known.value;
    }
    let value: Installation;
    try {
      const now = await inspectPackage(
        { kind: "path", folder: live.folder.packageDir },
        this.#ports.environment,
      );
      value =
        now.contentHash === live.record.contentHash
          ? { state: "installed", verifiedAt: new Date(this.#ports.now()) }
          : {
              state: "failed-check",
              reason: "content-moved",
              verifiedAt: new Date(this.#ports.now()),
            };
    } catch (error) {
      const reason = error instanceof PackageRefusal ? error.reason : "unreadable";
      value = { state: "failed-check", reason, verifiedAt: new Date(this.#ports.now()) };
    }
    if (value.state === "failed-check") {
      this.#ports.logger.warn(
        `packages: ${name}'s installed copy failed its check (${value.reason})`,
      );
    }
    this.#installed.set(name, { key, value });
    return value;
  }

  /** Ask where the package came from; a folder's answer is kept with when it was asked. */
  async #ask(record: InstalledRecord): Promise<void> {
    if (record.origin?.kind === "file") {
      await this.#askFolder(record);
      return;
    }
    await this.#ports.updates.checkOne(record);
  }

  async #askFolder(record: InstalledRecord): Promise<void> {
    const finding = await this.#ports.updates.checkOne(record);
    this.#folders.set(record.package, {
      key: keyOf(record),
      value: { finding, at: new Date(this.#ports.now()) },
    });
  }

  #update(
    record: InstalledRecord,
    listed: ListedPackage | undefined,
    checkedAt: number | null,
    now: Date,
  ): PackageUpdate | null {
    const name = record.package;
    const left = this.#left.get(name);
    if (left?.key === keyOf(record)) {
      return { state: "available", version: left.value.version, verifiedAt: left.value.at };
    }
    const found =
      record.origin?.kind === "file"
        ? this.#folderFacet(record)
        : catalogueFacet(listed, checkedAt);
    if (found?.state === "available" || found?.state === "changed") {
      return found;
    }
    return this.#goBackOffer(record, now) ?? found;
  }

  #folderFacet(record: InstalledRecord): PackageUpdate | null {
    const asked = this.#folders.get(record.package);
    if (asked?.key !== keyOf(record)) {
      return null;
    }
    const { finding, at } = asked.value;
    switch (finding.kind) {
      case "current":
        return { state: "up-to-date", verifiedAt: at };
      case "newer":
        return { state: "available", version: finding.version, verifiedAt: at };
      case "moved":
        return { state: "changed", version: finding.version, verifiedAt: at };
      case "unchecked":
        return null;
    }
  }

  /** Go back while what the last update replaced is kept, for seven days from the update. */
  #goBackOffer(
    record: InstalledRecord,
    now: Date,
  ): Extract<PackageUpdate, { state: "updated" }> | null {
    const at = record.installedAt;
    const kept = this.#ports.roots.kept(record.package);
    if (kept === undefined || at === undefined) {
      return null;
    }
    const offer = {
      state: "updated" as const,
      version: record.version,
      previous: kept.version,
      at: new Date(at),
      rollbackUntil: new Date(at + ROLLBACK_WINDOW_MS),
      verifiedAt: new Date(at),
    };
    return rollbackOffered(offer, now) ? offer : null;
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

/** Registered while the running runtime holds one of its types; unverified while it is not running. */
function registrationOf(
  name: string,
  types: readonly string[] | null,
  at: Date,
): Registration | null {
  if (types === null) {
    return null;
  }
  const loaded = types.some((type) => type.startsWith(`inny-${name}-`));
  return { state: loaded ? "registered" : "not-registered", verifiedAt: at };
}

/** A catalogue package's update facet from the last update check; null before any check. */
function catalogueFacet(
  listed: ListedPackage | undefined,
  checkedAt: number | null,
): PackageUpdate | null {
  if (checkedAt === null || listed === undefined) {
    return null;
  }
  const at = new Date(checkedAt);
  const line = listed.update;
  if (line === null) {
    return { state: "up-to-date", verifiedAt: at };
  }
  switch (line.kind) {
    case "newer":
    case "failed":
      return line.version === null
        ? null
        : { state: "available", version: line.version, verifiedAt: at };
    case "moved":
      return line.version === null
        ? null
        : { state: "changed", version: line.version, verifiedAt: at };
    case "unchecked":
      return null;
  }
}
