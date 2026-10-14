// Run history in the real app (plan 0022 §E, risk 3; ux-writing "Configuration › Flows › Run
// history"), driven through the real shell/main.ts bundle and the embedded Node-RED: a run found
// again with the filters and the search, re-run from its source or from a step, re-run and
// deleted in bulk from the Selected bar, deleted from its ⋯ menu, and a re-run from a step no
// longer in the flow refused.
//
// The flow is the livekit fixture (test/fixtures/livekit): a recorder source, Copy, then two of
// its work steps, Transcribe and File, each with a result line. Every gate file a step waits for
// is written before its recording, so each run goes straight through to Done.
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { STRINGS } from "../../src/ui/strings";
import { cleanUp, launchApp, quit, scratchDirectories, waitForRunning } from "./app-harness";

const FLOW = "historyflow";
const FLOW_NAME = "Recordings to Anytype";

interface RunValue {
  runId: string;
  title: string;
  state: string;
  rerunOf: string | null;
  rerunFrom: string | null;
  steps: { name: string }[];
  results: { step: string; text: string }[];
}
interface Inny {
  inny: {
    app: {
      completeSetup(): Promise<{ ok: boolean }>;
      runs(query: object): Promise<{ ok: boolean; value?: { runs: RunValue[] } }>;
      run(runId: string): Promise<{ ok: boolean; value?: RunValue; refused?: unknown }>;
      flows(): Promise<{ ok: boolean; value?: { id: string; steps: { id: string }[] }[] }>;
      inbox(): Promise<{ id: string; title: string }[]>;
      submitView(id: string, values: object): Promise<{ ok: boolean }>;
      rerun(
        flowId: string,
        runId: string,
        from?: string,
      ): Promise<{ ok: boolean; value?: unknown; refused?: unknown }>;
    };
  };
}

/**
 * The flow: Recorder → Copy → Transcribe → File; `tail` "none" leaves File out, "question" adds
 * a question after File (the viewts fixture's action view), where each run waits.
 */
function historyFlow(folder: string, tail: "file" | "none" | "question" = "file"): object[] {
  const at = (n: number) => ({ x: 120, y: 40 * n });
  const step = (id: string, type: string, name: string, n: number, next: string[]) => ({
    id,
    type,
    z: FLOW,
    name,
    folder,
    ...at(n),
    wires: [next],
  });
  return [
    { id: FLOW, type: "tab", label: FLOW_NAME },
    step("rec", "inny-livekit-recorder", "Recorder", 1, ["copy"]),
    step("copy", "inny-livekit-copy", "Copy", 2, ["work"]),
    step("work", "inny-livekit-work", "Transcribe", 3, tail === "none" ? [] : ["file"]),
    ...(tail === "none"
      ? []
      : [step("file", "inny-livekit-work", "File", 4, tail === "question" ? ["ask"] : [])]),
    ...(tail === "question"
      ? [
          {
            id: "ask",
            type: "inny-viewts-ask",
            z: FLOW,
            name: "Approve sending",
            ...at(5),
            wires: [[], []],
          },
        ]
      : []),
  ];
}

function deploy(port: number, nodes: object[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(nodes);
    const sent = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/red/flows",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(text) },
      },
      (response) => {
        response.resume();
        response.on("end", () => {
          resolve(response.statusCode ?? 0);
        });
      },
    );
    sent.on("error", reject);
    sent.end(text);
  });
}

/** A recording that goes straight through: every gate its steps wait for, then its file. */
function record(folder: string, title: string, anytypeObject?: string): void {
  for (const gate of [".copied", ".next", ".worked"]) {
    fs.writeFileSync(path.join(folder, `${title}${gate}`), "");
  }
  if (anytypeObject !== undefined) {
    fs.writeFileSync(path.join(folder, `${title}.anytype`), anytypeObject);
  }
  fs.writeFileSync(path.join(folder, `${title}.wav`), "");
}

/** Launch, close Setup, deploy the flow watching `folder`, and open its Run history. */
async function launchOnHistory(
  apps: ElectronApplication[],
  env: Record<string, string>,
  folder: string,
) {
  fs.mkdirSync(folder, { recursive: true });
  const running = await launchApp(env);
  apps.push(running.app);
  const { window, output } = running;
  const port = Number((await waitForRunning(window, "runtime")).port);
  expect(
    (await window.evaluate(() => (window as unknown as Inny).inny.app.completeSetup())).ok,
  ).toBe(true);
  expect(await deploy(port, historyFlow(folder))).toBe(204);
  await expect
    .poll(() => output.join(""), { timeout: 30_000 })
    .toMatch(/\[inny-livekit-recorder rec\] ready/);
  await go(window, `#/configuration/flows/${FLOW}/history`);
  await expect(history(window)).toHaveAttribute("data-flow", FLOW, { timeout: 30_000 });
  return { ...running, port };
}

const go = (window: Page, hash: string) =>
  window.evaluate((to) => {
    globalThis.location.hash = to;
  }, hash);

const history = (window: Page) => window.getByTestId("history-screen");
const rows = (window: Page) => history(window).locator("tbody tr");
const rowsOf = (window: Page, title: string) => rows(window).filter({ hasText: title });

/** The flow's runs, newest first, as the page's own call answers them. */
async function runsOf(window: Page): Promise<RunValue[]> {
  const answer = await window.evaluate(
    (flowId) => (window as unknown as Inny).inny.app.runs({ flowId, limit: 200 }),
    FLOW,
  );
  expect(answer.ok).toBe(true);
  return answer.value?.runs ?? [];
}

/** Wait until the flow has `count` runs, every one of them Done. */
async function allDone(window: Page, count: number): Promise<RunValue[]> {
  await expect
    .poll(async () => (await runsOf(window)).map((run) => run.state), { timeout: 30_000 })
    .toEqual(Array.from({ length: count }, () => "done"));
  return runsOf(window);
}

/** The flow's steps' ids as `flow.list` answers them now: a redeploy has landed when they move. */
const stepIds = (window: Page) => async () => {
  const answer = await window.evaluate(() => (window as unknown as Inny).inny.app.flows());
  return answer.value?.find((flow) => flow.id === FLOW)?.steps.map((step) => step.id);
};

/** A row's ⋯ menu, then one of its items. */
async function rowMenu(window: Page, row: Locator, title: string, item: string): Promise<void> {
  await row.getByRole("button", { name: `${STRINGS["a11y.more"]}: ${title}` }).click();
  await window.getByRole("menuitem", { name: item, exact: true }).click();
}

const checkbox = (row: Locator, title: string) =>
  row.locator('[data-component="checkbox"]').filter({ hasText: `Select ${title}` });

test("re-run makes a new card", async () => {
  test.setTimeout(240_000);
  const { scratch, env } = scratchDirectories();
  const folder = path.join(scratch, "recorder");
  const apps: ElectronApplication[] = [];
  try {
    const { app, window } = await launchOnHistory(apps, env, folder);
    await expect(history(window)).toContainText(STRINGS["history.empty"]);
    await expect(history(window)).toContainText(
      "Runs are kept for 90 days. Change this in Configuration › General.",
    );
    record(folder, "rec1");
    const [first] = await allDone(window, 1);
    await expect(rows(window)).toHaveCount(1, { timeout: 10_000 });
    await expect(rows(window).first()).toContainText(STRINGS["history.state.done"]);

    // Re-run from the row's ⋯ menu: a new run, re-run of the first, from its source.
    await rowMenu(window, rowsOf(window, "rec1"), "rec1", STRINGS["history.rerun"]);
    const twice = await allDone(window, 2);
    const again = twice[0] as RunValue;
    expect(again).toMatchObject({ title: "rec1", rerunOf: first?.runId, rerunFrom: null });
    expect(again.steps.map((step) => step.name)).toEqual(["Copy", "Transcribe", "File"]);
    // Newest first: the re-run, captioned with when the run it re-runs started.
    await expect(rows(window)).toHaveCount(2);
    await expect(rows(window).first()).toContainText(/Re-run today \d\d:\d\d/);
    await expect(rows(window).nth(1)).not.toContainText("Re-run today");

    // A new card on the board: one per run, the re-run's beside the first's.
    await go(window, `#/live/${FLOW}`);
    const cards = window.getByTestId("live-board").getByTestId("run-card");
    await expect(cards).toHaveCount(2, { timeout: 30_000 });
    expect(
      await cards.evaluateAll((all) => all.map((card) => card.getAttribute("data-run"))),
    ).toEqual([again.runId, first?.runId]);

    // Found again: the search and the state filter narrow the rows; the Selected bar re-runs.
    await go(window, `#/configuration/flows/${FLOW}/history`);
    record(folder, "rec2");
    await allDone(window, 3);
    await expect(rows(window)).toHaveCount(3);
    await history(window).getByPlaceholder(STRINGS["history.search"]).fill("rec2");
    await expect(rows(window)).toHaveCount(1);
    await expect(rows(window).first()).toContainText("rec2");
    await history(window).getByPlaceholder(STRINGS["history.search"]).fill("");
    await expect(rows(window)).toHaveCount(3);
    const segments = history(window).locator('[data-component="segmented-control"]');
    await segments.getByText(STRINGS["history.filter.failed"], { exact: true }).click();
    await expect(history(window)).toContainText("No failed runs in the last 7 days.");
    await segments.getByText(STRINGS["history.filter.all"], { exact: true }).click();
    await expect(rows(window)).toHaveCount(3);

    await checkbox(rowsOf(window, "rec2"), "rec2").click();
    await checkbox(rowsOf(window, "rec1").first(), "rec1").click();
    await expect(history(window)).toContainText("2 runs selected");
    await history(window)
      .getByRole("button", { name: STRINGS["history.rerun"], exact: true })
      .click();
    const five = await allDone(window, 5);
    expect(five.filter((run) => run.rerunOf !== null)).toHaveLength(3);
    await expect(history(window)).not.toContainText("runs selected");

    await quit(app);
  } finally {
    await cleanUp(apps, scratch);
  }
});

test("re-run from a step keeps earlier results", async () => {
  test.setTimeout(240_000);
  const { scratch, env } = scratchDirectories();
  const folder = path.join(scratch, "recorder");
  const apps: ElectronApplication[] = [];
  try {
    const { app, window } = await launchOnHistory(apps, env, folder);
    record(folder, "rec1");
    const [first] = await allDone(window, 1);
    expect(first?.results.map((result) => result.step)).toEqual(["Transcribe", "File"]);

    // Re-run from… › the flow's steps in order; File is chosen.
    const row = rowsOf(window, "rec1");
    await row.getByRole("button", { name: `${STRINGS["a11y.more"]}: rec1` }).click();
    await window.getByRole("menuitem", { name: STRINGS["history.rerunFrom"] }).click();
    const steps = window.getByRole("menuitem").filter({ hasNotText: /Re-run|Open|Delete/ });
    await expect(steps).toHaveText(["Copy", "Transcribe", "File"]);
    await window.getByRole("menuitem", { name: "File", exact: true }).click();

    const [again] = await allDone(window, 2);
    // Only File ran again; Transcribe's result was kept, then File's own came.
    expect(again).toMatchObject({ rerunOf: first?.runId, rerunFrom: "file" });
    expect(again?.steps.map((step) => step.name)).toEqual(["File"]);
    expect(again?.results).toEqual([
      expect.objectContaining({ step: "Transcribe", text: "Moved rec1 to *Archive*" }),
      expect.objectContaining({ step: "File", text: "Moved rec1 to *Archive*" }),
    ]);
    await expect(rows(window)).toHaveCount(2, { timeout: 10_000 });
    await expect(rows(window).first()).toContainText(/Re-run today \d\d:\d\d/);

    // A plain Re-run of that re-run starts from the source again: every step, nothing kept.
    await rowMenu(window, rows(window).first(), "rec1", STRINGS["history.rerun"]);
    const [third] = await allDone(window, 3);
    expect(third).toMatchObject({ rerunOf: again?.runId, rerunFrom: null });
    expect(third?.steps.map((step) => step.name)).toEqual(["Copy", "Transcribe", "File"]);
    expect(third?.results.map((result) => result.step)).toEqual(["Transcribe", "File"]);

    await quit(app);
  } finally {
    await cleanUp(apps, scratch);
  }
});

test("delete keeps Anytype objects", async () => {
  test.setTimeout(240_000);
  const { scratch, env } = scratchDirectories();
  const folder = path.join(scratch, "recorder");
  const apps: ElectronApplication[] = [];
  // A fake Anytype holding the object the run made: every request it hears is kept.
  const heard: string[] = [];
  const objects = new Set(["object-rec1"]);
  const anytype = http.createServer((request, response) => {
    heard.push(`${String(request.method)} ${String(request.url)}`);
    if (request.method === "DELETE") {
      objects.delete(String(request.url).split("/").pop() ?? "");
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => anytype.listen(0, "127.0.0.1", resolve));
  const anytypeUrl = `http://127.0.0.1:${String((anytype.address() as AddressInfo).port)}`;
  try {
    const { app, window, port, output } = await launchOnHistory(
      apps,
      { ...env, ANYTYPE_API_BASE_URL: anytypeUrl },
      folder,
    );
    record(folder, "rec1", "object-rec1");
    record(folder, "rec2");
    record(folder, "rec3");
    const runs = await allDone(window, 3);
    const made = runs.find((run) => run.title === "rec1");
    expect(made?.results).toEqual([
      expect.objectContaining({ text: "Meeting notes → *Renaissance*" }),
      expect.objectContaining({ text: "Meeting notes → *Renaissance*" }),
    ]);
    await expect(rows(window)).toHaveCount(3, { timeout: 10_000 });

    // Open in Anytype, offered for the run with an Anytype result only: Anytype opens the object.
    await app.evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as unknown as { opened: string[] }).opened = opened;
      shell.openExternal = (url: string) => {
        opened.push(url);
        return Promise.resolve();
      };
    });
    await rowMenu(window, rowsOf(window, "rec1"), "rec1", STRINGS["history.openInAnytype"]);
    await expect
      .poll(() => app.evaluate(() => (globalThis as unknown as { opened: string[] }).opened))
      .toEqual(["anytype://object?objectId=object-rec1&spaceId=space-1"]);
    await expect(history(window)).toHaveAttribute("data-flow", FLOW);
    await rowsOf(window, "rec2")
      .getByRole("button", { name: `${STRINGS["a11y.more"]}: rec2` })
      .click();
    await expect(
      window.getByRole("menuitem", { name: STRINGS["history.openInAnytype"] }),
    ).toHaveCount(0);
    await window.keyboard.press("Escape");

    // One run, from its ⋯ menu: the Destructive dialog says Anytype keeps its results.
    await rowMenu(window, rowsOf(window, "rec1"), "rec1", STRINGS["history.deleteRun"]);
    const dialog = window.getByRole("alertdialog");
    await expect(dialog).toContainText("Delete this run?");
    await expect(dialog).toContainText(
      "Its results in Anytype are kept; only InnyTypes' record of it goes.",
    );
    await dialog.getByRole("button", { name: STRINGS["history.delete"], exact: true }).click();
    await expect(rowsOf(window, "rec1")).toHaveCount(0, { timeout: 10_000 });
    const gone = await window.evaluate(
      (runId) => (window as unknown as Inny).inny.app.run(runId),
      made?.runId ?? "",
    );
    expect(gone).toEqual({
      ok: false,
      refused: { reason: "gone", sentence: "history.runGone" },
    });

    // The rest from the Selected bar, after Cancel kept them once.
    await checkbox(rows(window).first(), "rec3").click();
    await checkbox(rows(window).nth(1), "rec2").click();
    await expect(history(window)).toContainText("2 runs selected");
    const bar = history(window);
    await bar.getByRole("button", { name: STRINGS["history.delete"], exact: true }).click();
    await expect(dialog).toContainText("Delete 2 runs?");
    await dialog.getByRole("button", { name: STRINGS["dialog.cancel"] }).click();
    await expect(dialog).toBeHidden();
    await expect(rows(window)).toHaveCount(2);
    await bar.getByRole("button", { name: STRINGS["history.delete"], exact: true }).click();
    await dialog.getByRole("button", { name: STRINGS["history.delete"], exact: true }).click();
    await expect(history(window)).toContainText(STRINGS["history.empty"], { timeout: 10_000 });
    expect(await runsOf(window)).toEqual([]);

    // Anytype was never asked to remove anything, nor about the object: it is there, untouched.
    expect(
      heard.filter((line) => line.startsWith("DELETE ") || line.includes("object-rec1")),
    ).toEqual([]);
    expect([...objects]).toEqual(["object-rec1"]);

    // A run waiting on a question: deleted, its question goes, and the run never comes back.
    expect(await deploy(port, historyFlow(folder, "question"))).toBe(204);
    const inbox = () => window.evaluate(() => (window as unknown as Inny).inny.app.inbox());
    await expect
      .poll(stepIds(window), { timeout: 30_000 })
      .toEqual(["copy", "work", "file", "ask"]);
    // The recorder starts again with the redeploy: only a recording after that is a new run.
    const readies = () => output.join("").split("[inny-livekit-recorder rec] ready").length - 1;
    await expect.poll(readies, { timeout: 30_000 }).toBe(2);
    record(folder, "rec4");
    await expect.poll(inbox, { timeout: 30_000 }).toHaveLength(1);
    const [question] = await inbox();
    await expect.poll(async () => (await runsOf(window))[0]?.state).toBe("waiting");
    await rowMenu(window, rowsOf(window, "rec4"), "rec4", STRINGS["history.deleteRun"]);
    await dialog.getByRole("button", { name: STRINGS["history.delete"], exact: true }).click();
    await expect.poll(inbox, { timeout: 10_000 }).toEqual([]);
    const answered = await window.evaluate(
      (id) => (window as unknown as Inny).inny.app.submitView(id, {}),
      question?.id ?? "",
    );
    expect(answered.ok).toBe(false);
    await expect(history(window)).toContainText(STRINGS["history.empty"]);
    expect(await runsOf(window)).toEqual([]);

    await quit(app);
  } finally {
    await cleanUp(apps, scratch);
    await new Promise((resolve) => anytype.close(resolve));
  }
});

test("a step no longer in the flow is refused", async () => {
  test.setTimeout(240_000);
  const { scratch, env } = scratchDirectories();
  const folder = path.join(scratch, "recorder");
  const apps: ElectronApplication[] = [];
  try {
    const { app, window, port } = await launchOnHistory(apps, env, folder);
    record(folder, "rec1");
    const [first] = await allDone(window, 1);

    // File leaves the flow; the run that went through it is still in Run history.
    expect(await deploy(port, historyFlow(folder, "none"))).toBe(204);
    await expect.poll(stepIds(window), { timeout: 30_000 }).toEqual(["copy", "work"]);
    await expect(rows(window)).toHaveCount(1, { timeout: 10_000 });

    // Re-run from… offers the flow's steps as they are now: File is gone from it.
    await rowsOf(window, "rec1")
      .getByRole("button", { name: `${STRINGS["a11y.more"]}: rec1` })
      .click();
    await window.getByRole("menuitem", { name: STRINGS["history.rerunFrom"] }).click();
    await expect(window.getByRole("menuitem", { name: "Transcribe", exact: true })).toBeVisible();
    await expect(window.getByRole("menuitem", { name: "File", exact: true })).toHaveCount(0);
    await window.keyboard.press("Escape");
    await window.keyboard.press("Escape");

    // Asked anyway (a menu read before the redeploy): refused with the sentence, nothing started.
    const answer = await window.evaluate(
      ({ flowId, runId }) => (window as unknown as Inny).inny.app.rerun(flowId, runId, "file"),
      { flowId: FLOW, runId: first?.runId ?? "" },
    );
    expect(answer).toEqual({
      ok: false,
      refused: { reason: "no-step", sentence: "flows.refused.noStep" },
    });
    expect(STRINGS["flows.refused.noStep"]).toBe("This step is no longer in the flow.");
    expect(await runsOf(window)).toHaveLength(1);

    // A step still in the flow re-runs as before.
    await rowMenu(window, rowsOf(window, "rec1"), "rec1", STRINGS["history.rerun"]);
    await allDone(window, 2);

    await quit(app);
  } finally {
    await cleanUp(apps, scratch);
  }
});
