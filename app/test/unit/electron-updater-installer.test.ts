// The SelfUpdater over electron-updater: wiring only (WI-0018-24). A fake shaped like
// electron-updater's AppUpdater stands in; the real one needs a real Electron main process,
// which the e2e stage alone provides.
import { describe, expect, it, vi } from "vitest";
import { ElectronUpdaterInstaller } from "../../src/adapters/update/electron-updater-installer";

function fakeAppUpdater() {
  return {
    logger: null as unknown,
    autoDownload: false,
    autoInstallOnAppQuit: false,
    channel: null as string | null,
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn().mockResolvedValue(null),
    quitAndInstall: vi.fn(),
  };
}

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("ElectronUpdaterInstaller", () => {
  it("configures the updater for a background download and an install at quit", () => {
    const updater = fakeAppUpdater();
    const logger = fakeLogger();
    new ElectronUpdaterInstaller(updater as never, "acme/innytypes", "beta", logger);
    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(updater.channel).toBe("beta");
    expect(updater.logger).toBe(logger);
    expect(updater.setFeedURL).toHaveBeenCalledWith({
      provider: "github",
      owner: "acme",
      repo: "innytypes",
    });
  });

  it("refuses a repo slug that is not owner/repo", () => {
    const updater = fakeAppUpdater();
    expect(
      () => new ElectronUpdaterInstaller(updater as never, "no-slash", "latest", fakeLogger()),
    ).toThrow(/owner\/repo/);
    expect(
      () => new ElectronUpdaterInstaller(updater as never, "/repo", "latest", fakeLogger()),
    ).toThrow();
    expect(
      () => new ElectronUpdaterInstaller(updater as never, "owner/", "latest", fakeLogger()),
    ).toThrow();
  });

  it("checkForUpdates delegates to the real updater when it succeeds", async () => {
    const updater = fakeAppUpdater();
    const installer = new ElectronUpdaterInstaller(
      updater as never,
      "acme/innytypes",
      "latest",
      fakeLogger(),
    );
    await installer.checkForUpdates();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it("quitAndInstall delegates to the real updater when it succeeds", () => {
    const updater = fakeAppUpdater();
    const installer = new ElectronUpdaterInstaller(
      updater as never,
      "acme/innytypes",
      "latest",
      fakeLogger(),
    );
    installer.quitAndInstall();
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("checkForUpdates delegates, and never rejects when the updater's own call fails", async () => {
    const updater = fakeAppUpdater();
    updater.checkForUpdates.mockRejectedValue(new Error("offline"));
    const logger = fakeLogger();
    const installer = new ElectronUpdaterInstaller(
      updater as never,
      "acme/innytypes",
      "latest",
      logger,
    );
    await expect(installer.checkForUpdates()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("offline"));
  });

  it("quitAndInstall delegates, and never throws when the updater's own call fails", () => {
    const updater = fakeAppUpdater();
    updater.quitAndInstall.mockImplementation(() => {
      throw new Error("nothing staged");
    });
    const logger = fakeLogger();
    const installer = new ElectronUpdaterInstaller(
      updater as never,
      "acme/innytypes",
      "latest",
      logger,
    );
    expect(() => {
      installer.quitAndInstall();
    }).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("nothing staged"));
  });
});
