// The licences stage of the gate (plan 0018 §6): every production dependency, in every
// workspace, carries an OSI-approved licence, or the gate is red.
//
// Why not `license-checker`: it reads only the root package's dependency tree and never
// follows npm workspaces, so the production dependencies of `app/` (Node-RED, later) would
// pass without ever being looked at. `npm query .prod` lists every package that is not a
// dev dependency, across the root and all workspaces, with the licence its manifest declares.
import { execFileSync } from "node:child_process";

// OSI-approved licences, by SPDX id (https://opensource.org/licenses). Extend only with an
// id that is on the OSI list; a licence that is not is a finding, not a configuration.
const OSI_APPROVED = new Set([
  "0BSD",
  "AFL-3.0",
  "Apache-2.0",
  "Artistic-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BSL-1.0",
  "EPL-2.0",
  "ISC",
  "LGPL-2.1-only",
  "LGPL-2.1-or-later",
  "LGPL-3.0-only",
  "LGPL-3.0-or-later",
  "MIT",
  "MIT-0",
  "MPL-2.0",
  "Python-2.0",
  "Unlicense",
  "UPL-1.0",
  "Zlib",
]);

/** The licence a manifest declares, as one SPDX expression, or null when it declares none. */
function declaredLicence(manifest) {
  const licence = manifest.license;
  if (typeof licence === "string" && licence.trim() !== "") {
    return licence.trim();
  }
  // Old manifests spell it as an object: { "type": "MIT", "url": "..." }.
  if (licence !== null && typeof licence === "object" && typeof licence.type === "string") {
    return licence.type;
  }
  return null;
}

/**
 * Whether an SPDX expression is satisfied by OSI-approved licences alone.
 *
 * `A OR B` needs one approved alternative and `A AND B` needs both. An expression mixing the
 * two is judged conservatively: every id in it must be approved.
 */
function isOsiApproved(expression) {
  const ids = expression
    .replace(/[()]/g, " ")
    .split(/\s+/)
    .filter((token) => token !== "");
  const hasOr = ids.includes("OR");
  const hasAnd = ids.includes("AND");
  const licences = ids.filter((token) => token !== "OR" && token !== "AND");
  if (licences.length === 0) {
    return false;
  }
  if (hasOr && !hasAnd) {
    return licences.some((id) => OSI_APPROVED.has(id));
  }
  return licences.every((id) => OSI_APPROVED.has(id));
}

function main() {
  const output = execFileSync("npm", ["query", ".prod"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const packages = JSON.parse(output);

  const refused = [];
  for (const manifest of packages) {
    const licence = declaredLicence(manifest);
    const where = manifest.location === "" ? "(root)" : manifest.location;
    if (licence === null) {
      refused.push(`${manifest.name}@${manifest.version} at ${where}: no licence declared`);
      continue;
    }
    if (!isOsiApproved(licence)) {
      refused.push(`${manifest.name}@${manifest.version} at ${where}: ${licence}`);
    }
  }

  if (refused.length > 0) {
    console.error(`licences: ${refused.length} production package(s) without an OSI licence:`);
    for (const line of refused) {
      console.error(`  ${line}`);
    }
    process.exit(1);
  }
  console.log(`licences: ${packages.length} production packages, every one OSI-approved`);
}

main();
