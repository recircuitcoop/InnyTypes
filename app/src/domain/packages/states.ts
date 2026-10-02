// What a package row shows (plan 0022 §A "domain/packages/states.ts", §F; design-system "Package
// row"; ux-writing "Configuration › General", Packages). Values only: the row's words ("Registered",
// "Installing · 60%", "Updated to 0.4 on Tuesday", the in-use refusal) are ui/strings.ts's
// (WI-0022-10), listed in app/test/unit/domain/wording.fixture.test.ts.
//
// A package has three facets, each a state InnyTypes verified, and when:
// * registration: registered | not-registered — the current generation's `ready.types[]`.
// * installation: installed | not-installed | installing {progress} | verifying | failed-check —
//   the content hash re-checked at start and on demand.
// * update: up-to-date | available {version} | updating | updated {version, at, previous,
//   rollbackUntil} — the last check's time, or the update's.
//
// THE RULE: no state without `verifiedAt`. Every state type below carries a required
// `verifiedAt: Date`, so a state cannot be built without one. A facet InnyTypes has not verified
// yet is `null`, and the row shows nothing for it and offers none of its actions.
//
// Transitions are functions that return the package with its new facet, or a structured refusal.
// They take `at`, the time the caller verified the outcome (after the restart, the re-hash, the
// check): this module never reads a clock.
//
// Owner decisions: D5 — a package's previous environment is kept 7 days, and Go back is offered
// for that long; D6 — unregister (and remove) refuse while a flow uses the package, and the
// refusal names every flow and step that uses it. A package that ships with the app can be
// unregistered, never removed.

import type { RefusalReason } from "./archive";
import type { VersionFinding } from "./versions";

/** How long Go back is offered after an update, and the previous environment kept (D5). */
export const ROLLBACK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** What every state carries: when InnyTypes last verified it. */
interface Verified {
  readonly verifiedAt: Date;
}

export type Registration =
  (Verified & { readonly state: "registered" }) | (Verified & { readonly state: "not-registered" });

export type Installation =
  | (Verified & { readonly state: "installed" })
  | (Verified & { readonly state: "not-installed" })
  /** `progress` is a whole percentage, 0 to 100, across fetching, verifying, building, swapping. */
  | (Verified & { readonly state: "installing"; readonly progress: number })
  | (Verified & { readonly state: "verifying" })
  /** `reason` is the step of the install order that refused it (domain/packages/archive.ts). */
  | (Verified & { readonly state: "failed-check"; readonly reason: RefusalReason });

export type PackageUpdate =
  | (Verified & { readonly state: "up-to-date" })
  | (Verified & { readonly state: "available"; readonly version: string })
  | (Verified & { readonly state: "updating"; readonly version: string })
  /**
   * `previous` is the version Go back returns to; `rollbackUntil` ends the offer. `at` is when
   * the update was made (the row's "Updated to 0.4 on Tuesday").
   */
  | (Verified & {
      readonly state: "updated";
      readonly version: string;
      readonly previous: string;
      readonly at: Date;
      readonly rollbackUntil: Date;
    });

export type RegistrationState = Registration["state"];
export type InstallationState = Installation["state"];
export type PackageUpdateState = PackageUpdate["state"];

export const REGISTRATION_STATES: readonly RegistrationState[] = ["registered", "not-registered"];
export const INSTALLATION_STATES: readonly InstallationState[] = [
  "installed",
  "not-installed",
  "installing",
  "verifying",
  "failed-check",
];
export const PACKAGE_UPDATE_STATES: readonly PackageUpdateState[] = [
  "up-to-date",
  "available",
  "updating",
  "updated",
];

/** Where the package came from. A folder's row says "From a folder: path" and is re-hashed. */
export type PackageSource =
  { readonly kind: "catalogue" } | { readonly kind: "folder"; readonly path: string };

/** One package as its row knows it. A facet is null until InnyTypes has verified it. */
export interface Package {
  readonly name: string;
  readonly version: string;
  readonly source: PackageSource;
  /** False: the row says "Unsigned". */
  readonly signed: boolean;
  /** It ships with the app: it can be unregistered, never removed. */
  readonly shipped: boolean;
  readonly registration: Registration | null;
  readonly installation: Installation | null;
  readonly update: PackageUpdate | null;
}

/** One place a package is used: a flow, and the step of that flow made from one of its types. */
export interface StepUse {
  readonly flow: string;
  readonly step: string;
}

/** Why a transition was refused. Values only; the refusal's sentence is ui/strings.ts's. */
export type Refusal =
  /** D6: a flow uses the package. `uses` lists EVERY flow and step, in the order given. */
  | {
      readonly reason: "in-use";
      readonly action: "unregister" | "remove";
      readonly uses: readonly StepUse[];
    }
  /** It ships with the app: it is never removed. */
  | { readonly reason: "shipped" }
  /** Go back after its seven days, or after no update at all. */
  | { readonly reason: "rollback-expired" }
  /** The action needs the package's files and environment on this Mac. */
  | { readonly reason: "not-installed" }
  /** An install or an update is under way. */
  | { readonly reason: "busy" }
  /** The package is already in the state asked for, or there is no update to make. */
  | { readonly reason: "nothing-to-do" }
  /** Plan 0013: the folder's content changed and its version did not. Never applied. */
  | { readonly reason: "content-moved"; readonly version: string }
  /** The source could not be checked; the facet keeps what was last verified. */
  | { readonly reason: "unchecked"; readonly detail: string };

export type Outcome =
  | { readonly kind: "done"; readonly package: Package }
  | { readonly kind: "refused"; readonly refusal: Refusal };

const done = (pkg: Package): Outcome => ({ kind: "done", package: pkg });
const refused = (refusal: Refusal): Outcome => ({ kind: "refused", refusal });

/** True while an install or an update is under way: nothing else may start meanwhile. */
export function isBusy(pkg: Package): boolean {
  const installing =
    pkg.installation?.state === "installing" || pkg.installation?.state === "verifying";
  return installing || pkg.update?.state === "updating";
}

const isInstalled = (pkg: Package): boolean => pkg.installation?.state === "installed";

/** Every use once, in the order first given: the refusal names each flow and step (D6). */
function distinctUses(uses: readonly StepUse[]): StepUse[] {
  const seen = new Set<string>();
  const kept: StepUse[] = [];
  for (const use of uses) {
    const key = `${use.flow}\n${use.step}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    kept.push(use);
  }
  return kept;
}

// ── Registration ─────────────────────────────────────────────────────────────────────────────

export function register(pkg: Package, at: Date): Outcome {
  if (isBusy(pkg)) {
    return refused({ reason: "busy" });
  }
  if (!isInstalled(pkg)) {
    return refused({ reason: "not-installed" });
  }
  if (pkg.registration?.state === "registered") {
    return refused({ reason: "nothing-to-do" });
  }
  return done({ ...pkg, registration: { state: "registered", verifiedAt: at } });
}

/**
 * D6: refused while any flow, deployed or not, uses the package; `uses` is every step of every
 * flow made from one of its types. A shipped package may be unregistered: its files stay.
 */
export function unregister(pkg: Package, uses: readonly StepUse[], at: Date): Outcome {
  if (isBusy(pkg)) {
    return refused({ reason: "busy" });
  }
  if (pkg.registration?.state === "not-registered") {
    return refused({ reason: "nothing-to-do" });
  }
  if (uses.length > 0) {
    return refused({ reason: "in-use", action: "unregister", uses: distinctUses(uses) });
  }
  return done({ ...pkg, registration: { state: "not-registered", verifiedAt: at } });
}

// ── Installation ─────────────────────────────────────────────────────────────────────────────

/** Starts an install: from not installed, or after a failed check. */
export function install(pkg: Package, at: Date): Outcome {
  if (isBusy(pkg)) {
    return refused({ reason: "busy" });
  }
  if (isInstalled(pkg)) {
    return refused({ reason: "nothing-to-do" });
  }
  return done({ ...pkg, installation: { state: "installing", progress: 0, verifiedAt: at } });
}

/** What an install, or a re-check of what is installed, reported. */
export type InstallReport =
  | { readonly kind: "progress"; readonly percent: number }
  | { readonly kind: "verifying" }
  | { readonly kind: "verified" }
  | { readonly kind: "failed-check"; readonly reason: RefusalReason };

/** A whole percentage between 0 and 100. */
function percent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

/**
 * The install's phases as they are reported, and the content re-check at start and on demand.
 * Progress and verifying only move an install that is under way; verified and failed-check
 * also judge a package already installed (the re-check).
 */
export function advanceInstall(pkg: Package, report: InstallReport, at: Date): Outcome {
  const underWay =
    pkg.installation?.state === "installing" || pkg.installation?.state === "verifying";
  switch (report.kind) {
    case "progress":
      if (pkg.installation?.state !== "installing") {
        return refused({ reason: "nothing-to-do" });
      }
      return done({
        ...pkg,
        installation: { state: "installing", progress: percent(report.percent), verifiedAt: at },
      });
    case "verifying":
      if (!underWay) {
        return refused({ reason: "nothing-to-do" });
      }
      return done({ ...pkg, installation: { state: "verifying", verifiedAt: at } });
    case "verified":
      return done({ ...pkg, installation: { state: "installed", verifiedAt: at } });
    case "failed-check":
      return done({
        ...pkg,
        installation: { state: "failed-check", reason: report.reason, verifiedAt: at },
      });
  }
}

/**
 * Removes the files and environment. Refused for a shipped package (never removed), and while
 * a flow uses it, naming every flow and step (D6, ux-writing: "same sentence, with remove").
 */
export function remove(pkg: Package, uses: readonly StepUse[], at: Date): Outcome {
  if (pkg.shipped) {
    return refused({ reason: "shipped" });
  }
  if (isBusy(pkg)) {
    return refused({ reason: "busy" });
  }
  if (pkg.installation === null || pkg.installation.state === "not-installed") {
    return refused({ reason: "not-installed" });
  }
  if (uses.length > 0) {
    return refused({ reason: "in-use", action: "remove", uses: distinctUses(uses) });
  }
  return done({
    ...pkg,
    installation: { state: "not-installed", verifiedAt: at },
    registration: { state: "not-registered", verifiedAt: at },
    update: null,
  });
}

// ── Update ───────────────────────────────────────────────────────────────────────────────────

/**
 * The last check's word on the package: from the catalogue, or a folder re-hashed ("Check for
 * changes", domain/packages/versions.ts `judgeFolder`). A moved version is never applied; a
 * source that could not be checked leaves the facet at what was last verified.
 */
export function checkForChanges(pkg: Package, finding: VersionFinding, at: Date): Outcome {
  if (isBusy(pkg)) {
    return refused({ reason: "busy" });
  }
  if (!isInstalled(pkg)) {
    return refused({ reason: "not-installed" });
  }
  switch (finding.kind) {
    case "current":
      // A recent update stays "Updated to …" (and its Go back) until its window ends.
      if (pkg.update?.state === "updated" && rollbackOffered(pkg.update, at)) {
        return done({ ...pkg, update: { ...pkg.update, verifiedAt: at } });
      }
      return done({ ...pkg, update: { state: "up-to-date", verifiedAt: at } });
    case "newer":
      return done({
        ...pkg,
        update: { state: "available", version: finding.version, verifiedAt: at },
      });
    case "moved":
      return refused({ reason: "content-moved", version: finding.version });
    case "unchecked":
      return refused({ reason: "unchecked", detail: finding.reason });
  }
}

/** Starts the update the last check found. */
export function update(pkg: Package, at: Date): Outcome {
  if (isBusy(pkg)) {
    return refused({ reason: "busy" });
  }
  if (!isInstalled(pkg)) {
    return refused({ reason: "not-installed" });
  }
  if (pkg.update?.state !== "available") {
    return refused({ reason: "nothing-to-do" });
  }
  return done({
    ...pkg,
    update: { state: "updating", version: pkg.update.version, verifiedAt: at },
  });
}

/**
 * The update's end, once the restarted runtime proved ready (or did not). A failed update keeps
 * the version that ran before and offers the update again.
 */
export function finishUpdate(pkg: Package, succeeded: boolean, at: Date): Outcome {
  if (pkg.update?.state !== "updating") {
    return refused({ reason: "nothing-to-do" });
  }
  const version = pkg.update.version;
  if (!succeeded) {
    return done({ ...pkg, update: { state: "available", version, verifiedAt: at } });
  }
  return done({
    ...pkg,
    version,
    update: {
      state: "updated",
      version,
      previous: pkg.version,
      at,
      rollbackUntil: new Date(at.getTime() + ROLLBACK_WINDOW_MS),
      verifiedAt: at,
    },
  });
}

/** D5: Go back is offered for seven days after an update, and not a moment after. */
export function rollbackOffered(update: PackageUpdate | null, now: Date): boolean {
  return update?.state === "updated" && now.getTime() < update.rollbackUntil.getTime();
}

/**
 * D5: Go back swaps the previous environment back and restarts the runtime (the caller does
 * both, then passes the time it proved ready). It never blocks the version it left: that
 * version is offered as an update again.
 */
export function rollBack(pkg: Package, at: Date): Outcome {
  if (isBusy(pkg)) {
    return refused({ reason: "busy" });
  }
  if (!isInstalled(pkg)) {
    return refused({ reason: "not-installed" });
  }
  if (pkg.update?.state !== "updated" || !rollbackOffered(pkg.update, at)) {
    return refused({ reason: "rollback-expired" });
  }
  const left = pkg.update.version;
  return done({
    ...pkg,
    version: pkg.update.previous,
    update: { state: "available", version: left, verifiedAt: at },
  });
}

// ── The row's actions ────────────────────────────────────────────────────────────────────────

/** The buttons a Package row can show (design-system "Package row"). */
export type RowAction =
  "register" | "unregister" | "install" | "remove" | "update" | "check-for-changes" | "go-back";

/** The row's actions: the enabled ones, and the ones shown but disabled. */
export interface RowActions {
  readonly enabled: readonly RowAction[];
  readonly disabled: readonly RowAction[];
}

/**
 * One action per facet, in the row's order (Register/Unregister, Install/Remove, then Update or
 * Check for changes or Go back). An unverified facet offers nothing; a busy package offers
 * nothing new; Unregister and Remove stay enabled while used, so pressing them gives the
 * refusal that names every use.
 */
export function rowActions(pkg: Package, now: Date): RowActions {
  const enabled: RowAction[] = [];
  const disabled: RowAction[] = [];
  const offer = (action: RowAction, allowed: boolean) => {
    (allowed ? enabled : disabled).push(action);
  };
  const busy = isBusy(pkg);
  const installed = isInstalled(pkg);

  if (pkg.registration !== null) {
    if (pkg.registration.state === "registered") {
      offer("unregister", !busy);
    } else {
      offer("register", !busy && installed);
    }
  }

  if (pkg.installation !== null) {
    if (installed) {
      offer("remove", !busy && !pkg.shipped);
    } else {
      offer("install", !busy);
    }
  }

  if (pkg.update !== null) {
    if (pkg.source.kind === "folder") {
      offer("check-for-changes", !busy && installed);
    } else {
      offer("update", !busy && installed && pkg.update.state === "available");
    }
    if (rollbackOffered(pkg.update, now)) {
      offer("go-back", !busy && installed);
    }
  }

  return { enabled, disabled };
}
