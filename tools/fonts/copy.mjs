// IBM Plex for the UI (plan 0022 §J): the woff2 files the stylesheet's @font-face rules name are
// copied from the pinned @fontsource packages into app/dist/ui/fonts, beside dist/ui/app.css,
// with each family's OFL-1.1 licence. Nothing is fetched at run time and nothing is committed:
// the packages are production dependencies, so the licences stage of the gate sees them.
//
//   node tools/fonts/copy.mjs
//
// The set copied is exactly what app/src/ui/styles/app.css declares: Plex Sans 400, 500 and
// 600 and Plex Mono 400, each in the latin and latin-ext subsets. A file missing from a package
// fails the build rather than leaving a face that silently falls back to the system font.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MODULES = path.join(REPO, "node_modules", "@fontsource");
const OUT = path.join(REPO, "app", "dist", "ui", "fonts");

const FAMILIES = [
  { package: "ibm-plex-sans", weights: [400, 500, 600] },
  { package: "ibm-plex-mono", weights: [400] },
];
const SUBSETS = ["latin", "latin-ext"];

fs.mkdirSync(OUT, { recursive: true });
for (const family of FAMILIES) {
  const from = path.join(MODULES, family.package);
  for (const weight of family.weights) {
    for (const subset of SUBSETS) {
      const file = `${family.package}-${subset}-${String(weight)}-normal.woff2`;
      fs.copyFileSync(path.join(from, "files", file), path.join(OUT, file));
    }
  }
  fs.copyFileSync(path.join(from, "LICENSE"), path.join(OUT, `${family.package}.LICENSE.txt`));
}
