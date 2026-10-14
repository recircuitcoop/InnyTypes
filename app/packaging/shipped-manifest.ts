// Build step (`npm run build:packages`): write the content hash of every package shipped with
// this app build into the bundle (application/shipped-manifest.ts). Usage:
//
//     node dist/build/shipped-manifest.cjs <out.json> <package root>...
//
// Each root is read as the app reads it at start (adapters/fs/declared-package-store.ts). It is
// build tooling beside the packaging config, not part of the app's own composition.
import fs from "node:fs";
import * as path from "node:path";
import { DeclaredPackageStore } from "../src/adapters/fs/declared-package-store";
import { FsPackageSource } from "../src/adapters/fs/package-source";
import { sha256Hex } from "../src/adapters/signature/digest";
import { shippedManifest } from "../src/application/shipped-manifest";

const [out, ...roots] = process.argv.slice(2);
if (out === undefined || roots.length === 0) {
  throw new Error("usage: shipped-manifest <out.json> <package root>...");
}
const say = (message: string) => {
  process.stderr.write(`${message}\n`);
};
// A folder that is not a package is said at INFO by the store: not news to a build.
const store = new DeclaredPackageStore(roots, { info: () => undefined, warn: say, error: say });
void shippedManifest(store.documents(), { source: new FsPackageSource(), sha256: sha256Hex }).then(
  (manifest) => {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
  },
);
