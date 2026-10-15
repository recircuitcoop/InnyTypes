// Consent-first telemetry through the real app (WI-0018-22): the first-run question, Setup's
// Reports step (plan 0022 §H); nothing queued or sent before it is answered, however often the
// runtime crashes; a question left unanswered asked again on the next launch; a yes that sends this
// launch's usage report and a crash report to local fake servers; off in Configuration › General's
// Reports section (WI-0022-18) stopping everything; the question never asked again once
// answered; and the full privacy notice beside the question while it is unanswered (D25).
//
// The servers are a fake GlitchTip and a fake Umami on one local HTTPS server in this test process
// (test/fixtures/tls). Nothing is ever sent to a real GlitchTip or Umami, and the machine
// identifier is the e2e hooks' stand-in, so this machine's own is never read.
import { createHmac } from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { PRIVACY_NOTICE, PRIVACY_NOTICE_OPENING } from "../../src/ui/general";
import { STRINGS } from "../../src/ui/strings";
import {
  cleanUp,
  launchApp,
  openGeneral,
  quit,
  scratchDirectories,
  waitForRunning,
  type RunningApp,
  FIRST_START_RECORD,
} from "./app-harness";

const TLS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "tls");
const CERT = fs.readFileSync(path.join(TLS, "localhost-cert.pem"), "utf8");
const KEY = fs.readFileSync(path.join(TLS, "localhost-key.pem"), "utf8");

const MACHINE = "E2E-MACHINE-IDENTIFIER-4f7a2c9e";
const LOG_CANARY = "e2e-telemetry-log-canary-6b1d8f3a";

interface Received {
  readonly url: string;
  readonly auth: string;
  readonly body: string;
}

/** Nothing sent should arrive in this long, if it were going to: the sender wakes at once. */
const QUIET_MS = 2_000;

const quiet = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, QUIET_MS);
  });

/** Setup's step now: Reports asks the question. */
const setupStep = (window: Page): Locator => window.getByTestId("setup-step");

/** A button of Setup's step, by its test id, saying its words. */
const SETUP_BUTTON = {
  "setup.welcome.start": "setup-continue",
  "setup.reports.send": "setup-reports-send",
} as const;
async function setupButton(window: Page, key: keyof typeof SETUP_BUTTON): Promise<Locator> {
  const button = setupStep(window).getByTestId(SETUP_BUTTON[key]);
  await expect(button).toHaveText(STRINGS[key]);
  return button;
}

/** The fake GlitchTip and Umami: one local HTTPS server recording every request it is sent. */
async function fakeServers(): Promise<{
  received: Received[];
  server: https.Server;
  port: number;
}> {
  const received: Received[] = [];
  const server = https.createServer({ cert: CERT, key: KEY }, (request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({
        url: request.url ?? "",
        auth: String(request.headers["x-sentry-auth"] ?? ""),
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.writeHead(200).end("{}");
    });
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
  return { received, server, port };
}

/** The app's environment: the e2e hooks, the stand-in machine identifier, the fake servers. */
function appEnv(env: Record<string, string>, port: number): Record<string, string> {
  return {
    ...env,
    INNYTYPES_E2E_HOOKS: "1",
    INNYTYPES_TEST_CATALOGUE_CA: CERT,
    INNYTYPES_TEST_MACHINE_ID: MACHINE,
    INNYTYPES_LOG_CANARY: LOG_CANARY,
    INNYTYPES_GLITCHTIP_DSN: `https://e2ekey@127.0.0.1:${String(port)}/5`,
    INNYTYPES_UMAMI_URL: `https://127.0.0.1:${String(port)}/umami`,
    INNYTYPES_UMAMI_WEBSITE_ID: "e2e-site",
  };
}

/** Every line of the privacy notice (D25), as strings.ts words it. */
const NOTICE_LINES: readonly string[] = [
  PRIVACY_NOTICE_OPENING,
  ...PRIVACY_NOTICE.flatMap((part) => [
    part.heading,
    ...part.lines,
    ...(part.listed ?? []),
    ...(part.after ?? []),
  ]),
].map((key) => STRINGS[key]);

/** The privacy notice in `where`, holding every one of its lines. */
async function expectNotice(where: Locator): Promise<void> {
  const notice = where.getByTestId("privacy-notice");
  await expect(notice).toBeVisible();
  for (const line of NOTICE_LINES) {
    await expect(notice).toContainText(line);
  }
}

/** Crash the runtime and wait for its next generation. */
async function crashRuntime(window: Page): Promise<void> {
  const runtime = await waitForRunning(window, "runtime");
  process.kill(runtime.pid, "SIGKILL");
  await waitForRunning(window, "runtime", runtime.generation + 1);
}

test("telemetry asks first, sends nothing before a yes, sends only redacted reports after, and stops on off", async () => {
  test.setTimeout(180_000);
  const { received, server, port } = await fakeServers();
  const { scratch, userData, env, canaryKey } = scratchDirectories();
  const queue = path.join(userData, "telemetry-queue");
  const queued = (): string[] => (fs.existsSync(queue) ? fs.readdirSync(queue) : []);
  const runEnv = appEnv(env, port);
  const apps: RunningApp["app"][] = [];
  try {
    // ── launch 1: asked in Setup's Reports step; a crash while unanswered reports nothing ───
    const first = await launchApp(runEnv);
    apps.push(first.app);
    await expect(setupStep(first.window)).toHaveAttribute("data-step", "welcome", {
      timeout: 15_000,
    });
    await (await setupButton(first.window, "setup.welcome.start")).click();
    await expect(setupStep(first.window)).toHaveAttribute("data-step", "reports");
    await expect(setupStep(first.window)).toContainText(STRINGS["setup.reports.title"]);
    await expect(setupStep(first.window)).toContainText(STRINGS["setup.reports.body"]);
    await crashRuntime(first.window);
    await quiet();
    expect(received).toEqual([]);
    expect(queued()).toEqual([]);
    // Closed without an answer: that is not a no.
    await quit(first.app);

    // ── launch 2: asked again; a yes sends this launch's usage, then a crash report ────────
    const second = await launchApp(runEnv);
    apps.push(second.app);
    const window = second.window;
    await expect(setupStep(window)).toHaveAttribute("data-step", "reports", { timeout: 15_000 });
    expect(received).toEqual([]);
    await (await setupButton(window, "setup.reports.send")).click();
    await expect(setupStep(window)).toHaveAttribute("data-step", "connect-anytype");
    await expect
      .poll(() => received.map((request) => request.url), { timeout: 15_000 })
      .toEqual(["/umami/api/send"]);
    await crashRuntime(window);
    await expect
      .poll(() => received.map((request) => request.url), { timeout: 15_000 })
      .toEqual(["/umami/api/send", "/api/5/envelope/"]);

    const [usage, crash] = received;
    const machineId = createHmac("sha256", "innytypes.machine-id.v1").update(MACHINE).digest("hex");
    expect(JSON.parse(usage?.body ?? "")).toMatchObject({
      type: "event",
      payload: { website: "e2e-site", name: "usage", data: { machine_id: machineId } },
    });
    expect(crash?.auth).toContain("sentry_key=e2ekey");
    const event = JSON.parse(crash?.body.split("\n")[2] ?? "") as {
      exception: { values: { type: string; value: string }[] };
      tags: Record<string, string>;
      extra: Record<string, unknown>;
    };
    expect(event.exception.values).toEqual([{ type: "RuntimeCrashed", value: "" }]);
    expect(event.tags["machine_id"]).toBe(machineId);
    expect(event.extra).toMatchObject({
      crashed: "runtime",
      stopped_for_good: false,
      crashes: { runtime: 1, services: 0, node: 0, node_stopped: 0 },
    });
    // No canary, no home path, no raw identifier in anything that left.
    const sent = received.map((request) => `${request.auth}\n${request.body}`).join("\n");
    for (const canary of [canaryKey, LOG_CANARY, MACHINE, scratch, userData]) {
      expect(sent).not.toContain(canary);
    }
    await expect.poll(queued, { timeout: 10_000 }).toEqual([]);

    // ── off in General: the switch answers too, and a crash then reports nothing ──────────
    const general = await openGeneral(window);
    const reports = general.getByTestId("general-reports");
    const state = general.getByTestId("general-reports-state");
    await expect(state).toHaveText(STRINGS["general.reports.on"]);
    await expect(reports).toHaveAttribute("data-on", "true");
    await expect(general.getByTestId("general-reports-crash")).toHaveText(
      STRINGS["general.reports.crashNotYet"],
    );
    await expect(reports.getByTestId("general-reports-switch")).toContainText(
      STRINGS["general.reports.switch"],
    );
    await reports.getByTestId("general-reports-switch").click();
    await expect(state).toHaveText(STRINGS["general.reports.off"]);
    await expect(reports).toHaveAttribute("data-on", "false");
    const before = received.length;
    await crashRuntime(window);
    await quiet();
    expect(received).toHaveLength(before);
    expect(queued()).toEqual([]);
    // The answer is stored as off. Setup's state sits beside it, completed by openGeneral (plan
    // 0022 §H, WI-0022-11).
    expect(JSON.parse(fs.readFileSync(path.join(userData, "shell-settings.json"), "utf8"))).toEqual(
      {
        ...FIRST_START_RECORD,
        telemetry: false,
        setup: expect.objectContaining({ step: "connect-anytype", completed: true }) as unknown,
      },
    );
    await quit(second.app);

    // ── launch 3: answered, so never asked again: Setup is over, the window opens on Live ──
    const third = await launchApp(runEnv);
    apps.push(third.app);
    await waitForRunning(third.window, "runtime");
    await expect(third.window.getByTestId("frame")).toHaveAttribute("data-route", "live", {
      timeout: 15_000,
    });
    await expect(setupStep(third.window)).toHaveCount(0);
    const again = await openGeneral(third.window);
    await expect(again.getByTestId("general-reports-state")).toHaveText(
      STRINGS["general.reports.off"],
    );
    await quit(third.app);
    expect(received).toHaveLength(before);
  } finally {
    await cleanUp(apps, scratch);
    await new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    });
  }
});

test("the full privacy notice is beside the question in Setup's Reports step and in General › Reports while unanswered, and nothing is sent before an answer", async () => {
  test.setTimeout(120_000);
  const { received, server, port } = await fakeServers();
  const { scratch, userData, env } = scratchDirectories();
  const queue = path.join(userData, "telemetry-queue");
  const queued = (): string[] => (fs.existsSync(queue) ? fs.readdirSync(queue) : []);
  const apps: RunningApp["app"][] = [];
  try {
    const { app, window } = await launchApp(appEnv(env, port));
    apps.push(app);
    await expect(setupStep(window)).toHaveAttribute("data-step", "welcome", { timeout: 15_000 });
    await (await setupButton(window, "setup.welcome.start")).click();

    // Setup's Reports step: the notice between the question and its two answers.
    await expect(setupStep(window)).toHaveAttribute("data-step", "reports");
    await expectNotice(setupStep(window));
    await quiet();
    expect(received).toEqual([]);
    expect(queued()).toEqual([]);

    // General › Reports, Setup closed with the question still unanswered: the notice again.
    const general = await openGeneral(window);
    const section = general.getByTestId("general-section-reports");
    await expect(section.getByTestId("general-reports-state")).toHaveText(
      STRINGS["general.reports.off"],
    );
    await expectNotice(section);
    await quiet();
    expect(received).toEqual([]);
    expect(queued()).toEqual([]);

    // A yes answers it: the notice goes, and only now does a report leave.
    await section.getByTestId("general-reports-switch").click();
    await expect(section.getByTestId("general-reports-state")).toHaveText(
      STRINGS["general.reports.on"],
    );
    await expect(section.getByTestId("privacy-notice")).toHaveCount(0);
    await expect
      .poll(() => received.map((request) => request.url), { timeout: 15_000 })
      .toEqual(["/umami/api/send"]);
    await quit(app);
  } finally {
    await cleanUp(apps, scratch);
    await new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    });
  }
});
