// The suite's own home directory: no test can reach this user's, and one that tries fails.
//
// The vitest twin of tests/home_guard.py. A test that writes into the real home is not
// hermetic, and on the machine of somebody who runs InnyTypes it writes next to a live app,
// into the directories whose sockets, settings and keys that app is using. It was twice
// found only by chance in the old app (plan 0012, slice 05). This setup file runs before
// every test file and does two independent things:
//
// * Everything that finds a home finds a scratch one. HOME, USERPROFILE and the XDG
//   variables point into a directory made for this worker under the temp directory. That is
//   where os.homedir() looks, in this process and in every child a test starts with the
//   environment it inherited. After each test the scratch home must be empty again: a leak
//   is observed on disk, not predicted from a list of functions that write.
// * The real home is closed to this process. Node has no audit hook, so every write-shaped
//   function of node:fs and node:fs/promises is wrapped: a write to a path inside the real
//   home is refused before it reaches the disk, and recorded, so the test fails even when
//   the code under test swallows the refusal. This catches what redirection cannot: a path
//   spelled out, or captured before the redirection happened.
//
// Two places inside the real home stay writable: the temp directory (when it lives there)
// and this repository's checkout, which on a developer machine usually sits under the home.
//
// What it cannot see, said plainly: a child process, whose writes happen outside this
// process's fs module, when it was started with an environment that does not name the
// scratch home.
// The default export: the module object itself, whose functions can be replaced. A
// namespace import (`* as fs`) is frozen.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";

/** A test tried to change something in this user's real home. Not an fs error on purpose. */
export class WriteToRealDirectory extends Error {
  override name = "WriteToRealDirectory";
}

/** Names the scratch home to any process started from this one. */
export const SANDBOX_VARIABLE = "INNYTYPES_TEST_HOME";

interface GuardState {
  readonly realHomes: readonly string[];
  readonly allowed: readonly string[];
  readonly sandboxHome: string;
  readonly blocked: string[];
}

// vitest can run several test files in one worker process, and every file runs its setup
// files again. The fs module is shared by all of them, so the guard is installed once per
// process and its state lives on the process, not on this module.
const STATE_KEY = Symbol.for("innytypes.test.homeGuard");
const holder = globalThis as typeof globalThis & { [STATE_KEY]?: GuardState };

const REPOSITORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A path and its resolved form, so a symlinked home or temp dir is matched both ways. */
function bothSpellings(location: string): string[] {
  const spellings = new Set([path.resolve(location)]);
  try {
    spellings.add(fs.realpathSync(location));
  } catch {
    // Not there yet: the spelled path is all there is to compare.
  }
  return [...spellings];
}

function isInside(target: string, root: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

function toPath(argument: unknown): string | null {
  if (typeof argument === "string") {
    return path.resolve(argument);
  }
  if (Buffer.isBuffer(argument)) {
    return path.resolve(argument.toString("utf8"));
  }
  if (argument instanceof URL && argument.protocol === "file:") {
    return path.resolve(fileURLToPath(argument));
  }
  return null; // a file descriptor, or nothing: no path to judge
}

/** The real-home path an argument names, or null when it names none. */
function insideRealHome(state: GuardState, argument: unknown): string | null {
  const target = toPath(argument);
  if (target === null) {
    return null;
  }
  if (state.allowed.some((root) => isInside(target, root))) {
    return null;
  }
  return state.realHomes.some((root) => isInside(target, root)) ? target : null;
}

const WRITE_FLAGS =
  fs.constants.O_WRONLY |
  fs.constants.O_RDWR |
  fs.constants.O_CREAT |
  fs.constants.O_TRUNC |
  fs.constants.O_APPEND;

function opensForWriting(flags: unknown): boolean {
  if (typeof flags === "number") {
    return (flags & WRITE_FLAGS) !== 0;
  }
  if (typeof flags === "string") {
    return /[wax+]/.test(flags);
  }
  return false; // the default flag is "r"
}

// Which arguments of each write-shaped function name a path the call changes.
const FIRST_PATH = [
  "appendFile",
  "chmod",
  "chown",
  "lchmod",
  "lchown",
  "lutimes",
  "mkdir",
  "mkdtemp",
  "rm",
  "rmdir",
  "truncate",
  "unlink",
  "utimes",
  "writeFile",
  "createWriteStream",
] as const;
const BOTH_PATHS = ["copyFile", "cp", "link", "rename", "symlink"] as const;

type Checker = (args: unknown[]) => unknown[];

const CHECKERS = new Map<string, Checker>([
  ...FIRST_PATH.map((name): [string, Checker] => [name, (args) => [args[0]]]),
  ...BOTH_PATHS.map((name): [string, Checker] => [name, (args) => [args[0], args[1]]]),
  ["open", (args) => (opensForWriting(args[1]) ? [args[0]] : [])],
]);

function refusal(state: GuardState, name: string, args: unknown[]): WriteToRealDirectory | null {
  const checker = CHECKERS.get(name.replace(/Sync$/, ""));
  if (checker === undefined) {
    return null;
  }
  for (const argument of checker(args)) {
    const target = insideRealHome(state, argument);
    if (target !== null) {
      state.blocked.push(`fs.${name} ${target}`);
      return new WriteToRealDirectory(`a test tried to fs.${name} ${target}, in this user's home`);
    }
  }
  return null;
}

type AnyFunction = (...args: unknown[]) => unknown;

/** Wrap every write-shaped function of one fs object; `rejects` for the promise API. */
function guardObject(state: GuardState, target: object, rejects: boolean): void {
  const functions = target as Record<string, unknown>;
  for (const name of Object.keys(functions)) {
    const original = functions[name];
    if (typeof original !== "function" || !CHECKERS.has(name.replace(/Sync$/, ""))) {
      continue;
    }
    const wrapped = function (this: unknown, ...args: unknown[]): unknown {
      const error = refusal(state, name, args);
      if (error !== null) {
        if (rejects) {
          return Promise.reject(error);
        }
        throw error;
      }
      return (original as AnyFunction).apply(this, args);
    };
    functions[name] = wrapped;
  }
}

function install(): GuardState {
  const existing = holder[STATE_KEY];
  if (existing !== undefined) {
    return existing;
  }

  // Worked out while HOME is still the real one, which is the point of them. The account
  // database is asked too, in case HOME had already been moved before this process started.
  const realHomes = [...new Set([os.homedir(), os.userInfo().homedir].flatMap(bothSpellings))];
  const allowed = [...new Set([os.tmpdir(), REPOSITORY].flatMap(bothSpellings))];
  const sandboxHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "inny-home-")));

  process.env[SANDBOX_VARIABLE] = sandboxHome;
  process.env["HOME"] = sandboxHome;
  process.env["USERPROFILE"] = sandboxHome;
  process.env["XDG_CONFIG_HOME"] = path.join(sandboxHome, ".config");
  process.env["XDG_DATA_HOME"] = path.join(sandboxHome, ".local", "share");
  process.env["XDG_STATE_HOME"] = path.join(sandboxHome, ".local", "state");
  process.env["XDG_CACHE_HOME"] = path.join(sandboxHome, ".cache");
  process.env["XDG_RUNTIME_DIR"] = path.join(sandboxHome, "run");

  const state: GuardState = { realHomes, allowed, sandboxHome, blocked: [] };
  guardObject(state, fs, false);
  guardObject(state, fs.promises, true);
  // ESM named imports of node:fs are bound to their own copies; this re-syncs them, so
  // `import { writeFileSync } from "node:fs"` gets the guarded function too.
  syncBuiltinESMExports();

  // Remove the scratch home when this worker ends. rmSync is allowed: it is not in the home.
  process.once("exit", () => {
    fs.rmSync(sandboxHome, { recursive: true, force: true });
  });

  holder[STATE_KEY] = state;
  return state;
}

const state = install();

/** The scratch home every test runs in. */
export const SANDBOX_HOME = state.sandboxHome;

/** Every path in the real home the guard is closing, as it compares them. */
export const REAL_HOMES = state.realHomes;

/**
 * Everything written into a home since the last call, then forgotten so it is told once.
 *
 * The refusals recorded above, and every entry the scratch home now holds. The scratch home
 * is emptied afterwards, so one leaking test fails and the next starts clean.
 */
export function collectLeaks(): string[] {
  const leaks = state.blocked.map((entry) => `refused: ${entry}`);
  state.blocked.length = 0;
  for (const entry of fs.readdirSync(SANDBOX_HOME).sort()) {
    const full = path.join(SANDBOX_HOME, entry);
    const found = fs.statSync(full).isDirectory()
      ? fs.readdirSync(full, { recursive: true, encoding: "utf8" }).map((p) => path.join(entry, p))
      : [];
    leaks.push(...[entry, ...found].sort().map((relative) => `written: ~/${relative}`));
    fs.rmSync(full, { recursive: true, force: true });
  }
  return leaks;
}

afterEach(() => {
  const leaks = collectLeaks();
  if (leaks.length > 0) {
    throw new WriteToRealDirectory(`this test wrote into a home:\n  ${leaks.join("\n  ")}`);
  }
});
