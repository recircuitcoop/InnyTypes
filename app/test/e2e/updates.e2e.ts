// InnyTypes' own update in the real app (plan 0022 §G, owner decision D4), driven through
// Configuration › General › Updates and the runtime banner.
//
// - Every state's sentence from ux-writing, reached by Check now against a feed that answers,
//   holds, refuses or tampers; Quit and update quits; "Check automatically" is stored.
// - Go back verifies the older release exactly as an update is verified (its tag's signed
//   latest-*.yml, its artifact's sha512) before electron-updater is pinned to it, and quits to
//   install it; a tampered older release is refused and nothing is installed.
// - A crash loop just after an update offers Go back in the banner and in one notice, never
//   applying it.
//
// Never GitHub or any network release host: every release is served by a local HTTPS fake on
// loopback (test/fixtures/tls), signed by a throwaway key generated here. The dev build is not
// packaged, so electron-updater itself never downloads or installs anything.
import fs from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { sha512Base64 } from "../../src/adapters/signature/digest";
import { t } from "../../src/ui/strings";
import { Signer } from "../fakes/minisign-signer";
import {
  APP,
  cleanUp,
  exitOf,
  launchApp,
  openGeneral,
  quit,
  scratchDirectories,
  waitForRunning,
} from "./app-harness";

const TLS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "tls");
const CERT = fs.readFileSync(path.join(TLS, "localhost-cert.pem"), "utf8");
const KEY = fs.readFileSync(path.join(TLS, "localhost-key.pem"), "utf8");

/** The version this dev build reports (app.getVersion() reads app/package.json). */
const CURRENT = (
  JSON.parse(fs.readFileSync(path.join(APP, "package.json"), "utf8")) as {
    version: string;
  }
).version;
const NEWER = `${String(Number(CURRENT.split(".")[0]) + 1)}.0.0`;
/** A release older than any this project made: the one Go back returns to. */
const OLD = "0.0.1";
const OLD_TAG = `v${OLD}`;
const PLATFORM = process.platform === "darwin" ? "mac" : "linux";
const YML = `latest-${PLATFORM}.yml`;

const LATEST = "/releases/latest/download";
const OLD_DIR = `/releases/download/${OLD_TAG}`;

/** A local HTTPS release host: what it serves, what it was asked, and responses held back. */
async function serve() {
  const published = new Map<string, Uint8Array>();
  const asked: string[] = [];
  const held = new Map<string, Promise<void>>();
  const server = https.createServer({ cert: CERT, key: KEY }, (request, response) => {
    const url = request.url ?? "";
    asked.push(url);
    void (held.get(url) ?? Promise.resolve()).then(() => {
      const body = published.get(url);
      if (body === undefined) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-length": String(body.length) }).end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `https://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    published,
    asked,
    /** Hold `url`'s answer until the returned function is called. */
    hold(url: string): () => void {
      let release = (): void => undefined;
      held.set(
        url,
        new Promise<void>((resolve) => {
          release = () => {
            held.delete(url);
            resolve();
          };
        }),
      );
      return () => {
        release();
      };
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
type Host = Awaited<ReturnType<typeof serve>>;

/**
 * Publish `version` under `dir` as electron-builder does: its yml, the yml's minisign signature by
 * `signer`, and the artifact. `served` replaces the artifact's bytes after its sha512 was signed.
 */
function publish(
  host: Host,
  dir: string,
  version: string,
  signer: Signer,
  served?: Uint8Array,
): string {
  const artifact = new TextEncoder().encode(`InnyTypes ${version}, the zip's bytes`);
  const file = `InnyTypes-${version}-${process.arch}-${PLATFORM}.zip`;
  const yaml = new TextEncoder().encode(
    `version: ${version}\nfiles:\n  - url: ${file}\n    sha512: ${sha512Base64(artifact)}\n` +
      `    size: ${String(artifact.length)}\npath: ${file}\nsha512: ${sha512Base64(artifact)}\n`,
  );
  host.published.set(`${dir}/${YML}`, yaml);
  host.published.set(`${dir}/${YML}.minisig`, new TextEncoder().encode(signer.sign(yaml)));
  host.published.set(`${dir}/${file}`, served ?? artifact);
  return `${dir}/${file}`;
}

function unpublish(host: Host): void {
  host.published.clear();
}

/** The app pointed at the fake host, trusting `signer`'s key; `lastVersion` as if it ran before. */
function setUp(host: Host, signer: Signer, lastVersion?: string) {
  const dirs = scratchDirectories();
  if (lastVersion !== undefined) {
    fs.mkdirSync(dirs.userData, { recursive: true });
    fs.writeFileSync(
      path.join(dirs.userData, "shell-settings.json"),
      JSON.stringify({ appUpdate: { lastVersion } }),
    );
  }
  const env = {
    ...dirs.env,
    INNYTYPES_E2E_HOOKS: "1",
    INNYTYPES_TEST_CATALOGUE_CA: CERT,
    INNYTYPES_TEST_UPDATE_RELEASES: `${host.base}/releases`,
    INNYTYPES_UPDATE_KEY: signer.publicKeyLine,
  };
  return { ...dirs, env };
}

const settingsOf = (userData: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(userData, "shell-settings.json"), "utf8")) as Record<
    string,
    unknown
  >;

const stateLine = (window: Page) => window.getByTestId("general-update-state");
const checkNow = (window: Page) => window.getByTestId("general-update-check").click();

async function confirmGoBack(window: Page): Promise<void> {
  await window.getByTestId("general-update-go-back").click();
  const dialog = window.getByRole("dialog");
  await expect(dialog).toContainText(t("general.goBack.confirm", { version: OLD }));
  await dialog.getByRole("button", { name: t("general.goBack.yes"), exact: true }).click();
}

const TODAY = t("time.today");
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("every state sentence", async () => {
  test.setTimeout(4 * 60_000);
  const host = await serve();
  const signer = new Signer();
  const { scratch, userData, env } = setUp(host, signer);
  const apps: ElectronApplication[] = [];
  try {
    const first = await launchApp(env);
    apps.push(first.app);
    let window = first.window;
    await openGeneral(window);
    const line = stateLine(window);

    // Unchecked: nothing to go back to, the switch off by default.
    await expect(line).toHaveText(t("update.unchecked", { version: CURRENT }));
    await expect(window.getByTestId("general-update-go-back")).toHaveCount(0);
    await expect(window.getByTestId("general-update-auto")).toHaveAttribute("data-on", "false");

    // No feed: the check failed for want of a connection (no check finished yet).
    await checkNow(window);
    await expect(line).toHaveText(t("update.checkFailed.noConnection"));
    await expect(line).toHaveAttribute("data-state", "check-failed");

    // Checking…, held at the metadata; then up to date, with today's time.
    publish(host, LATEST, CURRENT, signer);
    let release = host.hold(`${LATEST}/${YML}`);
    await checkNow(window);
    await expect(line).toHaveText(t("update.checking"));
    release();
    await expect(line).toHaveText(
      new RegExp(
        `^${escape(t("update.upToDate", { version: CURRENT, day: TODAY, time: "TIME" })).replace("TIME", "\\d\\d:\\d\\d")}$`,
      ),
    );

    // The feed gone again: the failure names when the last check was.
    unpublish(host);
    await checkNow(window);
    await expect(line).toHaveText(
      `${t("update.checkFailed.noConnection")} ${t("update.lastChecked", { day: TODAY })}`,
    );

    // A newer version whose artifact was tampered with: downloading (held), then refused.
    const tampered = publish(host, LATEST, NEWER, signer, new TextEncoder().encode("tampered"));
    release = host.hold(tampered);
    await checkNow(window);
    await expect(line).toHaveText(t("update.downloading", { version: NEWER, percent: 0 }));
    await expect(window.getByRole("progressbar")).toBeVisible();
    release();
    await expect(line).toHaveText(t("update.installFailed", { version: NEWER }));

    // The real one: ready, with Quit and update as the Primary button.
    unpublish(host);
    publish(host, LATEST, NEWER, signer);
    await checkNow(window);
    await expect(line).toHaveText(t("update.ready", { version: NEWER }));
    const quitAndUpdate = window.getByTestId("general-update-quit");
    await expect(quitAndUpdate).toHaveText(t("general.quitAndUpdate"));
    await expect(quitAndUpdate).toHaveAttribute("data-variant", /kind=primary/);

    // "Check automatically" is stored, and put back.
    const auto = window.getByTestId("general-update-auto");
    await auto.getByRole("checkbox").click({ force: true });
    await expect(auto).toHaveAttribute("data-on", "true");
    expect(settingsOf(userData)["update"]).toEqual({ auto_check: true, channel: "latest" });
    await auto.getByRole("checkbox").click({ force: true });
    await expect(auto).toHaveAttribute("data-on", "false");

    // Quit and update quits InnyTypes (the quit is where the install happens).
    const exited = exitOf(first.app);
    await quitAndUpdate.click();
    await exited;

    // The next start is on another version than the one that ran last: updated, with Go back.
    const stored = settingsOf(userData);
    fs.writeFileSync(
      path.join(userData, "shell-settings.json"),
      JSON.stringify({
        ...stored,
        appUpdate: { ...(stored["appUpdate"] as object), lastVersion: OLD },
      }),
    );
    const second = await launchApp(env);
    apps.push(second.app);
    window = second.window;
    await openGeneral(window);
    await expect(stateLine(window)).toHaveText(
      t("update.updated", { version: CURRENT, day: TODAY }),
    );
    await expect(window.getByTestId("general-update-go-back")).toHaveText(
      t("general.goBack", { version: OLD }),
    );

    // Going back…, held; the older release cannot be reached, which is a failed check.
    unpublish(host);
    release = host.hold(`${OLD_DIR}/${YML}`);
    await confirmGoBack(window);
    await expect(stateLine(window)).toHaveText(t("update.rollingBack", { version: OLD }));
    release();
    await expect(stateLine(window)).toHaveText(
      `${t("update.checkFailed.noConnection")} ${t("update.lastChecked", { day: TODAY })}`,
    );
    await quit(second.app);
  } finally {
    await cleanUp(apps, scratch);
    await host.close();
  }
});

test("go back verifies the old release", async () => {
  test.setTimeout(2 * 60_000);
  const host = await serve();
  const signer = new Signer();
  const { scratch, userData, env } = setUp(host, signer, OLD);
  const apps: ElectronApplication[] = [];
  try {
    const artifact = publish(host, OLD_DIR, OLD, signer);
    const { app, window, output } = await launchApp(env);
    apps.push(app);
    await openGeneral(window);
    await expect(stateLine(window)).toHaveText(
      t("update.updated", { version: CURRENT, day: TODAY }),
    );
    // Recorded at the first start on this version: the release Go back returns to, by its tag.
    expect(settingsOf(userData)["appUpdate"]).toMatchObject({
      lastVersion: CURRENT,
      previous: { version: OLD, tag: OLD_TAG },
    });

    const exited = exitOf(app);
    await confirmGoBack(window);
    await exited;

    // The older release's own signed yml, its signature and its artifact, from its tag only.
    expect(host.asked).toEqual([`${OLD_DIR}/${YML}`, `${OLD_DIR}/${YML}.minisig`, artifact]);
    const log = output.join("");
    expect(log).toContain(`update: going back to ${OLD}: ${host.base}${OLD_DIR}/${YML}`);
    // Only then is electron-updater pinned to that release, with the downgrade allowed.
    expect(log).toContain(`electron-updater: pinned to ${host.base}${OLD_DIR}, downgrade allowed`);
    expect(log.indexOf("electron-updater: pinned to")).toBeGreaterThan(
      log.indexOf(`update: going back to ${OLD}:`),
    );
    expect(settingsOf(userData)["appUpdate"]).toMatchObject({ goingBackTo: OLD });
  } finally {
    await cleanUp(apps, scratch);
    await host.close();
  }
});

test("tampered old release refused", async () => {
  test.setTimeout(2 * 60_000);
  const host = await serve();
  const signer = new Signer();
  const { scratch, userData, env } = setUp(host, signer, OLD);
  const apps: ElectronApplication[] = [];
  try {
    // Signed by a key other than the one this build trusts.
    const artifact = publish(host, OLD_DIR, OLD, new Signer());
    const { app, window, output } = await launchApp(env);
    apps.push(app);
    await openGeneral(window);
    const refused = t("update.installFailed", { version: OLD });

    await confirmGoBack(window);
    await expect(stateLine(window)).toHaveText(refused);
    expect(host.asked).not.toContain(artifact);

    // Signed by the right key, but the artifact is not the one the signature names.
    unpublish(host);
    host.asked.length = 0;
    publish(host, OLD_DIR, OLD, signer, new TextEncoder().encode("tampered"));
    await confirmGoBack(window);
    await expect(stateLine(window)).toHaveText(refused);
    expect(host.asked).toContain(artifact);

    // Neither reached electron-updater, nothing is going back, and InnyTypes kept running.
    const log = output.join("");
    expect(log).not.toContain("electron-updater: pinned to");
    expect(log).not.toContain(`update: going back to ${OLD}:`);
    expect(log.match(/notice: An InnyTypes update was refused:/g)?.length).toBeGreaterThan(0);
    expect(settingsOf(userData)["appUpdate"]).toMatchObject({ goingBackTo: null });
    await waitForRunning(window, "runtime");
    await quit(app);
  } finally {
    await cleanUp(apps, scratch);
    await host.close();
  }
});

test("a crash loop just after an update offers Go back, and never applies it", async () => {
  test.setTimeout(3 * 60_000);
  const host = await serve();
  const signer = new Signer();
  const { scratch, env } = setUp(host, signer, OLD);
  const apps: ElectronApplication[] = [];
  try {
    const { app, window, output } = await launchApp(env);
    apps.push(app);
    let current = await waitForRunning(window, "runtime");
    await openGeneral(window);
    for (let crash = 1; crash <= 5; crash++) {
      process.kill(current.pid, "SIGKILL");
      if (crash < 5) {
        current = await waitForRunning(window, "runtime", current.generation + 1);
      }
    }
    const banner = window.getByTestId("runtime-banner");
    await expect(banner).toHaveAttribute("data-banner", "down", { timeout: 30_000 });
    const offer = banner.getByRole("button", {
      name: t("general.goBack", { version: OLD }),
      exact: true,
    });
    await expect(offer).toBeVisible();
    // One notice, offering it.
    expect(
      output.join("").match(new RegExp(`notice: Go back to InnyTypes ${escape(OLD)}\\?`, "g")),
    ).toHaveLength(1);

    // Offered, never applied: the state is as it was and no release was even asked for.
    await expect(stateLine(window)).toHaveText(
      t("update.updated", { version: CURRENT, day: TODAY }),
    );
    expect(host.asked).toEqual([]);
    // The banner's Go back asks first; Cancel leaves everything as it was.
    await offer.click();
    await expect(window.getByRole("dialog")).toContainText(
      t("general.goBack.confirm", { version: OLD }),
    );
    await window
      .getByRole("dialog")
      .getByRole("button", { name: t("dialog.cancel"), exact: true })
      .click();
    expect(host.asked).toEqual([]);
    await quit(app);
  } finally {
    await cleanUp(apps, scratch);
    await host.close();
  }
});
