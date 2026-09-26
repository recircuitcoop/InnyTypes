// Launch at login on Linux: one `.desktop` file in the XDG autostart directory (plan 0018 §3
// linux.py: port of linux.py:249 LinuxLoginItem). Electron has no Linux login item; registering
// is writing the file, and unregistering is deleting it. There is no service to ask and no state
// kept anywhere else.
//
// The entry's rules are the old DesktopEntry's (linux.py:120-230):
// * `Exec` is an absolute path and carries no field codes (%f, %U …), which would invite the
//   desktop to start one copy per file; the entry says SingleMainWindow too.
// * Every value is escaped as the Desktop Entry specification asks, so a newline cannot smuggle
//   in a key, and a percent in `Exec` is doubled so it is never read as a field code.

import fs from "node:fs";
import * as path from "node:path";
import { LoginItemError, type LoginItem } from "../../ports/login-item";
import { APP_USER_MODEL_ID } from "./notifier";

/** What the entry is called, wherever it is: the application's id, always. */
export const DESKTOP_FILENAME = `${APP_USER_MODEL_ID}.desktop`;

export interface DesktopEntry {
  /** The installed launcher, by its absolute path (the AppImage, or the installed binary). */
  readonly executable: string;
  /** An absolute path to an image, or an icon-theme name. */
  readonly icon: string;
}

/** The autostart directory: `$XDG_CONFIG_HOME/autostart`, or `~/.config/autostart`. */
export function autostartDirectory(xdgConfigHome: string | undefined, home: string): string {
  const base = xdgConfigHome !== undefined && xdgConfigHome !== "" ? xdgConfigHome : null;
  return path.join(base ?? path.join(home, ".config"), "autostart");
}

/** The file, key by key, as freedesktop's Desktop Entry specification spells it. */
export function renderDesktopEntry(entry: DesktopEntry): string {
  if (entry.executable === "" || !path.isAbsolute(entry.executable)) {
    throw new LoginItemError(
      `a .desktop entry needs the absolute path of the installed launcher, and ` +
        `"${entry.executable}" is not one`,
    );
  }
  if (entry.icon === "") {
    throw new LoginItemError("a .desktop entry needs an icon: an image path or an icon name");
  }
  return [
    "[Desktop Entry]",
    "Version=1.0",
    "Type=Application",
    "Name=InnyTypes",
    `Comment=${escape("Anytype, with InnyTypes watching over it")}`,
    `Exec=${execValue(entry.executable)}`,
    `Icon=${escape(entry.icon)}`,
    "Terminal=false",
    "Categories=Utility;Office;",
    "StartupNotify=true",
    `StartupWMClass=${escape(APP_USER_MODEL_ID)}`,
    "SingleMainWindow=true",
    "X-GNOME-Autostart-enabled=true",
  ]
    .map((line) => `${line}\n`)
    .join("");
}

export class AutostartLoginItem implements LoginItem {
  readonly #entry: DesktopEntry;
  readonly #directory: string;

  constructor(entry: DesktopEntry, directory: string) {
    this.#entry = entry;
    this.#directory = directory;
  }

  register(): void {
    const text = renderDesktopEntry(this.#entry);
    const file = path.join(this.#directory, DESKTOP_FILENAME);
    try {
      fs.mkdirSync(this.#directory, { recursive: true });
      fs.writeFileSync(file, text);
    } catch (error) {
      throw new LoginItemError(
        `the autostart entry could not be written to ${this.#directory}: ${codeOf(error)}`,
      );
    }
  }

  /** Removing an entry that is already gone is not an error. */
  unregister(): void {
    const file = path.join(this.#directory, DESKTOP_FILENAME);
    try {
      fs.rmSync(file, { force: true });
    } catch (error) {
      throw new LoginItemError(
        `the autostart entry at ${file} could not be removed: ${codeOf(error)}`,
      );
    }
  }
}

/** Backslashes first, or the escapes added afterwards would be escaped again. */
function escape(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");
}

/** The launcher, quoted when it has a space, with a literal percent doubled. */
function execValue(executable: string): string {
  const escaped = escape(executable).replaceAll("%", "%%");
  if (!escaped.includes(" ")) {
    return escaped;
  }
  return `"${escaped.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

const codeOf = (error: unknown): string => (error as NodeJS.ErrnoException).code ?? String(error);
