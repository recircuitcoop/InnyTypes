// Action and snapshot views in the real app (WI-0018-10), driven through the real shell/main.ts
// bundle and AppApi (`window.inny.app`), against BOTH reference view nodes: viewpy (Python,
// the standard library only) and viewts (TypeScript, run by Electron as Node).
//
// An action view makes the flow wait; it survives a `kill -9` of the runtime, pending under
// the same id and re-presented quietly; a submission continues the flow; a dismissal reaches
// Catch; the timeout output fires at its JOURNALED deadline, across the restart. A snapshot is
// recorded; its action starts a new run, traceable by msg.inny.run; a press of an unwired
// action, or of one whose view left the flow, is refused with 409 and the reason.
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

/** The view calls of AppApi, as the page sees them (src/ui/contract.ts). */
interface ViewApi {
  onViewPresented(listener: (view: Presented) => void): void;
  onPendingViews(listener: (count: number) => void): void;
  pendingViews(): Promise<number | null>;
  view(id: string): Promise<Result>;
  submitView(id: string, values: Record<string, unknown>): Promise<Result>;
  snapshot(id: string): Promise<Result>;
  pressAction(id: string, action: string, values: Record<string, unknown>): Promise<Result>;
}
interface Presented {
  id: string;
  window: string;
  first: boolean;
  title: string;
}
type Result =
  | { ok: true; value: Record<string, unknown> | null }
  | { ok: false; error: string; status?: number };
interface Heard {
  presented: Presented[];
  pending: number[];
}

type Api = { inny: { app: ViewApi }; heard?: Heard };

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

/** Listen on the page for what the shell passes on: presentations and pending counts. */
async function listen(window: Page): Promise<void> {
  await window.evaluate(() => {
    const page = window as unknown as Api;
    const heard: Heard = { presented: [], pending: [] };
    page.heard = heard;
    page.inny.app.onViewPresented((view) => heard.presented.push(view));
    page.inny.app.onPendingViews((count) => heard.pending.push(count));
  });
}

const heard = (window: Page): Promise<Heard> =>
  window.evaluate(() => (window as unknown as Api).heard ?? { presented: [], pending: [] });

/** One AppApi view call, made from the page. */
function call(window: Page, name: Exclude<keyof ViewApi, `on${string}`>, ...args: unknown[]) {
  return window.evaluate(
    ([method, rest]) => {
      const api = (window as unknown as Api).inny.app as unknown as Record<
        string,
        (...a: unknown[]) => Promise<unknown>
      >;
      return (api[method] as (...a: unknown[]) => Promise<unknown>)(...rest);
    },
    [name, args] as const,
  ) as Promise<Result>;
}

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

/** Which instance a pending view belongs to, asked of the runtime. */
async function instanceOf(window: Page, id: string): Promise<string> {
  const result = await call(window, "view", id);
  return result.ok && result.value !== null ? String(result.value["instanceId"]) : "";
}

for (const language of ["py", "ts"] as const) {
  const pkg = `view${language}`;

  test(`views (${language}): an action view waits across kill -9, a submission continues, a dismissal reaches Catch, the timeout keeps its journaled deadline, and a snapshot's action starts a new run or is refused with 409`, async () => {
    test.setTimeout(150_000);
    const { scratch, userData, env } = scratchDirectories();
    const launched: ElectronApplication[] = [];
    try {
      const { app, window, output } = await launchApp(env);
      launched.push(app);
      const said = () => output.join("");
      const first = await waitForRunning(window, "runtime");
      const port = Number(first.port);
      await listen(window);
      expect(await request(port, "POST", "/red/flows", flow(pkg, true))).toBe(204);
      await expect
        .poll(said, { timeout: 20_000 })
        .toMatch(new RegExp(`\\[inny-${pkg}-record rec\\] ready`));

      // ── an action view makes the flow wait ──────────────────────────────────────────────
      expect(await request(port, "POST", "/red/inject/go-ask")).toBe(200);
      expect(await request(port, "POST", "/red/inject/go-timed")).toBe(200);
      await expect.poll(async () => (await heard(window)).presented.length).toBe(2);
      const presented = (await heard(window)).presented;
      expect(presented.every((view) => view.first)).toBe(true);
      const byInstance = new Map<string, string>();
      for (const view of presented) {
        byInstance.set(await instanceOf(window, view.id), view.id);
      }
      const askId = byInstance.get("ask") as string;
      const timedId = byInstance.get("timed") as string;
      expect(presented.find((view) => view.id === askId)?.window).toBe("popout");
      await expect.poll(() => call(window, "pendingViews") as Promise<unknown>).toBe(2);
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
      await expect
        .poll(
          async () => (await heard(window)).presented.filter((v) => !v.first).map((v) => v.id),
          {
            timeout: 20_000,
          },
        )
        .toEqual(expect.arrayContaining([askId, timedId]));
      expect(await call(window, "view", askId)).toMatchObject({
        ok: true,
        value: { kind: "view", id: askId, instanceId: "ask" },
      });
      await expect.poll(() => call(window, "pendingViews") as Promise<unknown>).toBe(2);
      // The timeout's deadline was journaled: the restart did not move it.
      await expect.poll(() => deadlineOf(true), { timeout: 10_000 }).toBe(deadline);
      // Re-sent after the crash, and no attempt counted for a view waiting on a person.
      expect(journaled(userData, askId)).toMatchObject({ state: "awaiting", attempts: 1 });

      // ── the timeout output fires at that deadline ───────────────────────────────────────
      await expect.poll(said, { timeout: 20_000 }).toMatch(/\[debug:timed out\] \n?\{ n: 3 \}/);
      expect(Date.now()).toBeLessThan(Date.parse(deadline as string) + 4_000);
      expect(await call(window, "view", timedId)).toMatchObject({ value: { kind: "gone" } });

      // ── a submission continues the flow from the view's output ─────────────────────────
      expect(await call(window, "submitView", askId, { answer: "Ada" })).toEqual({
        ok: true,
        value: null,
      });
      await expect
        .poll(said, { timeout: 10_000 })
        .toMatch(/\[debug:answered\] \n?\{ answer: 'Ada' \}/);
      await expect.poll(() => call(window, "pendingViews") as Promise<unknown>).toBe(0);

      // ── a dismissal is an error that reaches Catch ──────────────────────────────────────
      expect(await request(port, "POST", "/red/inject/go-dismiss")).toBe(200);
      await expect
        .poll(async () => (await heard(window)).presented.length, { timeout: 10_000 })
        .toBe(5);
      const dismissId = (await heard(window)).presented.at(-1)?.id as string;
      expect(await call(window, "submitView", dismissId, { __dismiss__: true })).toMatchObject({
        ok: true,
      });
      await expect
        .poll(said, { timeout: 10_000 })
        .toMatch(/\[debug:caught\][\s\S]{0,200}dismissed by the person/);

      // ── a snapshot, and its action as a new run ─────────────────────────────────────────
      expect(await request(port, "POST", "/red/inject/go-rec")).toBe(200);
      const recorded = new RegExp(`snapshot (\\S+) recorded from \\[inny-${pkg}-record rec\\]`);
      const snapshotId = await captured(said, recorded);
      const passedRun = await captured(said, /\[debug:passed run\] \n?'?([0-9a-f-]{36})/);
      expect(await call(window, "snapshot", snapshotId)).toMatchObject({
        ok: true,
        value: {
          kind: "snapshot",
          instanceId: "rec",
          state: { n: 4 },
          actions: [
            { id: "again", enabled: true, reason: null },
            { id: "spare", enabled: false, reason: 'Nothing is wired to the "Spare" output.' },
          ],
        },
      });
      expect(await call(window, "pressAction", snapshotId, "again", { why: "again" })).toEqual({
        ok: true,
        value: null,
      });
      const againRun = await captured(said, /\[debug:again run\] \n?'?([0-9a-f-]{36})/);
      expect(againRun).not.toBe(passedRun);

      // ── presses refused with 409 and the reason ─────────────────────────────────────────
      expect(await call(window, "pressAction", snapshotId, "spare", {})).toEqual({
        ok: false,
        error: 'Nothing is wired to the "Spare" output.',
        status: 409,
      });
      expect(await request(port, "POST", "/red/flows", flow(pkg, false))).toBe(204);
      await expect
        .poll(() => call(window, "pressAction", snapshotId, "again", {}), { timeout: 10_000 })
        .toEqual({
          ok: false,
          error: "The view that took this snapshot is no longer in the flow.",
          status: 409,
        });
      // The snapshot itself still opens, its actions disabled with the reason.
      expect(await call(window, "snapshot", snapshotId)).toMatchObject({
        value: { actions: [{ enabled: false, reason: expect.stringContaining("no longer") }, {}] },
      });

      await quit(app);
      await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
    } finally {
      await cleanUp(launched, scratch);
    }
  });
}
