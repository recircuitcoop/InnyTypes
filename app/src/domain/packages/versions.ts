// Which version of an installed package is the one to have, and what this machine may do about
// it (helper/versions.py, ported and reshaped; plan 0013; plan 0018 §3; WI-0018-17).
//
// Plan 0013's complaint is the rule this file exists for: a package installed from a folder has
// no "newest version" anywhere, and its declared version need not move when its content does.
// So a check compares two things, never one:
//
// - the version: a catalogue's entry, or the folder's declaration, against the one installed;
// - the content hash, for a path install: the folder's files now against the hash recorded when
//   it was installed. Content that changed under the same version is refused and said, never
//   applied and never "up to date" (monty's case: a new event kind, the same version).
//
// And what may be done about a newer version is the person's, per package, from the settings:
//
// - `auto`: this machine applies it by itself;
// - `manual`: it is shown, with Apply, and applied only when the person presses it;
// - `pinned`: it is shown, and never applied, not even by a press.
//
// The mode in force is three levels, most specific first (config.py update_mode_for, plan 0006
// F2): the package's own mode, then the auto-update switch of the source it was installed from,
// then the global default. Pure: parsing and judging; the reads are the application's.

import type { CatalogueSource } from "./catalogue";

export type UpdateMode = "auto" | "manual" | "pinned";

export const UPDATE_MODES: readonly UpdateMode[] = ["auto", "manual", "pinned"];

/** The default for a package nobody chose a mode for: shown, never applied on its own. */
export const DEFAULT_UPDATE_MODE: UpdateMode = "manual";

/** A day: how often the catalogues are asked, unless the settings say otherwise. */
export const DEFAULT_CHECK_INTERVAL_SECONDS = 24 * 60 * 60;

/** The shortest interval the settings may ask for: a catalogue is not polled. */
export const MIN_CHECK_INTERVAL_SECONDS = 60;

/** The `packages` settings refused as a whole: the setting names what is wrong with it. */
export class PackageSettingsError extends Error {
  override name = "PackageSettingsError";
}

/** One package's own settings: its mode, when it chose one. */
export interface PackageOverride {
  readonly mode: UpdateMode | null;
}

/** The `packages` settings: the update policy, and whether and how often versions are checked. */
export interface PackagePolicy {
  readonly defaultMode: UpdateMode;
  /** Off: no catalogue and no folder is asked about any version, ever (D14). */
  readonly autoCheck: boolean;
  readonly checkIntervalSeconds: number;
  readonly overrides: ReadonlyMap<string, PackageOverride>;
}

export const DEFAULT_POLICY: PackagePolicy = {
  defaultMode: DEFAULT_UPDATE_MODE,
  autoCheck: true,
  checkIntervalSeconds: DEFAULT_CHECK_INTERVAL_SECONDS,
  overrides: new Map(),
};

const POLICY_KEYS = new Set(["update_mode", "auto_check_versions", "check_interval", "overrides"]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modeOf(value: unknown, where: string): UpdateMode {
  if (typeof value === "string" && (UPDATE_MODES as readonly string[]).includes(value)) {
    return value as UpdateMode;
  }
  throw new PackageSettingsError(
    `${where} is ${JSON.stringify(value)}; it must be one of ${UPDATE_MODES.join(", ")}`,
  );
}

/**
 * The `packages` setting (config.toml's [plugins] and [update], as WI-0018-25 imports them):
 *
 *     { "update_mode": "manual", "auto_check_versions": true, "check_interval": 86400,
 *       "overrides": { "monty": { "update_mode": "pinned" } } }
 *
 * Absent is the defaults. Anything it cannot account for is refused whole: a mode misspelled
 * and read as the default would move a package its owner pinned.
 */
export function parsePackagePolicy(section: unknown): PackagePolicy {
  if (section === undefined) {
    return DEFAULT_POLICY;
  }
  if (!isRecord(section)) {
    throw new PackageSettingsError("the packages setting is not an object");
  }
  const unknown = Object.keys(section).filter((key) => !POLICY_KEYS.has(key));
  if (unknown.length > 0) {
    throw new PackageSettingsError(
      `the packages setting holds unknown keys: ${unknown.join(", ")}`,
    );
  }
  const defaultMode =
    section["update_mode"] === undefined
      ? DEFAULT_UPDATE_MODE
      : modeOf(section["update_mode"], "packages.update_mode");

  const check = section["auto_check_versions"];
  if (check !== undefined && typeof check !== "boolean") {
    throw new PackageSettingsError("packages.auto_check_versions must be true or false");
  }

  const interval = section["check_interval"] ?? DEFAULT_CHECK_INTERVAL_SECONDS;
  if (typeof interval !== "number" || !Number.isFinite(interval)) {
    throw new PackageSettingsError("packages.check_interval must be a number of seconds");
  }
  if (interval < MIN_CHECK_INTERVAL_SECONDS) {
    throw new PackageSettingsError(
      `packages.check_interval is ${String(interval)} s; the shortest is ` +
        `${String(MIN_CHECK_INTERVAL_SECONDS)} s, so no catalogue is polled`,
    );
  }

  const listed = section["overrides"] ?? {};
  if (!isRecord(listed)) {
    throw new PackageSettingsError("packages.overrides is not an object of packages");
  }
  const overrides = new Map<string, PackageOverride>();
  for (const [name, value] of Object.entries(listed)) {
    const where = `packages.overrides.${name}`;
    if (!isRecord(value)) {
      throw new PackageSettingsError(`${where} is not an object`);
    }
    const extra = Object.keys(value).filter((key) => key !== "update_mode");
    if (extra.length > 0) {
      throw new PackageSettingsError(`${where} holds unknown keys: ${extra.join(", ")}`);
    }
    overrides.set(name, {
      mode:
        value["update_mode"] === undefined
          ? null
          : modeOf(value["update_mode"], `${where}.update_mode`),
    });
  }
  return { defaultMode, autoCheck: check ?? true, checkIntervalSeconds: interval, overrides };
}

/** Where the mode in force came from, so the page can say who decided. */
export type ModeLevel = "package" | "source" | "default";

/**
 * The mode in force for `name`, installed from the source `source` (null: from a file, or from
 * the official catalogue, which has no switch). A source that is no longer registered falls
 * through to the default: removing a source says nothing about what was installed from it.
 */
export function modeFor(
  policy: PackagePolicy,
  sources: readonly CatalogueSource[],
  name: string,
  source: string | null,
): { readonly mode: UpdateMode; readonly level: ModeLevel } {
  const own = policy.overrides.get(name)?.mode ?? null;
  if (own !== null) {
    return { mode: own, level: "package" };
  }
  const switched = sources.find((registered) => registered.name === source)?.autoUpdate ?? null;
  if (switched !== null) {
    // The switch is "update automatically": off stops this machine acting on its own, and
    // leaves the person's Apply (config.py CatalogueSource.update_mode).
    return { mode: switched ? "auto" : "manual", level: "source" };
  }
  return { mode: policy.defaultMode, level: "default" };
}

// --- versions ----------------------------------------------------------------------------------

interface ParsedVersion {
  readonly numbers: readonly number[];
  /** The pre-release identifiers after `-`; empty for a release. */
  readonly pre: readonly string[];
}

const VERSION = /^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseVersion(text: string): ParsedVersion | null {
  const match = VERSION.exec(text.trim());
  if (match === null) {
    return null;
  }
  return {
    numbers: (match[1] ?? "").split(".").map(Number),
    pre: match[2] === undefined ? [] : match[2].split("."),
  };
}

function compareIdentifiers(a: string, b: string): number {
  const numeric = /^\d+$/;
  if (numeric.test(a) && numeric.test(b)) {
    return Number(a) - Number(b);
  }
  if (numeric.test(a) !== numeric.test(b)) {
    // A number sorts before a word, as semver has it.
    return numeric.test(a) ? -1 : 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The order of two versions: negative when `a` is older, positive when newer, 0 when the same;
 * null when either is not a version this build can order. Numbers compare as numbers (1.10 is
 * after 1.9), a missing number is 0 (1.0 is 1.0.0), and a pre-release sorts before its release
 * (1.0.0-rc.1 before 1.0.0). Build metadata after `+` is not part of the order.
 */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null || right === null) {
    return null;
  }
  const length = Math.max(left.numbers.length, right.numbers.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left.numbers[index] ?? 0) - (right.numbers[index] ?? 0);
    if (difference !== 0) {
      return Math.sign(difference);
    }
  }
  if (left.pre.length === 0 || right.pre.length === 0) {
    // A release is after every pre-release of itself.
    return Math.sign(right.pre.length - left.pre.length);
  }
  const parts = Math.max(left.pre.length, right.pre.length);
  for (let index = 0; index < parts; index += 1) {
    const x = left.pre[index];
    const y = right.pre[index];
    if (x === undefined || y === undefined) {
      return x === undefined ? -1 : 1;
    }
    const difference = compareIdentifiers(x, y);
    if (difference !== 0) {
      return Math.sign(difference);
    }
  }
  return 0;
}

// --- the check ---------------------------------------------------------------------------------

/** What one installed package's check found. */
export type VersionFinding =
  /** What is installed is what its source says it should be. */
  | { readonly kind: "current" }
  /** A newer version: from the catalogue's entry, or the folder's declaration. */
  | { readonly kind: "newer"; readonly version: string }
  /**
   * Plan 0013: the folder's content changed and its declared version did not. Never applied;
   * the publisher must give it a new version.
   */
  | { readonly kind: "moved"; readonly version: string; readonly hash: string }
  /** It could not be checked, and why, in words for a person. */
  | { readonly kind: "unchecked"; readonly reason: string };

/** A catalogue's word on an installed package: the version its entry names, if any. */
export function judgeCatalogueVersion(
  installed: string,
  offered: string | undefined,
): VersionFinding {
  if (offered === undefined) {
    return { kind: "unchecked", reason: "its catalogue entry names no version" };
  }
  const order = compareVersions(offered, installed);
  if (order === null) {
    return {
      kind: "unchecked",
      reason: `the catalogue offers version "${offered}", which cannot be ordered against ${installed}`,
    };
  }
  // An older published version is never a candidate: a catalogue going back is not an update.
  return order > 0 ? { kind: "newer", version: offered } : { kind: "current" };
}

/**
 * A folder's word on a package installed from it: its declared version and its content hash
 * now, against what was installed. A newer version is an update; the same version with other
 * content is plan 0013's moved version; an older one is not an update.
 */
export function judgeFolder(
  installed: { readonly version: string; readonly contentHash: string },
  found: { readonly version: string; readonly contentHash: string },
): VersionFinding {
  if (found.version === installed.version) {
    return found.contentHash === installed.contentHash
      ? { kind: "current" }
      : { kind: "moved", version: found.version, hash: found.contentHash };
  }
  const order = compareVersions(found.version, installed.version);
  if (order === null) {
    return {
      kind: "unchecked",
      reason: `its folder declares version "${found.version}", which cannot be ordered against ${installed.version}`,
    };
  }
  return order > 0 ? { kind: "newer", version: found.version } : { kind: "current" };
}

/** What the mode lets be done with a newer version (the mode decides; a press is not a mode). */
export type UpdateAction = "apply" | "ask" | "hold";

/**
 * `auto` applies, `manual` waits for Apply, `pinned` holds. A version that failed here before
 * (it was rolled back) is held whatever the mode, until a newer one than it is published: a
 * machine that applied it again on every check would roll back on every check.
 */
export function actionFor(mode: UpdateMode, blocked: boolean): UpdateAction {
  if (mode === "pinned" || blocked) {
    return "hold";
  }
  return mode === "auto" ? "apply" : "ask";
}
