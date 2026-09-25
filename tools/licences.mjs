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

/**
 * Packages the check would refuse, each let through by exact name and version, with the evidence
 * and the reason. A new version of any of them is not on this list and turns the stage red again.
 * Every run prints this list, so it stays in sight.
 *
 * `expires` marks an exception that must disappear with a planned change. The three below are
 * data files of the npm CLI that @node-red/registry bundles; WI-0018-23 removes npm from the
 * built app.
 * TODO(WI-0018-23): once the bundle excludes npm, fail when an entry with `expires` still
 * matches a package in the built app's production tree.
 */
const EXCEPTIONS = [
  {
    package: "cli-table@0.3.11",
    evidence:
      "manifest declares none; README states MIT (node_modules/cli-table/README.md, and its " +
      "LICENSE file; upstream https://github.com/Automattic/cli-table)",
    reason: "a dependency of node-red-admin, which Node-RED 5.0.7 depends on",
  },
  {
    package: "pause@0.0.1",
    evidence:
      "manifest declares none; README states MIT (node_modules/pause/Readme.md; upstream " +
      "https://www.npmjs.com/package/pause/v/0.0.1)",
    reason: "a dependency of passport, which @node-red/editor-api 5.0.7 depends on",
  },
  {
    package: "qrcode-terminal@0.12.0",
    evidence:
      'manifest says "Apache 2.0", which is Apache-2.0 misspelt (node_modules/npm/node_modules/' +
      "qrcode-terminal/LICENSE; upstream https://github.com/gtanner/qrcode-terminal)",
    reason: "bundled inside the npm CLI that @node-red/registry depends on",
    expires: "WI-0018-23 removes npm from the bundle",
  },
  {
    package: "spdx-exceptions@2.5.0",
    evidence:
      "CC-BY-3.0, not OSI-approved: a JSON list of SPDX exception ids, data rather than code " +
      "(upstream https://github.com/kemitchell/spdx-exceptions.json)",
    reason: "bundled inside the npm CLI that @node-red/registry depends on",
    expires: "WI-0018-23 removes npm from the bundle",
  },
  {
    package: "spdx-license-ids@3.0.23",
    evidence:
      "CC0-1.0, not OSI-approved: a JSON list of SPDX licence ids, data rather than code " +
      "(upstream https://github.com/jslicense/spdx-license-ids)",
    reason: "bundled inside the npm CLI that @node-red/registry depends on",
    expires: "WI-0018-23 removes npm from the bundle",
  },
];

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
  // Older ones still use a `licenses` array of those objects (Node-RED's busboy, passport-*).
  // Judged conservatively: every licence listed must be approved, as if joined by AND.
  const listed = manifest.licenses;
  if (
    Array.isArray(listed) &&
    listed.length > 0 &&
    listed.every((entry) => entry !== null && typeof entry?.type === "string")
  ) {
    return listed.map((entry) => entry.type.trim()).join(" AND ");
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

  const excepted = new Map(EXCEPTIONS.map((exception) => [exception.package, exception]));
  const used = new Set();
  const refused = [];
  for (const manifest of packages) {
    const licence = declaredLicence(manifest);
    const where = manifest.location === "" ? "(root)" : manifest.location;
    if (licence !== null && isOsiApproved(licence)) {
      continue;
    }
    const id = `${manifest.name}@${manifest.version}`;
    if (excepted.has(id)) {
      used.add(id);
      continue;
    }
    refused.push(`${id} at ${where}: ${licence ?? "no licence declared"}`);
  }

  // The list stays exact: an exception that matches no package that needs it is refused too.
  for (const exception of EXCEPTIONS) {
    if (!used.has(exception.package)) {
      refused.push(`${exception.package}: an exception that no longer matches; remove it`);
    }
  }

  console.log(`licences: ${EXCEPTIONS.length} exception(s), by exact name and version:`);
  for (const exception of EXCEPTIONS) {
    const expiry = exception.expires === undefined ? "" : ` [expires: ${exception.expires}]`;
    console.log(`  ${exception.package}: ${exception.evidence}; ${exception.reason}${expiry}`);
  }

  if (refused.length > 0) {
    console.error(`licences: ${refused.length} refusal(s):`);
    for (const line of refused) {
      console.error(`  ${line}`);
    }
    process.exit(1);
  }
  console.log(
    `licences: ${packages.length} production packages, every one OSI-approved or excepted above`,
  );
}

main();
