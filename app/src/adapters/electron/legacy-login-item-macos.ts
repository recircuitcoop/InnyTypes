// The old installation's LaunchAgent on macOS (helper/macos.py MacLoginItem, BUNDLE_IDENTIFIER
// "it.l1nx.innytypes.helper"): removed by WI-0018-25 only once the new login item is confirmed
// working. `bootout` is attempted first, while the file launchd was told about is still on
// disk, but its failure is not fatal — a domain with no such agent is exactly the state being
// asked for, matching the old unregister()'s own tolerance.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import type { LegacyLoginItem } from "../../ports/legacy-login-item";

/** The identifier the old Briefcase bundle stamped (helper/config.py BUNDLE_IDENTIFIER). */
export const LEGACY_BUNDLE_IDENTIFIER = "it.l1nx.innytypes.helper";

export type Runner = (command: string, args: readonly string[]) => void;

export interface LegacyMacLoginItemOptions {
  readonly path: string;
  readonly identifier?: string;
  readonly uid: number;
  readonly launchctl?: string;
  readonly run?: Runner;
}

export class LegacyMacLoginItem implements LegacyLoginItem {
  readonly #path: string;
  readonly #identifier: string;
  readonly #uid: number;
  readonly #launchctl: string;
  readonly #run: Runner;

  constructor(options: LegacyMacLoginItemOptions) {
    this.#path = options.path;
    this.#identifier = options.identifier ?? LEGACY_BUNDLE_IDENTIFIER;
    this.#uid = options.uid;
    this.#launchctl = options.launchctl ?? "/bin/launchctl";
    this.#run =
      options.run ??
      ((command, args) => {
        execFileSync(command, args);
      });
  }

  present(): boolean {
    return fs.existsSync(this.#path);
  }

  remove(): void {
    if (fs.existsSync(this.#path)) {
      try {
        this.#run(this.#launchctl, ["bootout", `gui/${String(this.#uid)}/${this.#identifier}`]);
      } catch {
        // launchd had no such agent to unload; the file is removed regardless.
      }
    }
    fs.rmSync(this.#path, { force: true });
  }
}
