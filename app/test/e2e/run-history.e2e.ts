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
  /** A waiting run's card names the view it waits on (plan 0022 §C). */
  card?: { waiting: { viewId: string } | null };
}
interface Inny {
  inny: {
    app: {
      completeSetup(): Promise<{ ok: boolean }>;
      runs(query: object): Promise<{ ok: boolean; value?: { runs: RunValue[] } }>;
      run(runId: string): Promise<{ ok: boolean; value?: RunValue; refused?: unknown }>;
      flows(): Promise<{ ok: boolean; value?: { id: string; steps: { id: string }[] }[] }>;
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
const rows = (window: Page) => history(window).getByTestId("history-row");
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

/** A row's ⋯ button, named for its run. */
async function openRowMenu(row: Locator, title: string): Promise<void> {
  const more = row.getByTestId("history-row-more");
  await expect(more).toHaveAttribute("aria-label", `${STRINGS["a11y.more"]}: ${title}`);
  await more.click();
}

/** A row's ⋯ menu, then one of its items (`history-menu-<item>`), saying `words`. */
async function rowMenu(row: Locator, title: string, item: string, words: string): Promise<void> {
  await openRowMenu(row, title);
  const chosen = row.getByTestId(`history-menu-${item}`);
  await expect(chosen).toHaveText(words);
  await chosen.click();
}

/** A row's checkbox, named for its run. */
async function select(row: Locator, title: string): Promise<void> {
  const checkbox = row.getByTestId("history-row-select");
  await expect(checkbox).toContainText(`Select ${title}`);
  await checkbox.click();
}

/** Re-run from… › on a row: its submenu of the flow's steps. */
async function rerunFrom(row: Locator, title: string): Promise<Locator> {
  await openRowMenu(row, title);
  await expect(row.getByTestId("history-menu-rerun-from")).toHaveText(STRINGS["history.rerunFrom"]);
  await row.getByTestId("history-menu-rerun-from").click();
  return row.getByTestId("history-menu-step");
}

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
    await rowMenu(rowsOf(window, "rec1"), "rec1", "rerun", STRINGS["history.rerun"]);
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
    const search = history(window).getByTestId("history-search-input");
    await expect(search).toHaveAttribute("placeholder", STRINGS["history.search"]);
    await search.fill("rec2");
    await expect(rows(window)).toHaveCount(1);
    await expect(rows(window).first()).toContainText("rec2");
    await search.fill("");
    await expect(rows(window)).toHaveCount(3);
    const segments = history(window).getByTestId("history-filter");
    await expect(segments.getByTestId("history-filter-failed")).toHaveText(
      STRINGS["history.filter.failed"],
    );
    await segments.getByTestId("history-filter-failed").click();
    await expect(history(window)).toContainText("No failed runs in the last 7 days.");
    await expect(segments.getByTestId("history-filter-all")).toHaveText(
      STRINGS["history.filter.all"],
    );
    await segments.getByTestId("history-filter-all").click();
    await expect(rows(window)).toHaveCount(3);

    await select(rowsOf(window, "rec2"), "rec2");
    await select(rowsOf(window, "rec1").first(), "rec1");
    await expect(history(window)).toContainText("2 runs selected");
    const rerun = history(window).getByTestId("history-selection-rerun");
    await expect(rerun).toHaveText(STRINGS["history.rerun"]);
    await rerun.click();
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
    const steps = await rerunFrom(rowsOf(window, "rec1"), "rec1");
    await expect(steps).toHaveText(["Copy", "Transcribe", "File"]);
    await steps.filter({ hasText: /^File$/ }).click();

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
    await rowMenu(rows(window).first(), "rec1", "rerun", STRINGS["history.rerun"]);
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
    await rowMenu(rowsOf(window, "rec1"), "rec1", "anytype", STRINGS["history.openInAnytype"]);
    await expect
      .poll(() => app.evaluate(() => (globalThis as unknown as { opened: string[] }).opened))
      .toEqual(["anytype://object?objectId=object-rec1&spaceId=space-1"]);
    await expect(history(window)).toHaveAttribute("data-flow", FLOW);
    await openRowMenu(rowsOf(window, "rec2"), "rec2");
    await expect(rowsOf(window, "rec2").getByTestId("history-menu-delete")).toBeVisible();
    await expect(rowsOf(window, "rec2").getByTestId("history-menu-anytype")).toHaveCount(0);
    await window.keyboard.press("Escape");

    // One run, from its ⋯ menu: the Destructive dialog says Anytype keeps its results.
    await rowMenu(rowsOf(window, "rec1"), "rec1", "delete", STRINGS["history.deleteRun"]);
    const dialog = window.getByTestId("history-delete-dialog");
    await expect(dialog).toHaveAttribute("role", "alertdialog");
    await expect(dialog).toContainText("Delete this run?");
    await expect(dialog).toContainText(
      "Its results in Anytype are kept; only InnyTypes' record of it goes.",
    );
    await expect(dialog.getByTestId("history-delete-primary")).toHaveText(
      STRINGS["history.delete"],
    );
    await dialog.getByTestId("history-delete-primary").click();
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
    await select(rows(window).first(), "rec3");
    await select(rows(window).nth(1), "rec2");
    await expect(history(window)).toContainText("2 runs selected");
    const bar = history(window).getByTestId("history-selection");
    await expect(bar.getByTestId("history-selection-delete")).toHaveText(STRINGS["history.delete"]);
    await bar.getByTestId("history-selection-delete").click();
    await expect(dialog).toContainText("Delete 2 runs?");
    await expect(dialog.getByTestId("history-delete-cancel")).toHaveText(STRINGS["dialog.cancel"]);
    await dialog.getByTestId("history-delete-cancel").click();
    await expect(dialog).toBeHidden();
    await expect(rows(window)).toHaveCount(2);
    await bar.getByTestId("history-selection-delete").click();
    await dialog.getByTestId("history-delete-primary").click();
    await expect(history(window)).toContainText(STRINGS["history.empty"], { timeout: 10_000 });
    expect(await runsOf(window)).toEqual([]);

    // Anytype was never asked to remove anything, nor about the object: it is there, untouched.
    expect(
      heard.filter((line) => line.startsWith("DELETE ") || line.includes("object-rec1")),
    ).toEqual([]);
    expect([...objects]).toEqual(["object-rec1"]);

    // A run waiting on a question: deleted, its question goes, and the run never comes back.
    expect(await deploy(port, historyFlow(folder, "question"))).toBe(204);
    await expect
      .poll(stepIds(window), { timeout: 30_000 })
      .toEqual(["copy", "work", "file", "ask"]);
    // The recorder starts again with the redeploy: only a recording after that is a new run.
    const readies = () => output.join("").split("[inny-livekit-recorder rec] ready").length - 1;
    await expect.poll(readies, { timeout: 30_000 }).toBe(2);
    record(folder, "rec4");
    await expect
      .poll(async () => (await runsOf(window))[0]?.state, { timeout: 30_000 })
      .toBe("waiting");
    const question = (await runsOf(window))[0]?.card?.waiting?.viewId ?? "";
    expect(question).not.toBe("");
    await rowMenu(rowsOf(window, "rec4"), "rec4", "delete", STRINGS["history.deleteRun"]);
    await dialog.getByTestId("history-delete-primary").click();
    await expect.poll(async () => runsOf(window), { timeout: 10_000 }).toEqual([]);
    const answered = await window.evaluate(
      (id) => (window as unknown as Inny).inny.app.submitView(id, {}),
      question,
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
    const steps = await rerunFrom(rowsOf(window, "rec1"), "rec1");
    await expect(steps.filter({ hasText: /^Transcribe$/ })).toBeVisible();
    await expect(steps).toHaveText(["Copy", "Transcribe"]);
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
    await rowMenu(rowsOf(window, "rec1"), "rec1", "rerun", STRINGS["history.rerun"]);
    await allDone(window, 2);

    await quit(app);
  } finally {
    await cleanUp(apps, scratch);
  }
});
