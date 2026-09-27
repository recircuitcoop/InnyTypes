#!/usr/bin/env node
// Which mac packaging config to build with, and why (plan 0018 §1; WI-0018-24).
//
// As of 2026-09-27 the owner's keychain on this build machine has only an "Apple Development"
// identity for team TR744K6P28 — a development certificate, not the "Developer ID Application"
// certificate distribution and notarising need. So:
//
//   - with a Developer ID Application identity for team TR744K6P28 in the keychain (or a
//     CSC_LINK-provided one — electron-builder finds either the same way), build with
//     electron-builder.release.yml: signed for real, and notarised;
//   - without one, build with electron-builder.yml (ad-hoc, after-pack.cjs's own local
//     re-sign), and say plainly that notarising and the update proof are BLOCKED, naming
//     exactly what is missing, never a credential.
//
// `chooseMacSigning` is pure (a list of identity lines in, a decision out) so it is unit
// tested without `security` or a real keychain; `main` is the one place this file calls out.

/** Team TR744K6P28's own certificate: signing, notarising and the update proof depend on it. */
export const RELEASE_TEAM_ID = "TR744K6P28";

/**
 * `security find-identity -v -p codesigning`'s lines, decided into which electron-builder
 * config to build with and why a real release is blocked, when it is.
 */
export function chooseMacSigning(identityLines, teamId = RELEASE_TEAM_ID) {
  const developerId = identityLines.find(
    (line) => line.includes("Developer ID Application") && line.includes(teamId),
  );
  if (developerId !== undefined) {
    return { config: "electron-builder.release.yml", identity: developerId, blocked: null };
  }
  // "security find-identity" always ends with a "N valid identities found" summary line, even
  // when N is 0; that line names no certificate, so it is never itself "what was found".
  const found = identityLines.filter(
    (line) => line.trim() !== "" && !/^\s*\d+\s+valid identities? found\s*$/.test(line),
  );
  const detail =
    found.length === 0
      ? "no signing identity is in this keychain at all"
      : `this keychain has ${found.map((line) => line.trim()).join("; ")}, none of them a ` +
        `Developer ID Application certificate for team ${teamId}`;
  return {
    config: "electron-builder.yml",
    identity: null,
    blocked:
      `notarising and the update proof are BLOCKED: ${detail}. A Developer ID Application ` +
      "certificate for that team is needed to sign, plus an app-specific password or an API " +
      "key for notarytool to notarise (neither is a thing this script ever prints or stores).",
  };
}

async function main() {
  const { execFileSync } = await import("node:child_process");
  let raw;
  try {
    raw = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], {
      encoding: "utf8",
    });
  } catch (error) {
    // No `security` (not macOS), or no keychain reachable: the same as finding nothing.
    raw = "";
    process.stderr.write(
      `select-signing: could not run "security find-identity" (${String(error)}); treating this as no identity found.\n`,
    );
  }
  const decision = chooseMacSigning(raw.split("\n"));
  if (decision.blocked !== null) {
    process.stderr.write(`select-signing: ${decision.blocked}\n`);
  } else {
    process.stderr.write(`select-signing: signing with ${decision.identity?.trim() ?? ""}\n`);
  }
  process.stdout.write(`${decision.config}\n`);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  await main();
}
