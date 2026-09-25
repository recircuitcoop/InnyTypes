// The parity ledger's gate check (plan 0018 §5.3).
//
// A ledger the gate does not check is a list of intentions, and a ported test that did not
// run proves nothing. So this refuses, in every gate run:
//
// * a row set that is not exactly old-tests.txt, an old-tests.txt whose sha256 is not the one
//   in the ledger's header comment, and any old_id that appears twice;
// * any illegal field: an unknown fate, a replaced or retired row without a reason_code from
//   the list or without a reason, an owner-retired-behaviour row without owner_ack "yes", a
//   ported or replaced row that names no new test, an old_file that is not its old_id's file;
// * any vitest:, playwright: or pytest-sdk: id in new_ids that is not in this run's reports
//   with status passed (skipped, todo and missing all fail), and any proof: id that is not a
//   row of proofs.csv.
//
// Modes: normal allows undecided rows and prints how many each work item still has. --final
// allows none, and requires every referenced proof to pass on every required target.
// --wi WI-0018-NN adds "no undecided row with this wi" to whichever mode runs.
//
// Runs as plain Node (type stripping), so it imports nothing but node: modules.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const LEDGER_COLUMNS = [
  "old_id",
  "old_file",
  "behaviour",
  "fate",
  "new_ids",
  "reason_code",
  "reason",
  "owner_ack",
  "wi",
] as const;

export const PROOF_COLUMNS = [
  "proof_id",
  "behaviour",
  "os",
  "arch",
  "status",
  "app_version",
  "commit",
  "date",
  "script",
  "evidence",
] as const;

export const FATES = ["undecided", "ported", "replaced", "retired"] as const;

export const REASON_CODES = [
  "toga-ui",
  "node-config-replaces-plugin-settings",
  "helper-host-split-gone",
  "pid-file-signalling-gone",
  "event-bus-replaced-by-wires",
  "briefcase-packaging",
  "python-internal",
  "cli-removed",
  "electron-builtin",
  "node-red-builtin",
  "owner-retired-behaviour",
] as const;

export const PROOF_STATUSES = ["todo", "pass", "fail", "blocked"] as const;

/** The targets every referenced proof must pass on in --final mode, as os-arch. */
export const REQUIRED_TARGETS = [
  "macos-arm64",
  "macos-x64",
  "linux-arm64",
  "linux-x64",
  "windows-x64",
] as const;

/** The header comment line of ledger.csv that carries the sha256 of old-tests.txt. */
export const SHA_COMMENT = "# old-tests.txt sha256: ";

/** The kinds of new id a report can prove, and the prefix each is written with. */
const REPORTED_KINDS = ["vitest", "playwright", "pytest-sdk"] as const;
type ReportedKind = (typeof REPORTED_KINDS)[number];

/** Every test id a report names, with each status it had (one per project or repeat). */
export type TestStatuses = Map<string, string[]>;

// --- CSV (RFC 4180) --------------------------------------------------------------------------

/**
 * The records of an RFC 4180 document: quoted fields may hold commas, quotes ("") and line
 * breaks. Comment lines starting with "#" before the first record are skipped, and returned.
 */
export function parseCsv(text: string): { comments: string[]; records: string[][] } {
  const comments: string[] = [];
  let start = 0;
  while (text.startsWith("#", start)) {
    const end = text.indexOf("\n", start);
    comments.push(text.slice(start, end === -1 ? text.length : end).replace(/\r$/, ""));
    start = end === -1 ? text.length : end + 1;
  }

  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let index = start;
  while (index < text.length) {
    const char = text.charAt(index);
    if (quoted) {
      if (char === '"' && text.charAt(index + 1) === '"') {
        field += '"';
        index += 2;
        continue;
      }
      if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      if (char === "\r" && text.charAt(index + 1) === "\n") {
        index += 1;
      }
    } else {
      field += char;
    }
    index += 1;
  }
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return { comments, records };
}

// --- reports ---------------------------------------------------------------------------------

function add(statuses: TestStatuses, id: string, status: string): void {
  const seen = statuses.get(id);
  if (seen === undefined) {
    statuses.set(id, [status]);
  } else {
    seen.push(status);
  }
}

function toPosix(location: string): string {
  return location.split(path.sep).join("/");
}

interface VitestReport {
  testResults: {
    name: string;
    assertionResults: { fullName: string; status: string }[];
  }[];
}

/**
 * vitest's JSON reporter: `vitest:<file relative to root>::<fullName>`. Statuses are vitest's
 * own: passed, failed, skipped, pending, todo.
 */
export function readVitestReport(text: string, root: string, into: TestStatuses): void {
  const report = JSON.parse(text) as VitestReport;
  for (const file of report.testResults) {
    const relative = toPosix(path.relative(root, file.name));
    for (const test of file.assertionResults) {
      add(into, `vitest:${relative}::${test.fullName}`, test.status);
    }
  }
}

interface PlaywrightSuite {
  title: string;
  file: string;
  specs?: { title: string; file: string; tests: { status: string }[] }[];
  suites?: PlaywrightSuite[];
}

/**
 * Playwright's JSON reporter: `playwright:<file>::<describe > ... > test title>`. A test passes
 * only when Playwright calls it "expected"; "flaky", "skipped" and "unexpected" do not.
 */
export function readPlaywrightReport(text: string, into: TestStatuses): void {
  const report = JSON.parse(text) as { suites: PlaywrightSuite[] };

  function visit(suite: PlaywrightSuite, titles: string[]): void {
    for (const spec of suite.specs ?? []) {
      const id = `playwright:${spec.file}::${[...titles, spec.title].join(" > ")}`;
      if (spec.tests.length === 0) {
        add(into, id, "missing");
      }
      for (const test of spec.tests) {
        add(into, id, test.status === "expected" ? "passed" : test.status);
      }
    }
    for (const child of suite.suites ?? []) {
      visit(child, [...titles, child.title]);
    }
  }

  // The top-level suites are the files; their titles are not part of the title path.
  for (const file of report.suites) {
    visit(file, []);
  }
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return match?.[1] === undefined ? null : decodeXml(match[1]);
}

/**
 * pytest's JUnit XML: `pytest-sdk:<node id>`. pytest writes `classname="tests.test_x.Cls"`,
 * so the node id is rebuilt from it: trailing segments that start with a capital are
 * classes, the rest is the module's path. A testcase with <skipped>, <failure> or <error>
 * inside is not passed.
 */
export function readJunitReport(text: string, into: TestStatuses): void {
  const testcase = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const match of text.matchAll(testcase)) {
    const tag = match[1] ?? "";
    const body = match[3] ?? "";
    const classname = attribute(tag, "classname") ?? "";
    const name = attribute(tag, "name") ?? "";
    const segments = classname.split(".");
    const classes: string[] = [];
    while (segments.length > 1 && /^[A-Z]/.test(segments[segments.length - 1] ?? "")) {
      classes.unshift(segments.pop() ?? "");
    }
    const nodeId = [`${segments.join("/")}.py`, ...classes, name].join("::");
    const status = /<skipped\b/.test(body)
      ? "skipped"
      : /<(failure|error)\b/.test(body)
        ? "failed"
        : "passed";
    add(into, `pytest-sdk:${nodeId}`, status);
  }
}

// --- the check -------------------------------------------------------------------------------

export interface CheckOptions {
  ledger: string;
  oldTests: string;
  proofs: string;
  /** vitest JSON reports, and the directory their file paths are made relative to. */
  vitest: readonly string[];
  vitestRoot: string;
  playwright: readonly string[];
  junit: readonly string[];
  final: boolean;
  /** WI-0018-NN (a longer work item id is cut to that); null when not asked. */
  wi: string | null;
}

export interface CheckResult {
  errors: string[];
  rows: number;
  /** Undecided rows per wi; the empty string is rows with no wi. */
  undecidedByWi: Map<string, number>;
}

/** WI-0018-03-shell-and-supervisor and WI-0018-03 both name WI-0018-03. */
export function normaliseWi(wi: string): string {
  return /^WI-\d{4}-\d{2}/.exec(wi)?.[0] ?? wi;
}

function isOneOf<T extends string>(list: readonly T[], value: string): value is T {
  return (list as readonly string[]).includes(value);
}

function sameColumns(header: string[] | undefined, expected: readonly string[]): boolean {
  return header !== undefined && header.join(",") === expected.join(",");
}

interface Proofs {
  /** proof_id → status per os-arch target. */
  byId: Map<string, Map<string, string>>;
  errors: string[];
}

function readProofs(file: string): Proofs {
  const { records } = parseCsv(readFileSync(file, "utf8"));
  const [header, ...rows] = records;
  const byId = new Map<string, Map<string, string>>();
  const errors: string[] = [];
  if (!sameColumns(header, PROOF_COLUMNS)) {
    return { byId, errors: [`${file}: header must be ${PROOF_COLUMNS.join(",")}`] };
  }
  for (const [index, row] of rows.entries()) {
    const [proofId = "", , os = "", arch = "", status = ""] = row;
    const where = `${file} row ${String(index + 2)} (${proofId})`;
    if (row.length !== PROOF_COLUMNS.length) {
      errors.push(
        `${where}: ${String(row.length)} fields, expected ${String(PROOF_COLUMNS.length)}`,
      );
      continue;
    }
    if (!isOneOf(PROOF_STATUSES, status)) {
      errors.push(`${where}: status "${status}" is not one of ${PROOF_STATUSES.join(", ")}`);
    }
    const targets = byId.get(proofId) ?? new Map<string, string>();
    const target = `${os}-${arch}`;
    if (targets.has(target)) {
      errors.push(`${where}: a second row for ${target}`);
    }
    targets.set(target, status);
    byId.set(proofId, targets);
  }
  return { byId, errors };
}

function readReports(options: CheckOptions): Map<ReportedKind, TestStatuses | null> {
  const reports = new Map<ReportedKind, TestStatuses | null>(
    REPORTED_KINDS.map((kind) => [kind, null]),
  );
  const collect = (
    kind: ReportedKind,
    files: readonly string[],
    read: (text: string, into: TestStatuses) => void,
  ): void => {
    if (files.length === 0) {
      return;
    }
    const statuses: TestStatuses = new Map();
    for (const file of files) {
      read(readFileSync(file, "utf8"), statuses);
    }
    reports.set(kind, statuses);
  };
  collect("vitest", options.vitest, (text, into) => {
    readVitestReport(text, options.vitestRoot, into);
  });
  collect("playwright", options.playwright, readPlaywrightReport);
  collect("pytest-sdk", options.junit, readJunitReport);
  return reports;
}

/** Every refusal of §5.3 for one ledger, in one list; an empty list is a pass. */
export function checkParity(options: CheckOptions): CheckResult {
  const errors: string[] = [];
  const undecidedByWi = new Map<string, number>();

  // --- the row set is exact ---
  const oldTestsText = readFileSync(options.oldTests, "utf8");
  const oldIds = oldTestsText.split("\n").filter((line) => line !== "");
  const sha256 = createHash("sha256").update(oldTestsText).digest("hex");

  const { comments, records } = parseCsv(readFileSync(options.ledger, "utf8"));
  const recorded = comments.find((line) => line.startsWith(SHA_COMMENT))?.slice(SHA_COMMENT.length);
  if (recorded === undefined) {
    errors.push(`${options.ledger}: no "${SHA_COMMENT}<hex>" header comment`);
  } else if (recorded.trim() !== sha256) {
    errors.push(
      `${options.oldTests} has sha256 ${sha256}, the ledger header records ${recorded.trim()}`,
    );
  }

  const [header, ...rows] = records;
  if (!sameColumns(header, LEDGER_COLUMNS)) {
    errors.push(`${options.ledger}: header must be ${LEDGER_COLUMNS.join(",")}`);
    return { errors, rows: 0, undecidedByWi };
  }

  const seen = new Map<string, number>();
  for (const row of rows) {
    const oldId = row[0] ?? "";
    seen.set(oldId, (seen.get(oldId) ?? 0) + 1);
  }
  for (const [oldId, count] of seen) {
    if (count > 1) {
      errors.push(`duplicated row: ${oldId} appears ${String(count)} times`);
    }
  }
  const oldSet = new Set(oldIds);
  for (const oldId of oldIds) {
    if (!seen.has(oldId)) {
      errors.push(`old id missing from the ledger: ${oldId}`);
    }
  }
  for (const oldId of seen.keys()) {
    if (!oldSet.has(oldId)) {
      errors.push(`not an id in old-tests.txt: ${oldId}`);
    }
  }

  // --- every field is legal, and every new id proven ---
  const proofs = readProofs(options.proofs);
  errors.push(...proofs.errors);
  const reports = readReports(options);
  const wanted = options.wi === null ? null : normaliseWi(options.wi);

  for (const row of rows) {
    const [
      oldId = "",
      oldFile = "",
      ,
      fate = "",
      newIds = "",
      reasonCode = "",
      reason = "",
      ownerAck = "",
      wi = "",
    ] = row;
    const where = `row ${oldId}`;
    if (row.length !== LEDGER_COLUMNS.length) {
      errors.push(
        `${where}: ${String(row.length)} fields, expected ${String(LEDGER_COLUMNS.length)}`,
      );
      continue;
    }
    if (oldFile !== oldId.split("::")[0]) {
      errors.push(`${where}: old_file "${oldFile}" is not the file of its old_id`);
    }
    if (!/^(WI-0018-\d{2})?$/.test(wi)) {
      errors.push(`${where}: wi "${wi}" is not WI-0018-NN`);
    }
    if (!isOneOf(FATES, fate)) {
      errors.push(`${where}: fate "${fate}" is not one of ${FATES.join(", ")}`);
    }
    if (ownerAck !== "" && ownerAck !== "yes") {
      errors.push(`${where}: owner_ack must be "yes" or empty, not "${ownerAck}"`);
    }
    if (reasonCode !== "" && !isOneOf(REASON_CODES, reasonCode)) {
      errors.push(`${where}: reason_code "${reasonCode}" is not in the list`);
    }
    if (fate === "replaced" || fate === "retired") {
      if (reasonCode === "") {
        errors.push(`${where}: a ${fate} row needs a reason_code`);
      }
      if (reason.trim() === "") {
        errors.push(`${where}: a ${fate} row needs a reason`);
      }
    }
    if (reasonCode === "owner-retired-behaviour" && ownerAck !== "yes") {
      errors.push(`${where}: owner-retired-behaviour needs owner_ack "yes"`);
    }

    const ids = newIds
      .split(";")
      .map((id) => id.trim())
      .filter((id) => id !== "");
    if ((fate === "ported" || fate === "replaced") && ids.length === 0) {
      errors.push(`${where}: a ${fate} row names no new test`);
    }
    for (const id of ids) {
      errors.push(...checkNewId(id, where, reports, proofs, options.final));
    }

    if (fate === "undecided") {
      undecidedByWi.set(wi, (undecidedByWi.get(wi) ?? 0) + 1);
      if (options.final) {
        errors.push(`${where}: undecided, and --final allows none`);
      } else if (wanted !== null && wi === wanted) {
        errors.push(`${where}: undecided, and --wi ${wanted} allows none`);
      }
    }
  }

  return { errors, rows: rows.length, undecidedByWi };
}

function checkNewId(
  id: string,
  where: string,
  reports: Map<ReportedKind, TestStatuses | null>,
  proofs: Proofs,
  final: boolean,
): string[] {
  const kind = id.slice(0, id.indexOf(":"));
  if (kind === "proof") {
    const proofId = id.slice("proof:".length);
    const targets = proofs.byId.get(proofId);
    if (targets === undefined) {
      return [`${where}: ${id} is not in proofs.csv`];
    }
    if (!final) {
      return [];
    }
    return REQUIRED_TARGETS.filter((target) => targets.get(target) !== "pass").map(
      (target) =>
        `${where}: ${id} is ${targets.get(target) ?? "missing"} on ${target}, --final needs pass`,
    );
  }
  if (!isOneOf(REPORTED_KINDS, kind)) {
    return [`${where}: "${id}" is not a vitest:, playwright:, pytest-sdk: or proof: id`];
  }
  const report = reports.get(kind) ?? null;
  if (report === null) {
    return [`${where}: ${id} cannot be proven: no ${kind} report was given to this run`];
  }
  const statuses = report.get(id);
  if (statuses === undefined) {
    return [`${where}: ${id} did not run in this gate (missing from the ${kind} report)`];
  }
  const failed = statuses.filter((status) => status !== "passed");
  if (failed.length > 0) {
    return [`${where}: ${id} did not pass in this gate (${failed.join(", ")})`];
  }
  return [];
}

// --- command line ----------------------------------------------------------------------------

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The per-WI undecided counts, one line each, the way the gate prints them. */
export function describeUndecided(undecidedByWi: Map<string, number>): string[] {
  const total = [...undecidedByWi.values()].reduce((sum, count) => sum + count, 0);
  return [
    `undecided: ${String(total)}`,
    ...[...undecidedByWi.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([wi, count]) => `  ${wi === "" ? "(no wi)" : wi}: ${String(count)}`),
  ];
}

function main(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      final: { type: "boolean", default: false },
      wi: { type: "string" },
      ledger: { type: "string", default: path.join(REPO, "docs/parity/ledger.csv") },
      "old-tests": { type: "string", default: path.join(REPO, "docs/parity/old-tests.txt") },
      proofs: { type: "string", default: path.join(REPO, "docs/parity/proofs.csv") },
      vitest: { type: "string", multiple: true, default: [] },
      "vitest-root": { type: "string", default: path.join(REPO, "app") },
      playwright: { type: "string", multiple: true, default: [] },
      junit: { type: "string", multiple: true, default: [] },
    },
  });

  const result = checkParity({
    ledger: values.ledger,
    oldTests: values["old-tests"],
    proofs: values.proofs,
    vitest: values.vitest,
    vitestRoot: values["vitest-root"],
    playwright: values.playwright,
    junit: values.junit,
    final: values.final,
    wi: values.wi ?? null,
  });

  const mode = values.final ? "--final" : "normal";
  console.log(
    `parity (${mode}${values.wi === undefined ? "" : `, --wi ${values.wi}`}): ${String(result.rows)} rows`,
  );
  for (const line of describeUndecided(result.undecidedByWi)) {
    console.log(line);
  }
  for (const error of result.errors) {
    console.error(`REFUSED ${error}`);
  }
  if (result.errors.length > 0) {
    console.error(`parity: ${String(result.errors.length)} refusal(s)`);
    return 1;
  }
  console.log("parity: ledger holds");
  return 0;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main(process.argv.slice(2));
}
