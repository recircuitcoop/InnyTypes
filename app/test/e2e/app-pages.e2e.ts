// The app pages and the pop-outs (WI-0018-11), in the real app: pages served by the shell on
// inny-app://, alive through a runtime kill -9 and while the runtime is down for good; the
// Inbox with its badge and notice; cancel from Jobs; pop-outs on inny-view:// in the
// inny-views partition, with the exact webPreferences, CSP and id-less bridge of spec 8.5,
// every P10f probe run from inside a live pop-out AND from inside a third-party component;
// two at once; closing without submitting; placement remembered; a restart re-presenting
// quietly, opening nothing.
import fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import {
  assertHermetic,
  cleanUp,
  exitOf,
  launchApp,
  processesNaming,
  quit,
  scratchDirectories,
  waitForRunning,
} from "./app-harness";

/** Spec 8.5.5, exactly. */
const VIEW_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "connect-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'";

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

const PAGES = ["editor", "inbox", "snapshots", "events", "jobs", "packages", "settings"];

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

/** Show a page from the nav, and see that it is the one shown. */
async function go(window: Page, name: string): Promise<void> {
  await window.getByTestId(`nav-${name}`).click();
  await expect(window.getByTestId(`page-${name}`)).toBeVisible();
}

/** The pop-out pages open now. */
const popoutPages = (app: ElectronApplication): Page[] =>
  app.windows().filter((page) => page.url().startsWith("inny-view://"));

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
    innyKeys: ["action", "get", "submit"],
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

test("every page is reachable, served by the shell on inny-app://, says what it is for, and Quit in the window turns everything off", async () => {
  test.setTimeout(90_000);
  const { scratch, userData, env } = scratchDirectories();
  const launched: ElectronApplication[] = [];
  try {
    const { app, window } = await launchApp(env);
    launched.push(app);
    await waitForRunning(window, "runtime");
    await waitForRunning(window, "services");
    expect(window.url()).toBe("inny-app://app/index.html");
    // The editor is the first page, in its frame on the runtime's port.
    await expect(window.getByTestId("page-editor")).toBeVisible();
    await expect(window.getByTestId("editor")).toBeVisible();
    for (const name of PAGES) {
      await go(window, name);
      await expect(window.getByTestId(`page-${name}`)).toBeVisible();
      for (const other of PAGES.filter((page) => page !== name)) {
        await expect(window.getByTestId(`page-${other}`)).toBeHidden();
      }
      // The children's state is above every page (spec 10.8 childState).
      await expect(window.getByTestId("child-state-runtime")).toHaveText("running");
    }
    await go(window, "inbox");
    await expect(window.getByTestId("inbox-empty")).toBeVisible();
    await go(window, "snapshots");
    await expect(window.getByTestId("snapshots-empty")).toBeVisible();
    await go(window, "jobs");
    await expect(window.getByTestId("jobs-empty")).toBeVisible();
    await go(window, "events");
    await expect(window.getByTestId("events-empty")).toBeVisible();
    await go(window, "packages");
    // The shipped Anytype package, and no catalogue in a build that configures none.
    await expect(
      window.locator('[data-testid="package-item"][data-name="anytype"]'),
    ).toHaveAttribute("data-kind", "shipped");
    await expect(window.getByTestId("catalogue-problem")).toBeVisible();
    await go(window, "settings");
    await expect(window.getByTestId("settings-secret-storage")).toBeVisible();
    await expect(window.getByTestId("settings-mcp-saved")).toHaveText(
      `http://127.0.0.1:${env["INNYTYPES_MCP_PORT"] ?? ""}/mcp`,
    );
    await expect(window.getByTestId("settings-anytype-state")).not.toBeEmpty();
    await expect(window.getByTestId("page-editor")).toBeHidden();

    // Quit is on the window, above every page, and it is the one quit: nothing is left.
    const exited = exitOf(app);
    await window.getByTestId("quit").click();
    await exited;
    assertHermetic(app);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
  } finally {
    await cleanUp(launched, scratch);
  }
});

test("the pages stay alive through a runtime kill -9 and while it is down for good, the Inbox keeps its last contents, and Jobs cancels", async () => {
  test.setTimeout(150_000);
  const { scratch, userData, env } = scratchDirectories();
  const launched: ElectronApplication[] = [];
  try {
    const { app, window, output } = await launchApp({ ...env, INNYTYPES_E2E_HOOKS: "1" });
    launched.push(app);
    const said = () => output.join("");
    let runtime = await waitForRunning(window, "runtime");
    const port = Number(runtime.port);
    expect(await request(port, "POST", "/red/flows", flow(port))).toBe(204);
    await expect.poll(said, { timeout: 20_000 }).toMatch(/\[inny-popoutkit-slow slow\] ready/);

    // ── the Inbox: an inline view is listed with the badge, and a notice on first presentation
    expect(await request(port, "POST", "/red/inject/go-i")).toBe(200);
    await go(window, "inbox");
    await expect(window.getByTestId("inbox-item")).toHaveCount(1);
    await expect(window.getByTestId("inbox-badge")).toHaveText("1");
    await expect.poll(said).toMatch(/notice: InnyTypes is waiting for you: Answer the pop-out kit/);
    expect(await popoutKeys(app)).toEqual([]); // an inline view opens no window

    // ── cancel from Jobs ────────────────────────────────────────────────────────────────
    expect(await request(port, "POST", "/red/inject/go-slow")).toBe(200);
    await go(window, "jobs");
    await expect
      .poll(async () => {
        await window.getByTestId("jobs-refresh").click();
        return window.getByTestId("job-item").count();
      })
      .toBe(1);
    await expect(window.getByTestId("job-item")).toContainText("inny-popoutkit-slow");
    await window.getByTestId("job-cancel").click();
    await expect(window.getByTestId("jobs-message")).toHaveText("Cancel sent.");
    await expect
      .poll(said, { timeout: 10_000 })
      .toMatch(/\[debug:caught\][\s\S]{0,200}cancelled after \d+s/);
    await expect(window.getByTestId("jobs-empty")).toBeVisible();

    // ── kill -9, and the page reloaded at once: it is the shell's, so it comes back whole ─
    process.kill(runtime.pid, "SIGKILL");
    await window.reload();
    await expect(window.getByTestId("shell-ready")).toBeVisible();
    expect(window.url()).toBe("inny-app://app/index.html");
    await go(window, "inbox");
    await expect(window.getByTestId("inbox-item")).toHaveCount(1);
    runtime = await waitForRunning(window, "runtime", runtime.generation + 1);

    // ── down for good (the crash-loop limit, five in two minutes, the kill above the first)
    for (let crash = 2; crash <= 5; crash++) {
      process.kill(runtime.pid, "SIGKILL");
      if (crash < 5) {
        runtime = await waitForRunning(window, "runtime", runtime.generation + 1);
      }
    }
    await expect(window.getByTestId("child-state-runtime")).toHaveText("stopped");
    await window.reload();
    await expect(window.getByTestId("child-state-runtime")).toHaveText("stopped");
    for (const name of PAGES) {
      await go(window, name);
      await expect(window.getByTestId(`page-${name}`)).toBeVisible();
    }
    await go(window, "inbox");
    await expect(window.getByTestId("inbox-item")).toHaveCount(1); // its last contents
    await expect(window.getByTestId("runtime-state").first()).toHaveAttribute(
      "data-state",
      "down-for-good",
    );
    await window.getByTestId("inbox-open").click();
    await expect(window.getByTestId("inbox-message")).not.toBeEmpty();
    await go(window, "jobs");
    await expect(window.getByTestId("jobs-message")).toContainText("cannot answer now");
    await go(window, "settings");
    await expect(window.getByTestId("settings-secret-storage")).toBeVisible();
    await expect(window.getByTestId("settings-mcp-saved")).not.toHaveText("nothing");

    // ── Restart: the pages ask again ────────────────────────────────────────────────────
    await window.getByTestId("child-restart-runtime").click();
    await waitForRunning(window, "runtime", runtime.generation + 1);
    await go(window, "inbox");
    await window.getByTestId("inbox-open").click();
    await expect(window.getByTestId("view-title")).toHaveText("Answer the pop-out kit");
    await window.getByTestId("field-answer").fill("inline");
    await window.getByTestId("view-submit").click();
    await expect(window.getByTestId("inbox-message")).toHaveText("Sent.");
    await expect
      .poll(said, { timeout: 10_000 })
      .toMatch(/\[debug:answered\] \n?\{ answer: 'inline', sure: false \}/);
    await expect(window.getByTestId("inbox-empty")).toBeVisible();
    await expect(window.getByTestId("inbox-badge")).toHaveText("");

    await quit(app);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
  } finally {
    await cleanUp(launched, scratch);
  }
});

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
        "inny-view://popoutkit/view.html",
        "inny-view://popoutkit/component.js",
      ]) {
        csp[url] = (await views.fetch(url)).headers.get("content-security-policy");
      }
      return csp;
    });
    expect(Object.values(headers)).toEqual([VIEW_CSP, VIEW_CSP, VIEW_CSP, VIEW_CSP]);

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
    await a.getByTestId("view-submit").click();
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
    const pending = await window.evaluate(
      (id) =>
        (
          window as unknown as { inny: { app: { view(id: string): Promise<unknown> } } }
        ).inny.app.view(id),
      idB,
    );
    expect(pending).toMatchObject({ ok: true, value: { kind: "view", id: idB } });
    expect(said()).not.toMatch(/dismissed by the person/);
    expect(said()).not.toMatch(/\[debug:caught\]/);
    const remembered = JSON.parse(
      fs.readFileSync(path.join(userData, "popout-placements.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(remembered["view:inny-popoutkit-ask"]).toEqual(placed);

    // ── "Open in window" from the Inbox re-opens it where its type was left ─────────────
    await go(window, "inbox");
    await expect(window.getByTestId("inbox-item")).toHaveCount(1);
    await expect(window.getByTestId("inbox-badge")).toHaveText("1");
    await window.getByTestId("inbox-popout").click();
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

    // ── a snapshot in a pop-out, only when asked; its bridge refuses a submit ───────────
    expect(await request(port, "POST", "/red/inject/go-rec")).toBe(200);
    await expect
      .poll(said, { timeout: 10_000 })
      .toMatch(/snapshot (\S+) recorded from \[inny-popoutkit-record rec\]/);
    const snapshotId = /snapshot (\S+) recorded from \[inny-popoutkit-record rec\]/.exec(
      said(),
    )?.[1] as string;
    await go(window, "snapshots");
    await expect(window.getByTestId("snapshot-item")).toHaveCount(1);
    expect((await popoutKeys(app)).some((key) => key.startsWith("snapshot:"))).toBe(false);
    await window.getByTestId("snapshot-popout").click();
    await expect.poll(() => popoutKeys(app)).toContain(`snapshot:${snapshotId}`);
    const s = await popoutFor(app, snapshotId);
    await s.getByTestId("field-why").fill("again, please");
    await s.getByTestId("action-again").click();
    await expect(s.getByTestId("view-status")).toHaveText("Sent.");
    await expect
      .poll(said, { timeout: 10_000 })
      .toMatch(/\[debug:again\] \n?\{ state: \{ n: 4 \}, values: \{ why: 'again, please' \} \}/);
    const refused = await s.evaluate(async () => {
      try {
        await (window as unknown as { inny: { submit(v: object): Promise<unknown> } }).inny.submit(
          {},
        );
        return "allowed";
      } catch (error) {
        return (error as Error).message;
      }
    });
    expect(refused).toMatch(/not an action view/);
    await s.close();

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
