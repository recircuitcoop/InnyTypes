// The package versions whose update failed here and was rolled back (WI-0018-17; the old
// rollout.py's blocked record). Such a version is never applied again by this machine, not even
// in `auto` mode: applying it on every check would roll back on every check. A newer version is
// not blocked by it. The record lives in this user's data and outlives a restart.

export interface BlockedUpdates {
  /** Why `name` at `version` is blocked, or null when it is not. Throws when unreadable. */
  reason(name: string, version: string): string | null;
  /** Block `name` at `version`, saying why. Blocking it again keeps one entry. */
  block(name: string, version: string, reason: string): void;
}
