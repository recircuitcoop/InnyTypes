// wireUpdate (WI-0018-24): platform selection and scheduling, the one thing shell/main.ts
// hands off rather than doing itself (plan 0018 §2.3, its own 600-line limit).
import { afterEach, describe, expect, it, vi } from "vitest";
import { updateSource, wireUpdate, type WireUpdateOptions } from "../../src/shell/update";
import type { Notice } from "../../src/domain/notices/notices";
import type { Clock } from "../../src/ports/clock";

const realPlatform = process.platform;

function setPlatform(value: string): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

afterEach(() => {
  setPlatform(realPlatform);
});

function options(): WireUpdateOptions {
  const notices: Notice[] = [];
  const clock: Clock = { now: () => 0, after: vi.fn(() => () => undefined) };
  return {
    transport: {
      http: { get: vi.fn() },
      verifier: { verify: vi.fn() },
      sha512: () => "",
    },
    settings: { readUpdate: () => ({ auto_check: false }), writeUpdate: vi.fn() },
    report: {
      notifier: {
        raise: (notice: Notice) => notices.push(notice),
        clear: () => undefined,
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    },
    selfUpdater: { checkForUpdates: vi.fn(), downloadRelease: vi.fn(), quitAndInstall: vi.fn() },
    session: { clock, currentVersion: () => "1.0.0" },
    publicKey: null,
    feedBaseUrl: "https://example.invalid",
    tagBaseUrl: (tag) => `https://example.invalid/${tag}`,
  };
}

describe("wireUpdate", () => {
  it("wires and schedules the check on macOS", () => {
    setPlatform("darwin");
    const check = wireUpdate(options());
    expect(check).not.toBeNull();
  });

  it("wires and schedules the check on Linux", () => {
    setPlatform("linux");
    const check = wireUpdate(options());
    expect(check).not.toBeNull();
  });

  it("is null on a platform this application does not self-update (Windows: WI-0025-01)", () => {
    setPlatform("win32");
    expect(wireUpdate(options())).toBeNull();
  });
});

describe("updateSource: only a build that is not installed can be pointed elsewhere", () => {
  const built = { updateRepo: "acme/innytypes", updatePublicKey: "the built-in key" };
  const overrides = {
    INNYTYPES_UPDATE_REPO: "mallory/innytypes",
    INNYTYPES_UPDATE_KEY: "mallory's key",
    INNYTYPES_E2E_HOOKS: "1",
    INNYTYPES_TEST_UPDATE_RELEASES: "https://mallory.invalid/releases",
  };

  it("an installed build ignores every override: its own repo, key and GitHub releases", () => {
    expect(updateSource({ packaged: true, env: overrides, built })).toEqual({
      repo: "acme/innytypes",
      publicKey: "the built-in key",
      releases: "https://github.com/acme/innytypes/releases",
    });
  });

  it("a development or e2e build takes the repo, the key and the test release host", () => {
    expect(updateSource({ packaged: false, env: overrides, built })).toEqual({
      repo: "mallory/innytypes",
      publicKey: "mallory's key",
      releases: "https://mallory.invalid/releases",
    });
  });

  it("the test release host needs the e2e hooks, even in development", () => {
    const env = { ...overrides, INNYTYPES_E2E_HOOKS: undefined };
    expect(updateSource({ packaged: false, env, built }).releases).toBe(
      "https://github.com/mallory/innytypes/releases",
    );
  });

  it("with nothing set, a development build uses what it was built with", () => {
    expect(updateSource({ packaged: false, env: {}, built })).toEqual({
      repo: "acme/innytypes",
      publicKey: "the built-in key",
      releases: "https://github.com/acme/innytypes/releases",
    });
  });
});
