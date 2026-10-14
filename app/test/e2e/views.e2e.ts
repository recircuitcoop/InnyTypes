// Action and snapshot views in the real app (WI-0018-10), driven through the real shell/main.ts
// bundle, against BOTH reference view nodes: viewpy (Python, the standard library only) and viewts
// (TypeScript, run by Electron as Node). What the runtime presents is read from its own log lines;
// a dismissal goes the way Live's Skip this step sends one (AppApi `submitView`), and a pop-out
// answers for itself.
//
// An action view makes the flow wait; a pop-out view opens its window by itself; it survives a
// `kill -9` of the runtime, pending under the same id and re-presented quietly; a submission
// continues the flow; a dismissal reaches Catch; the timeout output fires at its JOURNALED
// deadline, across the restart. A snapshot is recorded, in the run its source started.
import * as http from "node:http";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import {
  cleanUp,
  launchApp,
  processesNaming,
  quit,
  scratchDirectories,
  waitForRunning,
} from "./app-harness";

type Result =
  | { ok: true; value: Record<string, unknown> | null }
  | { ok: false; error: string; status?: number };

type Api = {
  inny: { app: { submitView(id: string, values: Record<string, unknown>): Promise<Result> } };
};

function request(port: number, method: string, route: string, body?: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    const sent = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: route,
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

/** Answer the pending view `id` from the page, as Live's Skip this step does. */
const submit = (window: Page, id: string, values: Record<string, unknown>): Promise<Result> =>
  window.evaluate(
    ([view, answer]) => (window as unknown as Api).inny.app.submitView(view, answer),
    [id, values] as const,
  );

/** The first group of `pattern` in what the app printed, once it is there. */
async function captured(said: () => string, pattern: RegExp): Promise<string> {
  await expect.poll(() => pattern.exec(said())?.[1], { timeout: 10_000 }).toBeDefined();
  return pattern.exec(said())?.[1] as string;
}

const debug = (id: string, name: string, complete: string) => ({
  id,
  type: "debug",
  z: "tab1",
  name,
  active: true,
  tosidebar: false,
  console: true,
  complete,
  targetType: complete === "true" ? "full" : "msg",
  wires: [],
});

const inject = (id: string, target: string, payload: string) => ({
  id,
  type: "inject",
  z: "tab1",
  props: [{ p: "payload" }],
  payload,
  payloadType: "json",
  repeat: "",
  once: false,
  wires: [[target]],
});

/**
 * The flow: three action views (plain, to dismiss, timed) and one snapshot view. Every node
 * but the tab has x and y: Node-RED treats a node without them as a config node, and a Catch
 * node that is one catches nothing.
 */
function flow(pkg: string, withRecord: boolean): object[] {
  const ask = `inny-${pkg}-ask`;
  const record = `inny-${pkg}-record`;
  const nodes: object[] = [
    { id: "tab1", type: "tab", label: "Views" },
    inject("go-ask", "ask", '{"n":1}'),
    { id: "ask", type: ask, z: "tab1", window: "popout", wires: [["dbg-answered"], []] },
    inject("go-dismiss", "dismiss", '{"n":2}'),
    { id: "dismiss", type: ask, z: "tab1", window: "inline", wires: [["dbg-answered"], []] },
    inject("go-timed", "timed", '{"n":3}'),
    {
      id: "timed",
      type: ask,
      z: "tab1",
      window: "inline",
      timeout_seconds: "8",
      wires: [["dbg-answered"], ["dbg-timeout"]],
    },
    {
      id: "catch",
      type: "catch",
      z: "tab1",
      scope: null,
      uncaught: false,
      wires: [["dbg-caught"]],
    },
    debug("dbg-answered", "answered", "payload"),
    debug("dbg-timeout", "timed out", "payload"),
    debug("dbg-caught", "caught", "error"),
    ...(withRecord
      ? [
          inject("go-rec", "rec", '{"n":4}'),
          {
            id: "rec",
            type: record,
            z: "tab1",
            name: "Rec",
            wires: [["dbg-passed"], ["dbg-again"], []],
          },
          debug("dbg-passed", "passed run", "inny.run"),
          debug("dbg-again", "again run", "inny.run"),
        ]
      : []),
  ];
  return nodes.map((node, n) => (n === 0 ? node : { x: 100, y: 40 * n, ...node }));
}

/** A journal entry as the runtime left it on disk (read-only, beside the running runtime). */
function journaled(userData: string, inputId: string): Record<string, unknown> | null {
  const db = new DatabaseSync(path.join(userData, "journal.sqlite"), { readOnly: true });
  try {
    const row = db.prepare("SELECT body FROM journal WHERE input_id = ?").get(inputId) as
      { body: string } | undefined;
    return row === undefined ? null : (JSON.parse(row.body) as Record<string, unknown>);
  } finally {
    db.close();
  }
}

/** The view the runtime presented for `instance`, first or again, from its log line. */
const presentedFor = (said: () => string, instance: string, again: boolean): Promise<string> =>
  captured(
    said,
    new RegExp(
      `view (\\S+) of instance ${instance} ${again ? "re-presented" : "presented \\(first\\)"}`,
    ),
  );

/** The pop-out pages open now, and the view each answers for, through its own bridge. */
async function popoutViews(app: ElectronApplication): Promise<string[]> {
  const ids: string[] = [];
  for (const page of app.windows().filter((each) => each.url().startsWith("inny-view://"))) {
    ids.push(
      await page.evaluate(async () => {
        const got = await (window as unknown as { inny: { get(): Promise<Result> } }).inny.get();
        const id = got.ok ? got.value?.["id"] : undefined;
        return typeof id === "string" ? id : "";
      }),
    );
  }
  return ids;
}

for (const language of ["py", "ts"] as const) {
  const pkg = `view${language}`;

  test(`views (${language}): an action view waits across kill -9, a submission continues, a dismissal reaches Catch, the timeout keeps its journaled deadline, and a snapshot is recorded`, async () => {
    test.setTimeout(150_000);
    const { scratch, userData, env } = scratchDirectories();
    const launched: ElectronApplication[] = [];
    try {
      const { app, window, output } = await launchApp(env);
      launched.push(app);
      const said = () => output.join("");
      const first = await waitForRunning(window, "runtime");
      const port = Number(first.port);
      expect(await request(port, "POST", "/red/flows", flow(pkg, true))).toBe(204);
      await expect
        .poll(said, { timeout: 20_000 })
        .toMatch(new RegExp(`\\[inny-${pkg}-record rec\\] ready`));

      // ── an action view makes the flow wait; a pop-out view opens its window by itself ──
      expect(await request(port, "POST", "/red/inject/go-ask")).toBe(200);
      expect(await request(port, "POST", "/red/inject/go-timed")).toBe(200);
      const askId = await presentedFor(said, "ask", false);
      const timedId = await presentedFor(said, "timed", false);
      await expect.poll(() => popoutViews(app), { timeout: 15_000 }).toEqual([askId]);
      expect(said()).not.toContain("[debug:answered]");
      const deadlineOf = (again: boolean) =>
        new RegExp(`view ${timedId} ${again ? "re-" : ""}presented; times out at (\\S+)`).exec(
          said(),
        )?.[1];
      const deadline = deadlineOf(false);
      expect(deadline).toBeDefined();

      // ── kill -9 the runtime: still pending, same id, re-presented quietly ───────────────
      process.kill(first.pid, "SIGKILL");
      await waitForRunning(window, "runtime", first.generation + 1);
      expect(await presentedFor(said, "ask", true)).toBe(askId);
      expect(await presentedFor(said, "timed", true)).toBe(timedId);
      // The timeout's deadline was journaled: the restart did not move it.
      await expect.poll(() => deadlineOf(true), { timeout: 10_000 }).toBe(deadline);
      // Re-sent after the crash, and no attempt counted for a view waiting on a person.
      expect(journaled(userData, askId)).toMatchObject({ state: "awaiting", attempts: 1 });

      // ── the timeout output fires at that deadline; the view is no longer waiting ────────
      await expect.poll(said, { timeout: 20_000 }).toMatch(/\[debug:timed out\] \n?\{ n: 3 \}/);
      expect(Date.now()).toBeLessThan(Date.parse(deadline as string) + 4_000);
      expect(await submit(window, timedId, { answer: "late" })).toMatchObject({ ok: false });

      // ── a submission, from the view's own pop-out, continues the flow and closes it ────
      const popout = app.windows().find((page) => page.url().startsWith("inny-view://"));
      expect(
        await popout?.evaluate(() =>
          (
            window as unknown as {
              inny: { submit(values: Record<string, unknown>): Promise<Result> };
            }
          ).inny.submit({ answer: "Ada" }),
        ),
      ).toEqual({ ok: true, value: null });
      await expect
        .poll(said, { timeout: 10_000 })
        .toMatch(/\[debug:answered\] \n?\{ answer: 'Ada' \}/);
      await expect.poll(() => popoutViews(app), { timeout: 10_000 }).toEqual([]);

      // ── a dismissal is an error that reaches Catch ──────────────────────────────────────
      expect(await request(port, "POST", "/red/inject/go-dismiss")).toBe(200);
      const dismissId = await presentedFor(said, "dismiss", false);
      expect(await submit(window, dismissId, { __dismiss__: true })).toMatchObject({ ok: true });
      await expect
        .poll(said, { timeout: 10_000 })
        .toMatch(/\[debug:caught\][\s\S]{0,200}dismissed by the person/);

      // ── a snapshot is recorded, and the flow goes on in the run that took it ────────────
      expect(await request(port, "POST", "/red/inject/go-rec")).toBe(200);
      await captured(
        said,
        new RegExp(`snapshot (\\S+) recorded from \\[inny-${pkg}-record rec\\]`),
      );
      await captured(said, /\[debug:passed run\] \n?'?([0-9a-f-]{36})/);

      await quit(app);
      await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
    } finally {
      await cleanUp(launched, scratch);
    }
  });
}
