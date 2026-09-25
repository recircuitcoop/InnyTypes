// domain/packages/environment.ts: what environment a verified package gets, judged on its
// files before anything is built (spec 2.3.3). Python 3.13 only; a node package never needs
// npm; an executable's binary matches the sha256 its declaration states.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { PackageRefusal } from "../../src/domain/packages/archive";
import type { Declaration } from "../../src/domain/packages/declaration";
import {
  installSteps,
  packageManagerCommands,
  planEnvironment,
  type EnvironmentPlan,
} from "../../src/domain/packages/environment";

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const TARGET = { platform: "darwin", arch: "arm64" };
const HASH = `sha256:${"a".repeat(64)}`;

function declaration(
  environment: Declaration["environment"],
  command: Declaration["types"][number]["command"] = ["{python}", "{package}/node.py"],
): Declaration {
  return {
    protocol: 2,
    package: "monty",
    version: "0.1.0",
    ...(environment === undefined ? {} : { environment }),
    types: [{ id: "watch", kind: "source", label: "Watch", command, config: {}, outputs: [] }],
  };
}

function plan(d: Declaration, files: Record<string, string | Uint8Array> = {}): EnvironmentPlan {
  const map = new Map(
    Object.entries(files).map(([file, value]) => [
      file,
      typeof value === "string" ? text(value) : value,
    ]),
  );
  return planEnvironment(d, map, TARGET, sha256);
}

function refusal(d: Declaration, files: Record<string, string | Uint8Array> = {}): string {
  try {
    plan(d, files);
  } catch (error) {
    expect(error).toBeInstanceOf(PackageRefusal);
    expect((error as PackageRefusal).reason).toBe("environment");
    return (error as Error).message;
  }
  throw new Error("the package was accepted");
}

describe("uv-python", () => {
  it("plans the bundled Python 3.13 with the package's parsed lock", () => {
    const planned = plan(declaration({ kind: "uv-python", python: "3.13" }), {
      "requirements.lock": `alpha==1.0 --hash=${HASH}\n`,
    });
    expect(planned).toEqual({
      kind: "uv-python",
      python: "3.13",
      lock: { requirements: [{ name: "alpha", version: "1.0", hashes: [HASH] }] },
    });
  });

  it("plans no lock for a package that ships none, and 3.13 when none is named", () => {
    expect(plan(declaration({ kind: "uv-python" }))).toEqual({
      kind: "uv-python",
      python: "3.13",
      lock: null,
    });
  });

  it.each(["3.12", "3.14", ">=3.11", "3"])("refuses Python %j, with a reason", (python) => {
    expect(refusal(declaration({ kind: "uv-python", python }))).toBe(
      `monty: it asks for Python ${python}, and InnyTypes provides Python 3.13 only; ` +
        'declare "python": "3.13"',
    );
  });

  it("refuses a lock that breaks a rule, naming the rule", () => {
    expect(
      refusal(declaration({ kind: "uv-python" }), { "requirements.lock": "alpha>=1\n" }),
    ).toMatch(/^monty: requirements\.lock: line 1: "alpha>=1" is not an exact pin/);
  });

  it("refuses a lock that is not UTF-8", () => {
    expect(
      refusal(declaration({ kind: "uv-python" }), {
        "requirements.lock": Uint8Array.from([0xff, 0xfe]),
      }),
    ).toBe("monty: requirements.lock: not UTF-8 text");
  });
});

describe("node", () => {
  const node = (
    command: Declaration["types"][number]["command"] = ["{node}", "{package}/node.js"],
  ) => declaration({ kind: "node", node: ">=22" }, command);

  it("plans nothing to build for pre-bundled JavaScript", () => {
    expect(
      plan(node(), {
        "node.js": "console.log(1)",
        "package.json": JSON.stringify({ name: "x", devDependencies: { esbuild: "1" } }),
      }),
    ).toEqual({ kind: "node" });
  });

  it.each([
    [["npm", "start"]],
    [["npx", "tsx", "{package}/node.ts"]],
    [["{node}", "/usr/lib/node_modules/npm/bin/npm-cli.js", "install"]],
    [{ darwin: ["{node}", "{package}/node.js"], win32: ["C:\\nodejs\\npm.cmd", "start"] }],
    [["yarn"]],
    [["corepack", "pnpm", "i"]],
  ])("refuses a command that runs a package manager: %j", (command) => {
    const message = refusal(node(command), { "node.js": "", "node.ts": "" });
    expect(message).toContain("it needs an install step");
    expect(message).toContain("nothing ever runs npm");
    expect(message).toMatch(/type watch's command runs/);
  });

  it("refuses a package.json that npm would install from, or run scripts of", () => {
    const message = refusal(node(), {
      "node.js": "",
      "package.json": JSON.stringify({
        dependencies: { ws: "8" },
        optionalDependencies: { fsevents: "2" },
        scripts: { postinstall: "node build.js", test: "vitest" },
      }),
    });
    expect(message).toContain("package.json declares dependencies, which npm would install");
    expect(message).toContain("package.json declares optionalDependencies");
    expect(message).toContain("package.json has a postinstall script, which npm would run");
    expect(message).not.toContain("test script");
  });

  it("refuses a native build, a package.json that is not JSON, and an entry not shipped", () => {
    const message = refusal(node(), { "binding.gyp": "{}", "package.json": "{" });
    expect(message).toContain("binding.gyp asks for a native build");
    expect(message).toContain("package.json is not JSON");
    expect(message).toContain("the command names node.js, which the package does not ship");
  });

  it("finds no install step in what is not an object", () => {
    expect(installSteps(null)).toEqual([]);
    expect(installSteps([1])).toEqual([]);
    expect(installSteps({ dependencies: {} })).toEqual([]);
  });

  it("finds package managers in every platform's command", () => {
    expect(packageManagerCommands(node({ linux: ["pnpx", "x"], default: ["{node}"] }))).toEqual([
      `type watch's command runs "pnpx"`,
    ]);
  });
});

describe("executable", () => {
  const binary = text("\x7fELF pretend binary");
  const exe = (binaries: Record<string, { path: string; sha256: string }>): Declaration =>
    declaration({ kind: "executable", binaries }, ["{package}/bin/tool"]);

  it("plans the binary for this platform when its sha256 matches", () => {
    expect(
      plan(exe({ "darwin-arm64": { path: "bin/tool", sha256: sha256(binary) } }), {
        "bin/tool": binary,
      }),
    ).toEqual({ kind: "executable", binary: "bin/tool" });
  });

  it("refuses a binary whose sha256 is not the declared one", () => {
    expect(
      refusal(exe({ "darwin-arm64": { path: "bin/tool", sha256: "0".repeat(64) } }), {
        "bin/tool": binary,
      }),
    ).toBe(
      "monty: its darwin-arm64 binary bin/tool does not match the sha256 its declaration states",
    );
  });

  it("refuses when there is no binary for this platform, naming the ones there are", () => {
    expect(refusal(exe({ "linux-x64": { path: "bin/tool", sha256: sha256(binary) } }))).toBe(
      "monty: it declares no binary for darwin-arm64; it has linux-x64",
    );
    expect(refusal(declaration({ kind: "executable" }))).toBe(
      "monty: it declares no binary for darwin-arm64; it declares none at all",
    );
  });

  it("refuses a declared binary the package does not ship", () => {
    expect(refusal(exe({ "darwin-arm64": { path: "bin/tool", sha256: sha256(binary) } }))).toBe(
      "monty: its darwin-arm64 binary bin/tool is not in the package",
    );
  });
});

it("refuses a package that declares no environment", () => {
  expect(refusal(declaration(undefined))).toBe(
    "monty: it declares no environment; an installed package declares one (spec 2.3.3)",
  );
});
