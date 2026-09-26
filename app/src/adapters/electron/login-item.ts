// Launch at login on macOS and Windows: Electron's login item (plan 0018 §3 macos.py: Replace,
// `app.setLoginItemSettings`). setLoginItemSettings answers nothing, so the OS's answer is read
// back: a login item the OS did not take (macOS asking for approval in System Settings, a
// policy that forbids it) is a refusal, never a switch that reads "on" while nothing starts.

import { LoginItemError, type LoginItem } from "../../ports/login-item";

/** Electron's `app`, as far as the login item goes. */
export interface LoginItemApp {
  setLoginItemSettings(settings: { openAtLogin: boolean }): void;
  getLoginItemSettings(): { openAtLogin: boolean; status?: string };
}

export class ElectronLoginItem implements LoginItem {
  readonly #app: LoginItemApp;

  constructor(app: LoginItemApp) {
    this.#app = app;
  }

  register(): void {
    this.#set(true);
  }

  unregister(): void {
    this.#set(false);
  }

  #set(on: boolean): void {
    try {
      this.#app.setLoginItemSettings({ openAtLogin: on });
    } catch (error) {
      throw new LoginItemError(`the operating system refused the login item: ${String(error)}`);
    }
    const answer = this.#app.getLoginItemSettings();
    if (answer.openAtLogin !== on) {
      // macOS 13 and later say why (requires-approval, not-found); the others only say no.
      const status = answer.status === undefined ? "" : ` (${answer.status})`;
      throw new LoginItemError(
        on
          ? `the operating system did not register InnyTypes to start at login${status}`
          : `the operating system still starts InnyTypes at login${status}`,
      );
    }
  }
}
