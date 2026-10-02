// The flow templates' build check (tools/templates/check.mjs, plan 0022 §D), run as the build
// runs it: the shipped templates pass and are copied into the build; a fixture breaking every
// rule fails, naming each problem.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const APP = path.resolve(__dirname, "..", "..");
const CHECK = path.join(APP, "..", "tools", "templates", "check.mjs");

function check(...args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [CHECK, ...args], {
      cwd: APP,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (error) {
    const failed = error as { status: number; stderr: string };
    return { code: failed.status, out: failed.stderr };
  }
}

describe("the templates' build check", () => {
  it("passes the shipped templates and copies them where the build says", () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "inny-templates-"));
    try {
      fs.writeFileSync(path.join(out, "stale.json"), "[]");
      expect(check("templates", "--out", out)).toEqual({ code: 0, out: "templates: 2 checked\n" });
      expect(fs.readdirSync(out).sort()).toEqual([
        "blank.json",
        "index.json",
        "recordings-to-anytype.json",
      ]);
      const index = JSON.parse(fs.readFileSync(path.join(out, "index.json"), "utf8")) as {
        id: string;
        line: string;
        official: boolean;
      }[];
      expect(index.find((entry) => entry.id === "recordings-to-anytype")).toMatchObject({
        line: "transcribe, summarise, file, approve, send, schedule",
        official: true,
      });
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });

  it("checks app/templates when told no folder", () => {
    expect(check().code).toBe(0);
  });

  it("fails a fixture breaking every rule, naming each problem", () => {
    const { code, out } = check("test/fixtures/templates-bad");
    expect(code).toBe(1);
    const lines = out.trim().split("\n");
    expect(lines).toEqual([
      "templates: template two-tabs: holds 2 tabs; a template is exactly one",
      "templates: template leaky: the id n1 is used twice",
      "templates: template leaky: n2 is not on the template's tab",
      "templates: template leaky: holds credentials; a template never does",
      "templates: template strangers: f is of type function, which is neither Node-RED's core/common nor InnyTypes'",
      "templates: template strangers: m is of type inny-monty-watch, from the package monty it does not declare",
      "templates: template strangers: n is of type inny-anytype-nope, which the package anytype does not have",
      expect.stringMatching(/^templates: template absent: cannot be read as JSON/),
      "templates: index: the id leaky is listed twice",
      'templates: index: {"id":"Bad Id","name":"Bad","line":"x","packages":[],"official":true} is not {id, name, line, packages, official}',
      "templates: orphan.json: is not in the index",
    ]);
  });

  it("fails an index that is not a list, or not there", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inny-templates-"));
    try {
      expect(check(dir)).toMatchObject({
        code: 1,
        out: expect.stringContaining("index: cannot be read") as unknown,
      });
      fs.writeFileSync(path.join(dir, "index.json"), "{}");
      expect(check(dir)).toEqual({
        code: 1,
        out: "templates: index: is not a list of templates\n",
      });
      fs.writeFileSync(
        path.join(dir, "index.json"),
        JSON.stringify([{ id: "x", name: "X", line: "l", packages: [], official: true }]),
      );
      fs.writeFileSync(path.join(dir, "x.json"), JSON.stringify({ not: "a list" }));
      expect(check(dir)).toEqual({
        code: 1,
        out: "templates: template x: is not a list of nodes\n",
      });
      fs.writeFileSync(
        path.join(dir, "x.json"),
        JSON.stringify([{ id: "t", type: "tab" }, { z: "t" }]),
      );
      expect(check(dir)).toEqual({
        code: 1,
        out: "templates: template x: a node has no id or no type\n",
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
