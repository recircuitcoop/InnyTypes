// The shell's side of the Packages page (shell/packages.ts; WI-0018-16): the restart of only
// the runtime and its timing, the deployed flows' types, and the page's IPC calls, with a real
// Supervisor over fake children and a fake clock.
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FsPackageRoots } from "../../src/adapters/fs/package-roots";
import { deployedTypes, runtimeRestarter, wirePackages } from "../../src/shell/packages";
import { IPC } from "../../src/shell/ipc";
import { obedient, RecordingLogger, type Behaviour } from "../fakes/children";
import { supervised } from "../fakes/supervised";

let scratch: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "inny-shell-packages-"));
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** Answers the first init only: a runtime that never comes back after a restart. */
function comesUpOnce(): Behaviour {
  let inits = 0;
  return {
    onPost(child, message, clock) {
      if (message.t === "init" && ++inits > 1) {
        return;
      }
      obedient.onPost?.(child, message, clock);
    },
  };
}

describe("restarting only the runtime", () => {
  it("resolves with the time from the restart to the next generation running", async () => {
    const { clock, supervisor, logger } = supervised(obedient);
    supervisor.start();
    clock.advance(5);
    const restart = runtimeRestarter(supervisor, clock, logger);
    const took = restart("pinger was installed");
    clock.advance(10);
    expect(await took).toBe(2);
    expect(supervisor.status()).toMatchObject({ state: "running", generation: 2 });
    expect(logger.lines).toContainEqual(
      expect.stringContaining("restarting only the runtime: pinger was installed"),
    );
  });

  it("resolves null at once when the runtime is not running to restart", async () => {
    const { clock, supervisor, logger } = supervised(obedient);
    expect(await runtimeRestarter(supervisor, clock, logger)("x")).toBeNull();
  });

  it("resolves null, and says so, when the runtime does not come back", async () => {
    const { clock, supervisor, logger } = supervised(comesUpOnce());
    supervisor.start();
    clock.advance(5);
    const took = runtimeRestarter(supervisor, clock, logger)("x");
    clock.advance(60_000);
    expect(await took).toBeNull();
    expect(logger.lines).toContainEqual(
      expect.stringContaining("the runtime did not come back within 60000 ms"),
    );
  });
});

describe("the deployed flows' types", () => {
  it("are read from Node-RED's saved flows; none before the first deploy", () => {
    const file = path.join(scratch, "flows.json");
    expect(deployedTypes(file)).toEqual([]);
    fs.writeFileSync(
      file,
      JSON.stringify([
        { id: "t", type: "tab" },
        { id: "a", type: "inny-pinger-ping", z: "t" },
      ]),
    );
    expect(deployedTypes(file)).toEqual(["tab", "inny-pinger-ping"]);
    fs.writeFileSync(file, "{");
    expect(() => deployedTypes(file)).toThrow(SyntaxError);
  });
});

describe("the Packages page's calls", () => {
  function wired(chosen: string[] | null) {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const { clock, supervisor } = supervised(obedient);
    const logger = new RecordingLogger();
    wirePackages({
      ipc: {
        handle: (channel, handler) => {
          handlers.set(channel, handler as (event: unknown, ...args: unknown[]) => unknown);
        },
      },
      dialog: {
        showOpenDialog: () =>
          Promise.resolve({ canceled: chosen === null, filePaths: chosen ?? [] }),
      },
      runtime: supervisor,
      editor: { nodes: () => Promise.resolve(null) },
      clock,
      logger,
      userDir: scratch,
      shippedStore: { documents: () => [{ name: "anytype", document: { version: "1.2.3" } }] },
      catalogueUrl: "",
      catalogueKey: null,
      catalogueCache: { read: () => null, write: () => undefined, forget: () => undefined },
      http: { get: () => Promise.reject(new Error("no network here")) },
      forgetGenerated: () => undefined,
      environment: {
        roots: new FsPackageRoots(path.join(scratch, "node-packages")),
      } as never,
    });
    const call = (channel: string, ...args: unknown[]) =>
      Promise.resolve(handlers.get(channel)?.({}, ...args));
    return { call, logger };
  }

  it("lists the shipped packages, and says a build with no catalogue has none", async () => {
    const { call } = wired(null);
    expect(await call(IPC.packages)).toEqual({
      packages: [{ name: "anytype", version: "1.2.3", kind: "shipped", signed: true }],
      catalogue: [],
      catalogueProblem: "this build is configured with no package catalogue",
    });
    const outcome = await call(IPC.packageInstall, "pinger");
    expect(outcome).toEqual({
      ok: false,
      error:
        "Not installed: the catalogue could not be read: this build is configured with no " +
        "package catalogue.",
    });
  });

  it("chooses a file with the shell's own chooser; a cancel chooses nothing", async () => {
    expect(await wired(["/somewhere/pkg.tgz"]).call(IPC.packageChooseFile)).toBe(
      "/somewhere/pkg.tgz",
    );
    expect(await wired(null).call(IPC.packageChooseFile)).toBeNull();
  });

  it("asks for the unsigned confirmation, and refuses calls that name nothing", async () => {
    const { call } = wired(null);
    expect(await call(IPC.packageInstallFile, "/somewhere/pkg", false)).toMatchObject({
      ok: false,
      needsConfirmation: true,
    });
    for (const [channel, args] of [
      [IPC.packageInstall, [7]],
      [IPC.packageInstallFile, ["", true]],
      [IPC.packageRemove, [null]],
    ] as const) {
      expect(await call(channel, ...args)).toMatchObject({ ok: false });
    }
    expect(await call(IPC.packageRemove, "pinger")).toEqual({
      ok: false,
      error: "Not removed: pinger is not installed.",
    });
    expect(await call(IPC.packageRemove, "anytype")).toEqual({
      ok: false,
      error: "Not removed: anytype is shipped with InnyTypes and cannot be removed.",
    });
  });

  it("gives a declaration with no version a question mark", async () => {
    const handlers = new Map<string, (event: unknown) => unknown>();
    const { clock, supervisor } = supervised(obedient);
    wirePackages({
      ipc: { handle: (channel, handler) => handlers.set(channel, handler as never) },
      dialog: {} as never,
      runtime: supervisor,
      editor: { nodes: () => Promise.resolve([]) },
      clock,
      logger: new RecordingLogger(),
      userDir: scratch,
      shippedStore: { documents: () => [{ name: "odd", document: null }] },
      catalogueUrl: "",
      catalogueKey: null,
      catalogueCache: { read: () => null, write: () => undefined, forget: () => undefined },
      http: { get: () => Promise.reject(new Error("unused")) },
      forgetGenerated: () => undefined,
      environment: { roots: new FsPackageRoots(path.join(scratch, "np")) } as never,
    });
    expect(await handlers.get(IPC.packages)?.({})).toMatchObject({
      packages: [{ name: "odd", version: "?" }],
    });
  });
});
