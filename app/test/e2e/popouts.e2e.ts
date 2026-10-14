// The pop-outs (WI-0018-11), in the real app: on inny-view:// in the inny-views partition, with
// the exact webPreferences, CSP and id-less bridge of spec 8.5, every P10f probe run from inside a
// live pop-out AND from inside a third-party component; two at once; closing without submitting,
// the question still waiting on Live; placement remembered when Live's Answer opens it again; a
// restart re-presenting quietly, opening nothing. And a view that plays a sound (plan 0020): a
// Listen control in a pop-out, for a pop-out view and an inline one, playing the pop-out kit's
// generated tone once. And widget views (plan
// 0021, the widget kit): drawn only in the pop-up, styled by the tokens, every P10f probe run
// from inside the reorder widget's page, Continue disabled until setValid(true) (C19), an
// answer its schema refuses keeping the view waiting (C17), its structured answer accepted
// (C16), and falling back to their form when the widget can't be drawn (C18). And Preview a
// view… (plan 0021 D4): the reorder widget drawn with its type's sample props, no flow run, its
// answer logged.
import fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { STRINGS } from "../../src/ui/strings";
import {
  cleanUp,
  launchApp,
  openLive,
  processesNaming,
  quit,
  scratchDirectories,
  waitForRunning,
} from "./app-harness";

/** Spec 8.5.5, exactly. */
const VIEW_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "media-src 'self' data:; connect-src 'none'; form-action 'none'; frame-ancestors 'none'; " +
  "base-uri 'none'";

/**
 * Spec 8.5.4, as Electron reads it back from a live window (getLastWebPreferences, untyped
 * but present). It does not report spellcheck, navigateOnDragDrop or preload: the unit test of
 * adapters/electron/popouts.ts holds the options passed to BrowserWindow to all of them.
 */
const WEB_PREFERENCES = {
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  nodeIntegrationInWorker: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
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

/** The kit's flow: two rich pop-out views, one drawn by the kit's component, a record, a slow node. */
function flow(port: number): object[] {
  const nodes: object[] = [
    { id: "tab1", type: "tab", label: "Pop-outs" },
    inject("go-a", "ask-a", '{"n":1}'),
    {
      id: "ask-a",
      type: "inny-popoutkit-ask",
      z: "tab1",
      window: "popout",
      show: "rich",
      wires: [["dbg-answered"]],
    },
    inject("go-b", "ask-b", '{"n":2}'),
    {
      id: "ask-b",
      type: "inny-popoutkit-ask",
      z: "tab1",
      window: "popout",
      show: "rich",
      wires: [["dbg-answered"]],
    },
    inject("go-c", "ask-c", JSON.stringify({ port })),
    {
      id: "ask-c",
      type: "inny-popoutkit-ask",
      z: "tab1",
      window: "popout",
      show: "component",
      wires: [["dbg-answered"]],
    },
    inject("go-i", "ask-i", '{"n":9}'),
    {
      id: "ask-i",
      type: "inny-popoutkit-ask",
      z: "tab1",
      window: "inline",
      show: "rich",
      wires: [["dbg-answered"]],
    },
    inject("go-rec", "rec", '{"n":4}'),
    {
      id: "rec",
      type: "inny-popoutkit-record",
      z: "tab1",
      name: "Rec",
      wires: [[], ["dbg-again"]],
    },
    inject("go-slow", "slow", '{"n":5}'),
    { id: "slow", type: "inny-popoutkit-slow", z: "tab1", wires: [[]] },
    {
      id: "catch",
      type: "catch",
      z: "tab1",
      scope: null,
      uncaught: false,
      wires: [["dbg-caught"]],
    },
    debug("dbg-answered", "answered", "payload"),
    debug("dbg-again", "again", "payload"),
    debug("dbg-caught", "caught", "error"),
  ];
  return nodes.map((node, n) => (n === 0 ? node : { x: 100, y: 40 * n, ...node }));
}

/** The questions waiting on the flow's board in Live, inline in their places. */
const waitingOnLive = (window: Page) =>
  window.getByTestId("live-board").getByTestId("question-inline");

/** Live's Answer on the one question waiting there: its pop-out opens, or comes forward. */
async function answerOnLive(window: Page): Promise<void> {
  await expect(waitingOnLive(window)).toHaveCount(1, { timeout: 15_000 });
  await waitingOnLive(window).getByRole("button", { name: STRINGS["card.answer"] }).click();
}

/** The pop-out pages open now. */
const popoutPages = (app: ElectronApplication): Page[] =>
  app.windows().filter((page) => page.url().startsWith("inny-view://"));

/** Skip this step in a pop-out's chrome, which asks once (ux-writing "Questions"): Skip. */
async function skipConfirmed(page: Page): Promise<void> {
  await page.getByTestId("view-dismiss").click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Skip", exact: true }).click();
}

/** The pop-outs the shell holds now, by `view:<id>` / `snapshot:<id>` (e2e hook). */
const popoutKeys = (app: ElectronApplication): Promise<string[]> =>
  app.evaluate(() =>
    (globalThis as unknown as { innytypesE2E: { popouts(): string[] } }).innytypesE2E.popouts(),
  );

/** The view id a pop-out page answers for, asked through its own bridge. */
const idOf = (page: Page): Promise<string> =>
  page.evaluate(async () => {
    const got = await (
      window as unknown as { inny: { get(): Promise<{ ok: boolean; value?: { id: string } }> } }
    ).inny.get();
    return got.ok ? (got.value?.id ?? "") : "";
  });

/** The pop-out page for `id`, once it is open and drawn. */
async function popoutFor(app: ElectronApplication, id: string): Promise<Page> {
  let found: Page | undefined;
  await expect
    .poll(
      async () => {
        for (const page of popoutPages(app)) {
          if ((await idOf(page).catch(() => "")) === id) {
            found = page;
            return true;
          }
        }
        return false;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  return found as Page;
}

/** One window's facts, read in the main process: its URL, bounds, and webPreferences. */
async function windowFacts(app: ElectronApplication, url: string) {
  return app.evaluate(({ BrowserWindow, session }, wanted) => {
    const window = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === wanted);
    if (window === undefined) {
      return null;
    }
    return {
      preferences: (
        window.webContents as unknown as { getLastWebPreferences(): Record<string, unknown> }
      ).getLastWebPreferences(),
      partitioned: window.webContents.session === session.fromPartition("inny-views"),
      bounds: window.getBounds(),
    };
  }, url);
}

/**
 * The P10f probes (arch_pivot P10f, spec 8.5.9), as page script. They run through the main
 * process's `executeJavaScript`, which the page's CSP holds to; Playwright's own evaluate is
 * exempt from it (an `eval` there succeeds), so it cannot prove a CSP. The third-party
 * component (test/fixtures/popoutkit/view/component.js) runs the same list as its own script.
 */
const probeSource = (port: number): string => `(async () => {
  const outcome = async (promise) => {
    try { await promise; return "allowed"; }
    catch (error) { return "refused: " + (error && error.message ? error.message : String(error)); }
  };
  const results = {
    require: typeof require,
    process: typeof process,
    module: typeof module,
    electron: typeof window.electron,
    innyKeys: Object.keys(window.inny).sort(),
    appApi: typeof window.inny.app,
    getLength: window.inny.get.length,
  };
  results.fetchRuntime = await outcome(fetch("http://127.0.0.1:${String(port)}/red/settings"));
  results.fetchFile = await outcome(fetch("file:///etc/hosts"));
  try { results.eval = String(eval("1+1")); } catch (error) { results.eval = error.name; }
  try { results.newFunction = String(new Function("return 2")()); } catch (error) { results.newFunction = error.name; }
  const script = document.createElement("script");
  script.textContent = "window.__innyInlineRan = true;";
  document.body.append(script);
  await new Promise((resolve) => setTimeout(resolve, 50));
  results.inlineScript = window.__innyInlineRan === true ? "ran" : "did not run";
  results.windowOpen = window.open("https://example.com/") === null ? "denied" : "opened";
  results.action = await outcome(window.inny.action("again", {}));
  const other = await window.inny.get("someone-else");
  results.getOwn = other.ok ? other.value.id : "not ok: " + other.error;
  return results;
})()`;

/** Run the probes in the pop-out of `id`, as page script (see probeSource). */
async function probe(
  app: ElectronApplication,
  id: string,
  port: number,
): Promise<Record<string, unknown>> {
  return app.evaluate(
    async ({ BrowserWindow }, [wanted, source]) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.webContents.getURL().startsWith("inny-view://")) {
          continue;
        }
        const own = (await window.webContents.executeJavaScript(
          "window.inny.get().then((got) => (got.ok ? got.value.id : ''))",
        )) as string;
        if (own === wanted) {
          return (await window.webContents.executeJavaScript(source)) as Record<string, unknown>;
        }
      }
      return { found: false };
    },
    [id, probeSource(port)] as const,
  );
}

/** What every probe must find, in a pop-out of the action view `id`. */
function sandboxed(id: string) {
  return {
    require: "undefined",
    process: "undefined",
    module: "undefined",
    electron: "undefined",
    // The five-call bridge (spec 8.5.6), and nothing else.
    innyKeys: ["action", "draft", "get", "setValid", "submit"],
    appApi: "undefined",
    getLength: 0,
    fetchRuntime: expect.stringMatching(/^refused: /),
    fetchFile: expect.stringMatching(/^refused: /),
    eval: "EvalError",
    newFunction: "EvalError",
    inlineScript: "did not run",
    windowOpen: "denied",
    action: expect.stringMatching(/^refused: .*not a snapshot/),
    getOwn: id,
  };
}

test("pop-outs: sandboxed exactly, every P10f probe from inside a pop-out and a third-party component, two at once, submit, close without submitting, placement remembered, quiet re-presentation", async () => {
  test.setTimeout(240_000);
  const { scratch, userData, env } = scratchDirectories();
  const launched: ElectronApplication[] = [];
  try {
    const { app, window, output } = await launchApp({ ...env, INNYTYPES_E2E_HOOKS: "1" });
    launched.push(app);
    const said = () => output.join("");
    const notices = () => said().match(/notice: InnyTypes is waiting for you/g)?.length ?? 0;
    let runtime = await waitForRunning(window, "runtime");
    const port = Number(runtime.port);
    expect(await request(port, "POST", "/red/flows", flow(port))).toBe(204);
    await expect.poll(said, { timeout: 20_000 }).toMatch(/\[inny-popoutkit-slow slow\] ready/);

    // ── a first presentation opens its pop-out by itself ────────────────────────────────
    expect(await request(port, "POST", "/red/inject/go-a")).toBe(200);
    await expect.poll(() => popoutPages(app).length, { timeout: 15_000 }).toBe(1);
    const a = popoutPages(app)[0] as Page;
    const idA = await idOf(a);
    expect(await popoutKeys(app)).toEqual([`view:${idA}`]);
    await expect.poll(notices).toBe(1);
    expect(a.url()).toBe("inny-view://app/view.html");

    // ── served by the shell, in the inny-views partition, with the exact webPreferences ─
    const facts = await windowFacts(app, a.url());
    expect(facts?.partitioned).toBe(true);
    expect(facts?.preferences).toMatchObject(WEB_PREFERENCES);
    // ── the CSP, as a response header of every file the page is made of ───────────────
    const headers = await app.evaluate(async ({ session }) => {
      const views = session.fromPartition("inny-views");
      const csp: Record<string, string | null> = {};
      for (const url of [
        "inny-view://app/view.html",
        "inny-view://app/view.js",
        "inny-view://app/tokens.css",
        "inny-view://app/view-kit.css",
        "inny-view://popoutkit/view.html",
        "inny-view://popoutkit/component.js",
        "inny-view://popoutkit/tokens.css",
        "inny-view://popoutkit/view-kit.css",
      ]) {
        const response = await views.fetch(url);
        csp[url] = response.ok ? response.headers.get("content-security-policy") : null;
      }
      return csp;
    });
    // Every file served (a 404 would read null), the tokens and the view kit among them (plan 0021).
    expect(Object.values(headers)).toEqual(Array.from({ length: 8 }, () => VIEW_CSP));

    // ── the generic renderer: text, table, media, an Anytype link, and the form ─────────
    await expect(a.getByTestId("view-title")).toHaveText("Answer the pop-out kit");
    await expect(a.getByTestId("view-text")).toHaveText('{"n":1}');
    await expect(a.getByTestId("view-fields")).toContainText("by the pop-out kit");
    await expect(a.getByTestId("view-table").locator("tbody tr")).toHaveCount(2);
    await expect(a.getByTestId("view-media")).toHaveAttribute("src", /^data:image\/png;base64,/);
    await expect(a.getByTestId("view-anytype")).toHaveAttribute(
      "href",
      "anytype://object?objectId=obj-1&spaceId=space-1",
    );

    // ── every P10f probe, from inside the live pop-out ──────────────────────────────────
    expect(await probe(app, idA, port)).toEqual(sandboxed(idA));

    // ── two at once ─────────────────────────────────────────────────────────────────────
    expect(await request(port, "POST", "/red/inject/go-b")).toBe(200);
    await expect.poll(() => popoutPages(app).length, { timeout: 15_000 }).toBe(2);
    const b = popoutPages(app).find((page) => page !== a) as Page;
    const idB = await idOf(b);
    expect((await popoutKeys(app)).sort()).toEqual([`view:${idA}`, `view:${idB}`].sort());

    // ── a submission in one pop-out continues the flow and closes only that one ─────────
    await a.getByTestId("field-answer").fill("Ada");
    await a.getByTestId("field-count").fill("3");
    await a.getByTestId("field-sure").check();
    await a.getByTestId("view-continue").click();
    await expect
      .poll(said, { timeout: 10_000 })
      .toMatch(/\[debug:answered\] \n?\{ answer: 'Ada', count: 3, sure: true \}/);
    await expect.poll(() => popoutKeys(app), { timeout: 10_000 }).toEqual([`view:${idB}`]);

    // ── placement, then closing without submitting: the view stays pending ──────────────
    const placed = { x: 123, y: 145, width: 611, height: 503 };
    await app.evaluate(({ BrowserWindow }, bounds) => {
      const window = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().startsWith("inny-view://"),
      );
      window?.setBounds(bounds);
      window?.close();
    }, placed);
    await expect.poll(() => popoutKeys(app)).toEqual([]);
    // Still waiting: Live lists it in its question's place.
    await openLive(window, "tab1");
    await expect(waitingOnLive(window)).toHaveCount(1, { timeout: 15_000 });
    expect(said()).not.toMatch(/dismissed by the person/);
    expect(said()).not.toMatch(/\[debug:caught\]/);
    const remembered = JSON.parse(
      fs.readFileSync(path.join(userData, "popout-placements.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(remembered["view:inny-popoutkit-ask"]).toEqual(placed);

    // ── Live's Answer re-opens it where its type was left ───────────────────────────────
    await answerOnLive(window);
    const reopened = await popoutFor(app, idB);
    expect((await windowFacts(app, reopened.url()))?.bounds).toEqual(placed);

    // ── a third-party component, on its package's own origin, under the same sandbox ────
    expect(await request(port, "POST", "/red/inject/go-c")).toBe(200);
    await expect
      .poll(
        () => popoutPages(app).some((page) => page.url().startsWith("inny-view://popoutkit/")),
        { timeout: 15_000 },
      )
      .toBe(true);
    const c = popoutPages(app).find(
      (page) => page.url() === "inny-view://popoutkit/view.html",
    ) as Page;
    const idC = await idOf(c);
    const cFacts = await windowFacts(app, c.url());
    expect(cFacts?.partitioned).toBe(true);
    expect(cFacts?.preferences).toMatchObject(WEB_PREFERENCES);
    await expect(c.getByTestId("component-view-id")).toHaveText(idC);
    await expect(c.getByTestId("component-probes")).not.toBeEmpty({ timeout: 10_000 });
    const fromComponent = JSON.parse(
      (await c.getByTestId("component-probes").textContent()) ?? "{}",
    ) as unknown;
    expect(fromComponent).toEqual(sandboxed(idC));
    expect(await probe(app, idC, port)).toEqual(sandboxed(idC));
    await c.getByTestId("component-submit").click();
    await expect
      .poll(said, { timeout: 10_000 })
      .toMatch(/\[debug:answered\] \n?\{ answer: 'from the component' \}/);

    // ── a restart: the open pop-out survives; the pending view is re-presented quietly ──
    await expect.poll(() => popoutKeys(app)).toEqual([`view:${idB}`]);
    const noticesBefore = notices();
    process.kill(runtime.pid, "SIGKILL");
    await reopened.reload(); // loads from the shell even while the runtime is gone
    runtime = await waitForRunning(window, "runtime", runtime.generation + 1);
    await expect
      .poll(said, { timeout: 20_000 })
      .toMatch(new RegExp(`view ${idB} re-presented: it waits quietly in the Inbox`));
    await expect(reopened.getByTestId("view-title")).toHaveText("Answer the pop-out kit", {
      timeout: 15_000,
    });
    // Nothing thrown at the person: the one window it had, no new one, no notice.
    expect(await popoutKeys(app)).toEqual([`view:${idB}`]);
    expect(notices()).toBe(noticesBefore);
    await reopened.close();
    await expect.poll(() => popoutKeys(app)).toEqual([]);
    process.kill(runtime.pid, "SIGKILL");
    runtime = await waitForRunning(window, "runtime", runtime.generation + 1);
    await expect
      .poll(
        () =>
          said().match(new RegExp(`view ${idB} re-presented: it waits quietly`, "g"))?.length ?? 0,
        { timeout: 20_000 },
      )
      .toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await popoutKeys(app)).toEqual([]);
    expect(notices()).toBe(noticesBefore);

    await quit(app);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
  } finally {
    await cleanUp(launched, scratch);
  }
});

/** The kit's sound flow (plan 0020): a tone with its own label in a pop-out, and one inline. */
function soundFlow(): object[] {
  const nodes: object[] = [
    { id: "tab1", type: "tab", label: "A sound" },
    inject("go-sp", "ask-sp", '{"label":"Listen to the tone"}'),
    {
      id: "ask-sp",
      type: "inny-popoutkit-ask",
      z: "tab1",
      window: "popout",
      show: "sound",
      wires: [["dbg-answered"]],
    },
    inject("go-si", "ask-si", "{}"),
    {
      id: "ask-si",
      type: "inny-popoutkit-ask",
      z: "tab1",
      window: "inline",
      show: "sound",
      wires: [["dbg-answered"]],
    },
    debug("dbg-answered", "answered", "payload"),
  ];
  return nodes.map((node, n) => (n === 0 ? node : { x: 100, y: 40 * n, ...node }));
}

/** What a page's one sample did: its play and ended events, counted from before the press. */
interface Heard {
  plays: number;
  ends: number;
  paused: boolean;
  ended: boolean;
  duration: number;
  played: number[][];
}

/** Count the sample's play and ended events from now on (page script, not a sleep). */
const countPlays = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const sample = document.querySelector("[data-testid=view-audio]") as HTMLAudioElement;
    const tally = { plays: 0, ends: 0 };
    (window as unknown as { __heard: typeof tally }).__heard = tally;
    sample.addEventListener("play", () => {
      tally.plays += 1;
    });
    sample.addEventListener("ended", () => {
      tally.ends += 1;
    });
  });

/** The sample's events so far, and its media state. */
const heard = (page: Page): Promise<Heard> =>
  page.evaluate(() => {
    const sample = document.querySelector("[data-testid=view-audio]") as HTMLAudioElement;
    const tally = (window as unknown as { __heard: { plays: number; ends: number } }).__heard;
    const played: number[][] = [];
    for (let n = 0; n < sample.played.length; n++) {
      played.push([sample.played.start(n), sample.played.end(n)]);
    }
    return {
      ...tally,
      paused: sample.paused,
      ended: sample.ended,
      duration: sample.duration,
      played,
    };
  });

/** Press the Listen control and see the sample play once, from the start to its end. */
async function listenOnce(page: Page, label: string): Promise<void> {
  const listen = page.getByTestId("view-listen");
  await expect(listen).toHaveText(label);
  await expect(listen).toHaveAttribute("data-variant", /kind=secondary/);
  await expect(listen.locator('[data-component="icon"]')).toHaveAttribute(
    "data-variant",
    /name=play/,
  );
  await countPlays(page);
  await listen.click();
  // The ended event, not a sleep: once it has fired, the sample played to its end exactly once.
  await expect.poll(async () => (await heard(page)).ends, { timeout: 15_000 }).toBe(1);
  const after = await heard(page);
  expect(after).toMatchObject({ plays: 1, ends: 1, paused: true, ended: true });
  expect(after.duration).toBeCloseTo(1, 1);
  expect(after.played).toHaveLength(1); // one stretch, from the start
  expect(after.played[0]?.[0]).toBeCloseTo(0, 1);
  expect(after.played[0]?.[1]).toBeCloseTo(1, 1);
  await expect(listen).toHaveText(label); // "Listening…" is over: it reads its label again
  await expect(listen).toHaveAttribute("aria-pressed", "false");
}

test("a view plays a sound", async () => {
  test.setTimeout(150_000);
  const { scratch, userData, env } = scratchDirectories();
  const launched: ElectronApplication[] = [];
  try {
    const { app, window, output } = await launchApp({ ...env, INNYTYPES_E2E_HOOKS: "1" });
    launched.push(app);
    const said = () => output.join("");
    const runtime = await waitForRunning(window, "runtime");
    const port = Number(runtime.port);
    expect(await request(port, "POST", "/red/flows", soundFlow())).toBe(204);
    await expect.poll(said, { timeout: 20_000 }).toMatch(/\[inny-popoutkit-ask ask-sp\] ready/);
    await expect.poll(said, { timeout: 20_000 }).toMatch(/\[inny-popoutkit-ask ask-si\] ready/);

    // ── in the pop-out: a Listen control with the package's label, and it plays once ─────
    expect(await request(port, "POST", "/red/inject/go-sp")).toBe(200);
    await expect.poll(() => popoutPages(app).length, { timeout: 15_000 }).toBe(1);
    const p = popoutPages(app)[0] as Page;
    await expect(p.getByTestId("view-title")).toHaveText("Listen before answering");
    await expect(p.getByTestId("view-audio")).toHaveAttribute("src", /^data:audio\/wav;base64,/);
    await listenOnce(p, "Listen to the tone");
    await p.getByTestId("field-heard").check();
    await p.getByTestId("view-continue").click();
    await expect.poll(said, { timeout: 10_000 }).toMatch(/\[debug:answered\] \n?\{ heard: true \}/);

    // ── an inline view, answered from Live in its pop-out: its label falls back to "Listen" ─
    await expect.poll(() => popoutPages(app).length, { timeout: 10_000 }).toBe(0);
    expect(await request(port, "POST", "/red/inject/go-si")).toBe(200);
    await openLive(window, "tab1");
    await answerOnLive(window);
    await expect.poll(() => popoutPages(app).length, { timeout: 15_000 }).toBe(1);
    const i = popoutPages(app)[0] as Page;
    await expect(i.getByTestId("view-title")).toHaveText("Listen before answering");
    await listenOnce(i, "Listen");

    await quit(app);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
  } finally {
    await cleanUp(launched, scratch);
  }
});

/** The widget kit's flow (plan 0021): a reorder widget, and three widgets that can't be drawn. */
function widgetFlow(): object[] {
  const nodes: object[] = [
    { id: "tab1", type: "tab", label: "Widgets" },
    // Every instance says inline: a widget opens in the pop-up anyway (pop-up only).
    inject("go-r", "reorder", "{}"),
    {
      id: "reorder",
      type: "inny-widgetkit-reorder",
      z: "tab1",
      window: "inline",
      wires: [["dbg-answered"]],
    },
    inject("go-m", "missing", "{}"),
    {
      id: "missing",
      type: "inny-widgetkit-missing",
      z: "tab1",
      window: "inline",
      show: "missing",
      wires: [["dbg-answered"]],
    },
    inject("go-x", "crash", "{}"),
    {
      id: "crash",
      type: "inny-widgetkit-missing",
      z: "tab1",
      window: "inline",
      show: "crash",
      wires: [["dbg-answered"]],
    },
    inject("go-b", "bare", "{}"),
    {
      id: "bare",
      type: "inny-widgetkit-missing",
      z: "tab1",
      window: "inline",
      show: "bare",
      wires: [["dbg-answered"]],
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
    debug("dbg-caught", "caught", "error"),
  ];
  return nodes.map((node, n) => (n === 0 ? node : { x: 100, y: 40 * n, ...node }));
}

/** Inject `go`, and the one pop-up it opens by itself, on the widget kit's own origin. */
async function widgetPopout(app: ElectronApplication, port: number, go: string): Promise<Page> {
  expect(await request(port, "POST", `/red/inject/${go}`)).toBe(200);
  await expect.poll(() => popoutPages(app).length, { timeout: 15_000 }).toBe(1);
  const page = popoutPages(app)[0] as Page;
  expect(page.url()).toBe("inny-view://widgetkit/view.html");
  return page;
}

test("widget views", async () => {
  test.setTimeout(180_000);
  const { scratch, userData, env } = scratchDirectories();
  const launched: ElectronApplication[] = [];
  try {
    const { app, window, output } = await launchApp({ ...env, INNYTYPES_E2E_HOOKS: "1" });
    launched.push(app);
    const said = () => output.join("");
    const caught = () => said().match(/\[debug:caught\]/g)?.length ?? 0;
    const runtime = await waitForRunning(window, "runtime");
    const port = Number(runtime.port);
    expect(await request(port, "POST", "/red/flows", widgetFlow())).toBe(204);
    for (const id of ["reorder", "missing", "crash", "bare"]) {
      await expect
        .poll(said, { timeout: 20_000 })
        .toMatch(new RegExp(`\\[inny-widgetkit-(reorder|missing) ${id}\\] ready`));
    }

    // ── pop-up only: an inline instance's widget opens in its pop-up by itself ───────────
    const r = await widgetPopout(app, port, "go-r");
    const idR = await idOf(r);
    expect(await popoutKeys(app)).toEqual([`view:${idR}`]);
    // Live never draws it: the question waits in its place, and Answer brings the pop-up forward.
    await openLive(window, "tab1");
    await expect(waitingOnLive(window)).toContainText("Put these in order", { timeout: 15_000 });
    await answerOnLive(window);
    expect(await popoutKeys(app)).toEqual([`view:${idR}`]);
    await expect(window.getByTestId("view-form")).toHaveCount(0);

    // ── the tokens in the sandbox: the widget looks like InnyTypes ─────────────────────
    await expect(r.getByTestId("reorder-row-0")).toContainText("Ada");
    const styled = await r.evaluate(() => {
      const row = document.querySelector('[data-testid="reorder-row-0"]') as HTMLElement;
      return {
        canvas: getComputedStyle(document.documentElement)
          .getPropertyValue("--inny-surface-canvas")
          .trim(),
        body: getComputedStyle(document.body).backgroundColor,
        rowRadius: getComputedStyle(row).borderTopLeftRadius,
      };
    });
    expect(styled.canvas).not.toBe("");
    expect(styled.body).not.toBe("rgba(0, 0, 0, 0)");
    expect(styled.rowRadius).not.toBe("0px");
    // Drawn in time, it never falls back: past the 3 s, still the widget and its Continue.
    await r.evaluate(() => new Promise((resolve) => setTimeout(resolve, 3_500)));
    await expect(r.getByTestId("view-component")).toHaveCount(1);
    await expect(r.getByTestId("field-choice")).toHaveCount(0);
    await expect(r.getByTestId("view-unavailable")).toHaveCount(0);

    // ── C19: Continue stays disabled until the widget says setValid(true) ───────────────
    await expect(r.getByTestId("view-continue")).toBeDisabled();

    // ── every P10f probe, from inside the reorder widget's page, the widget drawn ───────
    expect(await probe(app, idR, port)).toEqual(sandboxed(idR));
    await expect(r.getByTestId("view-component")).toHaveCount(1); // the probes broke nothing

    // The person puts the list in order: a move, and the widget is valid.
    await r.getByTestId("reorder-down-0").click();
    await expect(r.getByTestId("view-continue")).toBeEnabled();

    // ── C17: an answer the type's schema refuses: the pop-up says so, the view waits ────
    // A widget answering what its `answer` schema does not allow (an undeclared property).
    await r.evaluate(() => {
      const widget = document.querySelector("widgetkit-reorder") as HTMLElement & {
        answer: () => unknown;
      };
      widget.answer = () => ({ order: ["Grace", "Ada", "Linus"], sneaked: true });
    });
    await r.getByTestId("view-continue").click();
    await expect(r.getByTestId("view-status")).toHaveText(
      "That answer couldn't be sent: it doesn't match what this step expects. " +
        "Your answer is still here. Try again, or skip this step.",
    );
    expect(await popoutKeys(app)).toEqual([`view:${idR}`]);
    await expect(waitingOnLive(window)).toHaveCount(1);
    expect(said()).not.toMatch(/\[debug:answered\]/); // nothing reached the node
    await expect(r.getByTestId("reorder-row-0")).toContainText("Grace"); // the work is still here

    // ── C16: the widget's own answer, structured JSON, is accepted and reaches the flow ──
    await r.evaluate(() => {
      Reflect.deleteProperty(document.querySelector("widgetkit-reorder") as HTMLElement, "answer");
    });
    await r.getByTestId("view-continue").click();
    await expect
      .poll(said, { timeout: 10_000 })
      .toMatch(/\[debug:answered\] \n?\{ order: \[ 'Grace', 'Ada', 'Linus' \] \}/);
    await expect.poll(() => popoutKeys(app), { timeout: 10_000 }).toEqual([]);

    // ── C18: an element never defined: after 3 s, the fallback form, which answers ─────
    const m = await widgetPopout(app, port, "go-m");
    await expect(m.getByTestId("field-choice")).toBeVisible({ timeout: 10_000 });
    await expect(m.getByTestId("view-component")).toHaveCount(0);
    // The pop-out's chrome (WI-0022-13): the fallback form's Continue is enabled, and answers it.
    await expect(m.getByTestId("view-continue")).toBeEnabled();
    await m.getByTestId("field-choice").fill("Ada");
    await m.getByTestId("view-continue").click();
    await expect
      .poll(said, { timeout: 10_000 })
      .toMatch(/\[debug:answered\] \n?\{ choice: 'Ada' \}/);
    await expect.poll(() => popoutKeys(app), { timeout: 10_000 }).toEqual([]);

    // ── a widget that throws as it is drawn falls back at once, never a dead Continue ───
    const x = await widgetPopout(app, port, "go-x");
    const fellBackAt = await (
      await x.waitForFunction(() =>
        document.querySelector('[data-testid="field-choice"]') === null ? 0 : performance.now(),
      )
    ).jsonValue();
    expect(fellBackAt).toBeLessThan(3_000); // the crash, not the timer
    await expect(x.locator("widgetkit-crash")).toHaveCount(0);
    await expect(x.getByTestId("view-continue")).toBeEnabled();
    await skipConfirmed(x);
    await expect.poll(caught, { timeout: 10_000 }).toBe(1);
    await expect.poll(() => popoutKeys(app), { timeout: 10_000 }).toEqual([]);

    // ── with no form: it says so, and Skip this step is all there is ────────────────────
    const b = await widgetPopout(app, port, "go-b");
    await expect(b.getByTestId("view-unavailable")).toHaveText(
      "This question can't be shown here. Skip this step, or open it again after updating widgetkit.",
      { timeout: 10_000 },
    );
    await expect(b.locator('[data-component="question-popout"] button')).toHaveCount(1);
    await expect(b.getByTestId("view-dismiss")).toHaveText("Skip this step");
    await skipConfirmed(b);
    await expect.poll(caught, { timeout: 10_000 }).toBe(2);
    expect(said().match(/dismissed by the person/g)?.length ?? 0).toBeGreaterThanOrEqual(2);

    await quit(app);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
  } finally {
    await cleanUp(launched, scratch);
  }
});

test("Preview a view…", async () => {
  test.setTimeout(120_000);
  const { scratch, userData, env } = scratchDirectories();
  const launched: ElectronApplication[] = [];
  try {
    const { app, window, output } = await launchApp({ ...env, INNYTYPES_E2E_HOOKS: "1" });
    launched.push(app);
    const said = () => output.join("");
    await waitForRunning(window, "runtime");
    // The chooser is a native dialog: the person picks the reorder type in it.
    await app.evaluate(({ dialog }) => {
      Object.assign(dialog, {
        showMessageBox: (options: { readonly buttons?: string[] }) =>
          Promise.resolve({
            response: options.buttons?.indexOf("Reorder (widget kit)") ?? -1,
            checkboxChecked: false,
          }),
      });
    });
    await app.evaluate(({ Menu }) => {
      Menu.getApplicationMenu()?.getMenuItemById("preview-a-view")?.click();
    });
    await expect.poll(() => popoutPages(app).length, { timeout: 15_000 }).toBe(1);
    const p = popoutPages(app)[0] as Page;
    // The real sandbox, on the package's own origin, under the pop-out CSP.
    expect(p.url()).toBe("inny-view://widgetkit/view.html");
    expect(await popoutKeys(app)).toEqual(["preview:widgetkit-reorder"]);
    // Drawn with the type's sample props (its `props` examples), not the node's own list.
    await expect(p.locator('[data-component="question-popout"]')).toContainText(
      "Reorder (widget kit)",
    );
    for (const [n, name] of ["Grace", "Ada", "Linus"].entries()) {
      await expect(p.getByTestId(`reorder-row-${String(n)}`)).toContainText(name);
    }
    await expect(p.getByTestId("view-continue")).toBeDisabled();
    await p.getByTestId("reorder-down-0").click();
    await expect(p.getByTestId("view-continue")).toBeEnabled();
    await p.getByTestId("view-continue").click();
    // The answer it would send is logged; the window closes as a sent one does.
    await expect
      .poll(said, { timeout: 10_000 })
      .toContain('preview:widgetkit-reorder would send {"order":["Ada","Grace","Linus"]}');
    await expect.poll(() => popoutKeys(app), { timeout: 10_000 }).toEqual([]);

    await quit(app);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
  } finally {
    await cleanUp(launched, scratch);
  }
});
