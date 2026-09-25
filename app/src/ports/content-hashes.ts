// The content hash recorded for every package version this machine has installed (plan 0013;
// WI-0018-15). It outlives a removal: a version whose content moved is refused even when the
// version it moved from is no longer installed.

export interface ContentHashes {
  /** The hash recorded for `name` at `version`, or undefined when that version is new here. */
  recorded(name: string, version: string): string | undefined;
  /** Record the hash of an installed version. Never replaces a different hash. */
  record(name: string, version: string, hash: string): void;
}
