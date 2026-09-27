// electron-builder replaces Briefcase entirely (plan 0018 §1, §8.3 WI-0018-23): these are the
// new equivalents of a handful of tests/test_bundle.py's old assertions (docs/parity/ledger.csv,
// fate "replaced"), read from the same committed files electron-builder itself reads, rather
// than from a remembered string. Every other tests/test_bundle.py assertion — the
// Briefcase-specific "python -m X calls Y" mechanism, and the icon's own pixel content — is
// retired: Briefcase's identifier-matches-module-name mechanism has no Electron equivalent
// (package.json's `main` just is the entry file), and tools/make_icon.py plus the committed
// icon files are unchanged by this work item, so their content is not re-asserted here.
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { APP_USER_MODEL_ID } from "../../src/adapters/electron/notifier";

const APP_ROOT = path.resolve(__dirname, "..", "..");
const CONFIG = fs.readFileSync(path.join(APP_ROOT, "packaging", "electron-builder.yml"), "utf8");
const PACKAGE_JSON = JSON.parse(fs.readFileSync(path.join(APP_ROOT, "package.json"), "utf8")) as {
  productName: string;
};

/** One `key: value` line's value, unquoted; throws if the config has no such line. */
function configValue(key: string): string {
  const match = new RegExp(`^${key}:\\s*"?([^"\\n]+?)"?\\s*$`, "m").exec(CONFIG);
  if (match?.[1] === undefined) {
    throw new Error(`packaging/electron-builder.yml has no top-level "${key}:" line`);
  }
  return match[1];
}

describe("electron-builder identifies the app the way the rest of it does (was Briefcase's bundle identifier/name)", () => {
  it("appId is the same string setAppUserModelId raises toasts under", () => {
    // The old Briefcase bundle stamped this same identifier everywhere (helper/config.py
    // BUNDLE_IDENTIFIER, tests/test_bundle.py's D27 check); electron-builder's appId is its
    // direct successor, and adapters/electron/notifier.ts's own comment says so.
    expect(configValue("appId")).toBe(APP_USER_MODEL_ID);
    expect(APP_USER_MODEL_ID).toBe("it.l1nx.innytypes.helper");
  });

  it("productName is the application the user knows, in both the package manifest and electron-builder", () => {
    expect(configValue("productName")).toBe("InnyTypes");
    expect(PACKAGE_JSON.productName).toBe("InnyTypes");
  });

  it("the icon paths point at the committed images, still the ones tools/make_icon.py draws", () => {
    // Both `mac:` and `linux:` sections have their own `icon:` line, indented under them
    // (never at column 0), so each is found scoped to its own section rather than by a bare
    // top-level "icon:" match.
    const macIconMatch = /^mac:[\s\S]*?^\s*icon:\s*"([^"]+)"/m.exec(CONFIG);
    expect(macIconMatch?.[1]).toBe("../src/innytypes/resources/innytypes.icns");
    expect(fs.existsSync(path.resolve(APP_ROOT, macIconMatch?.[1] ?? ""))).toBe(true);

    const linuxIconMatch = /^linux:[\s\S]*?^\s*icon:\s*"([^"]+)"/m.exec(CONFIG);
    expect(linuxIconMatch?.[1]).toBe("../src/innytypes/resources/innytypes.png");
    expect(fs.existsSync(path.resolve(APP_ROOT, linuxIconMatch?.[1] ?? ""))).toBe(true);
  });
});

describe("every bundled runtime dependency is an exact pin (was Briefcase's per-platform toga==X pin)", () => {
  const raw = JSON.parse(
    fs.readFileSync(path.join(APP_ROOT, "..", "tools", "runtimes", "manifest.json"), "utf8"),
  ) as Record<
    string,
    { version: string; targets: Record<string, { url: string; sha256: string }> } | string
  >;
  // "_comment" is the manifest's own human-readable header, not a tool.
  const manifest = Object.fromEntries(
    Object.entries(raw).filter(
      (entry): entry is [string, (typeof raw)[string]] => entry[0] !== "_comment",
    ),
  ) as Record<
    string,
    { version: string; targets: Record<string, { url: string; sha256: string }> }
  >;

  it("python, uv and node are all present, each with an exact version", () => {
    expect(Object.keys(manifest).sort()).toEqual(["node", "python", "uv"]);
    for (const tool of Object.values(manifest)) {
      // An exact version has no range operator; a pin that could still float is not a pin.
      expect(tool.version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it("every target's runtime is pinned by a real sha256, one target's per platform-arch", () => {
    for (const [tool, { targets }] of Object.entries(manifest)) {
      expect(Object.keys(targets).sort(), tool).toEqual([
        "linux-arm64",
        "linux-x64",
        "mac-arm64",
        "mac-x64",
      ]);
      for (const [target, entry] of Object.entries(targets)) {
        expect(entry.sha256, `${tool} ${target}`).toMatch(/^[0-9a-f]{64}$/);
        expect(entry.url, `${tool} ${target}`).toMatch(/^https:\/\//);
      }
    }
  });
});
