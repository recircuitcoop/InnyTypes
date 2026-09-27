// The old installation's plugin environments (addons/discovery.py's addons root): WI-0018-25
// lists them in one notice, and deletes them only on the press of that notice's button —
// nothing here deletes anything on its own.

export interface LegacyPackageEnvironments {
  /** Every old plugin's id found under the old addons root, sorted; empty when there is none. */
  list(): readonly string[];
  /** Delete the whole old addons root. Safe when it is already gone. */
  deleteAll(): void;
}
