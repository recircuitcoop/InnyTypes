// What Setup's package step offers (plan 0022 §H, owner decision D17: "Offer AnyType mcp only
// until then"): only the official packages that ship inside the app. In 0.3.0 that is the
// anytype and folder packages (D18: folder is the starter flow's source, WI-0022-25); monty and
// innyrize are offered once they publish signed archives and are bundled beside the app too.
//
// One source of truth for the offer: the packages actually found beside the app, each with the
// one-line description the screens show (docs/ux/ux-writing.md, "The first run", Packages).
// A shipped package with no line here is not offered, and a unit test fails for it, so a new
// package cannot be bundled without its sentence.

import type { ShippedPackageSource } from "../ports/shipped-packages";

/** The Packages step's row for each official package: "*name*: line" (ux-writing.md). */
export const OFFICIAL_PACKAGE_LINES: Readonly<Record<string, string>> = {
  anytype: "files notes, tasks and links in Anytype.",
  folder: "starts a run for each new file in a folder.",
};

/** One row of Setup's Packages step. */
export interface OfficialPackage {
  readonly name: string;
  readonly version: string;
  readonly line: string;
  readonly official: true;
}

/** The declaration's `version`, when it has one that is text. */
function versionOf(document: unknown): string | undefined {
  if (typeof document !== "object" || document === null || !("version" in document)) {
    return undefined;
  }
  return typeof document.version === "string" ? document.version : undefined;
}

/** Every official package shipped inside the app, by name, with its version and line. */
export function shippedPackages(source: ShippedPackageSource): OfficialPackage[] {
  return source.documents().flatMap((declared): OfficialPackage[] => {
    const line = Object.hasOwn(OFFICIAL_PACKAGE_LINES, declared.name)
      ? OFFICIAL_PACKAGE_LINES[declared.name]
      : undefined;
    const version = versionOf(declared.document);
    // Early outs: only a package with its line and a version is offered.
    if (line === undefined || version === undefined) {
      return [];
    }
    return [{ name: declared.name, version, line, official: true }];
  });
}
