// domain/packages/lock.ts: a uv-python package's hash lock, judged before anything is
// installed from it. The rules of the old lock (tests/test_plugin_environments.py) that still
// apply carry over: exact pins, sha256 hashes and nothing else, each name once, comments and
// continuations, and a lock re-emitted from what was parsed.
import { describe, expect, it } from "vitest";

import {
  LockError,
  canonicalName,
  findLocked,
  lockText,
  parseLock,
} from "../../src/domain/packages/lock";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;

function refusal(text: string): string {
  try {
    parseLock(text);
  } catch (error) {
    expect(error).toBeInstanceOf(LockError);
    return (error as Error).message;
  }
  throw new Error("the lock was accepted");
}

describe("parseLock", () => {
  it("parses continuations and ignores comments", () => {
    const lock = parseLock(
      "# via uv pip compile\n" +
        `click==8.5.0 \\\n    --hash=${HASH_B} \\\n    --hash=${HASH_A}  # two artifacts\n` +
        "\n" +
        `alpha==1.0 --hash=${HASH_A}\n`,
    );
    expect(lock.requirements).toEqual([
      { name: "click", version: "8.5.0", hashes: [HASH_A, HASH_B] },
      { name: "alpha", version: "1.0", hashes: [HASH_A] },
    ]);
  });

  it("judges a lock that ends mid-continuation", () => {
    expect(parseLock(`click==8.5.0 \\\n    --hash=${HASH_A} \\`).requirements).toHaveLength(1);
    expect(refusal("click==8.5.0 \\")).toMatch(/locked with no hash/);
  });

  it.each([
    ["# nothing but a comment\n", "the lock is empty"],
    [`click --hash=${HASH_A}`, "is not an exact pin"],
    [`click>=8.5.0 --hash=${HASH_A}`, "is not an exact pin"],
    ["click==8.5.0 --hash=md5:abc", "is not a sha256 hash"],
    [`click==8.5.0 --hash=sha256:${"G".repeat(64)}`, "is not a sha256 hash"],
    ["click==8.5.0 --index-url=https://pypi.org/simple", "is not a hash"],
    ["click==8.5.0", "locked with no hash"],
    ["monty @ file:///tmp/a-checkout", "is a direct reference"],
    [`monty @ file:///tmp/monty.whl --hash=${HASH_A}`, "is a direct reference"],
    ["monty @ git+https://example.test/monty.git@main", "is a direct reference"],
  ])("refuses %j: %s", (text, reason) => {
    expect(refusal(text)).toContain(reason);
  });

  it("refuses a distribution locked twice, however it is spelled", () => {
    expect(refusal(`Foo_Bar==1 --hash=${HASH_A}\nfoo-bar==2 --hash=${HASH_B}\n`)).toBe(
      "line 2: foo-bar is locked twice (already on line 1); a lock names each distribution " +
        "once, at one version",
    );
  });

  it("names the line an entry started on", () => {
    expect(refusal(`alpha==1 --hash=${HASH_A}\n\n# c\nbeta>=2 \\\n --hash=${HASH_A}`)).toMatch(
      /^line 4: /,
    );
  });
});

describe("the lock as written", () => {
  it("round-trips through the file it writes", () => {
    const lock = parseLock(`beta==2 --hash=${HASH_B} --hash=${HASH_A}\nalpha==1 --hash=${HASH_A}`);
    const text = lockText(lock);
    expect(text).toContain(`beta==2 \\\n    --hash=${HASH_A} \\\n    --hash=${HASH_B}`);
    expect(parseLock(text)).toEqual(lock);
  });

  it("finds a requirement whatever way its name is spelled", () => {
    const lock = parseLock(`Foo.Bar==1 --hash=${HASH_A}`);
    expect(findLocked(lock, "foo_bar")?.version).toBe("1");
    expect(findLocked(lock, "other")).toBeUndefined();
    expect(canonicalName("Foo__Bar.baz")).toBe("foo-bar-baz");
  });
});
