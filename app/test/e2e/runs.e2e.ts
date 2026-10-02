// The runs read model in the real app (plan 0022 §C, WI-0022-06): a created event fired through
// its source starts a run in the source's flow, `run.list` grows by it, and the `runs` signal
// reaches the page through the shell as `onRuns`, from the runtime's composition root.
//
// The source is a created event type's (user-events), deployed on its own tab: the tab's id is
// the flow's. With nothing journaled downstream, the run settles to done once nothing is left
// to do for it.
import * as http from "node:http";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { cleanUp, launchApp, quit, scratchDirectories, waitForRunning } from "./app-harness";

const SOURCE = "inny-user-events-ping-v1";
const FLOW = "runs-tab";

/** What the page's AppApi offers, as far as this spec calls it. */
interface Inny {
  inny: {
    app: {
      createEventType(name: string, label: string, schema: object): Promise<unknown>;
      fireEvent(type: string, values: object): Promise<{ ok: boolean }>;
      runList(query: object): Promise<{ ok: boolean; value?: unknown; error?: string }>;
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
      (window as unknown as Inny).inny.app.runList({
        flowId,
        limit,
        ...(cursor === undefined ? {} : { cursor }),
      }),
    { flowId: FLOW, limit, cursor },
  );
  expect(answer.ok, answer.error).toBe(true);
  return answer.value as {
    runs: { runId: string; flowId: string; title: string; state: string }[];
    next: string | null;
  };
}

const fire = (window: Page, note: string) =>
  window.evaluate(
    (values) => (window as unknown as Inny).inny.app.fireEvent("user.ping.v1", values),
    { note },
  );

test("a fired event starts a run in its source's flow: run.list grows and onRuns fires", async () => {
  test.setTimeout(180_000);
  const { scratch, env } = scratchDirectories();
  const apps: ElectronApplication[] = [];
  try {
    const { app, window, output } = await launchApp(env);
    apps.push(app);
    const said = () => output.join("");
    const first = await waitForRunning(window, "runtime");

    // A created event type; only the runtime restarts for it.
    const created = await window.evaluate(() =>
      (window as unknown as Inny).inny.app.createEventType("ping", "Ping", {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { note: { type: "string" } },
        additionalProperties: true,
      }),
    );
    expect(created).toMatchObject({ ok: true });
    const running = await waitForRunning(window, "runtime", first.generation + 1);
    await expect
      .poll(said, { timeout: 20_000 })
      .toMatch(new RegExp(`generated \\d+ node types: [^\\n]*${SOURCE}`));

    // Its source alone on a tab: the tab is the flow.
    const flow = [
      { id: FLOW, type: "tab", label: "Runs" },
      { id: "ping-src", type: SOURCE, z: FLOW, name: "Ping", x: 100, y: 40, wires: [[]] },
    ];
    expect(await deploy(Number(running.port), flow)).toBe(204);
    await expect
      .poll(said, { timeout: 20_000 })
      .toMatch(new RegExp(`\\[${SOURCE} ping-src\\] ready`));

    // The page listens for the runs signal, as Live will.
    await window.evaluate(() => {
      const page = window as unknown as Inny;
      page.heardRuns = [];
      page.inny.app.onRuns((changed) => page.heardRuns?.push(changed));
    });
    const heard = () => window.evaluate(() => (window as unknown as Inny).heardRuns ?? []);
    expect((await runsOf(window)).runs).toEqual([]);

    // Fired: one run, in the source's flow, named by its event's type; then done.
    expect(await fire(window, "first")).toMatchObject({ ok: true });
    await expect.poll(async () => (await runsOf(window)).runs.length, { timeout: 15_000 }).toBe(1);
    await expect.poll(heard, { timeout: 10_000 }).toContainEqual({ flowId: FLOW });
    const [run] = (await runsOf(window)).runs;
    expect(run).toMatchObject({ flowId: FLOW, title: "user.ping.v1" });
    await expect
      .poll(async () => (await runsOf(window)).runs[0]?.state, { timeout: 15_000 })
      .toBe("done");

    // Fired again: the list grows, newest first, a page at a time.
    expect(await fire(window, "second")).toMatchObject({ ok: true });
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
