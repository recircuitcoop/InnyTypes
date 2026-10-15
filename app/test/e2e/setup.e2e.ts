// Setup in the real app (plan 0022 §H, Acceptance "setup"; WI-0022-16), driven through its screens:
// Welcome, Reports, Connect Anytype, Source folder, the starter's node forms, Ready, with the Setup
// sidebar listing Welcome, Reports, Anytype, Source folder, Steps and Ready. No package step and no
// starter choice: the shipped anytype and folder packages are simply there, and the starter flow
// is installed once Setup reaches Source folder. Try with a sample copies the bundled sample into
// the chosen folder and the starter's run reaches Done, filed in a fake Anytype.
//
// Never the owner's Anytype, key or files: a fake Anytype on a free loopback port (paired with the
// code 1234 through Setup itself), the fake MCP child, a scratch HOME and userData (app-harness),
// and the shell's folder chooser replaced so it answers a folder in the scratch home.
import fs from "node:fs";
import * as path from "node:path";
import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { toolSignature } from "../../src/adapters/anytype/tool-surface";
import { ANYTYPE_VERSION, PACKAGE_VERSION } from "../../src/domain/anytype/pins";
import { STRINGS } from "../../src/ui/strings";
import { FakeAnytypeServer } from "../fakes/anytype";
import { anytypeKeyFile, APP, cleanUp, launchApp, quit, scratchDirectories } from "./app-harness";

/** The key the fake Anytype hands out for the code 1234: a test value, not a credential. */
const KEY = "e2e-setup-anytype-key-5b21";
const FAKE = path.join(APP, "test", "fixtures", "fake-mcp");
/** An address nothing answers on: a starter that never meets a file never calls it anyway. */
const NOWHERE = "http://127.0.0.1:9";

/** The titles the walkthrough shows, in order (ux-writing "The first run (Setup)"). */
const WALK = [
  STRINGS["setup.welcome.title"],
  STRINGS["setup.reports.title"],
  STRINGS["setup.anytype.title"],
  STRINGS["setup.folder.title"],
  "Set up: File in Anytype",
  STRINGS["setup.ready.title"],
];

/** The fake MCP child's surface, so the services process comes up ready on it once paired. */
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

type Answer = { ok: boolean; value?: unknown; refused?: { reason: string } };
interface Flow {
  id: string;
  name: string;
  on: boolean;
  health: { kind: string };
  steps: { id: string; type: string }[];
  sources: { id: string; type: string }[];
}
interface Api {
  inny: { app: Record<string, (...args: unknown[]) => Promise<Answer>> };
}

/** One AppApi call from the page. */
const call = (window: Page, name: string, ...args: unknown[]) =>
  window.evaluate(([op, given]) => (window as unknown as Api).inny.app[op]?.(...given), [
    name,
    args,
  ] as const) as Promise<Answer>;

const flowsOf = async (window: Page) => (await call(window, "flows")).value as Flow[];

const setupStep = (window: Page) => window.getByTestId("setup-step");
const title = (window: Page) => setupStep(window).getByTestId("setup-step-title");
/** Setup's buttons, by the ux-writing words each one says. */
const SETUP_BUTTON = {
  "setup.welcome.start": "setup-continue",
  "setup.continue": "setup-continue",
  "setup.back": "setup-back",
  "setup.reports.dontSend": "setup-reports-dont-send",
  "setup.anytype.skip": "setup-anytype-skip",
  "setup.anytype.connect": "setup-anytype-connect",
  "setup.ready.own": "setup-ready-own",
  "setup.ready.openLive": "setup-ready-open-live",
  "setup.ready.sample": "setup-ready-sample",
} as const;
const button = (window: Page, key: keyof typeof SETUP_BUTTON) =>
  setupStep(window).getByTestId(SETUP_BUTTON[key]);
/** The sidebar's current entry, by its words: the one marked as the current step. */
const currentStep = (sidebar: Locator) =>
  sidebar
    .getByTestId("sidebar-step")
    .evaluateAll((all) =>
      all.filter((li) => li.getAttribute("aria-current") === "step").map((li) => li.textContent),
    );

/** The shell's folder chooser answers `folder`, as the person choosing it would. */
async function chooserAnswers(app: ElectronApplication, folder: string): Promise<void> {
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [chosen] });
  }, folder);
}

/** Wait for a step, by its id, and say its title for the walk's record. */
async function at(window: Page, step: string, seen: string[]): Promise<void> {
  await expect(setupStep(window)).toHaveAttribute("data-step", step, { timeout: 20_000 });
  seen.push((await title(window).textContent()) ?? "");
}

/** Welcome and Reports (Don't send), to Connect Anytype. */
async function welcomeAndReports(window: Page, seen: string[]): Promise<void> {
  await at(window, "welcome", seen);
  await button(window, "setup.welcome.start").click();
  await at(window, "reports", seen);
  await button(window, "setup.reports.dontSend").click();
  await at(window, "connect-anytype", seen);
}

/** Source folder: the starter installed, the folder chosen, its name shown; then Continue. */
async function chooseFolder(app: ElectronApplication, window: Page, folder: string) {
  await chooserAnswers(app, folder);
  const choose = window.getByTestId("setup-choose-folder");
  await expect(choose).toHaveAttribute("data-variant", /state=default/, { timeout: 30_000 });
  await choose.click();
  await expect(window.getByTestId("setup-folder")).toHaveText(path.basename(folder));
}

/** The starter's one node form (File in Anytype): its space and where Anytype answers. */
async function fillForm(window: Page, seen: string[], space: string, api: string) {
  await at(window, "node-forms", seen);
  await expect(setupStep(window)).toContainText("Step 1 of 1.");
  const field = (key: string) => window.getByTestId(`setup-field-${key}-text-input`);
  await expect(field("space_id")).toBeVisible({ timeout: 15_000 });
  // Continue with the space empty is refused, and the form says so.
  await button(window, "setup.continue").click();
  await expect(window.getByTestId("setup-message")).toContainText("File in Anytype");
  await expect(setupStep(window)).toHaveAttribute("data-step", "node-forms");
  await field("space_id").fill(space);
  await field("api_base_url").fill(api);
  await button(window, "setup.continue").click();
}

/** From a fresh launch to Ready, Anytype skipped (nothing answers it). */
async function walkToReady(app: ElectronApplication, window: Page, folder: string) {
  const seen: string[] = [];
  await welcomeAndReports(window, seen);
  await button(window, "setup.anytype.skip").click();
  await at(window, "source-folder", seen);
  await chooseFolder(app, window, folder);
  await button(window, "setup.continue").click();
  await fillForm(window, seen, "sp-any", NOWHERE);
  await at(window, "ready", seen);
  return seen;
}

test("quit mid-setup resumes", async () => {
  test.setTimeout(180_000);
  const { scratch, env } = scratchDirectories();
  const watched = path.join(scratch, "Recordings");
  fs.mkdirSync(watched);
  const apps: ElectronApplication[] = [];
  try {
    const first = await launchApp(env);
    apps.push(first.app);
    const seen: string[] = [];
    await welcomeAndReports(first.window, seen);
    await button(first.window, "setup.anytype.skip").click();
    await at(first.window, "source-folder", seen);
    await chooseFolder(first.app, first.window, watched);
    await quit(first.app);

    // Back at Source folder, the folder still chosen, the starter installed once.
    const second = await launchApp(env);
    apps.push(second.app);
    await expect(setupStep(second.window)).toHaveAttribute("data-step", "source-folder", {
      timeout: 20_000,
    });
    await expect(second.window.getByTestId("setup-folder")).toHaveText("Recordings", {
      timeout: 20_000,
    });
    await expect.poll(async () => (await flowsOf(second.window)).length).toBe(1);
    await button(second.window, "setup.continue").click();
    await at(second.window, "node-forms", seen);
    await quit(second.app);

    // Back at the same form, and still one starter.
    const third = await launchApp(env);
    apps.push(third.app);
    await expect(setupStep(third.window)).toHaveAttribute("data-step", "node-forms", {
      timeout: 20_000,
    });
    await expect(setupStep(third.window)).toContainText("Step 1 of 1.");
    await expect(title(third.window)).toHaveText("Set up: File in Anytype");
    expect(await flowsOf(third.window)).toHaveLength(1);
    // Back goes to Source folder, then to Connect Anytype.
    await button(third.window, "setup.back").click();
    await expect(setupStep(third.window)).toHaveAttribute("data-step", "source-folder");
    await button(third.window, "setup.back").click();
    await expect(setupStep(third.window)).toHaveAttribute("data-step", "connect-anytype");
    await quit(third.app);
  } finally {
    await cleanUp(apps, scratch);
  }
});

test("the starter's forms, then Ready, then Open Live lands in Live", async () => {
  test.setTimeout(240_000);
  const { scratch, env } = scratchDirectories();
  const anytype = new FakeAnytypeServer(KEY);
  anytype.pairingCode = "1234";
  anytype.spaces = [{ id: "sp-work", name: "Work" }];
  const url = await anytype.start();
  const watched = path.join(scratch, "Inbox");
  fs.mkdirSync(watched);
  const apps: ElectronApplication[] = [];
  try {
    // Not paired: Setup pairs.
    fs.rmSync(anytypeKeyFile(scratch));
    const { app, window } = await launchApp(
      {
        ...env,
        ANYTYPE_API_BASE_URL: url,
        INNYTYPES_TEST_ANYTYPE: JSON.stringify({
          entry: path.join(FAKE, "server.mjs"),
          surface: fakeSurface(scratch),
        }),
      },
      { allowedKeys: [KEY] },
    );
    apps.push(app);
    const sidebar = window.getByTestId("sidebar");
    await expect(sidebar.getByTestId("sidebar-step")).toHaveText(
      ["welcome", "reports", "anytype", "folder", "steps", "ready"].map(
        (entry) => STRINGS[`setup.nav.${entry}` as keyof typeof STRINGS],
      ),
      { timeout: 20_000 },
    );
    const seen: string[] = [];
    await welcomeAndReports(window, seen);
    await expect.poll(() => currentStep(sidebar)).toEqual([STRINGS["setup.nav.anytype"]]);

    // Connect Anytype: Anytype is asked for a code as the step opens; the code connects.
    await expect(window.getByTestId("setup-anytype")).toHaveText(STRINGS["setup.anytype.running"], {
      timeout: 30_000,
    });
    await window.getByTestId("setup-anytype-code-input").fill("1234");
    await button(window, "setup.anytype.connect").click();
    await expect(window.getByTestId("setup-anytype")).toHaveText("Connected. Found 1 space.", {
      timeout: 30_000,
    });
    expect(fs.readFileSync(anytypeKeyFile(scratch), "utf8")).toBe(KEY);
    await button(window, "setup.continue").click();

    // Source folder, then the starter's one form, then Ready.
    await at(window, "source-folder", seen);
    await chooseFolder(app, window, watched);
    await button(window, "setup.continue").click();
    await expect.poll(() => currentStep(sidebar)).toEqual([STRINGS["setup.nav.steps"]]);
    await fillForm(window, seen, "sp-work", url);
    await at(window, "ready", seen);

    // Exactly the walkthrough: no package step, no starter choice.
    expect(seen).toEqual(WALK);
    expect(seen).not.toContain("Choose your packages");
    expect(seen).not.toContain("Start with a simple flow?");
    await expect(setupStep(window)).toContainText(
      "Your flow is on. Drop a file in Inbox to start. Or try it now with a 10-second sample.",
    );
    await expect(setupStep(window).getByTestId("marked-name")).toHaveText("Inbox");
    // Ready's three closing choices, in this order, and no other button.
    expect(
      await setupStep(window).evaluate((step) =>
        [...step.querySelectorAll("button")].map((choice) => choice.getAttribute("data-testid")),
      ),
    ).toEqual(["setup-ready-own", "setup-ready-open-live", "setup-ready-sample"]);
    for (const key of ["setup.ready.own", "setup.ready.openLive", "setup.ready.sample"] as const) {
      await expect(button(window, key)).toHaveText(STRINGS[key]);
    }
    await expect(button(window, "setup.ready.own")).toHaveAttribute(
      "data-variant",
      /kind=secondary/,
    );

    // The starter, installed with no choice from both shipped packages, is on and set up.
    const flows = await flowsOf(window);
    expect(flows).toHaveLength(1);
    const starter = flows[0] as Flow;
    expect(starter).toMatchObject({
      name: "Folder to Anytype",
      on: true,
      health: { kind: "ready" },
    });
    expect(starter.sources.map((source) => source.type)).toEqual(["inny-folder-watch"]);
    expect(starter.steps.map((step) => step.type)).toEqual(["inny-anytype-create-object"]);

    // Try with a sample: the sample lands in the folder, and a real run reaches Done.
    await button(window, "setup.ready.sample").click();
    await expect(button(window, "setup.ready.sample")).toHaveAttribute(
      "data-variant",
      /state=default/,
      { timeout: 45_000 },
    );
    await expect(window.getByTestId("setup-message")).toHaveCount(0);
    expect(fs.readdirSync(watched)).toEqual(["sample-10s.wav"]);
    await expect
      .poll(
        async () => {
          const page = (await call(window, "runs", { flowId: starter.id })).value as
            { runs: { state: string }[] } | undefined;
          return page?.runs.map((run) => run.state) ?? [];
        },
        { timeout: 60_000 },
      )
      .toEqual(["done"]);
    const created = anytype.to("POST", "/v1/spaces/sp-work/objects");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      authorization: `Bearer ${KEY}`,
      body: { name: "sample-10s.wav" },
    });
    // Setup is still on Ready: the sample is not a closing choice.
    await expect(setupStep(window)).toHaveAttribute("data-step", "ready");

    // Open Live: Setup completed, the starter's board.
    await button(window, "setup.ready.openLive").click();
    await expect(window.getByTestId("frame")).toHaveAttribute("data-route", "live");
    await expect
      .poll(() => window.evaluate(() => globalThis.location.hash))
      .toBe(`#/live/${starter.id}`);
    await expect(window.getByTestId("page-live")).toBeVisible();
    await quit(app);
  } finally {
    await anytype.close();
    await cleanUp(apps, scratch);
  }
});

test("I'll build my own lands in Flows", async () => {
  test.setTimeout(180_000);
  const { scratch, env } = scratchDirectories();
  const watched = path.join(scratch, "Notes");
  fs.mkdirSync(watched);
  const apps: ElectronApplication[] = [];
  try {
    const { app, window } = await launchApp(env);
    apps.push(app);
    expect(await walkToReady(app, window, watched)).toEqual(WALK);
    await button(window, "setup.ready.own").click();
    await expect(window.getByTestId("frame")).toHaveAttribute("data-route", "flows");
    await expect
      .poll(() => window.evaluate(() => globalThis.location.hash))
      .toBe("#/configuration/flows");
    // The starter is kept.
    await expect(window.getByTestId("flows-list")).toContainText("Folder to Anytype", {
      timeout: 15_000,
    });
    expect(await flowsOf(window)).toHaveLength(1);
    await quit(app);
  } finally {
    await cleanUp(apps, scratch);
  }
});

test("never shown again", async () => {
  test.setTimeout(180_000);
  const { scratch, userData, env } = scratchDirectories();
  const watched = path.join(scratch, "Drop");
  fs.mkdirSync(watched);
  const apps: ElectronApplication[] = [];
  try {
    const first = await launchApp(env);
    apps.push(first.app);
    await walkToReady(first.app, first.window, watched);
    await button(first.window, "setup.ready.openLive").click();
    await expect(first.window.getByTestId("frame")).toHaveAttribute("data-route", "live");
    // A move after completion changes nothing.
    expect(await call(first.window, "setSetupStep", { kind: "back" })).toMatchObject({
      ok: true,
      value: { step: "ready", completed: true },
    });
    await quit(first.app);
    for (const launch of [2, 3]) {
      const next = await launchApp(env);
      apps.push(next.app);
      await expect(next.window.getByTestId("frame"), `launch ${String(launch)}`).toHaveAttribute(
        "data-route",
        "live",
        { timeout: 20_000 },
      );
      await expect(next.window.getByTestId("window-setup")).toHaveCount(0);
      await quit(next.app);
    }
    const stored = JSON.parse(
      fs.readFileSync(path.join(userData, "shell-settings.json"), "utf8"),
    ) as { setup?: { completed?: boolean } };
    expect(stored.setup?.completed).toBe(true);
  } finally {
    await cleanUp(apps, scratch);
  }
});

test("a 0.2.1 user never sees setup", async () => {
  test.setTimeout(120_000);
  // Two 0.2.1 installations: one with a saved flow, one that answered the reports question.
  const withFlows = scratchDirectories();
  fs.mkdirSync(path.join(withFlows.userData, "node-red"), { recursive: true });
  fs.writeFileSync(
    path.join(withFlows.userData, "node-red", "flows.json"),
    JSON.stringify([{ id: "a1b2c3d4e5f60718", type: "tab", label: "Recordings to Anytype" }]),
  );
  const answered = scratchDirectories();
  fs.mkdirSync(answered.userData, { recursive: true });
  fs.writeFileSync(
    path.join(answered.userData, "shell-settings.json"),
    JSON.stringify({ telemetry: false }),
  );
  const apps: ElectronApplication[] = [];
  try {
    for (const installation of [withFlows, answered]) {
      const { app, window } = await launchApp(installation.env);
      apps.push(app);
      await expect(window.getByTestId("frame")).toHaveAttribute("data-route", "live", {
        timeout: 20_000,
      });
      await expect(window.getByTestId("window-setup")).toHaveCount(0);
      const stored = JSON.parse(
        fs.readFileSync(path.join(installation.userData, "shell-settings.json"), "utf8"),
      ) as { setup?: { completed?: boolean; starterFlowId?: unknown } };
      expect(stored.setup).toMatchObject({ completed: true, starterFlowId: null });
      // No starter is installed for them.
      await expect
        .poll(async () => (await call(window, "flows")).ok, { timeout: 20_000 })
        .toBe(true);
      expect((await flowsOf(window)).map((flow) => flow.name)).not.toContain("Folder to Anytype");
      await quit(app);
    }
  } finally {
    await cleanUp(apps, withFlows.scratch);
    await cleanUp([], answered.scratch);
  }
});
