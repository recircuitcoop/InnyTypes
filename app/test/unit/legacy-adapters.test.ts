// The filesystem and OS-process adapters WI-0018-25 reads the old installation through: where
// its files live on each platform, reading them without inventing values, and telling a live
// pid from a stale one.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LegacyLinuxAutostart } from "../../src/adapters/electron/legacy-login-item-linux";
import { LegacyMacLoginItem } from "../../src/adapters/electron/legacy-login-item-macos";
import { legacyConfigPath, readTextFileOrNull } from "../../src/adapters/fs/legacy-config";
import { legacyLockPath, readLegacyLockPid } from "../../src/adapters/fs/legacy-helper-lock";
import { JsonLegacyImportReportStore } from "../../src/adapters/fs/legacy-import-report";
import {
  FsLegacyPackageEnvironments,
  legacyAddonsRoot,
} from "../../src/adapters/fs/legacy-packages";
import { signalProcessLiveness } from "../../src/adapters/process/process-liveness";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

let scratch: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "inny-legacy-"));
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("legacy paths, per platform", () => {
  it("config.toml: macOS, Linux (XDG and its fallback) and Windows", () => {
    expect(legacyConfigPath({ platform: "darwin", home: "/Users/x", env: {} })).toBe(
      "/Users/x/Library/Application Support/innytypes/config.toml",
    );
    expect(
      legacyConfigPath({ platform: "linux", home: "/home/x", env: { XDG_CONFIG_HOME: "/cfg" } }),
    ).toBe("/cfg/innytypes/config.toml");
    expect(legacyConfigPath({ platform: "linux", home: "/home/x", env: {} })).toBe(
      "/home/x/.config/innytypes/config.toml",
    );
    expect(
      legacyConfigPath({ platform: "win32", home: "C:\\Users\\x", env: { LOCALAPPDATA: "C:\\L" } }),
    ).toBe("C:\\L\\innytypes\\config.toml");
  });

  it("the addons root: the same per-platform data directory, plus 'addons'", () => {
    expect(legacyAddonsRoot({ platform: "darwin", home: "/Users/x", env: {} })).toBe(
      "/Users/x/Library/Application Support/innytypes/addons",
    );
    expect(
      legacyAddonsRoot({ platform: "linux", home: "/home/x", env: { XDG_DATA_HOME: "/data" } }),
    ).toBe("/data/innytypes/addons");
  });

  it("the helper.lock path prefers XDG_RUNTIME_DIR, then a platform default", () => {
    expect(
      legacyLockPath(
        { platform: "linux", home: "/home/x", env: { XDG_RUNTIME_DIR: "/run/user/1000" } },
        "/tmp",
      ),
    ).toBe("/run/user/1000/innytypes/helper.lock");
    expect(legacyLockPath({ platform: "darwin", home: "/Users/x", env: {} }, "/tmp")).toBe(
      "/Users/x/Library/Caches/TemporaryItems/innytypes/helper.lock",
    );
    expect(legacyLockPath({ platform: "linux", home: "/home/x", env: {} }, "/tmp")).toBe(
      "/tmp/innytypes/helper.lock",
    );
  });
});

describe("readTextFileOrNull", () => {
  it("null for a missing file, the text for one that is there", () => {
    const file = path.join(scratch, "config.toml");
    expect(readTextFileOrNull(file)).toBeNull();
    fs.writeFileSync(file, "telemetry = true\n");
    expect(readTextFileOrNull(file)).toBe("telemetry = true\n");
  });
});

describe("readLegacyLockPid", () => {
  it("the pid a well-formed lock names; null for missing, malformed, or a non-positive pid", () => {
    const file = path.join(scratch, "helper.lock");
    expect(readLegacyLockPid(file)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ pid: 4242, kind: "helper" }));
    expect(readLegacyLockPid(file)).toBe(4242);
    fs.writeFileSync(file, "not json");
    expect(readLegacyLockPid(file)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ pid: -1 }));
    expect(readLegacyLockPid(file)).toBeNull();
    fs.writeFileSync(file, JSON.stringify([1, 2, 3]));
    expect(readLegacyLockPid(file)).toBeNull();
  });
});

describe("signalProcessLiveness", () => {
  it("alive when the signal succeeds, and when it fails with something other than ESRCH", () => {
    const alwaysOk = signalProcessLiveness(() => undefined);
    expect(alwaysOk.isAlive(1)).toBe(true);
    const eperm = signalProcessLiveness(() => {
      throw Object.assign(new Error("no permission"), { code: "EPERM" });
    });
    expect(eperm.isAlive(1)).toBe(true);
  });

  it("not alive when the signal fails with ESRCH: nothing has that pid", () => {
    const esrch = signalProcessLiveness(() => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    });
    expect(esrch.isAlive(99999)).toBe(false);
  });
});

describe("JsonLegacyImportReportStore", () => {
  it("does not exist until written, and holds exactly what was written afterwards", () => {
    const store = new JsonLegacyImportReportStore(scratch);
    expect(store.exists()).toBe(false);
    const report = {
      importedAt: "2026-01-01T00:00:00.000Z",
      launchAtLoginWanted: true,
      imported: ["telemetry: true"],
      ignored: [],
    };
    store.write(report);
    expect(store.exists()).toBe(true);
    const raw: unknown = JSON.parse(
      fs.readFileSync(path.join(scratch, "legacy-import-report.json"), "utf8"),
    );
    expect(raw).toEqual(report);
  });
});

describe("FsLegacyPackageEnvironments", () => {
  it("lists nothing for a root that does not exist, and every directory once it does", () => {
    const root = path.join(scratch, "addons");
    const environments = new FsLegacyPackageEnvironments(root);
    expect(environments.list()).toEqual([]);
    fs.mkdirSync(path.join(root, "monty"), { recursive: true });
    fs.mkdirSync(path.join(root, "innyrize"), { recursive: true });
    fs.writeFileSync(path.join(root, "not-a-package.txt"), "");
    expect(environments.list()).toEqual(["innyrize", "monty"]);
  });

  it("deleteAll removes the whole root, and a second call is not an error", () => {
    const root = path.join(scratch, "addons");
    fs.mkdirSync(path.join(root, "monty"), { recursive: true });
    const environments = new FsLegacyPackageEnvironments(root);
    environments.deleteAll();
    expect(fs.existsSync(root)).toBe(false);
    expect(environments.list()).toEqual([]);
    expect(() => {
      environments.deleteAll();
    }).not.toThrow();
  });
});

describe("LegacyMacLoginItem", () => {
  it("present() reads the filesystem; remove() unloads it and deletes the file, missing or not", () => {
    const file = path.join(scratch, "it.l1nx.innytypes.helper.plist");
    const item = new LegacyMacLoginItem({ path: file, uid: 501 });
    expect(item.present()).toBe(false);
    item.remove(); // absent already: no error, and launchctl is never called
    expect(execFileSync).not.toHaveBeenCalled();
    fs.writeFileSync(file, "<plist/>");
    expect(item.present()).toBe(true);
    item.remove();
    expect(execFileSync).toHaveBeenCalledWith("/bin/launchctl", [
      "bootout",
      "gui/501/it.l1nx.innytypes.helper",
    ]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("a launchctl failure does not stop the file from being removed", () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("no such agent");
    });
    const file = path.join(scratch, "it.l1nx.innytypes.helper.plist");
    fs.writeFileSync(file, "<plist/>");
    const item = new LegacyMacLoginItem({ path: file, uid: 501 });
    expect(() => {
      item.remove();
    }).not.toThrow();
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe("LegacyLinuxAutostart", () => {
  it("present() reads the filesystem; remove() deletes it, missing or not", () => {
    const item = new LegacyLinuxAutostart(scratch);
    expect(item.present()).toBe(false);
    expect(() => {
      item.remove();
    }).not.toThrow();
    const file = path.join(scratch, "it.l1nx.innytypes.helper.desktop");
    fs.writeFileSync(file, "[Desktop Entry]\n");
    expect(item.present()).toBe(true);
    item.remove();
    expect(fs.existsSync(file)).toBe(false);
  });
});
