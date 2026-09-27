// The `update` setting: the switch and channel domain/update/policy.ts judges (WI-0018-24).
import { describe, expect, it } from "vitest";
import {
  DEFAULT_UPDATE_POLICY,
  parseUpdatePolicy,
  UpdateSettingsError,
} from "../../src/domain/update/policy";

describe("parseUpdatePolicy", () => {
  it("is off by default, on the latest channel, when nothing is stored", () => {
    expect(parseUpdatePolicy(undefined)).toEqual(DEFAULT_UPDATE_POLICY);
    expect(DEFAULT_UPDATE_POLICY.autoCheck).toBe(false);
  });

  it("reads a stored switch and channel", () => {
    expect(parseUpdatePolicy({ auto_check: true, channel: "beta" })).toEqual({
      autoCheck: true,
      channel: "beta",
    });
  });

  it("fills in the default for whichever half is not stored", () => {
    expect(parseUpdatePolicy({ auto_check: true })).toEqual({ autoCheck: true, channel: "latest" });
    expect(parseUpdatePolicy({ channel: "beta" })).toEqual({ autoCheck: false, channel: "beta" });
  });

  it("refuses a setting that is not an object", () => {
    expect(() => parseUpdatePolicy("on")).toThrow(UpdateSettingsError);
    expect(() => parseUpdatePolicy(null)).toThrow(UpdateSettingsError);
    expect(() => parseUpdatePolicy([1])).toThrow(UpdateSettingsError);
  });

  it("refuses unknown keys", () => {
    expect(() => parseUpdatePolicy({ auto_check: true, extra: 1 })).toThrow(/unknown keys/);
  });

  it("refuses a non-boolean switch", () => {
    expect(() => parseUpdatePolicy({ auto_check: "yes" })).toThrow(/must be true or false/);
  });

  it("refuses a channel that could become an unsafe URL or file-name segment", () => {
    for (const bad of ["Latest", "../etc", "has space", "", "1beta", "beta/"]) {
      expect(() => parseUpdatePolicy({ channel: bad }), bad).toThrow(UpdateSettingsError);
    }
  });
});
