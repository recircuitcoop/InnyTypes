// The old installation's autostart entry on Linux (helper/linux.py LinuxLoginItem,
// DESKTOP_ENTRY_ID = BUNDLE_IDENTIFIER "it.l1nx.innytypes.helper"): removed by WI-0018-25 only
// once the new login item is confirmed working. Removing an entry already gone is not an error,
// matching the old unregister()'s own tolerance.

import fs from "node:fs";
import * as path from "node:path";
import type { LegacyLoginItem } from "../../ports/legacy-login-item";
import { LEGACY_BUNDLE_IDENTIFIER } from "./legacy-login-item-macos";

/** What the old entry was called (linux.py DESKTOP_FILENAME), wherever it is. */
export const LEGACY_DESKTOP_FILENAME = `${LEGACY_BUNDLE_IDENTIFIER}.desktop`;

export class LegacyLinuxAutostart implements LegacyLoginItem {
  readonly #file: string;

  constructor(directory: string, filename: string = LEGACY_DESKTOP_FILENAME) {
    this.#file = path.join(directory, filename);
  }

  present(): boolean {
    return fs.existsSync(this.#file);
  }

  remove(): void {
    fs.rmSync(this.#file, { force: true });
  }
}
