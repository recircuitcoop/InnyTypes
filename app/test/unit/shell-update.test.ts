// wireUpdate (WI-0018-24): platform selection and scheduling, the one thing shell/main.ts
// hands off rather than doing itself (plan 0018 §2.3, its own 600-line limit).
import { afterEach, describe, expect, it, vi } from "vitest";
import { wireUpdate, type WireUpdateOptions } from "../../src/shell/update";
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
    selfUpdater: { checkForUpdates: vi.fn(), quitAndInstall: vi.fn() },
    session: { clock, currentVersion: () => "1.0.0" },
    publicKey: null,
    feedBaseUrl: "https://example.invalid",
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
