// The version rules (domain/packages/versions.ts; WI-0018-17): the update policy from the
// settings, the mode in force, the order of versions, and what a catalogue or a folder says
// about an installed package, plan 0013's moved version among it.
//
// The old tests this answers are tests/test_plugin_version_check.py's ordering, mode and
// "older is never a candidate" rows, and plan 0013's missing rule for path installs.
import { describe, expect, it } from "vitest";

import type { CatalogueSource } from "../../src/domain/packages/catalogue";
import {
  actionFor,
  compareVersions,
  DEFAULT_POLICY,
  judgeCatalogueVersion,
  judgeFolder,
  modeFor,
  PackageSettingsError,
  parsePackagePolicy,
} from "../../src/domain/packages/versions";

const source = (name: string, autoUpdate: boolean | null): CatalogueSource => ({
  name,
  url: `https://${name}.test/catalogue.json`,
  publicKey: null,
  autoUpdate,
});

describe("the packages settings", () => {
  it("are the defaults when unset: manual, checked, once a day", () => {
    expect(parsePackagePolicy(undefined)).toBe(DEFAULT_POLICY);
    expect(DEFAULT_POLICY).toMatchObject({
      defaultMode: "manual",
      autoCheck: true,
      checkIntervalSeconds: 86_400,
    });
  });

  it("read the global mode, the switch, the interval and each package's own mode", () => {
    const policy = parsePackagePolicy({
      update_mode: "auto",
      auto_check_versions: false,
      check_interval: 600,
      overrides: { monty: { update_mode: "pinned" }, other: {} },
    });
    expect(policy.defaultMode).toBe("auto");
    expect(policy.autoCheck).toBe(false);
    expect(policy.checkIntervalSeconds).toBe(600);
    expect(policy.overrides.get("monty")).toEqual({ mode: "pinned" });
    expect(policy.overrides.get("other")).toEqual({ mode: null });
  });

  it.each([
    ["not an object", [], "is not an object"],
    ["an unknown key", { channel: "beta" }, "unknown keys: channel"],
    ["a misspelled mode", { update_mode: "automatic" }, "one of auto, manual, pinned"],
    ["a switch that is not a boolean", { auto_check_versions: "yes" }, "true or false"],
    ["an interval that is not a number", { check_interval: "daily" }, "number of seconds"],
    ["an interval that polls", { check_interval: 5 }, "the shortest is 60 s"],
    ["overrides that are not an object", { overrides: [] }, "not an object of packages"],
    ["an override that is not an object", { overrides: { monty: "auto" } }, "is not an object"],
    ["an override with an unknown key", { overrides: { monty: { pinned: true } } }, "unknown keys"],
    [
      "an override with a misspelled mode",
      { overrides: { monty: { update_mode: "off" } } },
      "packages.overrides.monty.update_mode",
    ],
  ])("refuse %s whole, naming what is wrong", (_what, section, reason) => {
    expect(() => parsePackagePolicy(section)).toThrow(PackageSettingsError);
    expect(() => parsePackagePolicy(section)).toThrow(reason);
  });
});

describe("the mode in force", () => {
  const policy = parsePackagePolicy({
    update_mode: "manual",
    overrides: { own: { update_mode: "pinned" }, none: {} },
  });
  const sources = [source("acme", true), source("quiet", false), source("undecided", null)];

  it("is the package's own mode first, even against its source's switch", () => {
    expect(modeFor(policy, sources, "own", "acme")).toEqual({ mode: "pinned", level: "package" });
  });

  it("is then the switch of the source it was installed from", () => {
    expect(modeFor(policy, sources, "none", "acme")).toEqual({ mode: "auto", level: "source" });
    expect(modeFor(policy, sources, "x", "quiet")).toEqual({ mode: "manual", level: "source" });
  });

  it("is the default for a source with no opinion, a removed source, and no source", () => {
    expect(modeFor(policy, sources, "x", "undecided").level).toBe("default");
    expect(modeFor(policy, sources, "x", "removed-since")).toEqual({
      mode: "manual",
      level: "default",
    });
    expect(modeFor(policy, sources, "x", null).level).toBe("default");
  });
});

describe("the order of versions", () => {
  it.each([
    ["1.10.0", "1.9.0", 1],
    ["1.0", "1.0.0", 0],
    ["2.0.0", "10.0.0", -1],
    ["1.0.0-rc.1", "1.0.0", -1],
    ["1.0.0", "1.0.0-rc.1", 1],
    ["1.0.0-alpha", "1.0.0-beta", -1],
    ["1.0.0-rc.2", "1.0.0-rc.10", -1],
    ["1.0.0-1", "1.0.0-alpha", -1],
    ["1.0.0-alpha", "1.0.0-1", 1],
    ["1.0.0-rc", "1.0.0-rc.1", -1],
    ["1.0.0-rc.1", "1.0.0-rc", 1],
    ["1.0.0-rc.1", "1.0.0-rc.1", 0],
    ["1.0.0+build.2", "1.0.0+build.1", 0],
  ])("orders %s against %s as %i: numbers as numbers, pre-releases first", (a, b, order) => {
    expect(compareVersions(a, b)).toBe(order);
  });

  it("cannot order what is not a version", () => {
    expect(compareVersions("latest", "1.0.0")).toBeNull();
    expect(compareVersions("1.0.0", "v2")).toBeNull();
  });
});

describe("what a catalogue says", () => {
  it("offers a newer version, and never an older or the same one", () => {
    expect(judgeCatalogueVersion("0.1.0", "0.2.0")).toEqual({ kind: "newer", version: "0.2.0" });
    expect(judgeCatalogueVersion("0.2.0", "0.1.0")).toEqual({ kind: "current" });
    expect(judgeCatalogueVersion("0.2.0", "0.2.0")).toEqual({ kind: "current" });
  });

  it("cannot check an entry that names no version, or one that cannot be ordered", () => {
    expect(judgeCatalogueVersion("0.1.0", undefined)).toEqual({
      kind: "unchecked",
      reason: "its catalogue entry names no version",
    });
    expect(judgeCatalogueVersion("0.1.0", "nightly")).toMatchObject({ kind: "unchecked" });
  });
});

describe("what a folder says (plan 0013)", () => {
  const installed = { version: "0.1.0", contentHash: "aaa" };

  it("is current when neither its version nor its content moved", () => {
    expect(judgeFolder(installed, { version: "0.1.0", contentHash: "aaa" })).toEqual({
      kind: "current",
    });
  });

  it("is a moved version when its content changed and its version did not: never current", () => {
    expect(judgeFolder(installed, { version: "0.1.0", contentHash: "bbb" })).toEqual({
      kind: "moved",
      version: "0.1.0",
      hash: "bbb",
    });
  });

  it("offers a newer declared version, and not an older one", () => {
    expect(judgeFolder(installed, { version: "0.2.0", contentHash: "bbb" })).toEqual({
      kind: "newer",
      version: "0.2.0",
    });
    expect(judgeFolder(installed, { version: "0.0.9", contentHash: "bbb" })).toEqual({
      kind: "current",
    });
    expect(judgeFolder(installed, { version: "dev", contentHash: "bbb" })).toMatchObject({
      kind: "unchecked",
    });
  });
});

describe("what the mode lets be done", () => {
  it("applies in auto, asks in manual, and holds a pinned or a blocked version", () => {
    expect(actionFor("auto", false)).toBe("apply");
    expect(actionFor("manual", false)).toBe("ask");
    expect(actionFor("pinned", false)).toBe("hold");
    expect(actionFor("auto", true)).toBe("hold");
    expect(actionFor("manual", true)).toBe("hold");
  });
});
