// The SelfUpdater over electron-updater (WI-0018-24; plan 0022 §G). The real AppUpdater needs a
// real, installed Electron main process, so a fake stands in that keeps the parts of
// electron-updater 6's AppUpdater this adapter relies on (read from its source, AppUpdater.js):
// the `channel` setter turns `allowDowngrade` on; `setFeedURL` replaces the feed;
// `checkForUpdates` reads whatever feed is set NOW and offers an older version only when
// `allowDowngrade` is on; `downloadUpdate` downloads what the last check found.
import { describe, expect, it, vi } from "vitest";
import { ElectronUpdaterInstaller } from "../../src/adapters/update/electron-updater-installer";
import type { ReleaseMetadata } from "../../src/domain/update/release-metadata";
import { ReleaseMismatchError } from "../../src/ports/self-updater";

const CURRENT = "3.0.0";
const NEWER = "3.0.1";
const OLDER = "2.0.1";
const TAG_URL = "https://example.invalid/acme/innytypes/releases/download/v2.0.1";
const GITHUB = "github:acme/innytypes";

function release(version: string, sha512 = `sha-of-${version}`): ReleaseMetadata {
  return { version, files: [{ url: `InnyTypes-${version}-mac.zip`, sha512, size: 10 }] };
}

const order = (a: string, b: string): number => {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  return left.reduce((found, part, index) => found || part - (right[index] ?? 0), 0);
};

/** An AppUpdater shaped and behaving as electron-updater's does, over feeds this test serves. */
function fakeAppUpdater(feeds: Record<string, ReleaseMetadata> = {}) {
  const fake = {
    feeds,
    logger: null as unknown,
    autoDownload: true,
    autoInstallOnAppQuit: false,
    allowDowngrade: false,
    feed: null as string | null,
    channelValue: null as string | null,
    /** allowDowngrade and the feed, as each check saw them. */
    checks: [] as { feed: string | null; allowDowngrade: boolean }[],
    found: null as ReleaseMetadata | null,
    downloaded: null as string | null,
    failDownload: false as boolean | Promise<void>,
    set channel(value: string) {
      fake.channelValue = value;
      fake.allowDowngrade = true; // AppUpdater.js: "allowDowngrade will be automatically set"
    },
    get channel(): string | null {
      return fake.channelValue;
    },
    setFeedURL: vi.fn(
      (options: { provider: string; url?: string; owner?: string; repo?: string }) => {
        fake.feed =
          options.provider === "github"
            ? `github:${String(options.owner)}/${String(options.repo)}`
            : String(options.url);
      },
    ),
    checkForUpdates: vi.fn(async () => {
      fake.checks.push({ feed: fake.feed, allowDowngrade: fake.allowDowngrade });
      await Promise.resolve();
      const info = fake.feed === null ? undefined : fake.feeds[fake.feed];
      if (info === undefined) {
        throw new Error(`HttpError: 404 ${String(fake.feed)}`);
      }
      const newer = order(info.version, CURRENT) > 0;
      const older = order(info.version, CURRENT) < 0;
      const isUpdateAvailable = newer || (fake.allowDowngrade && older);
      fake.found = isUpdateAvailable ? info : null;
      return { isUpdateAvailable, updateInfo: info, versionInfo: info };
    }),
    downloadUpdate: vi.fn(async () => {
      if (fake.failDownload instanceof Promise) {
        await fake.failDownload;
      } else if (fake.failDownload) {
        throw new Error("ECONNRESET");
      }
      fake.downloaded = fake.found?.version ?? null;
      return [`/cache/${String(fake.downloaded)}.zip`];
    }),
    quitAndInstall: vi.fn(),
  };
  return fake;
}

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function installer(fake: ReturnType<typeof fakeAppUpdater>, logger = fakeLogger()) {
  return new ElectronUpdaterInstaller(fake as never, "acme/innytypes", "latest", logger);
}

describe("ElectronUpdaterInstaller", () => {
  it("configures the updater: no download of its own, an install at quit, downgrades never allowed", () => {
    const updater = fakeAppUpdater();
    const logger = fakeLogger();
    new ElectronUpdaterInstaller(updater as never, "acme/innytypes", "beta", logger);
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(updater.channel).toBe("beta");
    // Setting the channel turned it on inside electron-updater; it is off again.
    expect(updater.allowDowngrade).toBe(false);
    expect(updater.logger).toBe(logger);
    expect(updater.setFeedURL).toHaveBeenCalledWith({
      provider: "github",
      owner: "acme",
      repo: "innytypes",
    });
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it("refuses a repo slug that is not owner/repo", () => {
    for (const slug of ["no-slash", "/repo", "owner/"]) {
      expect(
        () => new ElectronUpdaterInstaller(fakeAppUpdater() as never, slug, "latest", fakeLogger()),
      ).toThrow(/owner\/repo/);
    }
  });

  it("downloads an update when what electron-updater found is the verified release", async () => {
    const updater = fakeAppUpdater({ [GITHUB]: release(NEWER) });
    await installer(updater).checkForUpdates(release(NEWER));
    expect(updater.checks).toEqual([{ feed: GITHUB, allowDowngrade: false }]);
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(updater.downloaded).toBe(NEWER);
  });

  it.each([
    ["another version", release("3.0.2")],
    ["another sha512 for the same file", release(NEWER, "sha-of-something-else")],
    [
      "a file the signed metadata does not name",
      { version: NEWER, files: [{ url: "Other.zip", sha512: `sha-of-${NEWER}`, size: 10 }] },
    ],
    ["no files at all", { version: NEWER, files: [] }],
  ])(
    "refuses, and downloads nothing, when electron-updater's own fetch found %s",
    async (_, found) => {
      const updater = fakeAppUpdater({ [GITHUB]: found });
      const outcome = installer(updater).checkForUpdates(release(NEWER));
      await expect(outcome).rejects.toBeInstanceOf(ReleaseMismatchError);
      expect(updater.downloadUpdate).not.toHaveBeenCalled();
      expect(updater.downloaded).toBeNull();
    },
  );

  it("a forward check never stages an older version, even one that matches what it was handed", async () => {
    const updater = fakeAppUpdater({ [GITHUB]: release(OLDER) });
    await expect(installer(updater).checkForUpdates(release(OLDER))).rejects.toThrow(
      /does not offer/,
    );
    expect(updater.checks).toEqual([{ feed: GITHUB, allowDowngrade: false }]);
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
  });

  it("a check or download that fails rejects, for the caller to report", async () => {
    const offline = fakeAppUpdater({});
    await expect(installer(offline).checkForUpdates(release(NEWER))).rejects.toThrow("404");
    const broken = fakeAppUpdater({ [GITHUB]: release(NEWER) });
    broken.failDownload = true;
    await expect(installer(broken).checkForUpdates(release(NEWER))).rejects.toThrow("ECONNRESET");
  });

  it("an inactive electron-updater (a build that is not installed) downloads nothing", async () => {
    const updater = fakeAppUpdater();
    updater.checkForUpdates.mockResolvedValueOnce(null as never);
    await installer(updater).checkForUpdates(release(NEWER));
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
  });

  it("going back pins the tag with the downgrade allowed for that check alone, then restores both", async () => {
    const updater = fakeAppUpdater({ [TAG_URL]: release(OLDER) });
    const logger = fakeLogger();
    await installer(updater, logger).downloadRelease(TAG_URL, release(OLDER));
    expect(updater.checks).toEqual([{ feed: TAG_URL, allowDowngrade: true }]);
    expect(updater.downloaded).toBe(OLDER);
    expect(logger.info).toHaveBeenCalledWith(
      `electron-updater: pinned to ${TAG_URL}, downgrade allowed`,
    );
    expect(updater.feed).toBe(GITHUB);
    expect(updater.allowDowngrade).toBe(false);
  });

  it("a failed Go back restores the feed and the downgrade rule; the next check stages the verified forward version only", async () => {
    // The tag's release verified, then electron-updater's own download of it failed.
    const updater = fakeAppUpdater({ [TAG_URL]: release(OLDER), [GITHUB]: release(NEWER) });
    updater.failDownload = true;
    const updates = installer(updater);
    await expect(updates.downloadRelease(TAG_URL, release(OLDER))).rejects.toThrow("ECONNRESET");
    expect(updater.feed).toBe(GITHUB);
    expect(updater.allowDowngrade).toBe(false);

    // A later forward check (scheduled or Check now) reads the normal feed, without downgrades.
    updater.failDownload = false;
    await updates.checkForUpdates(release(NEWER));
    expect(updater.checks.at(-1)).toEqual({ feed: GITHUB, allowDowngrade: false });
    expect(updater.downloaded).toBe(NEWER);
    updates.quitAndInstall();
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("a Go back whose tag electron-updater reads differently is refused, and the feed restored", async () => {
    const updater = fakeAppUpdater({ [TAG_URL]: release(OLDER, "sha-of-a-substitute") });
    const outcome = installer(updater).downloadRelease(TAG_URL, release(OLDER));
    await expect(outcome).rejects.toBeInstanceOf(ReleaseMismatchError);
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    expect(updater.feed).toBe(GITHUB);
    expect(updater.allowDowngrade).toBe(false);
  });

  it("a Go back whose check fails restores the feed and the downgrade rule too", async () => {
    const updater = fakeAppUpdater({});
    await expect(installer(updater).downloadRelease(TAG_URL, release(OLDER))).rejects.toThrow();
    expect(updater.feed).toBe(GITHUB);
    expect(updater.allowDowngrade).toBe(false);
  });

  it("a check asked for during a Go back waits for it: never run inside the pinned feed", async () => {
    let finish = (): void => undefined;
    const updater = fakeAppUpdater({ [TAG_URL]: release(OLDER), [GITHUB]: release(NEWER) });
    updater.failDownload = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const updates = installer(updater);
    const goingBack = updates.downloadRelease(TAG_URL, release(OLDER));
    const checking = updates.checkForUpdates(release(NEWER));
    await vi.waitFor(() => {
      expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    });
    expect(updater.checks).toEqual([{ feed: TAG_URL, allowDowngrade: true }]);
    updater.failDownload = false;
    finish();
    await goingBack;
    await checking;
    expect(updater.checks).toEqual([
      { feed: TAG_URL, allowDowngrade: true },
      { feed: GITHUB, allowDowngrade: false },
    ]);
  });

  it("quitAndInstall delegates, and never throws when the updater's own call fails", () => {
    const updater = fakeAppUpdater();
    updater.quitAndInstall.mockImplementation(() => {
      throw new Error("nothing staged");
    });
    const logger = fakeLogger();
    const updates = installer(updater, logger);
    expect(() => {
      updates.quitAndInstall();
    }).not.toThrow();
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("nothing staged"));
  });
});
