// A package row's update facet from the update check's line (application/package-facets.ts): a
// version whose update failed here and was rolled back is blocked, with its reason, and never
// read as available, until a different version is listed.
import { describe, expect, it } from "vitest";
import { checkFacet, latestAsked } from "../../src/application/package-facets";
import type { ListedPackage, UpdateLine } from "../../src/application/install-package";
import type { InstalledRecord } from "../../src/ports/package-roots";

const CHECKED = new Date(2026, 9, 15, 9, 0).getTime();
const REASON = "instance vk of its types sent no ready within 30 s";

const listed = (update: UpdateLine | null): ListedPackage => ({
  name: "verkit",
  version: "0.2.0",
  kind: "installed",
  signed: true,
  from: "official",
  mode: "manual",
  update,
});

const failed: UpdateLine = { kind: "failed", version: "0.3.0", detail: REASON, apply: false };
const newer = (version: string): UpdateLine => ({
  kind: "newer",
  version,
  detail: null,
  apply: true,
});

const record: InstalledRecord = {
  package: "verkit",
  version: "0.2.0",
  contentHash: "hash",
  environment: "node",
  signed: true,
  origin: { kind: "catalogue", source: "official" },
};

describe("checkFacet", () => {
  it("reads a failed update as blocked, with its reason, never as available", () => {
    expect(checkFacet(listed(failed), CHECKED)).toEqual({
      state: "blocked",
      version: "0.3.0",
      reason: REASON,
      verifiedAt: new Date(CHECKED),
    });
  });

  it("offers a different version once it is listed", () => {
    expect(checkFacet(listed(newer("0.3.1")), CHECKED)).toEqual({
      state: "available",
      version: "0.3.1",
      verifiedAt: new Date(CHECKED),
    });
  });
});

describe("latestAsked", () => {
  // The board asked when Update was pressed, after the scheduled check: its own answer still
  // says the version is available, and the update then failed and was blocked.
  const mine = {
    at: CHECKED + 60_000,
    value: {
      update: { state: "available", version: "0.3.0", verifiedAt: new Date(CHECKED + 60_000) },
      unreadable: false,
    },
  } as const;

  it("says a blocked version though the board's own asking is newer", () => {
    expect(latestAsked(record, mine, listed(failed), CHECKED).update).toEqual({
      state: "blocked",
      version: "0.3.0",
      reason: REASON,
      verifiedAt: new Date(CHECKED + 60_000),
    });
  });

  it("says a blocked version before any scheduled check", () => {
    expect(latestAsked(record, mine, listed(failed), null).update?.state).toBe("blocked");
  });

  it("goes back to the newer asking once a different version is listed", () => {
    expect(latestAsked(record, mine, listed(newer("0.3.1")), CHECKED).update).toEqual(
      mine.value.update,
    );
  });
});
