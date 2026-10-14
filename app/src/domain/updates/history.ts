// What InnyTypes remembers about its own installs (plan 0022 §G, owner decision D4): the version
// that ran last, the release Go back returns to, a Go back under way, and the last check's time.
// Values only; the shell stores it as `appUpdate` in shell-settings.json.
//
// Why its own key and not inside `update`: the `update` setting is judged whole and refuses any
// key it does not know (domain/update/policy.ts, in 0.2.1 too). Writing the record there would
// break the older release's update check after a Go back; every 0.3.0 storage change is additive.
//
// The previous release is recorded at the first start on a new version, the moment the shell can
// see that an install happened (an update installs at quit, by electron-updater, or by Squirrel
// on its own; the next start is the one place all of them meet):
//
//   lastVersion unset            → this version is recorded; nothing to go back to
//   lastVersion = current        → nothing happened
//   lastVersion ≠ current        → an install: `previous` = lastVersion, tagged as GitHub tags it,
//                                   unless current is the version a Go back was under way to; then
//                                   nothing is offered (the version it left is an update again).

import { ROLLBACK_WINDOW_MS, type PreviousRelease, type UpdateEvent } from "./machine";

/** The release Go back returns to: its version, its release tag, and when it was replaced. */
export interface RecordedRelease {
  readonly version: string;
  readonly tag: string;
  readonly updatedAt: Date;
}

export interface UpdateHistory {
  /** The version that ran last; null before any start recorded one. */
  readonly lastVersion: string | null;
  readonly lastCheckedAt: Date | null;
  readonly previous: RecordedRelease | null;
  /** The version a Go back was started to, until the start on it. */
  readonly goingBackTo: string | null;
}

export const EMPTY_HISTORY: UpdateHistory = {
  lastVersion: null,
  lastCheckedAt: null,
  previous: null,
  goingBackTo: null,
};

/** The release tag of a version, as this project tags its GitHub releases. */
export const releaseTag = (version: string): string => `v${version}`;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const textOrNull = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

function dateOrNull(value: unknown): Date | null {
  if (typeof value !== "string") {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function recordedRelease(value: unknown): RecordedRelease | null {
  if (!isRecord(value)) {
    return null;
  }
  const version = textOrNull(value["version"]);
  const tag = textOrNull(value["tag"]);
  const updatedAt = dateOrNull(value["updatedAt"]);
  if (version === null || tag === null || updatedAt === null) {
    return null;
  }
  return { version, tag, updatedAt };
}

/**
 * The stored record, read leniently: a field that cannot be read is treated as unset. The worst
 * an unreadable field does is withhold a Go back offer; it never offers one it cannot verify.
 */
export function parseUpdateHistory(raw: unknown): UpdateHistory {
  if (!isRecord(raw)) {
    return EMPTY_HISTORY;
  }
  return {
    lastVersion: textOrNull(raw["lastVersion"]),
    lastCheckedAt: dateOrNull(raw["lastCheckedAt"]),
    previous: recordedRelease(raw["previous"]),
    goingBackTo: textOrNull(raw["goingBackTo"]),
  };
}

/** The record as JSON stores it. */
export function serialiseUpdateHistory(history: UpdateHistory): Record<string, unknown> {
  return {
    lastVersion: history.lastVersion,
    lastCheckedAt: history.lastCheckedAt?.toISOString() ?? null,
    previous:
      history.previous === null
        ? null
        : {
            version: history.previous.version,
            tag: history.previous.tag,
            updatedAt: history.previous.updatedAt.toISOString(),
          },
    goingBackTo: history.goingBackTo,
  };
}

/** What the start found: the record to store, and the `installed` event when there was one. */
export interface AtStart {
  readonly history: UpdateHistory;
  readonly installed: Extract<UpdateEvent, { kind: "installed" }> | null;
}

/** Judges a start on `current` against the record (see the table at the top of this file). */
export function atStart(history: UpdateHistory, current: string, now: Date): AtStart {
  const last = history.lastVersion;
  if (last === null || last === current) {
    return { history: { ...history, lastVersion: current }, installed: null };
  }
  const wentBack = history.goingBackTo === current;
  return {
    history: {
      lastVersion: current,
      lastCheckedAt: history.lastCheckedAt,
      previous: wentBack ? null : { version: last, tag: releaseTag(last), updatedAt: now },
      goingBackTo: null,
    },
    installed: { kind: "installed", version: current, previous: last, at: now, wentBack },
  };
}

/** The machine's view of the recorded release: Go back is offered for seven days after it. */
export function previousRelease(history: UpdateHistory): PreviousRelease | null {
  const previous = history.previous;
  if (previous === null) {
    return null;
  }
  return {
    version: previous.version,
    firstStartedAt: previous.updatedAt,
    rollbackUntil: new Date(previous.updatedAt.getTime() + ROLLBACK_WINDOW_MS),
  };
}
