// Launch at login (WI-0018-21; launcher.py:1450, linux.py:249, macos.py): the OS is asked first,
// the setting is written only after it answered yes, and a failure leaves both unchanged. The
// real Electron call is proven here against a mocked `app`; the e2e drives the switch through
// the page against a scratch autostart directory, never this user's login items.
import fs from "node:fs";
import os from "node:os";
import * as path from "node:path";
import type { IpcMainInvokeEvent } from "electron";
import { describe, expect, it } from "vitest";
import {
  AutostartLoginItem,
  autostartDirectory,
  DESKTOP_FILENAME,
  renderDesktopEntry,
} from "../../src/adapters/electron/login-item-linux";
import { ElectronLoginItem, type LoginItemApp } from "../../src/adapters/electron/login-item";
import { JsonSettingsStore } from "../../src/adapters/fs/settings-store";
import { LaunchAtLogin, unpackagedLoginItem } from "../../src/application/launch-at-login";
import { LoginItemError, type LoginItem } from "../../src/ports/login-item";
import type { LaunchAtLoginSetting } from "../../src/ports/settings-store";
import { wireLaunchAtLogin } from "../../src/shell/desktop";
import { IPC } from "../../src/shell/ipc";
import { RecordingLogger } from "../fakes/children";

/** An OS and a settings file that write everything they are asked into one journal. */
function world(options: { refuse?: boolean; unsavable?: boolean } = {}) {
  const journal: string[] = [];
  let stored = false;
  const item: LoginItem = {
    register: () => {
      journal.push("os register");
      if (options.refuse === true) {
        throw new LoginItemError("the operating system said no");
      }
    },
    unregister: () => {
      journal.push("os unregister");
    },
  };
  const setting: LaunchAtLoginSetting = {
    readLaunchAtLogin: () => stored,
    writeLaunchAtLogin: (on) => {
      journal.push(`setting ${String(on)}`);
      if (options.unsavable === true) {
        throw new Error("read-only disk");
      }
      stored = on;
    },
  };
  const logger = new RecordingLogger();
  const subject = new LaunchAtLogin({ item, setting, logger });
  return { subject, journal, logger, stored: () => stored };
}

describe("LaunchAtLogin: the order of the two halves", () => {
  it("is off by default, asks the OS first and writes the setting only after it said yes", () => {
    const { subject, journal, stored } = world();
    expect(subject.status()).toEqual({ on: false, problem: null });
    expect(subject.set(true)).toEqual({ on: true, problem: null });
    expect(journal).toEqual(["os register", "setting true"]);
    expect(subject.set(false)).toEqual({ on: false, problem: null });
    expect(journal).toEqual(["os register", "setting true", "os unregister", "setting false"]);
    expect(stored()).toBe(false);
  });

  it("an OS refusal writes no setting, leaves the switch off and says why, until it moves", () => {
    const { subject, journal, stored, logger } = world({ refuse: true });
    expect(subject.set(true)).toEqual({ on: false, problem: "the operating system said no" });
    expect(journal).toEqual(["os register"]);
    expect(stored()).toBe(false);
    expect(logger.lines.join("\n")).toContain("launch at login was not turned on");
    // The refusal clears once the switch moves.
    expect(subject.set(false)).toEqual({ on: false, problem: null });
  });

  it("a setting that cannot be saved puts the OS back the way it was", () => {
    const { subject, journal, stored } = world({ unsavable: true });
    const status = subject.set(true);
    expect(status.on).toBe(false);
    expect(status.problem).toBe("the setting could not be saved: read-only disk");
    expect(journal).toEqual(["os register", "setting true", "os unregister"]);
    expect(stored()).toBe(false);
  });

  it("logs, and still answers, when the OS will not be put back either", () => {
    const logger = new RecordingLogger();
    const subject = new LaunchAtLogin({
      item: {
        register: () => undefined,
        unregister: () => {
          throw new LoginItemError("stuck");
        },
      },
      setting: {
        readLaunchAtLogin: () => false,
        writeLaunchAtLogin: () => {
          throw new Error("read-only disk");
        },
      },
      logger,
    });
    expect(subject.set(true).on).toBe(false);
    expect(logger.lines.join("\n")).toContain("the login item could not be put back: stuck");
  });

  it("an unreadable settings file reads off, and says why", () => {
    const subject = new LaunchAtLogin({
      item: unpackagedLoginItem,
      setting: {
        readLaunchAtLogin: () => {
          throw new Error("settings.json is not JSON");
        },
        writeLaunchAtLogin: () => undefined,
      },
      logger: new RecordingLogger(),
    });
    expect(subject.status()).toEqual({ on: false, problem: "settings.json is not JSON" });
  });

  it("a run that is not the installed app refuses out loud, both ways", () => {
    const { subject } = world();
    const refused = new LaunchAtLogin({
      item: unpackagedLoginItem,
      setting: { readLaunchAtLogin: () => false, writeLaunchAtLogin: () => undefined },
      logger: new RecordingLogger(),
    });
    expect(refused.set(true).problem).toMatch(/needs the installed application/);
    expect(refused.set(false).problem).toMatch(/no login item to remove/);
    expect(subject.status().problem).toBeNull();
  });
});

describe("ElectronLoginItem (macOS, Windows): the real call, with Electron's app mocked", () => {
  function mockApp(answer: (asked: boolean) => { openAtLogin: boolean; status?: string }) {
    const calls: unknown[] = [];
    let asked = false;
    const app: LoginItemApp = {
      setLoginItemSettings: (settings) => {
        calls.push(settings);
        asked = settings.openAtLogin;
      },
      getLoginItemSettings: () => answer(asked),
    };
    return { app, calls };
  }

  it("asks setLoginItemSettings and reads the answer back", () => {
    const { app, calls } = mockApp((asked) => ({ openAtLogin: asked }));
    const item = new ElectronLoginItem(app);
    item.register();
    item.unregister();
    expect(calls).toEqual([{ openAtLogin: true }, { openAtLogin: false }]);
  });

  it("an OS that did not take it is a refusal naming its status, never a silent on", () => {
    const { app } = mockApp(() => ({ openAtLogin: false, status: "requires-approval" }));
    expect(() => {
      new ElectronLoginItem(app).register();
    }).toThrow("did not register InnyTypes to start at login (requires-approval)");
    const stuck = mockApp(() => ({ openAtLogin: true })).app;
    expect(() => {
      new ElectronLoginItem(stuck).unregister();
    }).toThrow("still starts InnyTypes at login");
  });

  it("a throw from Electron is a refusal too", () => {
    const item = new ElectronLoginItem({
      setLoginItemSettings: () => {
        throw new Error("not allowed");
      },
      getLoginItemSettings: () => ({ openAtLogin: false }),
    });
    expect(() => {
      item.register();
    }).toThrow(LoginItemError);
  });
});

describe("AutostartLoginItem (Linux): one .desktop file in the autostart directory", () => {
  const entry = { executable: "/opt/InnyTypes/innytypes", icon: "innytypes" };
  const scratch = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "inny-autostart-"));

  it("writes the entry where the desktop reads it at login, and removing it twice is fine", () => {
    const dir = path.join(scratch(), "autostart");
    const item = new AutostartLoginItem(entry, dir);
    item.register();
    const text = fs.readFileSync(path.join(dir, DESKTOP_FILENAME), "utf8");
    expect(text).toContain("Exec=/opt/InnyTypes/innytypes\n");
    expect(text).toContain("X-GNOME-Autostart-enabled=true\n");
    expect(text).toContain("SingleMainWindow=true\n");
    item.unregister();
    item.unregister();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("an entry that cannot be written or removed is refused with the path in it", () => {
    const base = scratch();
    const blocked = path.join(base, "autostart");
    fs.writeFileSync(blocked, "a file where the directory should be");
    expect(() => {
      new AutostartLoginItem(entry, blocked).register();
    }).toThrow(`the autostart entry could not be written to ${blocked}`);
    const dir = path.join(base, "real");
    fs.mkdirSync(path.join(dir, DESKTOP_FILENAME), { recursive: true });
    fs.writeFileSync(path.join(dir, DESKTOP_FILENAME, "x"), "");
    expect(() => {
      new AutostartLoginItem(entry, dir).unregister();
    }).toThrow(/the autostart entry at .* could not be removed/);
  });

  it("names the application once, by its id, with no field codes, and escapes what it must", () => {
    const text = renderDesktopEntry({
      executable: "/home/a b/100%/Inny\\Types",
      icon: "line\nInjected=1",
    });
    expect(DESKTOP_FILENAME).toBe("it.l1nx.innytypes.helper.desktop");
    expect(text).toContain('Exec="/home/a b/100%%/Inny\\\\\\\\Types"\n');
    expect(text).toContain("Icon=line\\nInjected=1\n");
    expect(text).not.toMatch(/^Injected=/m);
    expect(text).not.toMatch(/%[fFuU]/);
    expect(text).toContain("StartupWMClass=it.l1nx.innytypes.helper\n");
    expect(renderDesktopEntry({ executable: "/a\tb", icon: "i" })).toContain("Exec=/a\\tb\n");
  });

  it("refuses a launcher that is not an absolute path, and an entry with no icon", () => {
    expect(() => renderDesktopEntry({ executable: "innytypes", icon: "i" })).toThrow(
      /absolute path/,
    );
    expect(() => renderDesktopEntry({ executable: "", icon: "i" })).toThrow(/absolute path/);
    expect(() => renderDesktopEntry({ executable: "/a", icon: "" })).toThrow(/needs an icon/);
  });

  it("finds the autostart directory as the XDG base directory specification says", () => {
    expect(autostartDirectory("/xdg", "/home/u")).toBe(path.join("/xdg", "autostart"));
    expect(autostartDirectory("", "/home/u")).toBe(path.join("/home/u", ".config", "autostart"));
    expect(autostartDirectory(undefined, "/home/u")).toBe(
      path.join("/home/u", ".config", "autostart"),
    );
  });
});

describe("the stored switch and its IPC", () => {
  it("is stored beside the other settings, which it leaves as they were", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "inny-settings-")), "s.json");
    const store = new JsonSettingsStore(file);
    expect(store.readLaunchAtLogin()).toBe(false);
    store.writeEndpoint({ host: "127.0.0.1", port: 31010 });
    store.writeLaunchAtLogin(true);
    expect(store.readLaunchAtLogin()).toBe(true);
    expect(store.readEndpoint()).toEqual({ host: "127.0.0.1", port: 31010 });
    fs.writeFileSync(file, JSON.stringify({ launchAtLogin: "yes" }));
    expect(() => store.readLaunchAtLogin()).toThrow(/must be true or false/);
  });

  it("answers the page's two calls, and ignores a set that is not a boolean", () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
    const { subject, journal } = world();
    wireLaunchAtLogin({ handle: (channel, handler) => handlers.set(channel, handler) }, subject);
    const call = (channel: string, ...args: unknown[]) =>
      handlers.get(channel)?.({} as IpcMainInvokeEvent, ...args);
    expect(call(IPC.launchAtLogin)).toEqual({ on: false, problem: null });
    expect(call(IPC.setLaunchAtLogin, "yes")).toEqual({ on: false, problem: null });
    expect(journal).toEqual([]);
    expect(call(IPC.setLaunchAtLogin, true)).toEqual({ on: true, problem: null });
  });
});
