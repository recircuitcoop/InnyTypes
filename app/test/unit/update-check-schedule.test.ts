// UpdateCheck's own scheduling (WI-0018-24), against a FakeClock: no network at all is needed
// since the switch is off, which is exactly the point (application/update-check.ts's D14 rule).
import { describe, expect, it, vi } from "vitest";
import { UpdateCheck, type UpdateCheckPorts } from "../../src/application/update-check";
import { FakeClock } from "../fakes/clock";
import { RecordingLogger, RecordingNotifier } from "../fakes/children";

function ports(clock: FakeClock): UpdateCheckPorts {
  return {
    transport: { http: { get: vi.fn() }, verifier: { verify: vi.fn() }, sha512: () => "" },
    settings: { readUpdate: () => ({ auto_check: false }) },
    report: { notifier: new RecordingNotifier(), logger: new RecordingLogger() },
    selfUpdater: { checkForUpdates: vi.fn(), quitAndInstall: vi.fn() },
    session: { clock, currentVersion: () => "1.0.0" },
    publicKey: null,
    feedBaseUrl: "https://example.invalid",
    platform: "mac",
    arch: "arm64",
  };
}

describe("UpdateCheck.schedule", () => {
  it("checks once after firstMs, then again a day later, until stopped", async () => {
    const clock = new FakeClock();
    const check = new UpdateCheck(ports(clock));
    const spy = vi.spyOn(check, "check");
    check.schedule(60_000);
    expect(spy).not.toHaveBeenCalled();

    clock.advance(60_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(clock.pending).toBe(1);

    clock.advance(24 * 60 * 60 * 1000);
    await Promise.resolve();
    await Promise.resolve();
    expect(spy).toHaveBeenCalledTimes(2);

    check.stop();
    expect(clock.pending).toBe(0);
    clock.advance(24 * 60 * 60 * 1000);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("installAtQuit is a no-op before any check has staged an update", () => {
    const check = new UpdateCheck(ports(new FakeClock()));
    expect(() => {
      check.installAtQuit();
    }).not.toThrow();
  });
});
