// Consent-first telemetry through the real app (WI-0018-22): the first-launch question with its
// privacy notice; nothing queued or sent before it is answered, however often the runtime crashes;
// a dismissed question asked again on the next launch; a yes that sends this launch's usage report
// and a crash report to local fake servers; off in Settings stopping everything; and the question
// never asked again once answered.
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
import { expect, test, type Page } from "@playwright/test";
import {
  cleanUp,
  launchApp,
  quit,
  scratchDirectories,
  waitForRunning,
  type RunningApp,
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

/** Crash the runtime and wait for its next generation. */
async function crashRuntime(window: Page): Promise<void> {
  const runtime = await waitForRunning(window, "runtime");
  process.kill(runtime.pid, "SIGKILL");
  await waitForRunning(window, "runtime", runtime.generation + 1);
}

test("telemetry asks first, sends nothing before a yes, sends only redacted reports after, and stops on off", async () => {
  test.setTimeout(180_000);
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
  const { scratch, userData, env, canaryKey } = scratchDirectories();
  const queue = path.join(userData, "telemetry-queue");
  const queued = (): string[] => (fs.existsSync(queue) ? fs.readdirSync(queue) : []);
  const runEnv = {
    ...env,
    INNYTYPES_E2E_HOOKS: "1",
    INNYTYPES_TEST_CATALOGUE_CA: CERT,
    INNYTYPES_TEST_MACHINE_ID: MACHINE,
    INNYTYPES_LOG_CANARY: LOG_CANARY,
    INNYTYPES_GLITCHTIP_DSN: `https://e2ekey@127.0.0.1:${String(port)}/5`,
    INNYTYPES_UMAMI_URL: `https://127.0.0.1:${String(port)}/umami`,
    INNYTYPES_UMAMI_WEBSITE_ID: "e2e-site",
  };
  const apps: RunningApp["app"][] = [];
  try {
    // ── launch 1: asked, with the notice; a crash while unanswered reports nothing ─────────
    const first = await launchApp(runEnv);
    apps.push(first.app);
    const question = first.window.getByTestId("telemetry-question");
    await expect(question).toBeVisible();
    await expect(first.window.getByTestId("telemetry-question-text")).toContainText(
      "Send anonymous usage and crash reports",
    );
    await expect(first.window.getByTestId("telemetry-notice")).toContainText("GDPR");
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
    await expect(window.getByTestId("telemetry-question")).toBeVisible();
    expect(received).toEqual([]);
    await window.getByTestId("telemetry-yes").click();
    await expect(window.getByTestId("telemetry-question")).toBeHidden();
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

    // ── off in Settings: the switch answers too, and a crash then reports nothing ─────────
    await window.getByTestId("nav-settings").click();
    const state = window.getByTestId("settings-telemetry-state");
    await expect(state).toHaveText("on");
    await window.getByTestId("settings-telemetry-toggle").click();
    await expect(state).toHaveText("off");
    const before = received.length;
    await crashRuntime(window);
    await quiet();
    expect(received).toHaveLength(before);
    expect(queued()).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(userData, "shell-settings.json"), "utf8"))).toEqual(
      {
        telemetry: false,
      },
    );
    await quit(second.app);

    // ── launch 3: answered, so never asked again ───────────────────────────────────────────
    const third = await launchApp(runEnv);
    apps.push(third.app);
    await waitForRunning(third.window, "runtime");
    await expect(third.window.getByTestId("telemetry-question")).toBeHidden();
    await third.window.getByTestId("nav-settings").click();
    await expect(third.window.getByTestId("settings-telemetry-state")).toHaveText("off");
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
