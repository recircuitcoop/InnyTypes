// The operating system's login-item store, as the application touches it (launcher.py:1404
// LoginItem). Two calls and no state: whether the switch is on is the settings file's answer,
// not the OS's, because the settings file is what the window shows.

/** The OS would not register or remove the login item; the message says why, for a person. */
export class LoginItemError extends Error {
  override name = "LoginItemError";
}

export interface LoginItem {
  /** Ask the OS to start InnyTypes at login. Throws LoginItemError when it will not. */
  register(): void;
  /** Ask the OS to stop starting InnyTypes at login. Throws LoginItemError when it will not. */
  unregister(): void;
}
