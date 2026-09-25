// The hash lock of a uv-python package: everything its environment is allowed to contain,
// written down (addons/lock.py, ported and narrowed; plan 0018 §3; WI-0018-15).
//
// A package ships its lock as `requirements.lock` at its root, the output of
// `uv pip compile --generate-hashes`. It is a document this file JUDGES before anything is
// installed from it, with three rules and no exceptions:
//
// 1. Every requirement is an exact pin, `name==version`, never a range: a range makes what is
//    installed depend on when it was installed, which is what a lock exists to deny.
// 2. Every requirement carries at least one `--hash=sha256:<64 hex>`, and nothing else. The
//    hash is the whole check; without it an install takes whatever the index serves.
// 3. Every distribution is named once.
//
// The old lock also accepted git references (pinned by commit) and local wheels (for editable
// installs of the Python host's plugins). A package lock accepts neither: the environment is
// built with `uv pip sync --require-hashes`, which checks an artifact's digest and nothing
// else, and a package's own code arrives in its signed archive, not through the lock.
//
// What is installed is the lock this file parsed: `lockText` re-emits it from the parsed
// document, so nothing that failed a rule can reach uv by sitting where the parser skipped.
//
// Pure: no I/O.

/** Where a uv-python package keeps its lock, at the package root. */
export const LOCK_FILENAME = "requirements.lock";

/** A lock refused; the message names the line and the rule it broke. */
export class LockError extends Error {
  override name = "LockError";
}

/** One distribution, at one exact version, with the digests of the artifacts that serve it. */
export interface LockedRequirement {
  readonly name: string;
  readonly version: string;
  /** Sorted, so two resolutions of one set write one file. */
  readonly hashes: readonly string[];
}

/** A judged lock: every entry pinned, every entry hashed, no entry named twice. */
export interface EnvironmentLock {
  readonly requirements: readonly LockedRequirement[];
}

// A distribution name as packaging spells it. The version's character class has no `>`, `<`,
// `~`, `*` or `,`: a range has no spelling here, which is how rule 1 is enforced.
const PIN = /^(?<name>[A-Za-z0-9][A-Za-z0-9._-]*)==(?<version>[A-Za-z0-9][A-Za-z0-9.+!-]*)$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const HASH_OPTION = "--hash=";

/** The one spelling of a distribution name (PEP 503), so `Foo_Bar` and `foo-bar` are one. */
export function canonicalName(name: string): string {
  return name.replace(/[-_.]+/g, "-").toLowerCase();
}

/** Comments dropped and `\` continuations joined: one entry, and the line it started on. */
function logicalLines(text: string): { line: number; entry: string }[] {
  const entries: { line: number; entry: string }[] = [];
  let parts: string[] = [];
  let start = 0;
  text.split(/\r\n|\r|\n/).forEach((raw, index) => {
    const line = (raw.split("#", 1)[0] ?? "").trim();
    if (line === "") {
      return;
    }
    if (parts.length === 0) {
      start = index + 1;
    }
    if (line.endsWith("\\")) {
      parts.push(line.slice(0, -1).trim());
      return;
    }
    parts.push(line);
    entries.push({ line: start, entry: parts.filter((part) => part !== "").join(" ") });
    parts = [];
  });
  if (parts.length > 0) {
    // A file ending mid-continuation: still an entry, and still judged.
    entries.push({ line: start, entry: parts.filter((part) => part !== "").join(" ") });
  }
  return entries;
}

/** One logical line: an exact pin followed by nothing but sha256 hashes. */
function parseEntry(entry: string, line: number): LockedRequirement {
  const [pin = "", ...options] = entry.split(/\s+/);
  if (options[0] === "@") {
    throw new LockError(
      `line ${String(line)}: ${JSON.stringify(entry.split(/\s+--/)[0])} is a direct reference. ` +
        "A package lock takes every dependency by exact pin and sha256 hash; a git source or a " +
        "local file cannot be checked by `uv pip sync --require-hashes`, and the package's own " +
        "code arrives in its signed archive.",
    );
  }
  const match = PIN.exec(pin);
  if (match?.groups === undefined) {
    throw new LockError(
      `line ${String(line)}: ${JSON.stringify(pin)} is not an exact pin. A lock records every ` +
        "dependency at one version: a range or a bare name would make what gets installed " +
        "depend on when it was installed.",
    );
  }
  const hashes: string[] = [];
  for (const option of options) {
    if (!option.startsWith(HASH_OPTION)) {
      throw new LockError(
        `line ${String(line)}: ${JSON.stringify(option)} is not a hash. A locked requirement ` +
          "carries nothing but `--hash=` options, so no other setting can change what is installed.",
      );
    }
    const digest = option.slice(HASH_OPTION.length);
    if (!HASH.test(digest)) {
      throw new LockError(
        `line ${String(line)}: ${JSON.stringify(digest)} is not a sha256 hash: expected ` +
          "'sha256:' followed by 64 lowercase hex characters",
      );
    }
    hashes.push(digest);
  }
  if (hashes.length === 0) {
    throw new LockError(
      `line ${String(line)}: ${pin} is locked with no hash. The hash is the whole check: ` +
        "without it, an install takes whatever the index serves at the time.",
    );
  }
  return {
    name: match.groups["name"] ?? "",
    version: match.groups["version"] ?? "",
    hashes: hashes.sort(),
  };
}

/** Parse and judge a lock, or refuse it naming the line that broke a rule. */
export function parseLock(text: string): EnvironmentLock {
  const requirements: LockedRequirement[] = [];
  const seen = new Map<string, number>();
  for (const { line, entry } of logicalLines(text)) {
    const requirement = parseEntry(entry, line);
    const canonical = canonicalName(requirement.name);
    const first = seen.get(canonical);
    if (first !== undefined) {
      throw new LockError(
        `line ${String(line)}: ${requirement.name} is locked twice (already on line ` +
          `${String(first)}); a lock names each distribution once, at one version`,
      );
    }
    seen.set(canonical, line);
    requirements.push(requirement);
  }
  if (requirements.length === 0) {
    throw new LockError(
      "the lock is empty: a lock with no requirements locks nothing. A package with no " +
        `dependencies ships no ${LOCK_FILENAME}.`,
    );
  }
  return { requirements };
}

/** The locked requirement under `name`, whatever way the caller spelled it. */
export function findLocked(lock: EnvironmentLock, name: string): LockedRequirement | undefined {
  const wanted = canonicalName(name);
  return lock.requirements.find((requirement) => canonicalName(requirement.name) === wanted);
}

/** The lock as a requirements file, re-emitted from what `parseLock` accepted. */
export function lockText(lock: EnvironmentLock): string {
  const blocks = lock.requirements.map((requirement) =>
    [
      `${requirement.name}==${requirement.version}`,
      ...requirement.hashes.map((digest) => `${HASH_OPTION}${digest}`),
    ].join(" \\\n    "),
  );
  return (
    "# Re-emitted by InnyTypes from the package's own lock; the environment beside it was\n" +
    "# installed from exactly this file, with `uv pip sync --require-hashes`.\n" +
    blocks.join("\n") +
    "\n"
  );
}
