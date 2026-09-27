// Which mac packaging config to build with (WI-0018-24): pure, so no real keychain is needed
// to prove it picks correctly given what "security find-identity" would print.
import { describe, expect, it } from "vitest";
import { chooseMacSigning, RELEASE_TEAM_ID } from "../../packaging/select-signing.mjs";

// A real fingerprint is 40 hex characters; tests/test_no_secrets.py treats a bare one as
// credential-shaped, so this placeholder is deliberately not hex-only.
const FAKE_FINGERPRINT = "not-a-real-fingerprint";

describe("chooseMacSigning", () => {
  it("builds the release config when a Developer ID Application identity for the team exists", () => {
    const lines = [
      `  1) ${FAKE_FINGERPRINT} "Developer ID Application: Someone (TR744K6P28)"`,
      "     1 valid identities found",
    ];
    const decision = chooseMacSigning(lines);
    expect(decision).toMatchObject({ config: "electron-builder.release.yml", blocked: null });
  });

  it("blocks, naming the gap, when only Apple Development is in the keychain", () => {
    const lines = [
      `  1) ${FAKE_FINGERPRINT} "Apple Development: owner@example.com (TR744K6P28)"`,
      "     1 valid identities found",
    ];
    const decision = chooseMacSigning(lines);
    expect(decision.config).toBe("electron-builder.yml");
    expect(decision.blocked).toContain("Developer ID Application");
    expect(decision.blocked).toContain("Apple Development: owner@example.com (TR744K6P28)");
  });

  it("never prints a password, app-specific password value or API key, only that one is needed", () => {
    const decision = chooseMacSigning([]);
    expect(decision.blocked).toContain("app-specific password");
    expect(decision.blocked).toContain("notarytool");
    expect(decision.blocked).not.toMatch(/@|-----BEGIN/);
  });

  it("blocks, naming that nothing at all is found, when the keychain has no identity", () => {
    const decision = chooseMacSigning(["   0 valid identities found"]);
    expect(decision.config).toBe("electron-builder.yml");
    expect(decision.blocked).toContain("no signing identity is in this keychain at all");
  });

  it("does not match a Developer ID Application certificate for a different team", () => {
    const lines = ['"Developer ID Application: Someone Else (OTHERTEAM1)"'];
    const decision = chooseMacSigning(lines, RELEASE_TEAM_ID);
    expect(decision.config).toBe("electron-builder.yml");
  });
});
