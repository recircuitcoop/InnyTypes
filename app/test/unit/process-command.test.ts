// adapters/process/command.ts and process-tree.ts: argv, working directory and environment
// of a node process (spec 2.3, plan 0018 §7), and ending its tree.

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  CommandError,
  commandFor,
  minimalEnvironment,
  resolveCommand,
  substitute,
  unpackedDir,
} from "../../src/adapters/process/command";
import { processTreeFor } from "../../src/adapters/process/process-tree";

const VALUES = { python: "/env/bin/python", node: "/app/node", package: "/pkgs/monty" };

describe("the declared command", () => {
  it("is the bare array on every platform", () => {
    expect(commandFor(["a", "b"], "linux")).toEqual(["a", "b"]);
  });

  it("is the platform's own argv, else default, else refused", () => {
    const table = { darwin: ["mac"], default: ["any"] };
    expect(commandFor(table, "darwin")).toEqual(["mac"]);
    expect(commandFor(table, "linux")).toEqual(["any"]);
    expect(commandFor(table, "freebsd")).toEqual(["any"]);
    expect(() => commandFor({ win32: ["w"] }, "linux")).toThrow(
      /declares nothing for linux and no default/,
    );
  });
});

describe("placeholders", () => {
  it("substitutes {python}, {node} and {package}, and {{ is a literal {", () => {
    expect(substitute("{python}", VALUES)).toBe("/env/bin/python");
    expect(substitute("{package}/x.py", VALUES)).toBe("/pkgs/monty/x.py");
    expect(substitute("--node={node}", VALUES)).toBe("--node=/app/node");
    expect(substitute("{{json}}", VALUES)).toBe("{json}}");
    expect(substitute("plain", VALUES)).toBe("plain");
  });

  it("refuses any other placeholder or a lone {", () => {
    expect(() => substitute("{pyhton}", VALUES)).toThrow(CommandError);
    expect(() => substitute("a{b", VALUES)).toThrow(
      /unknown placeholder in "a\{b"; write \{ as \{\{/,
    );
  });

  it("resolves the argv and the working directory, both on the unpacked package", () => {
    const packed = path.join(
      "/Applications/InnyTypes.app/Contents/Resources/app.asar",
      "packages",
      "monty",
    );
    const resolved = resolveCommand(["{python}", "{package}/run.py"], "darwin", {
      ...VALUES,
      package: packed,
    });
    const unpacked = unpackedDir(packed);
    expect(unpacked).toContain(`app.asar.unpacked${path.sep}packages`);
    expect(resolved).toEqual({ argv: ["/env/bin/python", `${unpacked}/run.py`], cwd: unpacked });
    expect(unpackedDir("/pkgs/monty")).toBe("/pkgs/monty");
  });

  it("turns the packaged Anytype MCP entry into the file the bundled Node can read (0.2.0's MODULE_NOT_FOUND)", () => {
    // The exact argv 0.2.0's services process logged before every start of the child failed:
    // plain Node cannot read inside app.asar.
    const packed =
      "/Applications/InnyTypes.app/Contents/Resources/app.asar/node_modules/@anyproto/anytype-mcp/bin/cli.mjs";
    expect(unpackedDir(packed)).toBe(
      "/Applications/InnyTypes.app/Contents/Resources/app.asar.unpacked/node_modules/@anyproto/anytype-mcp/bin/cli.mjs",
    );
    // services/main.ts imports Electron's parentPort at load, so its wiring is read, not run:
    // the pinned entry goes through unpackedDir before it reaches the launcher.
    const servicesRoot = fs.readFileSync(
      path.join(__dirname, "..", "..", "src", "services", "main.ts"),
      "utf8",
    );
    expect(servicesRoot).toContain("unpackedDir(pinnedPackageEntry(require.resolve))");
  });

  it("refuses an empty command", () => {
    expect(() => resolveCommand([], "darwin", VALUES)).toThrow(/the command is empty/);
    expect(() => resolveCommand(["{{"].slice(1), "darwin", VALUES)).toThrow(CommandError);
  });

  it("refuses npm and npx by name, whatever declared it or how it is spelled (WI-0018-23)", () => {
    expect(() => resolveCommand(["npm", "install"], "darwin", VALUES)).toThrow(
      /npm is not in the bundle \(WI-0018-23\)/,
    );
    expect(() => resolveCommand(["npx", "cowsay"], "linux", VALUES)).toThrow(
      /npx is not in the bundle \(WI-0018-23\)/,
    );
    // A full path, or Windows' launcher extension, is still npm: the check is by basename.
    expect(() => resolveCommand(["/usr/local/bin/npm"], "linux", VALUES)).toThrow(CommandError);
    expect(() => resolveCommand(["npm.cmd"], "win32", VALUES)).toThrow(CommandError);
    // A package that merely names something starting with npm is not npm.
    expect(() => resolveCommand(["npm-check-updates"], "linux", VALUES)).not.toThrow();
  });
});

describe("the minimal environment", () => {
  it("keeps only the allow-listed variables, adds the node defaults, then the caller's", () => {
    const parent = {
      PATH: "/usr/bin",
      HOME: "/home/me",
      ANYTYPE_API_KEY: "secret",
      AWS_SECRET_ACCESS_KEY: "secret",
      ELECTRON_RUN_AS_NODE: "1",
      LANG: undefined,
    };
    expect(minimalEnvironment(parent, { PATH: "/venv/bin:/usr/bin" })).toEqual({
      PATH: "/venv/bin:/usr/bin",
      HOME: "/home/me",
      PYTHONUNBUFFERED: "1",
      PYTHONIOENCODING: "utf-8",
    });
    expect(minimalEnvironment({})).toEqual({ PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" });
  });
});

describe("the process tree", () => {
  it("on POSIX is a detached group, ended by signalling the negative pid", () => {
    const signals: [number, string][] = [];
    const tree = processTreeFor("darwin", (pid, signal) => signals.push([pid, signal]));
    expect(tree.detached).toBe(true);
    expect(tree.blocked).toBeNull();
    tree.kill(42);
    expect(signals).toEqual([[-42, "SIGKILL"]]);
  });

  it("on Windows is BLOCKED for WI-0025-01 and ends only the process", () => {
    const signals: [number, string][] = [];
    const tree = processTreeFor("win32", (pid, signal) => signals.push([pid, signal]));
    expect(tree.detached).toBe(false);
    expect(tree.blocked).toMatch(/^BLOCKED\(WI-0025-01\): Windows Job Objects/);
    tree.kill(42);
    expect(signals).toEqual([[42, "SIGKILL"]]);
  });

  it("treats a tree that is already gone as ended", () => {
    const gone = (): void => {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    };
    expect(() => {
      processTreeFor("linux", gone).kill(42);
    }).not.toThrow();
    expect(() => {
      processTreeFor("win32", gone).kill(42);
    }).not.toThrow();
    expect(() => {
      processTreeFor("linux").kill(2 ** 30);
    }).not.toThrow();
  });
});
