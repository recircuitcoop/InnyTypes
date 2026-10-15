// The desktop promises in the real app (WI-0018-21): launch at login through Configuration ›
// General's Start at login switch (WI-0022-18),
// the Anytype desktop app started or adopted and quit only if InnyTypes started it, and Quit in
// the app menu.
//
// Nothing here reaches this user's desktop: the login item is the Linux autostart adapter over a
// scratch directory (INNYTYPES_TEST_AUTOSTART_DIR, e2e hooks only), and Anytype is a fake app
// binary in the scratch home (test/fakes/anytype-app.ts). The real Electron login-item call is
// proven in test/unit/launch-at-login.test.ts with Electron's app mocked.
import { spawn } from "node:child_process";
import fs from "node:fs";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { STRINGS } from "../../src/ui/strings";
import { fakeAnytypeApp, fakeAnytypePid } from "../fakes/anytype-app";
import {
  isAlive,
  launchApp,
  openGeneral,
  quit,
  processesNaming,
  scratchDirectories,
  waitForRunning,
  exitOf,
  FIRST_START_RECORD,
} from "./app-harness";

/** The node that runs the fake app: this test runner's own, never anything on PATH. */
const NODE = process.execPath;

test("launch at login moves only after the OS said yes, Anytype is started and quit with InnyTypes, and Quit is in the app menu", async () => {
  const { scratch, userData, env } = scratchDirectories();
  const anytype = fakeAnytypeApp(scratch, NODE);
  const autostart = path.join(scratch, "autostart");
  const entry = path.join(autostart, "it.l1nx.innytypes.helper.desktop");
  // What the switch stored; Setup's state beside it is the frame's, stored as the window opens
  // (plan 0022 §H, WI-0022-11).
  const stored = (): unknown => {
    const settings = JSON.parse(
      fs.readFileSync(path.join(userData, "shell-settings.json"), "utf8"),
    ) as Record<string, unknown>;
    delete settings["setup"];
    return settings;
  };
  let anytypePid: number | null = null;
  try {
    const { app, window } = await launchApp({
      ...env,
      INNYTYPES_E2E_HOOKS: "1",
      INNYTYPES_TEST_AUTOSTART_DIR: autostart,
      INNYTYPES_ANYTYPE_APP: anytype,
    });
    await waitForRunning(window, "runtime");

    // ── Anytype was not running, so InnyTypes started it ───────────────────────────────────
    await expect.poll(() => fakeAnytypePid(anytype), { timeout: 15_000 }).not.toBeNull();
    anytypePid = fakeAnytypePid(anytype);

    // ── launch at login, through General's Start at login switch ──────────────────────────
    const general = await openGeneral(window);
    const login = general.getByTestId("general-login");
    // Ark's Switch: its label is the visible control, its checkbox the state a reader hears.
    const toggle = login.getByTestId("general-login-switch");
    const checkbox = login.getByTestId("general-login-switch-input");
    await expect(toggle).toContainText(STRINGS["general.startAtLogin"]);
    await expect(general.getByTestId("general-section-start-at-login")).toContainText(
      STRINGS["general.startAtLogin.line"],
    );
    await expect(login).toHaveAttribute("data-on", "false");
    await toggle.click();
    await expect(login).toHaveAttribute("data-on", "true");
    await expect(checkbox).toBeChecked();
    expect(fs.readFileSync(entry, "utf8")).toContain("X-GNOME-Autostart-enabled=true");
    expect(stored()).toEqual({ ...FIRST_START_RECORD, launchAtLogin: true });
    await toggle.click();
    await expect(login).toHaveAttribute("data-on", "false");
    expect(fs.existsSync(entry)).toBe(false);
    expect(stored()).toEqual({ ...FIRST_START_RECORD, launchAtLogin: false });

    // The OS refuses (a file where the autostart directory should be): nothing moves, and the
    // person is told so in words, never the system's own error.
    fs.rmSync(autostart, { recursive: true, force: true });
    fs.writeFileSync(autostart, "not a directory");
    await toggle.click();
    await expect(general.getByTestId("general-login-message")).toHaveText(
      STRINGS["general.startAtLogin.refused"],
    );
    await expect(login).toHaveAttribute("data-on", "false");
    await expect(checkbox).not.toBeChecked();
    expect(stored()).toEqual({ ...FIRST_START_RECORD, launchAtLogin: false });

    // ── Quit is in the app menu (Electron's own quit role, which runs app.quit(); a role item
    // cannot be clicked from a script on macOS, so the quit below is the call it makes) ─────
    const quitItem = await app.evaluate(({ Menu }) => {
      const find = (items: Electron.MenuItem[]): Electron.MenuItem | null => {
        for (const item of items) {
          const found =
            item.role === "quit" ? item : item.submenu ? find(item.submenu.items) : null;
          if (found !== null) {
            return found;
          }
        }
        return null;
      };
      const item = find(Menu.getApplicationMenu()?.items ?? []);
      return item === null ? null : { label: item.label, enabled: item.enabled };
    });
    expect(quitItem).toMatchObject({ enabled: true, label: expect.stringMatching(/^(Quit|Exit)/) });
    // The app menu's Quit runs the one quit: Anytype goes with it.
    const exited = exitOf(app);
    await app.evaluate(({ app: shell }) => {
      shell.quit();
    });
    await exited;
    await expect.poll(() => isAlive(anytypePid ?? 0), { timeout: 10_000 }).toBe(false);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
  } finally {
    if (anytypePid !== null && isAlive(anytypePid)) {
      process.kill(anytypePid, "SIGKILL");
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("an Anytype already running is adopted, never started twice, and left running on Quit", async () => {
  const { scratch, userData, env } = scratchDirectories();
  const anytype = fakeAnytypeApp(scratch, NODE);
  const theirs = spawn(anytype, [], { detached: true, stdio: "ignore" });
  theirs.unref();
  let anytypePid: number | null = null;
  try {
    await expect.poll(() => fakeAnytypePid(anytype), { timeout: 10_000 }).not.toBeNull();
    anytypePid = fakeAnytypePid(anytype);
    const { app, window, output } = await launchApp({ ...env, INNYTYPES_ANYTYPE_APP: anytype });
    await waitForRunning(window, "runtime");
    await expect
      .poll(() => output.join(""), { timeout: 15_000 })
      .toContain(
        `adopting the Anytype desktop app already running as process ${String(anytypePid)}`,
      );
    // A second start would have written its own pid over this one.
    expect(fakeAnytypePid(anytype)).toBe(anytypePid);

    await quit(app);
    expect(output.join("")).toContain(
      "leaving the Anytype desktop app running: InnyTypes adopted it",
    );
    expect(isAlive(anytypePid ?? 0)).toBe(true);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
  } finally {
    if (anytypePid !== null && isAlive(anytypePid)) {
      process.kill(anytypePid, "SIGKILL");
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
