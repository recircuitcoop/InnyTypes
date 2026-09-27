// Type declarations for select-signing.mjs, so test/unit/select-signing.test.ts can import it
// under strict TypeScript without electron-builder.yml's own build needing a TS toolchain
// (plan 0018 §1; WI-0018-24). Kept in sync by hand: the two exports are tiny and stable.

export const RELEASE_TEAM_ID: string;

export interface MacSigningDecision {
  readonly config: "electron-builder.release.yml" | "electron-builder.yml";
  readonly identity: string | null;
  readonly blocked: string | null;
}

export function chooseMacSigning(
  identityLines: readonly string[],
  teamId?: string,
): MacSigningDecision;
