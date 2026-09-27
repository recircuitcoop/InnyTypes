// Which old login item, if any, this platform has to remove (WI-0018-25).

import { describe, expect, it } from "vitest";
import { chooseLegacyLoginItem } from "../../src/adapters/electron/legacy-login-item";
import { LegacyLinuxAutostart } from "../../src/adapters/electron/legacy-login-item-linux";
import { LegacyMacLoginItem } from "../../src/adapters/electron/legacy-login-item-macos";

describe("chooseLegacyLoginItem", () => {
  it("macOS: the LaunchAgent", () => {
    expect(chooseLegacyLoginItem("darwin", "/Users/x", "/unused")).toBeInstanceOf(
      LegacyMacLoginItem,
    );
  });

  it("Linux: the autostart entry, in the same directory the new one uses", () => {
    expect(chooseLegacyLoginItem("linux", "/home/x", "/home/x/.config/autostart")).toBeInstanceOf(
      LegacyLinuxAutostart,
    );
  });

  it("Windows and anything else: none — unproven for this cutover (plan 0018 §10 risk 1)", () => {
    expect(chooseLegacyLoginItem("win32", "C:\\Users\\x", "/unused")).toBeNull();
  });
});
