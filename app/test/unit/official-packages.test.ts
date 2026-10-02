// Setup's package step (plan 0022 §H, D17): it offers only the official packages that ship
// inside the app, read from the folder beside it. In 0.3.0 that is anytype alone; monty and
// innyrize have published no signed archives, so nothing offers them.
import fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { DeclaredPackageStore } from "../../src/adapters/fs/declared-package-store";
import { OFFICIAL_PACKAGE_LINES, shippedPackages } from "../../src/application/official-packages";
import type { ShippedDeclaration } from "../../src/ports/shipped-packages";
import { RecordingLogger } from "../fakes/children";

const REPO = path.resolve(__dirname, "..", "..", "..");
/** PACKAGE_ROOTS[0] when run from the repository: `<APP_DIR>/../packages`. */
const SHIPPED_ROOT = path.join(REPO, "packages");

function shippedVersion(name: string): string {
  const file = path.join(SHIPPED_ROOT, name, "inny-package.json");
  return (JSON.parse(fs.readFileSync(file, "utf8")) as { version: string }).version;
}

function source(documents: ShippedDeclaration[]): { documents: () => ShippedDeclaration[] } {
  return { documents: () => documents };
}

describe("the official packages shipped inside the app", () => {
  it("are the anytype package alone, read from the folder beside the app", () => {
    const store = new DeclaredPackageStore([SHIPPED_ROOT], new RecordingLogger());
    expect(shippedPackages(store)).toEqual([
      {
        name: "anytype",
        version: shippedVersion("anytype"),
        line: "files notes, tasks and links in Anytype.",
        official: true,
      },
    ]);
  });

  it("never offers monty or innyrize, which ship no signed archive yet", () => {
    const store = new DeclaredPackageStore([SHIPPED_ROOT], new RecordingLogger());
    const names = shippedPackages(store).map((offered) => offered.name);
    expect(names).not.toContain("monty");
    expect(names).not.toContain("innyrize");
  });

  it("has a line for every package bundled beside the app, so none is dropped unseen", () => {
    const store = new DeclaredPackageStore([SHIPPED_ROOT], new RecordingLogger());
    const bundled = store.documents().map((declared) => declared.name);
    expect(bundled.length).toBeGreaterThan(0);
    expect(bundled.filter((name) => !(name in OFFICIAL_PACKAGE_LINES))).toEqual([]);
  });

  it("leaves out a package with no line, or no version, and only that one", () => {
    expect(
      shippedPackages(
        source([
          { name: "anytype", document: { package: "anytype", version: "9.9.9" } },
          { name: "monty", document: { package: "monty", version: "1.0.0" } },
          { name: "constructor", document: { version: "1.0.0" } },
          { name: "anytype", document: { package: "anytype" } },
          { name: "anytype", document: { package: "anytype", version: 3 } },
          { name: "anytype", document: null },
          { name: "anytype", document: "not a declaration" },
        ]),
      ),
    ).toEqual([
      {
        name: "anytype",
        version: "9.9.9",
        line: OFFICIAL_PACKAGE_LINES["anytype"],
        official: true,
      },
    ]);
  });

  it("offers nothing when nothing ships beside the app", () => {
    expect(shippedPackages(source([]))).toEqual([]);
  });

  // Owner decisions 1 and 8 (docs 8d3ea8e): Setup has no Packages step any more; the shipped
  // packages are set up on their own, and ux-writing gives their rows no sentence. The line kept
  // here is shown nowhere until WI-0022-16 or -25 decides its place, and must not be read as a
  // Setup line meanwhile.
  it("is no longer the line of a Setup Packages step: ux-writing has none", () => {
    const writing = fs.readFileSync(path.join(REPO, "docs", "ux", "ux-writing.md"), "utf8");
    expect(writing.split("\n").filter((row) => row.startsWith("| Packages |"))).toEqual([]);
    expect(writing).not.toContain(`"*anytype*: ${OFFICIAL_PACKAGE_LINES["anytype"] ?? ""}"`);
  });
});
