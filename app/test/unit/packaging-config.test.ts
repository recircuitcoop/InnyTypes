// electron-builder replaces Briefcase entirely (plan 0018 §1, §8.3 WI-0018-23): these are the
// new equivalents of a handful of tests/test_bundle.py's old assertions (docs/parity/ledger.csv,
// fate "replaced"), read from the same committed files electron-builder itself reads, rather
// than from a remembered string. Every other tests/test_bundle.py assertion — the
// Briefcase-specific "python -m X calls Y" mechanism, and the icon's own pixel content — is
// retired: Briefcase's identifier-matches-module-name mechanism has no Electron equivalent
// (package.json's `main` just is the entry file), and tools/make_icon.py plus the committed
// icon files are unchanged by this work item, so their content is not re-asserted here.
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { APP_USER_MODEL_ID } from "../../src/adapters/electron/notifier";

const APP_ROOT = path.resolve(__dirname, "..", "..");
const CONFIG = fs.readFileSync(path.join(APP_ROOT, "packaging", "electron-builder.yml"), "utf8");
const RELEASE_CONFIG = fs.readFileSync(
  path.join(APP_ROOT, "packaging", "electron-builder.release.yml"),
  "utf8",
);
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

describe("the bundled Node can read the Anytype MCP child (0.2.0's MODULE_NOT_FOUND)", () => {
  /** The `asarUnpack:` list's entries, in order. */
  function asarUnpack(config: string): string[] {
    const block = /^asarUnpack:\n((?:[ \t]+(?:-.*|#.*)\n)+)/m.exec(config)?.[1] ?? "";
    return [...block.matchAll(/^\s*-\s*"([^"]+)"/gm)].map((match) => match[1] ?? "");
  }

  it("both configs unpack node_modules/** beside app.asar, and still the test fixtures", () => {
    for (const [name, config] of [
      ["electron-builder.yml", CONFIG],
      ["electron-builder.release.yml", RELEASE_CONFIG],
    ] as const) {
      expect(asarUnpack(config), name).toEqual(["test/fixtures/**", "node_modules/**"]);
    }
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

describe("the release build never carries the local, ad-hoc entitlement (WI-0018-24)", () => {
  const GET_TASK_ALLOW = /<key>\s*com\.apple\.security\.get-task-allow\s*<\/key>/;
  const AFTER_PACK = fs.readFileSync(path.join(APP_ROOT, "packaging", "after-pack.cjs"), "utf8");

  /** Every `entitlements`/`entitlementsInherit` value a config names, wherever they sit. */
  function entitlementsPlists(config: string): string[] {
    return [...config.matchAll(/^\s*entitlements(?:Inherit)?:\s*"([^"]+)"\s*$/gm)].map(
      (match) => match[1] ?? "",
    );
  }

  it("the local (ad-hoc) config's mac section has no identity: the build is never signed by it", () => {
    expect(/^mac:[\s\S]*?^\s*identity:\s*null\s*$/m.test(CONFIG)).toBe(true);
  });

  it("names no identity in the release config: the real Developer ID is found from CSC_LINK/the keychain, never hardcoded", () => {
    expect(/^\s*identity:/m.test(RELEASE_CONFIG)).toBe(false);
  });

  it("the release config's hardened runtime is on, which notarising requires", () => {
    expect(/^\s*hardenedRuntime:\s*true\s*$/m.test(RELEASE_CONFIG)).toBe(true);
  });

  it("the release config names at least one entitlements plist, and every one is free of get-task-allow", () => {
    const plists = entitlementsPlists(RELEASE_CONFIG);
    expect(plists.length).toBeGreaterThan(0);
    for (const relative of plists) {
      const text = fs.readFileSync(path.join(APP_ROOT, "packaging", relative), "utf8");
      expect(text, relative).not.toMatch(GET_TASK_ALLOW);
    }
  });

  it("get-task-allow lives only in local-entitlements.mac.plist, which only after-pack.cjs's local re-sign uses", () => {
    const local = fs.readFileSync(
      path.join(APP_ROOT, "packaging", "local-entitlements.mac.plist"),
      "utf8",
    );
    expect(local).toMatch(GET_TASK_ALLOW);
    expect(AFTER_PACK).toContain("local-entitlements.mac.plist");
    // The one place after-pack.cjs's own re-sign runs is gated on the ad-hoc config's own
    // `identity: null` — never unconditional, or a real, identity-signed build would carry it.
    expect(AFTER_PACK).toMatch(/identity\s*===\s*null/);
  });

  it("an ad-hoc build for distribution (INNYTYPES_DISTRIBUTE=1) re-signs with the release plist, never get-task-allow", () => {
    // after-pack.cjs is CommonJS, loaded the way electron-builder itself loads it.
    const { adHocEntitlementsPlist } = createRequire(__filename)(
      path.join(APP_ROOT, "packaging", "after-pack.cjs"),
    ) as { adHocEntitlementsPlist: (env: Record<string, string | undefined>) => string };

    // Default (local e2e): unchanged, the plist Playwright's CDP needs.
    expect(path.basename(adHocEntitlementsPlist({}))).toBe("local-entitlements.mac.plist");
    expect(path.basename(adHocEntitlementsPlist({ INNYTYPES_DISTRIBUTE: "0" }))).toBe(
      "local-entitlements.mac.plist",
    );

    // Distribution: the release plist, which the test above already proves is free of it.
    const distributed = adHocEntitlementsPlist({ INNYTYPES_DISTRIBUTE: "1" });
    expect(path.basename(distributed)).toBe("release-entitlements.mac.plist");
    expect(fs.readFileSync(distributed, "utf8")).not.toMatch(GET_TASK_ALLOW);
  });
});
