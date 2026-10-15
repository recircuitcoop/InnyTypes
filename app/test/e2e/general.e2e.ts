// Configuration › General in the real app (plan 0022 §M; WI-0022-18): every section's one-line
// state and actions from ux-writing.md, driven through the screen. Pairing with Anytype and the MCP
// endpoint's live move (the anytype and mcp-endpoint behaviours), See what would be sent in full,
// Advanced's status details, the Recorders and folders line, and retention's five choices.
//
// Never the owner's Anytype, key, port or clipboard: a fake Anytype on a free loopback port, the
// fake MCP child, a scratch HOME (app-harness), free ports, and the page's clipboard replaced by a
// stub that only keeps what it was given (the system clipboard is never read or written).
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import * as path from "node:path";
import { expect, test, type ElectronApplication, type Locator } from "@playwright/test";
import { toolSignature } from "../../src/adapters/anytype/tool-surface";
import { ANYTYPE_VERSION, PACKAGE_VERSION } from "../../src/domain/anytype/pins";
import { STRINGS } from "../../src/ui/strings";
import {
  anytypeKeyFile,
  APP,
  cleanUp,
  freePortNow,
  launchApp,
  openGeneral,
  quit,
  scratchDirectories,
  waitForRunning,
} from "./app-harness";

const KEY = "e2e-general-anytype-key-0123456789";
const FAKE = path.join(APP, "test", "fixtures", "fake-mcp");

/** A fake Anytype: pairing (code 1234), three spaces, and an empty answer to anything else. */
async function fakeAnytype(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      const url = request.url ?? "";
      if (url === "/v1/auth/challenges") {
        response.end('{"challenge_id":"e2e-challenge"}');
      } else if (url === "/v1/auth/api_keys") {
        const sent = JSON.parse(body) as { code?: string };
        response.statusCode = sent.code === "1234" ? 201 : 400;
        response.end(sent.code === "1234" ? JSON.stringify({ api_key: KEY }) : "{}");
      } else if (url.startsWith("/v1/spaces")) {
        response.end(
          JSON.stringify({
            data: ["Renaissance", "Fritte", "Home"].map((name, i) => ({
              id: `space-${String(i)}`,
              name,
              object: "space",
            })),
            pagination: { total: 3, offset: 0, limit: 100, has_more: false },
          }),
        );
      } else {
        response.end('{"data":[]}');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${String((server.address() as net.AddressInfo).port)}`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** The fake child's surface, recorded the way the committed one is. */
function fakeSurface(scratch: string): string {
  const tools = JSON.parse(fs.readFileSync(path.join(FAKE, "tools.json"), "utf8")) as {
    name: string;
    inputSchema: unknown;
  }[];
  const file = path.join(scratch, "fake-surface.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      package_version: PACKAGE_VERSION,
      anytype_version: ANYTYPE_VERSION,
      source: "bundled-spec",
      captured_at: "e2e",
      tools: Object.fromEntries(tools.map((t) => [t.name, toolSignature(t.inputSchema)])),
    }),
  );
  return file;
}

/** The fake MCP child, so the endpoint is served without the real package. */
const fakeChild = (scratch: string) =>
  JSON.stringify({
    entry: path.join(FAKE, "server.mjs"),
    args: ["--mode=canary"],
    surface: fakeSurface(scratch),
  });

/** A section of General, by its kind. */
const section = (general: Locator, kind: string) => general.getByTestId(`general-section-${kind}`);

/** One JSON-RPC call to the endpoint, the way an independent client makes it: its status. */
async function rpcStatus(url: string, token: string): Promise<number> {
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  return response.status;
}

const refused = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.on("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => {
      resolve(true);
    });
  });

test("General pairs with Anytype: Pair asks for the code, a wrong one is refused in words, the right one connects and the line counts the spaces", async () => {
  // Pairing waits on the services process and the MCP child's validation: slow on a busy machine.
  test.setTimeout(120_000);
  const { scratch, env } = scratchDirectories();
  const anytype = await fakeAnytype();
  const apps: ElectronApplication[] = [];
  try {
    // No key to start with: Not paired yet.
    fs.rmSync(anytypeKeyFile(scratch));
    const { app, window } = await launchApp(
      {
        ...env,
        ANYTYPE_API_BASE_URL: anytype.url,
        INNYTYPES_TEST_ANYTYPE: fakeChild(scratch),
      },
      { allowedKeys: [KEY] },
    );
    apps.push(app);
    await waitForRunning(window, "services");
    const general = await openGeneral(window);
    const anytypeSection = section(general, "anytype");
    const state = general.getByTestId("general-anytype-state");
    await expect(state).toHaveText(STRINGS["general.anytype.notPaired"], { timeout: 15_000 });
    const pair = general.getByTestId("general-anytype-pair");
    await expect(pair).toHaveText(STRINGS["general.pair"]);

    // Pair: Anytype shows a code, and General asks for it.
    await pair.click();
    const code = general.getByTestId("general-anytype-code-input");
    await expect(code).toBeVisible();
    await expect(anytypeSection).toContainText(STRINGS["general.anytype.code"]);
    // The code form's submit says Connect, as Setup's does; the start button keeps its label, so
    // each button has a name of its own.
    const connect = general.getByTestId("general-anytype-connect");
    await expect(connect).toHaveText(STRINGS["setup.anytype.connect"]);
    await expect(pair).toHaveText(STRINGS["general.pair"]);
    // Each button has a name of its own: one says Connect, one says Pair.
    const said = await anytypeSection.evaluate((element) =>
      [...element.querySelectorAll("button")].map((button) => button.textContent),
    );
    expect(said.filter((words) => words === STRINGS["setup.anytype.connect"])).toHaveLength(1);
    expect(said.filter((words) => words === STRINGS["general.pair"])).toHaveLength(1);

    // A wrong code is refused with General's sentence; nothing is stored.
    await code.fill("12");
    await general.getByTestId("general-anytype-connect").click();
    await expect(general.getByTestId("general-anytype-message")).toHaveText(
      STRINGS["general.anytype.codeRefused"],
    );
    expect(fs.existsSync(anytypeKeyFile(scratch))).toBe(false);

    // The right code: stored owner-only, never on the page, and the line counts the spaces.
    await code.fill("1234");
    await general.getByTestId("general-anytype-connect").click();
    await expect(state).toHaveText("Connected · 3 spaces", { timeout: 20_000 });
    await expect(pair).toHaveText(STRINGS["general.pairAgain"]);
    await expect(general.getByTestId("general-anytype-code")).toHaveCount(0);
    expect(fs.readFileSync(anytypeKeyFile(scratch), "utf8")).toBe(KEY);
    expect(fs.statSync(anytypeKeyFile(scratch)).mode & 0o777).toBe(0o600);
    expect(await window.content()).not.toContain(KEY);
    // Never a path on the screen.
    expect(await anytypeSection.textContent()).not.toContain(scratch);
    await quit(app);
  } finally {
    await anytype.close();
    await cleanUp(apps, scratch);
  }
});

test("General's AI apps line names the address served, Change port moves it live and says so, a taken port is refused in words, and Copy setup copies the command with the address served", async () => {
  const { scratch, env } = scratchDirectories();
  const anytype = await fakeAnytype();
  const blocker = net.createServer();
  const apps: ElectronApplication[] = [];
  try {
    const firstPort = Number(env["INNYTYPES_MCP_PORT"]);
    const { app, window } = await launchApp({
      ...env,
      ANYTYPE_API_BASE_URL: anytype.url,
      INNYTYPES_TEST_ANYTYPE: fakeChild(scratch),
    });
    apps.push(app);
    const general = await openGeneral(window);
    const state = general.getByTestId("general-ai-apps-state");
    // The address is drawn as code, its backticks not shown.
    await expect(state).toHaveText(
      `Claude, Codex and other apps can use your Anytype through InnyTypes at 127.0.0.1:${String(firstPort)}.`,
      { timeout: 20_000 },
    );
    await expect(state.getByTestId("inline-code")).toHaveText(`127.0.0.1:${String(firstPort)}`);
    // Change port is pre-filled with the port served.
    const port = general.getByTestId("general-port-input");
    await expect(port).toHaveValue(String(firstPort));

    const tokenFile = path.join(path.dirname(anytypeKeyFile(scratch)), "mcp_proxy_token");
    const token = fs.readFileSync(tokenFile, "utf8").trim();
    await expect
      .poll(() => rpcStatus(`http://127.0.0.1:${String(firstPort)}/mcp`, token), {
        timeout: 20_000,
      })
      .toBe(200);

    // A move: the new address serves, the old one is refused, the line and the field follow,
    // and General says apps need the new address.
    const secondPort = freePortNow();
    await port.fill(String(secondPort));
    await general.getByTestId("general-ai-apps-change").click();
    await expect(state).toContainText(`127.0.0.1:${String(secondPort)}`);
    await expect(general.getByTestId("general-ai-apps-message")).toHaveText(
      STRINGS["general.aiApps.moved"],
    );
    await expect(port).toHaveValue(String(secondPort));
    expect(await rpcStatus(`http://127.0.0.1:${String(secondPort)}/mcp`, token)).toBe(200);
    expect(await refused(firstPort)).toBe(true);

    // A port another program holds: refused with ux-writing's sentence, and nothing moves.
    const takenPort = freePortNow();
    await new Promise<void>((resolve) => blocker.listen(takenPort, "127.0.0.1", resolve));
    await port.fill(String(takenPort));
    await general.getByTestId("general-ai-apps-change").click();
    await expect(general.getByTestId("general-ai-apps-message")).toHaveText(
      `Port ${String(takenPort)} is used by another app. Choose another port.`,
    );
    await expect(state).toContainText(`127.0.0.1:${String(secondPort)}`);
    expect(await rpcStatus(`http://127.0.0.1:${String(secondPort)}/mcp`, token)).toBe(200);

    // Copy setup: exactly strings.ts's command with the URL served now filled in, never the
    // token. The page's clipboard is a stub here, so the system clipboard is never touched.
    await window.evaluate(() => {
      const kept = globalThis as unknown as { copiedSetup?: string };
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: (text: string) => {
            kept.copiedSetup = text;
            return Promise.resolve();
          },
        },
      });
    });
    const served = `http://127.0.0.1:${String(secondPort)}/mcp`;
    const copy = general.getByTestId("general-copy-setup");
    await expect(copy).toHaveText(
      STRINGS["general.copySetup"].replace("{app}", STRINGS["general.aiApps.app"]),
    );
    await copy.click();
    await expect(general.getByTestId("general-ai-apps-message")).toHaveText(
      STRINGS["general.aiApps.copied"],
    );
    const copied = await window.evaluate(
      () => (globalThis as unknown as { copiedSetup?: string }).copiedSetup,
    );
    expect(copied).toBe(STRINGS["general.aiApps.setup"].replace("{url}", served));
    expect(copied).not.toContain(token);
    await quit(app);
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
    await anytype.close();
    await cleanUp(apps, scratch);
  }
});

test("Set up ChatGPT says ChatGPT's own steps, Copy address copies the address served as it moves, and Copy token copies the endpoint's token without ever showing or logging it", async () => {
  test.setTimeout(120_000);
  const { scratch, env } = scratchDirectories();
  const anytype = await fakeAnytype();
  const apps: ElectronApplication[] = [];
  try {
    const firstPort = Number(env["INNYTYPES_MCP_PORT"]);
    const { app, window, output } = await launchApp({
      ...env,
      ANYTYPE_API_BASE_URL: anytype.url,
      INNYTYPES_TEST_ANYTYPE: fakeChild(scratch),
    });
    apps.push(app);
    const general = await openGeneral(window);
    const chatgpt = general.getByTestId("general-chatgpt");
    await expect(general.getByTestId("general-ai-apps-state")).toContainText(
      `127.0.0.1:${String(firstPort)}`,
      { timeout: 20_000 },
    );
    // The scratch home's token, the one the endpoint checks.
    const tokenFile = path.join(path.dirname(anytypeKeyFile(scratch)), "mcp_proxy_token");
    const token = fs.readFileSync(tokenFile, "utf8").trim();
    expect(token).not.toBe("");

    // ChatGPT's own steps, in order, every one a strings.ts line.
    await expect(chatgpt.getByTestId("general-chatgpt-title")).toHaveText(
      STRINGS["general.chatgpt"],
    );
    await expect(chatgpt.getByTestId("general-chatgpt-lead")).toHaveText(
      STRINGS["general.chatgpt.line"],
    );
    const steps = [
      STRINGS["general.chatgpt.step.open"],
      STRINGS["general.chatgpt.step.name"],
      STRINGS["general.chatgpt.step.url"],
      STRINGS["general.chatgpt.step.token"],
      STRINGS["general.chatgpt.step.save"],
    ];
    for (const [index, step] of steps.entries()) {
      await expect(chatgpt.getByTestId(`general-chatgpt-step-${String(index + 1)}`)).toHaveText(
        step,
      );
    }
    expect(
      await chatgpt.getByTestId("general-chatgpt-steps").evaluate((list) => list.children.length),
    ).toBe(steps.length);
    await expect(chatgpt.getByTestId("general-chatgpt-actions")).toBeVisible();

    // The page's clipboard is a stub that keeps every text it was given: the system clipboard
    // is never touched.
    await window.evaluate(() => {
      const kept = globalThis as unknown as { copied?: string[] };
      kept.copied = [];
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: (text: string) => {
            kept.copied?.push(text);
            return Promise.resolve();
          },
        },
      });
    });
    const copied = () =>
      window.evaluate(() => (globalThis as unknown as { copied?: string[] }).copied ?? []);
    const message = chatgpt.getByTestId("general-chatgpt-message");

    // Copy address: the URL served now, and again after Change moves it.
    const address = chatgpt.getByTestId("general-chatgpt-copy-address");
    await expect(address).toHaveText(STRINGS["general.chatgpt.copyAddress"]);
    await address.click();
    await expect(message).toHaveText(STRINGS["general.chatgpt.addressCopied"]);
    expect(await copied()).toEqual([`http://127.0.0.1:${String(firstPort)}/mcp`]);
    const secondPort = freePortNow();
    await general.getByTestId("general-port-input").fill(String(secondPort));
    await general.getByTestId("general-ai-apps-change").click();
    await expect(general.getByTestId("general-ai-apps-state")).toContainText(
      `127.0.0.1:${String(secondPort)}`,
      { timeout: 20_000 },
    );
    await address.click();
    expect((await copied()).at(-1)).toBe(`http://127.0.0.1:${String(secondPort)}/mcp`);

    // Copy token: exactly the token the endpoint checks, which then answers with it.
    const copyToken = chatgpt.getByTestId("general-chatgpt-copy-token");
    await expect(copyToken).toHaveText(STRINGS["general.chatgpt.copyToken"]);
    await copyToken.click();
    await expect(message).toHaveText(STRINGS["general.chatgpt.tokenCopied"]);
    const pasted = (await copied()).at(-1) ?? "";
    expect(pasted).toBe(token);
    expect(await rpcStatus(`http://127.0.0.1:${String(secondPort)}/mcp`, pasted)).toBe(200);

    // Never shown, never logged: not in the page's text or markup, not in anything the
    // processes printed, not in the one log.
    expect(await window.evaluate(() => document.body.innerText)).not.toContain(token);
    expect(await window.content()).not.toContain(token);
    await quit(app);
    expect(output.join("")).not.toContain(token);
    const log = path.join(scratch, "Library", "Logs", "innytypes", "innytypes.log");
    expect(fs.existsSync(log)).toBe(true);
    expect(fs.readFileSync(log, "utf8")).not.toContain(token);
  } finally {
    await anytype.close();
    await cleanUp(apps, scratch);
  }
});

test("General's AI apps offers the host beside the port: a host that is not loopback is refused in words and nothing moves, one Change moves both live, and the stored address wins at the next start", async () => {
  test.setTimeout(120_000);
  const { scratch, userData, env } = scratchDirectories();
  const anytype = await fakeAnytype();
  const apps: ElectronApplication[] = [];
  try {
    const firstPort = Number(env["INNYTYPES_MCP_PORT"]);
    // The variable names the IPv4 host; the stored one must win over it at the next start.
    const runEnv = {
      ...env,
      INNYTYPES_MCP_HOST: "127.0.0.1",
      ANYTYPE_API_BASE_URL: anytype.url,
      INNYTYPES_TEST_ANYTYPE: fakeChild(scratch),
    };
    const { app, window } = await launchApp(runEnv);
    apps.push(app);
    const general = await openGeneral(window);
    const state = general.getByTestId("general-ai-apps-state");
    await expect(state).toContainText(`127.0.0.1:${String(firstPort)}`, { timeout: 20_000 });
    const host = general.getByTestId("general-host-input");
    const port = general.getByTestId("general-port-input");
    const change = general.getByTestId("general-ai-apps-change");
    const message = general.getByTestId("general-ai-apps-message");
    await expect(host).toHaveValue("127.0.0.1");
    await expect(port).toHaveValue(String(firstPort));
    await expect(change).toHaveText(STRINGS["general.aiApps.change"]);
    const token = fs
      .readFileSync(path.join(path.dirname(anytypeKeyFile(scratch)), "mcp_proxy_token"), "utf8")
      .trim();
    const first = `http://127.0.0.1:${String(firstPort)}/mcp`;
    await expect.poll(() => rpcStatus(first, token), { timeout: 20_000 }).toBe(200);

    // A wildcard and a name: each refused in words, and the first address still serves.
    for (const refusedHost of ["0.0.0.0", "localhost"]) {
      await host.fill(refusedHost);
      await change.click();
      await expect(message).toHaveText(STRINGS["general.aiApps.hostRefused"]);
      await expect(state).toContainText(`127.0.0.1:${String(firstPort)}`);
      expect(await rpcStatus(first, token)).toBe(200);
    }
    const settings = path.join(userData, "settings.json");
    const storedMcp = () =>
      fs.existsSync(settings)
        ? (JSON.parse(fs.readFileSync(settings, "utf8")) as { mcp?: unknown }).mcp
        : undefined;
    expect(storedMcp()).toBeUndefined();

    // One Change moves host and port together: IPv6 loopback serves, the old address is gone.
    const secondPort = freePortNow();
    const second = `http://[::1]:${String(secondPort)}/mcp`;
    await host.fill("::1");
    await port.fill(String(secondPort));
    await change.click();
    await expect(state).toContainText(`[::1]:${String(secondPort)}`);
    await expect(message).toHaveText(STRINGS["general.aiApps.moved"]);
    await expect(host).toHaveValue("::1");
    await expect(port).toHaveValue(String(secondPort));
    expect(await rpcStatus(second, token)).toBe(200);
    expect(await refused(firstPort)).toBe(true);
    expect(storedMcp()).toEqual({ host: "::1", port: secondPort });
    await quit(app);

    // The next start: the stored address wins over INNYTYPES_MCP_HOST and INNYTYPES_MCP_PORT.
    const again = await launchApp(runEnv);
    apps.push(again.app);
    const reopened = await openGeneral(again.window);
    await expect(reopened.getByTestId("general-ai-apps-state")).toContainText(
      `[::1]:${String(secondPort)}`,
      { timeout: 20_000 },
    );
    await expect(reopened.getByTestId("general-host-input")).toHaveValue("::1");
    await expect.poll(() => rpcStatus(second, token), { timeout: 20_000 }).toBe(200);
    expect(await refused(firstPort)).toBe(true);
    await quit(again.app);
  } finally {
    await anytype.close();
    await cleanUp(apps, scratch);
  }
});

/** Choose `value` in the retention Select, which says `label` (Ark: the trigger, then the option). */
async function chooseRetention(general: Locator, value: string, label: string): Promise<void> {
  await general.getByTestId("general-retention-select-trigger").click();
  const option = general.getByTestId(`general-retention-select-option-${value}`);
  await expect(option).toHaveText(label);
  await option.click();
}

test("General shows the queued reports in full, Advanced's status details, Recorders and folders with none watched, and keeps runs 7, 30, 90 or 365 days or Forever", async () => {
  const { scratch, userData, env } = scratchDirectories();
  // Reports are on, and their one endpoint never answers: this launch's usage report waits in
  // the queue, which is what See what would be sent shows.
  const closedPort = freePortNow();
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(
    path.join(userData, "shell-settings.json"),
    JSON.stringify({
      telemetry: true,
      setup: { step: "welcome", formIndex: 0, formCount: 0, completed: true },
    }),
  );
  const runEnv = {
    ...env,
    INNYTYPES_E2E_HOOKS: "1",
    INNYTYPES_TEST_MACHINE_ID: "E2E-GENERAL-MACHINE-7c1e",
    INNYTYPES_UMAMI_URL: `https://127.0.0.1:${String(closedPort)}/umami`,
    INNYTYPES_UMAMI_WEBSITE_ID: "e2e-site",
  };
  const apps: ElectronApplication[] = [];
  try {
    const first = await launchApp(runEnv);
    apps.push(first.app);
    const window = first.window;
    const runtime = await waitForRunning(window, "runtime");
    const general = await openGeneral(window);

    // ── Reports: the state, the crash caption, and the queued reports in full ───────────────
    await expect(general.getByTestId("general-reports-state")).toHaveText(
      STRINGS["general.reports.on"],
    );
    await expect(general.getByTestId("general-reports-crash")).toHaveText(
      STRINGS["general.reports.crashNotYet"],
    );
    const see = general.getByTestId("general-reports-see");
    await expect(see).toHaveText(STRINGS["general.reports.see"]);
    await see.click();
    const sent = general.getByTestId("general-reports-sent");
    const queued = await window.evaluate(() =>
      (
        globalThis as unknown as {
          inny: { app: { telemetryReports(): Promise<{ kind: string; payload: unknown }[]> } };
        }
      ).inny.app.telemetryReports(),
    );
    expect(queued.map((report) => report.kind)).toEqual(["usage"]);
    // In full: each report's every field, exactly as it would leave.
    await expect(sent.getByTestId("general-reports-report")).toHaveText(
      queued.map((report) => JSON.stringify(report.payload, null, 2)),
    );
    await expect(see).toHaveText(STRINGS["general.reports.hide"]);
    await expect(see).toHaveAttribute("aria-expanded", "true");
    // Off deletes what waits, and the list says nothing waits.
    await expect(general.getByTestId("general-reports-switch")).toContainText(
      STRINGS["general.reports.switch"],
    );
    await general.getByTestId("general-reports-switch").click();
    await expect(general.getByTestId("general-reports-state")).toHaveText(
      STRINGS["general.reports.off"],
    );
    await expect(sent).toHaveText(STRINGS["general.reports.nothing"]);

    // ── Advanced: each child's state, process, port and generation; the endpoint served ─────
    const advanced = general.getByTestId("general-advanced");
    await expect(section(general, "advanced")).toContainText(STRINGS["general.advanced.line"]);
    const runtimeRow = advanced.getByTestId("general-child-runtime");
    await expect(runtimeRow).toHaveAttribute("data-state", "running");
    await expect(runtimeRow).toContainText(STRINGS["status.running"]);
    await expect(advanced.getByTestId("general-child-runtime-process")).toHaveText(
      `${String(runtime.pid)} · ${runtime.port} · ${String(runtime.generation)}`,
    );
    await expect(advanced.getByTestId("general-child-services")).toHaveAttribute(
      "data-state",
      "running",
    );
    await expect(advanced.getByTestId("general-advanced-endpoint")).toContainText(
      `http://127.0.0.1:${env["INNYTYPES_MCP_PORT"] ?? ""}/mcp`,
      { timeout: 20_000 },
    );
    await expect(advanced.getByTestId("general-advanced-anytype")).toBeVisible();
    await expect(advanced.getByTestId("general-advanced-secrets")).toHaveAttribute(
      "data-backend",
      /^(keychain|file)$/,
    );
    // A restart is followed: the runtime's next generation shows without a reload.
    process.kill(runtime.pid, "SIGKILL");
    const next = await waitForRunning(window, "runtime", runtime.generation + 1);
    await expect(advanced.getByTestId("general-child-runtime-process")).toHaveText(
      `${String(next.pid)} · ${next.port} · ${String(next.generation)}`,
      { timeout: 15_000 },
    );

    // ── Recorders and folders: no folder source in any flow, so none is watched ────────────
    await expect(general.getByTestId("general-recorders-state")).toHaveText(
      STRINGS["general.recorders.none"],
    );

    // ── Retention (D8): 90 days unless changed; each of the five choices is kept ────────────
    const runsState = general.getByTestId("general-runs-state");
    await expect(runsState).toHaveText("Runs are kept for 90 days.");
    const stored = () =>
      (
        JSON.parse(fs.readFileSync(path.join(userData, "shell-settings.json"), "utf8")) as {
          runs?: { retentionDays?: number | null };
        }
      ).runs?.retentionDays;
    for (const [label, days, line] of [
      ["7 days", 7, "Runs are kept for 7 days."],
      ["30 days", 30, "Runs are kept for 30 days."],
      ["365 days", 365, "Runs are kept for 365 days."],
      ["90 days", 90, "Runs are kept for 90 days."],
      ["Forever", null, "Runs are kept until you delete them."],
    ] as const) {
      await chooseRetention(general, days === null ? "forever" : String(days), label);
      await expect(runsState, label).toHaveText(line);
      await expect.poll(stored, { message: label }).toBe(days);
    }

    await general.getByTestId("general-add-folder").click();
    await expect
      .poll(() => window.evaluate(() => globalThis.location.hash))
      .toBe("#/configuration/flows");
    await quit(first.app);

    // The next launch reads Forever back.
    const second = await launchApp(runEnv);
    apps.push(second.app);
    const again = await openGeneral(second.window);
    await expect(again.getByTestId("general-runs-state")).toHaveText(
      "Runs are kept until you delete them.",
    );
    await expect(again.getByTestId("general-retention")).toHaveAttribute("data-value", "forever");
    await quit(second.app);
  } finally {
    await cleanUp(apps, scratch);
  }
});

test("General's Recorders and folders lists each folder source by its folder's name, watching while its flow is on, and says none is watched only when there is none", async () => {
  const { scratch, env } = scratchDirectories();
  const apps: ElectronApplication[] = [];
  try {
    const { app, window } = await launchApp(env);
    apps.push(app);
    await waitForRunning(window, "runtime");
    const general = await openGeneral(window);
    const state = general.getByTestId("general-recorders-state");
    await expect(state).toHaveText(STRINGS["general.recorders.none"], { timeout: 15_000 });

    // The starter, folder to Anytype: its folder source set to a folder in the scratch home.
    const watched = path.join(scratch, "Recordings");
    fs.mkdirSync(watched);
    const step = await window.evaluate(async (folder) => {
      type Flow = { id: string; sources: { id: string; type: string }[] };
      const api = (
        globalThis as unknown as {
          inny: {
            app: {
              flowFromTemplate(id: string): Promise<{ ok: boolean; value: { id: string } }>;
              flows(): Promise<{ ok: boolean; value: Flow[] }>;
              configureNode(
                flowId: string,
                nodeId: string,
                values: Record<string, unknown>,
              ): Promise<{ ok: boolean }>;
            };
          };
        }
      ).inny.app;
      // A flow write waits for the canvas to finish loading ("loading"): asked again until then.
      let made = await api.flowFromTemplate("folder-to-anytype");
      for (let tries = 0; !made.ok && tries < 60; tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        made = await api.flowFromTemplate("folder-to-anytype");
      }
      if (!made.ok) return { made: JSON.stringify(made), configured: false, flowId: "" };
      const flows = await api.flows();
      const flow = flows.value.find((each) => each.id === made.value.id);
      const source = flow?.sources.find((each) => each.type === "inny-folder-watch");
      const configured = await api.configureNode(made.value.id, source?.id ?? "", { folder });
      return {
        made: made.ok,
        configured: configured.ok,
        flowId: made.value.id,
      };
    }, watched);
    expect(step).toMatchObject({ made: true, configured: true });

    // A new flow is off: its folder is listed, by name, not watched.
    const line = general.getByTestId("general-recorder");
    await expect(line).toHaveText("Recordings · not watching: its flow is off", {
      timeout: 15_000,
    });
    await expect(state).not.toContainText(STRINGS["general.recorders.none"]);
    await expect(state).not.toContainText(scratch);

    // Switched on: watching.
    const on = await window.evaluate(
      (flowId) =>
        (
          globalThis as unknown as {
            inny: { app: { setFlowOn(id: string, on: boolean): Promise<{ ok: boolean }> } };
          }
        ).inny.app.setFlowOn(flowId, true),
      step.flowId,
    );
    expect(on.ok).toBe(true);
    await expect(line).toHaveText("Recordings · watching", { timeout: 15_000 });
    await expect(line).toHaveCount(1);
    await quit(app);
  } finally {
    await cleanUp(apps, scratch);
  }
});
