// The parity checker (plan 0018 §5.3), seen refusing. Each refusal the work item names has a
// committed fixture ledger in tools/parity/fixtures that breaks exactly one rule of the clean
// one, and each is asserted to fail for that reason alone, while the clean ledger passes.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  type CheckOptions,
  type TestStatuses,
  checkParity,
  describeUndecided,
  parseCsv,
  readJunitReport,
  readPlaywrightReport,
} from "../../../tools/parity/check";

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../tools/parity/fixtures",
);

const PASSED = "vitest:test/unit/a.test.ts::the thing works";

function options(ledger: string, overrides: Partial<CheckOptions> = {}): CheckOptions {
  return {
    ledger: path.join(FIXTURES, `${ledger}.csv`),
    oldTests: path.join(FIXTURES, "old-tests.txt"),
    proofs: path.join(FIXTURES, "proofs.csv"),
    vitest: [path.join(FIXTURES, "vitest.json")],
    vitestRoot: "/fixture-root",
    playwright: [],
    junit: [],
    final: false,
    wi: null,
    ...overrides,
  };
}

// Variants built from the clean fixture, for the rules the committed fixtures do not cover.
const scratch: string[] = [];

function scratchFile(name: string, text: string): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "inny-parity-"));
  scratch.push(directory);
  const file = path.join(directory, name);
  writeFileSync(file, text);
  return file;
}

function cleanWith(edit: (text: string) => string): string {
  return scratchFile("ledger.csv", edit(readFileSync(path.join(FIXTURES, "clean.csv"), "utf8")));
}

afterEach(() => {
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("the clean fixture ledger", () => {
  it("holds in normal mode, and counts its undecided row under its work item", () => {
    const result = checkParity(options("clean"));

    expect(result.errors).toEqual([]);
    expect(result.rows).toBe(4);
    expect(describeUndecided(result.undecidedByWi)).toEqual(["undecided: 1", "  WI-0018-03: 1"]);
  });
});

describe("each refusal the work item names, from its fixture ledger", () => {
  it("refuses a ported id that was skipped", () => {
    expect(checkParity(options("skipped-port")).errors).toEqual([
      "row tests/test_a.py::test_one: vitest:test/unit/a.test.ts::the thing is skipped did not pass in this gate (skipped)",
    ]);
  });

  it("refuses a ported id that does not exist", () => {
    expect(checkParity(options("nonexistent-port")).errors).toEqual([
      "row tests/test_a.py::test_one: vitest:test/unit/a.test.ts::a test nobody wrote did not run in this gate (missing from the vitest report)",
    ]);
  });

  it("refuses a retired row with no reason_code", () => {
    expect(checkParity(options("retired-without-reason-code")).errors).toEqual([
      "row tests/test_a.py::test_two[x]: a retired row needs a reason_code",
    ]);
  });

  it("refuses an owner-retired-behaviour row with no owner_ack", () => {
    expect(checkParity(options("missing-owner-ack")).errors).toEqual([
      'row tests/test_a.py::test_two[x]: owner-retired-behaviour needs owner_ack "yes"',
    ]);
  });

  it("refuses a duplicated row", () => {
    expect(checkParity(options("duplicated-row")).errors).toEqual([
      "duplicated row: tests/test_b.py::test_three appears 2 times",
    ]);
  });

  it("refuses a ledger missing an old id", () => {
    expect(checkParity(options("missing-old-id")).errors).toEqual([
      "old id missing from the ledger: tests/test_b.py::test_three",
    ]);
  });
});

describe("the rest of section 5.3", () => {
  it("refuses a ported id whose test is todo", () => {
    const ledger = cleanWith((text) =>
      text.replace(PASSED, "vitest:test/unit/a.test.ts::the thing is still to do"),
    );

    expect(checkParity({ ...options("clean"), ledger }).errors).toEqual([
      "row tests/test_a.py::test_one: vitest:test/unit/a.test.ts::the thing is still to do did not pass in this gate (todo)",
    ]);
  });

  it("refuses a ported id when this run produced no report of its kind", () => {
    expect(checkParity(options("clean", { vitest: [] })).errors).toEqual([
      `row tests/test_a.py::test_one: ${PASSED} cannot be proven: no vitest report was given to this run`,
    ]);
  });

  it("refuses an old-tests.txt whose sha256 is not the header's, and a row it does not list", () => {
    const listed = readFileSync(path.join(FIXTURES, "old-tests.txt"), "utf8");
    const oldTests = scratchFile("old-tests.txt", `${listed}tests/test_c.py::test_new\n`);

    const errors = checkParity(options("clean", { oldTests })).errors;

    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(
      /^.*old-tests\.txt has sha256 [0-9a-f]{64}, the ledger header records/,
    );
    expect(errors[1]).toBe("old id missing from the ledger: tests/test_c.py::test_new");
  });

  it("refuses a row that is not in old-tests.txt", () => {
    const ledger = cleanWith(
      (text) =>
        `${text}tests/test_z.py::test_ghost,tests/test_z.py,Ghost.,undecided,,,,,WI-0018-03\n`,
    );

    expect(checkParity({ ...options("clean"), ledger }).errors).toEqual([
      "not an id in old-tests.txt: tests/test_z.py::test_ghost",
    ]);
  });

  it("refuses every illegal field", () => {
    const ledger = cleanWith((text) =>
      text
        // The undecided row: an unknown fate, a wi that is not an item, a wrong old_file.
        .replace(
          "tests/test_b.py::test_three,tests/test_b.py,Not decided yet.,undecided,,,,,WI-0018-03",
          "tests/test_b.py::test_three,tests/test_a.py,Not decided yet.,maybe,,,,no,WI-3",
        )
        // The replaced row: a reason_code off the list, no reason, a proof nobody listed.
        .replace(
          "proof:quit,electron-builtin,Electron's app.quit does it; the quit proof shows it.",
          "proof:vanished;jest:a::b,electron-magic,",
        )
        // The ported row: no new test at all.
        .replace(PASSED, ""),
    );

    expect(checkParity({ ...options("clean"), ledger }).errors).toEqual([
      "row tests/test_a.py::test_one: a ported row names no new test",
      'row tests/test_b.py::test_four: reason_code "electron-magic" is not in the list',
      "row tests/test_b.py::test_four: a replaced row needs a reason",
      "row tests/test_b.py::test_four: proof:vanished is not in proofs.csv",
      'row tests/test_b.py::test_four: "jest:a::b" is not a vitest:, playwright:, pytest-sdk: or proof: id',
      'row tests/test_b.py::test_three: old_file "tests/test_a.py" is not the file of its old_id',
      'row tests/test_b.py::test_three: wi "WI-3" is not WI-0018-NN',
      'row tests/test_b.py::test_three: fate "maybe" is not one of undecided, ported, replaced, retired',
      'row tests/test_b.py::test_three: owner_ack must be "yes" or empty, not "no"',
    ]);
  });

  it("refuses a ledger whose header is not the columns of section 5.1", () => {
    const ledger = cleanWith((text) => text.replace("owner_ack,wi", "wi,owner_ack"));

    expect(checkParity({ ...options("clean"), ledger }).errors).toEqual([
      `${ledger}: header must be old_id,old_file,behaviour,fate,new_ids,reason_code,reason,owner_ack,wi`,
    ]);
  });
});

describe("--wi", () => {
  it("refuses an undecided row of that work item, named in full or short", () => {
    for (const wi of ["WI-0018-03", "WI-0018-03-shell-and-supervisor"]) {
      expect(checkParity(options("clean", { wi })).errors).toEqual([
        "row tests/test_b.py::test_three: undecided, and --wi WI-0018-03 allows none",
      ]);
    }
  });

  it("passes a work item with no undecided row", () => {
    expect(checkParity(options("clean", { wi: "WI-0018-01" })).errors).toEqual([]);
  });
});

describe("--final", () => {
  it("refuses any undecided row, and a proof that has not passed on every target", () => {
    expect(checkParity(options("clean", { final: true })).errors).toEqual([
      "row tests/test_b.py::test_four: proof:quit is todo on macos-arm64, --final needs pass",
      "row tests/test_b.py::test_four: proof:quit is todo on macos-x64, --final needs pass",
      "row tests/test_b.py::test_four: proof:quit is todo on linux-arm64, --final needs pass",
      "row tests/test_b.py::test_four: proof:quit is todo on linux-x64, --final needs pass",
      "row tests/test_b.py::test_four: proof:quit is blocked on windows-x64, --final needs pass",
      "row tests/test_b.py::test_three: undecided, and --final allows none",
    ]);
  });

  it("passes once every row is decided and every proof passed everywhere", () => {
    const ledger = cleanWith((text) =>
      text.replace(
        "Not decided yet.,undecided,,,,",
        "Not decided yet.,retired,,python-internal,Only Python needed it.,",
      ),
    );
    const proofs = scratchFile(
      "proofs.csv",
      readFileSync(path.join(FIXTURES, "proofs.csv"), "utf8").replace(
        /,(todo|blocked),/g,
        ",pass,",
      ),
    );

    expect(checkParity({ ...options("clean", { final: true }), ledger, proofs }).errors).toEqual(
      [],
    );
  });
});

describe("the reports", () => {
  it("reads Playwright's JSON: only an expected test passed", () => {
    const statuses: TestStatuses = new Map();
    readPlaywrightReport(
      JSON.stringify({
        suites: [
          {
            title: "smoke.e2e.ts",
            file: "smoke.e2e.ts",
            specs: [{ title: "opens", file: "smoke.e2e.ts", tests: [{ status: "expected" }] }],
            suites: [
              {
                title: "quit",
                file: "smoke.e2e.ts",
                specs: [
                  { title: "leaves nothing", file: "smoke.e2e.ts", tests: [{ status: "flaky" }] },
                  { title: "is skipped", file: "smoke.e2e.ts", tests: [{ status: "skipped" }] },
                ],
              },
            ],
          },
        ],
      }),
      statuses,
    );

    expect(Object.fromEntries(statuses)).toEqual({
      "playwright:smoke.e2e.ts::opens": ["passed"],
      "playwright:smoke.e2e.ts::quit > leaves nothing": ["flaky"],
      "playwright:smoke.e2e.ts::quit > is skipped": ["skipped"],
    });
  });

  it("reads pytest's JUnit XML back into node ids", () => {
    const statuses: TestStatuses = new Map();
    readJunitReport(
      `<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest">
        <testcase classname="tests.test_frames" name="test_start[a&amp;b]" time="0.1" />
        <testcase classname="tests.test_frames.TestClose" name="test_closed" time="0.1"></testcase>
        <testcase classname="tests.test_frames" name="test_later" time="0"><skipped message="x"/></testcase>
        <testcase classname="tests.test_frames" name="test_broken" time="0"><failure message="x">boom</failure></testcase>
      </testsuite></testsuites>`,
      statuses,
    );

    expect(Object.fromEntries(statuses)).toEqual({
      "pytest-sdk:tests/test_frames.py::test_start[a&b]": ["passed"],
      "pytest-sdk:tests/test_frames.py::TestClose::test_closed": ["passed"],
      "pytest-sdk:tests/test_frames.py::test_later": ["skipped"],
      "pytest-sdk:tests/test_frames.py::test_broken": ["failed"],
    });
  });

  it("parses RFC 4180 quoting, and keeps the header comments apart", () => {
    expect(parseCsv('# a comment\nx,y\r\n"a, ""b""","line\nbreak"\n')).toEqual({
      comments: ["# a comment"],
      records: [
        ["x", "y"],
        ['a, "b"', "line\nbreak"],
      ],
    });
  });
});
