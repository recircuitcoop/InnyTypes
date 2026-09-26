// The launch-at-login switch (launcher.py:1450 LaunchAtLogin): off by default, stored in the
// settings file, acted on by the OS.
//
// The order of the two halves is chosen so the settings file never claims something the machine
// is not doing. The OS is asked first; the setting is written only once that has worked; and a
// write that fails puts the OS back the way it was. A switch whose stored value and whose real
// behaviour disagree is worse than one that refuses to move. A refusal is said on the page, and
// cleared once the switch moves.

import type { Logger } from "../ports/logger";
import { LoginItemError, type LoginItem } from "../ports/login-item";
import type { LaunchAtLoginSetting } from "../ports/settings-store";

/** What the Settings page shows: the switch, and why it did not move when it did not. */
export interface LaunchAtLoginStatus {
  readonly on: boolean;
  readonly problem: string | null;
}

export interface LaunchAtLoginDeps {
  readonly item: LoginItem;
  readonly setting: LaunchAtLoginSetting;
  readonly logger: Logger;
}

export class LaunchAtLogin {
  readonly #deps: LaunchAtLoginDeps;
  #problem: string | null = null;

  constructor(deps: LaunchAtLoginDeps) {
    this.#deps = deps;
  }

  status(): LaunchAtLoginStatus {
    try {
      return { on: this.#deps.setting.readLaunchAtLogin(), problem: this.#problem };
    } catch (error) {
      // An unreadable settings file is said, and the switch reads off: it claims nothing.
      return { on: false, problem: (error as Error).message };
    }
  }

  /** Turn the switch on or off: in the OS, then in the settings file, in that order. */
  set(on: boolean): LaunchAtLoginStatus {
    try {
      this.#ask(on);
    } catch (error) {
      this.#problem = reasonOf(error);
      this.#deps.logger.warn(`launch at login was not turned ${onOff(on)}: ${this.#problem}`);
      return this.status();
    }
    try {
      this.#deps.setting.writeLaunchAtLogin(on);
    } catch (error) {
      // Put the machine back: a login item the person cannot see in the window is one they
      // cannot turn off either.
      this.#problem = `the setting could not be saved: ${reasonOf(error)}`;
      this.#deps.logger.error(`launch at login was not turned ${onOff(on)}: ${this.#problem}`);
      try {
        this.#ask(!on);
      } catch (undo) {
        this.#deps.logger.error(`the login item could not be put back: ${reasonOf(undo)}`);
      }
      return this.status();
    }
    this.#problem = null;
    this.#deps.logger.info(`launch at login is now ${onOff(on)}`);
    return this.status();
  }

  #ask(on: boolean): void {
    if (on) {
      this.#deps.item.register();
    } else {
      this.#deps.item.unregister();
    }
  }
}

/**
 * The login item of a run that is not an installed application, which refuses out loud
 * (launcher.py:1420 UnpackagedLoginItem): registering one needs the installed application's
 * identity, and a hook that quietly succeeded would leave the switch reading "on" while nothing
 * starts at login. It is also what keeps a development run, and every e2e run, from ever
 * touching this user's own login items.
 */
export const unpackagedLoginItem: LoginItem = {
  register: () => {
    throw new LoginItemError(
      "starting InnyTypes at login needs the installed application, and this run is not one",
    );
  },
  unregister: () => {
    throw new LoginItemError(
      "there is no login item to remove: this run is not the installed application",
    );
  },
};

const onOff = (on: boolean): string => (on ? "on" : "off");

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
