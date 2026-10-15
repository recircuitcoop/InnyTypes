// The runs read model in the real app (plan 0022 §C, WI-0022-06): an event a source emits starts a
// run in the source's flow, `run.list` grows by it, and the `runs` signal reaches the page through
// the shell as `onRuns`, from the runtime's composition root.
//
// The source is the live kit's recorder (test/fixtures/livekit), watching a folder, deployed on
// its own tab: the tab's id is the flow's. With nothing journaled downstream, the run settles to
// done once nothing is left to do for it.
import fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { cleanUp, launchApp, quit, scratchDirectories, waitForRunning } from "./app-harness";

const SOURCE = "inny-livekit-recorder";
const FLOW = "runs-tab";

/** What the page's AppApi offers, as far as this spec calls it. */
interface Inny {
  inny: {
    app: {
      runs(query: object): Promise<{ ok: boolean; value?: unknown; refused?: unknown }>;
      onRuns(listener: (changed: { flowId: string }) => void): void;
    };
  };
  heardRuns?: { flowId: string }[];
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

/** The runs of the flow, newest first, as the page's own call answers them. */
async function runsOf(window: Page, limit = 50, cursor?: string) {
  const answer = await window.evaluate(
    ({ flowId, limit, cursor }) =>
      (window as unknown as Inny).inny.app.runs({
        flowId,
        limit,
        ...(cursor === undefined ? {} : { cursor }),
      }),
    { flowId: FLOW, limit, cursor },
  );
  expect(answer.ok, JSON.stringify(answer.refused)).toBe(true);
  return answer.value as {
    runs: { runId: string; flowId: string; title: string; state: string }[];
    next: string | null;
  };
}

/** A recording lands in the watched folder: the recorder emits one event for it. */
const record = (folder: string, title: string): void => {
  fs.writeFileSync(path.join(folder, `${title}.wav`), "");
};

test("a source's event starts a run in its flow: run.list grows and onRuns fires", async () => {
  test.setTimeout(180_000);
  const { scratch, env } = scratchDirectories();
  const apps: ElectronApplication[] = [];
  try {
    const { app, window, output } = await launchApp(env);
    apps.push(app);
    const said = () => output.join("");
    const running = await waitForRunning(window, "runtime");
    const folder = path.join(scratch, "recordings");
    fs.mkdirSync(folder);

    // The source alone on a tab: the tab is the flow.
    const flow = [
      { id: FLOW, type: "tab", label: "Runs" },
      { id: "rec", type: SOURCE, z: FLOW, name: "Recorder", folder, x: 100, y: 40, wires: [[]] },
    ];
    expect(await deploy(Number(running.port), flow)).toBe(204);
    await expect.poll(said, { timeout: 20_000 }).toMatch(new RegExp(`\\[${SOURCE} rec\\] ready`));

    // The page listens for the runs signal, as Live will.
    await window.evaluate(() => {
      const page = window as unknown as Inny;
      page.heardRuns = [];
      page.inny.app.onRuns((changed) => page.heardRuns?.push(changed));
    });
    const heard = () => window.evaluate(() => (window as unknown as Inny).heardRuns ?? []);
    expect((await runsOf(window)).runs).toEqual([]);

    // A recording: one run, in the source's flow, named by its recording; then done.
    record(folder, "first");
    await expect.poll(async () => (await runsOf(window)).runs.length, { timeout: 15_000 }).toBe(1);
    await expect.poll(heard, { timeout: 10_000 }).toContainEqual({ flowId: FLOW });
    const [run] = (await runsOf(window)).runs;
    expect(run).toMatchObject({ flowId: FLOW, title: "first" });
    await expect
      .poll(async () => (await runsOf(window)).runs[0]?.state, { timeout: 15_000 })
      .toBe("done");

    // Another: the list grows, newest first, a page at a time.
    record(folder, "second");
    await expect.poll(async () => (await runsOf(window)).runs.length, { timeout: 15_000 }).toBe(2);
    const page1 = await runsOf(window, 1);
    expect(page1.runs).toHaveLength(1);
    expect(page1.runs[0]?.runId).not.toBe(run?.runId);
    expect(page1.next).not.toBeNull();
    const page2 = await runsOf(window, 1, page1.next ?? undefined);
    expect(page2.runs.map((r) => r.runId)).toEqual([run?.runId]);
    expect(page2.next).toBeNull();

    await quit(app);
  } finally {
    await cleanUp(apps, scratch);
  }
});
