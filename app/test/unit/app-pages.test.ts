// The app pages and the pop-out page (WI-0018-11), through AppApi / the view bridge and
// nothing else, with no DOM: the generic renderer's HTML, each page's drawing and its clicks
// and submissions, the retry of a pop-out while the runtime restarts, and the nav.

import { describe, expect, it } from "vitest";

import { mountApp, PAGES, runtimeLine, type AppDom, type PageName } from "../../src/ui/pages/app";
import { badgeText, inboxListHtml, mountInbox } from "../../src/ui/pages/inbox";
import { jobListHtml, mountJobs } from "../../src/ui/pages/jobs";
import type { PageEvent, Region, Section } from "../../src/ui/pages/page";
import {
  anytypeHtml,
  endpointHtml,
  mountSettings,
  secretStorageHtml,
} from "../../src/ui/pages/settings";
import { mountSnapshots, snapshotListHtml } from "../../src/ui/pages/snapshots";
import type {
  AnytypeStatus,
  AppApi,
  ChildStatus,
  McpEndpointStatus,
  ViewBridge,
  ViewResult,
} from "../../src/ui/contract";
import {
  attributeOf,
  componentElementOf,
  contentHtml,
  formValues,
  resultText,
  viewHtml,
} from "../../src/ui/view/render";
import { mountViewPage, RESTARTING, RETRY_MS, type ViewPage } from "../../src/ui/view/view";

// ── fakes ─────────────────────────────────────────────────────────────────────────────────

const region = (): Region => ({ innerHTML: "" });

class FakeSection implements Section {
  readonly listeners = new Map<string, ((event: PageEvent) => void)[]>();
  on(type: "click" | "submit", listener: (event: PageEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  fire(type: "click" | "submit", target: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ target, preventDefault: () => undefined });
    }
  }
}

/** An element with these attributes (and, for a form, these controls). */
const element = (attributes: Record<string, string>, elements?: unknown[]) => ({
  getAttribute: (name: string) => attributes[name] ?? null,
  ...(elements === undefined ? {} : { elements }),
});

const settle = async (): Promise<void> => {
  for (let n = 0; n < 10; n += 1) {
    await Promise.resolve();
  }
};

const RUNNING: ChildStatus = {
  child: "runtime",
  state: "running",
  generation: 1,
  pid: 5,
  port: 18_800,
  error: null,
};
const ANYTYPE: AnytypeStatus = {
  state: "unreachable",
  detail: "Anytype is not running",
  childPid: null,
  beats: 0,
  pairing: false,
};
const ENDPOINT: McpEndpointStatus = {
  served: "http://127.0.0.1:31010/mcp",
  saved: "http://127.0.0.1:31010/mcp",
  stored: false,
  ignoredVariables: [],
  problem: null,
  warning: "Clients must be updated to the new URL.",
};

/** An AppApi recording what the pages ask, answering from `answers`. */
function fakeApi(overrides: Partial<Record<keyof AppApi, unknown>> = {}) {
  // legacyPackages defaults to empty: most page tests have no old installation to migrate.
  const answers: Partial<Record<keyof AppApi, unknown>> = { legacyPackages: [], ...overrides };
  const calls: unknown[][] = [];
  const listeners = new Map<string, (value: never) => void>();
  const answer = (name: keyof AppApi, ...args: unknown[]): Promise<never> => {
    calls.push([name, ...args]);
    const value = answers[name];
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value as never);
  };
  const api: AppApi = {
    secretStorage: () => answer("secretStorage"),
    childStatus: () => answer("childStatus"),
    onChildStatus: (listener) => listeners.set("childStatus", listener),
    restartChild: (child) => answer("restartChild", child),
    anytypeStatus: () => answer("anytypeStatus"),
    startAnytypePairing: () => answer("startAnytypePairing"),
    completeAnytypePairing: (code) => answer("completeAnytypePairing", code),
    mcpEndpoint: () => answer("mcpEndpoint"),
    moveMcpEndpoint: (host, port) => answer("moveMcpEndpoint", host, port),
    onViewPresented: (listener) => listeners.set("viewPresented", listener),
    onPendingViews: (listener) => listeners.set("pendingViews", listener),
    pendingViews: () => answer("pendingViews"),
    view: (id) => answer("view", id),
    submitView: (id, values) => answer("submitView", id, values),
    snapshot: (id) => answer("snapshot", id),
    pressAction: (id, action, values) => answer("pressAction", id, action, values),
    inbox: () => answer("inbox"),
    onInbox: (listener) => listeners.set("inbox", listener),
    onJobs: (listener) => listeners.set("jobs", listener),
    openView: (id) => answer("openView", id),
    snapshots: () => answer("snapshots"),
    openSnapshot: (id) => answer("openSnapshot", id),
    jobs: () => answer("jobs"),
    cancelJob: (id) => answer("cancelJob", id),
    runList: (query) => answer("runList", query),
    runGet: (runId) => answer("runGet", runId),
    runClearDone: (flowId) => answer("runClearDone", flowId),
    runUndoClear: (flowId) => answer("runUndoClear", flowId),
    onRuns: (listener) => listeners.set("runs", listener),
    flowList: () => answer("flowList"),
    flowTemplates: () => answer("flowTemplates"),
    flowSetOn: (id, on) => answer("flowSetOn", id, on),
    flowRename: (id, name) => answer("flowRename", id, name),
    flowDuplicate: (id, name) => answer("flowDuplicate", id, name),
    flowExport: (id) => answer("flowExport", id),
    flowDelete: (id) => answer("flowDelete", id),
    flowFromTemplate: (templateId, name) => answer("flowFromTemplate", templateId, name),
    flowNodeForm: (flowId, nodeId) => answer("flowNodeForm", flowId, nodeId),
    flowNodeConfigure: (flowId, nodeId, values) =>
      answer("flowNodeConfigure", flowId, nodeId, values),
    onFlows: (listener) => listeners.set("flows", listener),
    quit: () => answer("quit"),
    editorPalette: () => answer("editorPalette"),
    runtimeNodeSets: () => answer("runtimeNodeSets"),
    raiseNodeEvents: (change) => answer("raiseNodeEvents", change),
    eventTypes: () => answer("eventTypes"),
    createEventType: (name, label, schema) => answer("createEventType", name, label, schema),
    versionEventType: (name, schema) => answer("versionEventType", name, schema),
    deleteEventType: (type) => answer("deleteEventType", type),
    fireEvent: (type, values) => answer("fireEvent", type, values),
    onQuitQuestion: (listener) => listeners.set("quitQuestion", listener),
    answerQuit: (choice) => answer("answerQuit", choice),
    packages: () => answer("packages"),
    installFromCatalogue: (id) => answer("installFromCatalogue", id),
    chooseInstallFile: () => answer("chooseInstallFile"),
    installFromFile: (file, confirmed) => answer("installFromFile", file, confirmed),
    removePackage: (name) => answer("removePackage", name),
    checkPackageUpdates: () => answer("checkPackageUpdates"),
    applyPackageUpdate: (name) => answer("applyPackageUpdate", name),
    installFromSource: (source, id, confirmed) =>
      answer("installFromSource", source, id, confirmed),
    registerSource: (name, url, key) => answer("registerSource", name, url, key),
    removeSource: (name) => answer("removeSource", name),
    setSourceAutoUpdate: (name, on) => answer("setSourceAutoUpdate", name, on),
    launchAtLogin: () => answer("launchAtLogin"),
    setLaunchAtLogin: (on) => answer("setLaunchAtLogin", on),
    telemetry: () => answer("telemetry"),
    setTelemetry: (on) => answer("setTelemetry", on),
    legacyPackages: () => answer("legacyPackages"),
    deleteLegacyPackages: () => answer("deleteLegacyPackages"),
  };
  const emit = (name: string, value: unknown): void => {
    (listeners.get(name) as (value: unknown) => void)(value);
  };
  return { api, calls, emit, answers };
}

const VIEW = {
  kind: "view",
  id: "v1",
  content: {
    title: "Name <them>",
    text: "some text",
    fields: { who: "Ada", n: 3 },
    table: { columns: ["a", "b"], rows: [["1", 2], "not a row"] },
    media: [
      { type: "image", src: "data:image/png;base64,AAAA", alt: "a pixel" },
      { type: "image", src: "javascript:alert(1)" },
      { type: "video", src: "clip.png" },
      "not media",
    ],
    anytype: { objectId: "o1", spaceId: "s1" },
    form: {
      type: "object",
      properties: {
        answer: { type: "string", title: "Answer" },
        count: { type: "integer" },
        sure: { type: "boolean" },
        colour: { enum: ["red", "blue"] },
        broken: "not a property",
      },
    },
  },
};

// ── the renderer ──────────────────────────────────────────────────────────────────────────

describe("the generic view renderer", () => {
  it("draws text, fields, a table, media, an Anytype link and the form, all escaped", () => {
    const html = viewHtml(VIEW);
    expect(html).toContain('<h2 data-testid="view-title">Name &lt;them&gt;</h2>');
    expect(html).toContain('<pre data-testid="view-text">some text</pre>');
    expect(html).toContain("<tr><th>who</th><td>Ada</td></tr><tr><th>n</th><td>3</td></tr>");
    expect(html).toContain(
      "<thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody>",
    );
    expect(html.match(/data-testid="view-media"/g)).toHaveLength(1);
    expect(html).not.toContain("javascript:");
    expect(html).toContain(
      'href="anytype://object?objectId=o1&amp;spaceId=s1">Open in Anytype</a>',
    );
    expect(html).toContain('<input type="text" name="answer" data-testid="field-answer">');
    expect(html).toContain(
      '<input type="number" name="count" data-kind="number" data-testid="field-count">',
    );
    expect(html).toContain(
      '<input type="checkbox" name="sure" data-kind="boolean" data-testid="field-sure">',
    );
    expect(html).toContain(
      '<select name="colour" data-testid="field-colour"><option value="red">red</option>',
    );
    expect(html).toContain('data-testid="view-submit"');
    expect(html).toContain('data-dismiss="1"');
  });

  it("leaves out what is not well formed, and says when a view is gone", () => {
    expect(contentHtml("not content")).toBe("");
    expect(contentHtml({ anytype: { objectId: "o 1", spaceId: "s" } })).toBe("");
    expect(contentHtml({ anytype: { objectId: 1 } })).toBe("");
    expect(contentHtml({ media: { type: "image", src: "pic.png" } })).toContain('src="pic.png"');
    expect(contentHtml({ table: { columns: "x", rows: "y" } })).toContain(
      "<thead><tr></tr></thead>",
    );
    expect(contentHtml({ component: { element: "kit-card" } })).toContain('data-slot="component"');
    expect(contentHtml({ anytype: { objectId: "o", spaceId: "s", name: "Doc" } })).toContain(
      ">Doc</a>",
    );
    expect(viewHtml({ kind: "gone", id: "v1" })).toContain('data-testid="view-gone"');
    expect(viewHtml(null)).toContain('data-testid="view-gone"');
  });

  it("draws a snapshot's actions: pressable, or disabled with the reason", () => {
    const html = viewHtml({
      kind: "snapshot",
      content: { title: "t" },
      actions: [
        {
          id: "again",
          label: "Run again",
          enabled: true,
          form: { properties: { why: { type: "string" } } },
        },
        { id: "spare", label: "Spare", enabled: false, reason: 'Nothing is wired to "Spare".' },
        { id: "bare" },
        "not an action",
      ],
    });
    expect(html).toContain('data-form="action" data-action-id="again"');
    expect(html).toContain('data-testid="field-why"');
    expect(html).toContain(
      '<button type="submit" data-testid="action-spare" disabled>Spare</button>',
    );
    expect(html).toContain("Nothing is wired to &quot;Spare&quot;.");
    expect(html).toContain('data-testid="action-bare">bare</button>');
    expect(viewHtml({ kind: "snapshot", content: {} })).toContain(
      'data-testid="view-actions"></div>',
    );
  });

  it("reads a form's values: text, numbers (left out when empty), checkboxes", () => {
    const number = {
      name: "count",
      value: "3",
      getAttribute: (n: string) => (n === "data-kind" ? "number" : null),
    };
    const empty = { ...number, name: "none", value: "" };
    const values = formValues({
      elements: [
        { name: "answer", value: "Ada" },
        number,
        empty,
        { name: "sure", type: "checkbox", checked: true },
        { name: "", value: "no name" },
        { value: "no name either" },
        { name: "blank" },
      ],
    });
    expect(values).toEqual({ answer: "Ada", count: 3, sure: true, blank: "" });
    expect(formValues(null)).toEqual({});
    expect(formValues({})).toEqual({});
  });

  it("names a component's element only when it is a valid custom element name", () => {
    expect(componentElementOf({ content: { component: { element: "kit-card" } } })).toBe(
      "kit-card",
    );
    expect(componentElementOf({ content: { component: { element: "Card" } } })).toBeNull();
    expect(componentElementOf({ content: { title: "t" } })).toBeNull();
    expect(componentElementOf(null)).toBeNull();
    expect(resultText({ ok: true, value: null })).toBe("Sent.");
    expect(resultText({ ok: false, error: "no" })).toBe("no");
    expect(attributeOf(null, "x")).toBeNull();
    expect(attributeOf({ getAttribute: "not a function" }, "x")).toBeNull();
    expect(attributeOf({ getAttribute: () => 7 }, "x")).toBeNull();
  });
});

// ── the pop-out page ──────────────────────────────────────────────────────────────────────

function fakeViewPage() {
  const listeners = new Map<string, (event: PageEvent & { detail?: unknown }) => void>();
  const later: (() => void)[] = [];
  const attached: [string, unknown][] = [];
  const page: ViewPage = {
    root: { innerHTML: "" },
    status: { textContent: null },
    on: (type, listener) => listeners.set(type, listener),
    attach: (name, value) => attached.push([name, value]),
    later: (ms, callback) => {
      expect(ms).toBe(RETRY_MS);
      later.push(callback);
    },
  };
  const fire = (type: string, target: unknown, detail?: unknown): void => {
    listeners.get(type)?.({ target, detail, preventDefault: () => undefined });
  };
  return { page, later, attached, fire };
}

function fakeBridge(gets: ViewResult[]) {
  const sent: unknown[][] = [];
  const bridge: ViewBridge = {
    get: () => Promise.resolve(gets.shift() ?? { ok: false, error: "none left" }),
    submit: (values) => {
      sent.push(["submit", values]);
      return Promise.resolve({ ok: true, value: null });
    },
    action: (id, values) => {
      sent.push(["action", id, values]);
      return values["fail"] === true
        ? Promise.reject(new Error("not a snapshot"))
        : Promise.resolve({ ok: false, error: "refused", status: 409 });
    },
  };
  return { bridge, sent };
}

describe("the pop-out page", () => {
  it("retries get() while the runtime restarts and says so, then draws the view", async () => {
    const { page, later } = fakeViewPage();
    const { bridge } = fakeBridge([
      { ok: false, error: "restarting", code: "restarting" },
      { ok: true, value: VIEW },
    ]);
    await mountViewPage(page, bridge);
    expect(page.status.textContent).toBe(RESTARTING);
    later.shift()?.();
    await settle();
    expect(page.status.textContent).toBe("");
    expect(page.root.innerHTML).toContain("view-title");
  });

  it("submits the form, a dismissal, an action and a component's answer through the bridge", async () => {
    const { page, fire, attached } = fakeViewPage();
    const component = { kind: "view", id: "v1", content: { component: { element: "kit-card" } } };
    const { bridge, sent } = fakeBridge([{ ok: true, value: component }]);
    await mountViewPage(page, bridge);
    expect(attached).toEqual([["kit-card", component]]);
    fire("submit", element({ "data-form": "view" }, [{ name: "answer", value: "Ada" }]));
    fire("click", element({ "data-dismiss": "1" }));
    fire("click", element({}));
    fire("submit", element({ "data-form": "action", "data-action-id": "again" }, []));
    fire(
      "submit",
      element({ "data-form": "action" }, [{ name: "fail", type: "checkbox", checked: true }]),
    );
    fire("inny-submit", null, { answer: "from the component" });
    fire("inny-submit", null, "not an object");
    await settle();
    expect(sent).toEqual([
      ["submit", { answer: "Ada" }],
      ["submit", { __dismiss__: true }],
      ["action", "again", {}],
      ["action", "", { fail: true }],
      ["submit", { answer: "from the component" }],
      ["submit", {}],
    ]);
  });

  it("says what a refused press or a refused call answered", async () => {
    const { page, fire } = fakeViewPage();
    const { bridge } = fakeBridge([{ ok: true, value: VIEW }]);
    await mountViewPage(page, bridge);
    fire("submit", element({ "data-form": "action", "data-action-id": "x" }, []));
    await settle();
    expect(page.status.textContent).toBe("refused");
    fire(
      "submit",
      element({ "data-form": "action" }, [{ name: "fail", type: "checkbox", checked: true }]),
    );
    await settle();
    expect(page.status.textContent).toBe("not a snapshot");
    bridge.submit = () => Promise.reject(new Error("plain"));
    fire("click", element({ "data-dismiss": "1" }));
    await settle();
    expect(page.status.textContent).toBe("plain");
  });
});

// ── the pages ─────────────────────────────────────────────────────────────────────────────

describe("the Inbox page", () => {
  it("lists the views with the badge; opens one here, or in its window; submits and dismisses", async () => {
    const { api, calls, emit, answers } = fakeApi({
      inbox: [{ id: "v1", title: "", window: "inline" }],
      pendingViews: 1,
      view: { ok: true, value: VIEW },
      submitView: { ok: true, value: null },
    });
    const page = {
      section: new FakeSection(),
      list: region(),
      detail: region(),
      message: region(),
      badge: region(),
    };
    await mountInbox(page, api);
    expect(page.list.innerHTML).toContain("(untitled)");
    expect(page.badge.innerHTML).toBe("1");
    emit("inbox", []);
    expect(page.list.innerHTML).toContain('data-testid="inbox-empty"');
    emit("pendingViews", 0);
    expect(page.badge.innerHTML).toBe("");

    page.section.fire("submit", element({ "data-form": "view" }, [])); // nothing open yet
    page.section.fire("click", element({ "data-open": "v1" }));
    await settle();
    expect(page.detail.innerHTML).toContain("view-title");
    page.section.fire("click", element({ "data-popout": "v1" }));
    page.section.fire("submit", element({ "data-form": "other" }, []));
    page.section.fire(
      "submit",
      element({ "data-form": "view" }, [{ name: "answer", value: "Ada" }]),
    );
    await settle();
    expect(page.message.innerHTML).toBe("Sent.");
    expect(page.detail.innerHTML).toBe("");

    answers.view = { ok: false, error: "the InnyTypes runtime is down" };
    answers.submitView = { ok: false, error: "This view is no longer waiting." };
    page.section.fire("click", element({ "data-open": "v1" }));
    await settle();
    expect(page.message.innerHTML).toBe("the InnyTypes runtime is down");
    page.section.fire("click", element({ "data-dismiss": "1" }));
    page.section.fire("click", element({}));
    await settle();
    expect(page.message.innerHTML).toBe("This view is no longer waiting.");
    expect(calls.filter((call) => call[0] === "openView")).toEqual([["openView", "v1"]]);
    expect(calls.filter((call) => call[0] === "submitView")).toEqual([
      ["submitView", "v1", { answer: "Ada" }],
      ["submitView", "v1", { __dismiss__: true }],
    ]);
    expect(inboxListHtml([{ id: "a<", title: "T&", window: "popout" }])).toContain(
      'data-id="a&lt;"',
    );
    expect(badgeText(null)).toBe("");
  });
});

describe("the Snapshots page", () => {
  it("lists newest first, opens one here or in its window, and presses an action", async () => {
    const { api, calls, answers } = fakeApi({
      snapshots: {
        ok: true,
        value: [{ id: "s1", instanceId: "rec", label: "Rec", title: "T", time: 0 }],
      },
      snapshot: {
        ok: true,
        value: {
          kind: "snapshot",
          content: { title: "t" },
          actions: [{ id: "again", label: "Run again", enabled: true }],
        },
      },
      pressAction: { ok: true, value: null },
    });
    const page = {
      section: new FakeSection(),
      list: region(),
      detail: region(),
      message: region(),
    };
    const refresh = mountSnapshots(page, api);
    await refresh();
    expect(page.list.innerHTML).toContain('data-testid="snapshot-item" data-id="s1"');
    expect(page.list.innerHTML).toContain("1970-01-01T00:00:00.000Z");
    page.section.fire("submit", element({ "data-action-id": "again" }, [])); // nothing open yet
    page.section.fire("click", element({ "data-open": "s1" }));
    await settle();
    expect(page.detail.innerHTML).toContain('data-testid="action-again"');
    page.section.fire(
      "submit",
      element({ "data-action-id": "again" }, [{ name: "why", value: "x" }]),
    );
    await settle();
    expect(page.message.innerHTML).toBe("Started a new run.");
    answers.pressAction = { ok: false, error: "No.", status: 409 };
    page.section.fire("submit", element({ "data-action-id": "again" }, []));
    await settle();
    expect(page.message.innerHTML).toBe("No.");
    page.section.fire("click", element({ "data-popout": "s1" }));
    page.section.fire("click", element({ "data-refresh": "1" }));
    page.section.fire("click", element({}));
    answers.snapshots = { ok: false, error: "the InnyTypes runtime is down", code: "down" };
    answers.snapshot = { ok: false, error: "down" };
    await refresh();
    expect(page.message.innerHTML).toContain("cannot answer now (the InnyTypes runtime is down)");
    page.section.fire("click", element({ "data-open": "s1" }));
    await settle();
    expect(page.detail.innerHTML).toBe("");
    expect(calls.filter((call) => call[0] === "openSnapshot")).toEqual([["openSnapshot", "s1"]]);
    expect(snapshotListHtml([])).toContain("snapshots-empty");
  });
});

describe("the Jobs page", () => {
  it("lists the jobs, cancels one, and says when the runtime cannot answer", async () => {
    const job = {
      id: "in-1",
      instanceId: "slow",
      type: "inny-kit-slow",
      attempts: 1,
      createdAt: 0,
    };
    const { api, calls, answers } = fakeApi({
      jobs: { ok: true, value: [job] },
      cancelJob: { ok: true, value: null },
    });
    const page = { section: new FakeSection(), list: region(), message: region() };
    const refresh = mountJobs(page, api);
    await refresh();
    expect(page.list.innerHTML).toContain('data-cancel="in-1"');
    page.section.fire("click", element({ "data-cancel": "in-1" }));
    await settle();
    expect(page.message.innerHTML).toBe("Cancel sent.");
    answers.cancelJob = { ok: false, error: "This job is no longer running." };
    page.section.fire("click", element({ "data-cancel": "in-1" }));
    await settle();
    expect(page.message.innerHTML).toBe("This job is no longer running.");
    answers.jobs = { ok: false, error: "down" };
    page.section.fire("click", element({ "data-refresh": "1" }));
    page.section.fire("click", element({}));
    await settle();
    expect(page.message.innerHTML).toContain("cannot answer now");
    expect(calls.filter((call) => call[0] === "cancelJob")).toHaveLength(2);
    expect(jobListHtml([])).toContain("jobs-empty");
  });
});

describe("the Settings page", () => {
  it("shows the launch-at-login switch, moves it, and says why the OS refused", async () => {
    const { api, calls, answers } = fakeApi({
      secretStorage: { backend: "keychain", reason: null },
      mcpEndpoint: ENDPOINT,
      anytypeStatus: ANYTYPE,
      launchAtLogin: { on: false, problem: null },
      setLaunchAtLogin: { on: true, problem: null },
    });
    const page = {
      section: new FakeSection(),
      secrets: region(),
      endpoint: region(),
      anytype: region(),
      login: region(),
      legacy: region(),
      message: region(),
    };
    await mountSettings(page, api)();
    expect(page.login.innerHTML).toContain('data-testid="settings-login-state">off</span>');
    expect(page.login.innerHTML).toContain('data-login="on"');
    page.section.fire("click", element({ "data-login": "on" }));
    await settle();
    expect(page.login.innerHTML).toContain('data-testid="settings-login-state">on</span>');
    expect(page.login.innerHTML).toContain('data-login="off"');
    answers.setLaunchAtLogin = { on: true, problem: "the <OS> still starts it" };
    page.section.fire("click", element({ "data-login": "off" }));
    await settle();
    expect(page.login.innerHTML).toContain(
      'data-testid="settings-login-problem">the &lt;OS&gt; still starts it</p>',
    );
    expect(calls.filter((call) => call[0] === "setLaunchAtLogin")).toEqual([
      ["setLaunchAtLogin", true],
      ["setLaunchAtLogin", false],
    ]);
  });

  it("shows the secret storage, the endpoint and Anytype, moves the endpoint, and pairs", async () => {
    const { api, calls, answers } = fakeApi({
      secretStorage: { backend: "file", reason: "no keyring" },
      mcpEndpoint: ENDPOINT,
      anytypeStatus: ANYTYPE,
      moveMcpEndpoint: { ...ENDPOINT, problem: "the <port> is taken" },
      startAnytypePairing: { ...ANYTYPE, pairing: true },
      completeAnytypePairing: { ...ANYTYPE, state: "ready", detail: null },
      launchAtLogin: { on: false, problem: null },
    });
    const page = {
      section: new FakeSection(),
      secrets: region(),
      endpoint: region(),
      anytype: region(),
      login: region(),
      legacy: region(),
      message: region(),
    };
    const refresh = mountSettings(page, api);
    await refresh();
    expect(page.secrets.innerHTML).toContain("files only this account can read (no keyring)");
    expect(page.endpoint.innerHTML).toContain("http://127.0.0.1:31010/mcp");
    expect(page.anytype.innerHTML).toContain(": Anytype is not running");
    page.section.fire(
      "submit",
      element({ "data-form": "endpoint" }, [
        { name: "host", value: "127.0.0.1" },
        {
          name: "port",
          value: "31011",
          getAttribute: (n: string) => (n === "data-kind" ? "number" : null),
        },
      ]),
    );
    page.section.fire("submit", element({ "data-form": "endpoint" }, []));
    await settle();
    expect(page.endpoint.innerHTML).toContain("the &lt;port&gt; is taken");
    page.section.fire("click", element({ "data-pair": "1" }));
    page.section.fire("click", element({}));
    await settle();
    expect(page.anytype.innerHTML).toContain('data-testid="settings-anytype-code"');
    page.section.fire(
      "submit",
      element({ "data-form": "pair-code" }, [{ name: "code", value: "1234" }]),
    );
    page.section.fire("submit", element({ "data-form": "pair-code" }, []));
    page.section.fire("submit", element({ "data-form": "other" }, []));
    await settle();
    expect(page.anytype.innerHTML).toContain(">ready</span>");
    answers.mcpEndpoint = new Error("the services process is restarting");
    await refresh();
    expect(page.message.innerHTML).toBe("the services process is restarting");
    expect(calls).toContainEqual(["moveMcpEndpoint", "127.0.0.1", 31011]);
    expect(calls).toContainEqual(["moveMcpEndpoint", "", Number.NaN]);
    expect(calls).toContainEqual(["completeAnytypePairing", "1234"]);
    expect(calls).toContainEqual(["completeAnytypePairing", ""]);
    expect(secretStorageHtml({ backend: "keychain", reason: null })).toContain(
      "the system keychain.",
    );
    expect(endpointHtml({ ...ENDPOINT, served: null, saved: null })).toContain(">nothing</code>");
    expect(anytypeHtml({ ...ANYTYPE, detail: null })).toContain("unreachable</span></p>");
  });

  it("lists the old installation's plugin environments, and deletes them only on the press", async () => {
    const { api, calls } = fakeApi({
      secretStorage: { backend: "keychain", reason: null },
      mcpEndpoint: ENDPOINT,
      anytypeStatus: ANYTYPE,
      launchAtLogin: { on: false, problem: null },
      legacyPackages: ["monty", "innyrize"],
      deleteLegacyPackages: ["monty", "innyrize"],
    });
    const page = {
      section: new FakeSection(),
      secrets: region(),
      endpoint: region(),
      anytype: region(),
      login: region(),
      legacy: region(),
      message: region(),
    };
    await mountSettings(page, api)();
    expect(page.legacy.innerHTML).toContain("monty");
    expect(page.legacy.innerHTML).toContain("innyrize");
    expect(page.legacy.innerHTML).toContain('data-testid="settings-legacy-delete"');
    expect(calls).not.toContainEqual(["deleteLegacyPackages"]);
    page.section.fire("click", element({ "data-legacy-delete": "1" }));
    await settle();
    expect(calls).toContainEqual(["deleteLegacyPackages"]);
    expect(page.legacy.innerHTML).toBe("");
  });

  it("shows nothing when there is no old installation to migrate", async () => {
    const { api } = fakeApi({
      secretStorage: { backend: "keychain", reason: null },
      mcpEndpoint: ENDPOINT,
      anytypeStatus: ANYTYPE,
      launchAtLogin: { on: false, problem: null },
    });
    const page = {
      section: new FakeSection(),
      secrets: region(),
      endpoint: region(),
      anytype: region(),
      login: region(),
      legacy: region(),
      message: region(),
    };
    await mountSettings(page, api)();
    expect(page.legacy.innerHTML).toBe("");
  });
});

describe("the app", () => {
  it("mounts every page, shows one at a time from the nav, and asks again when the runtime is back", async () => {
    const { api, calls, emit } = fakeApi({
      childStatus: [RUNNING],
      inbox: [],
      pendingViews: null,
      snapshots: { ok: true, value: [] },
      jobs: { ok: true, value: [] },
      secretStorage: { backend: "keychain", reason: null },
      mcpEndpoint: ENDPOINT,
      anytypeStatus: ANYTYPE,
      packages: {
        packages: [],
        catalogue: [],
        catalogueProblem: null,
        sources: [],
        sourcesProblem: null,
        checkedAt: null,
      },
    });
    const sections = new Map(PAGES.map((name) => [name, { hidden: false }]));
    const nav = new FakeSection();
    const lines = [region(), region()];
    const dom: AppDom = {
      nav,
      sections,
      status: { innerHTML: "", addEventListener: () => undefined },
      editor: { src: "", hidden: true },
      runtimeLines: lines,
      inbox: {
        section: new FakeSection(),
        list: region(),
        detail: region(),
        message: region(),
        badge: region(),
      },
      snapshots: {
        section: new FakeSection(),
        list: region(),
        detail: region(),
        message: region(),
      },
      jobs: { section: new FakeSection(), list: region(), message: region() },
      settings: {
        section: new FakeSection(),
        secrets: region(),
        endpoint: region(),
        anytype: region(),
        login: region(),
        legacy: region(),
        message: region(),
      },
      packages: {
        section: new FakeSection(),
        list: region(),
        catalogue: region(),
        sources: region(),
        question: region(),
        message: region(),
      },
    };
    const show = await mountApp(dom, api);
    const visible = (): PageName[] => [...sections].filter(([, s]) => !s.hidden).map(([n]) => n);
    expect(visible()).toEqual(["editor"]);
    expect(dom.editor?.src).toBe("http://127.0.0.1:18800/red/");
    expect(lines[0]?.innerHTML).toBe(runtimeLine(RUNNING));
    for (const name of PAGES) {
      nav.fire("click", element({ "data-page": name }));
      await settle();
      expect(visible()).toEqual([name]);
    }
    nav.fire("click", element({ "data-page": "nowhere" }));
    nav.fire("click", element({}));
    await show("jobs");
    const asked = () => calls.filter((call) => call[0] === "jobs").length;
    const before = asked();
    emit("childStatus", { ...RUNNING, state: "down" });
    emit("childStatus", RUNNING);
    await settle();
    expect(asked()).toBe(before + 1);
    expect(lines[1]?.innerHTML).toContain('data-state="running"');
  });
});

describe("the Settings page: the endpoint and Anytype, as the old panel's rules had them", () => {
  const settings = (answers: Partial<Record<keyof AppApi, unknown>>) => {
    const { api } = fakeApi({
      secretStorage: { backend: "keychain", reason: null },
      mcpEndpoint: ENDPOINT,
      anytypeStatus: ANYTYPE,
      ...answers,
    });
    const page = {
      section: new FakeSection(),
      secrets: region(),
      endpoint: region(),
      anytype: region(),
      login: region(),
      legacy: region(),
      message: region(),
    };
    return { page, refresh: mountSettings(page, api) };
  };
  const move = (page: { section: FakeSection }, host: string, port: string): void => {
    const number = { name: "port", value: port, getAttribute: () => "number" };
    page.section.fire(
      "submit",
      element({ "data-form": "endpoint" }, [{ name: "host", value: host }, number]),
    );
  };

  it("offers the endpoint as a text field and a number field, with one Move", () => {
    const html = endpointHtml(ENDPOINT);
    expect(html).toContain('<input type="text" name="host"');
    expect(html).toContain('<input type="number" name="port" min="1" max="65535" step="1"');
    expect(html.match(/type="submit"/g)).toHaveLength(1);
  });

  it("says the saved address beside the served one only when they differ", () => {
    expect(endpointHtml(ENDPOINT)).not.toContain("settings-mcp-saved");
    const differ = endpointHtml({ ...ENDPOINT, saved: "http://127.0.0.1:31011/mcp" });
    expect(differ).toContain('data-testid="settings-mcp-saved">http://127.0.0.1:31011/mcp');
  });

  it("names the variable a stored value is beating, and says nothing when none is ignored", () => {
    expect(endpointHtml(ENDPOINT)).not.toContain("settings-mcp-ignored");
    expect(endpointHtml({ ...ENDPOINT, ignoredVariables: ["INNYTYPES_MCP_PORT"] })).toContain(
      "INNYTYPES_MCP_PORT is set and ignored",
    );
    expect(
      endpointHtml({ ...ENDPOINT, ignoredVariables: ["INNYTYPES_MCP_HOST", "INNYTYPES_MCP_PORT"] }),
    ).toContain("INNYTYPES_MCP_HOST and INNYTYPES_MCP_PORT are set and ignored");
  });

  it("still says why nothing is served, with the fields to fix it beside it", () => {
    const html = endpointHtml({
      ...ENDPOINT,
      served: null,
      problem: "Another program is answering at http://127.0.0.1:1/mcp",
    });
    expect(html).toContain('data-testid="settings-mcp-problem">Another program is answering');
    expect(html).toContain('data-testid="settings-mcp-host"');
  });

  it("says clients must be updated only after a move that changed the URL", async () => {
    const moved = {
      ...ENDPOINT,
      served: "http://127.0.0.1:31011/mcp",
      saved: "http://127.0.0.1:31011/mcp",
    };
    const { page, refresh } = settings({ moveMcpEndpoint: moved });
    await refresh();
    expect(page.endpoint.innerHTML).not.toContain("settings-mcp-warning");
    move(page, "127.0.0.1", "31011");
    await settle();
    expect(page.endpoint.innerHTML).toContain("Clients must be updated to the new URL.");
    expect(page.endpoint.innerHTML).toContain("http://127.0.0.1:31011/mcp");
    move(page, "127.0.0.1", "31011"); // the address already served: moved nothing, says no more
    await settle();
    expect(page.endpoint.innerHTML).not.toContain("settings-mcp-warning");
  });

  it("shows a refused move's reason, and keeps the endpoint it had on the page", async () => {
    const { page, refresh } = settings({
      moveMcpEndpoint: new Error("0.0.0.0 must be loopback: only 127.0.0.1 and ::1 can be served"),
    });
    await refresh();
    const before = page.endpoint.innerHTML;
    move(page, "0.0.0.0", "31010");
    await settle();
    expect(page.message.innerHTML).toBe(
      "0.0.0.0 must be loopback: only 127.0.0.1 and ::1 can be served",
    );
    expect(page.endpoint.innerHTML).toBe(before);
  });

  it("says a key is missing without carrying one: the status it draws has no key in it", async () => {
    const noKey: AnytypeStatus = {
      ...ANYTYPE,
      state: "no-key",
      detail: "No Anytype API key is configured.",
    };
    const { page, refresh } = settings({ anytypeStatus: noKey });
    await refresh();
    expect(page.anytype.innerHTML).toContain(">no-key</span>: No Anytype API key is configured.");
    expect(page.anytype.innerHTML).toContain('data-testid="settings-anytype-pair"');
    expect(Object.keys(noKey).sort()).toEqual(["beats", "childPid", "detail", "pairing", "state"]);
  });
});

describe("the app: Quit", () => {
  it("is on the window above every page, and runs the one quit", async () => {
    const { api, calls } = fakeApi({
      childStatus: [RUNNING],
      inbox: [],
      pendingViews: null,
      snapshots: { ok: true, value: [] },
      jobs: { ok: true, value: [] },
      secretStorage: { backend: "keychain", reason: null },
      mcpEndpoint: ENDPOINT,
      anytypeStatus: ANYTYPE,
    });
    const nav = new FakeSection();
    await mountApp(
      {
        nav,
        sections: new Map(PAGES.map((name) => [name, { hidden: false }])),
        status: { innerHTML: "", addEventListener: () => undefined },
        runtimeLines: [],
        inbox: {
          section: new FakeSection(),
          list: region(),
          detail: region(),
          message: region(),
          badge: region(),
        },
        snapshots: {
          section: new FakeSection(),
          list: region(),
          detail: region(),
          message: region(),
        },
        jobs: { section: new FakeSection(), list: region(), message: region() },
        settings: {
          section: new FakeSection(),
          secrets: region(),
          endpoint: region(),
          anytype: region(),
          login: region(),
          legacy: region(),
          message: region(),
        },
        packages: {
          section: new FakeSection(),
          list: region(),
          catalogue: region(),
          sources: region(),
          question: region(),
          message: region(),
        },
      },
      api,
    );
    nav.fire("click", element({ "data-quit": "1" }));
    expect(calls.filter((call) => call[0] === "quit")).toEqual([["quit"]]);
  });
});

describe("the app: the Jobs page follows the jobs", () => {
  it("asks for the list again when the jobs change, only while the Jobs page is shown", async () => {
    const { api, calls, emit } = fakeApi({
      childStatus: [RUNNING],
      inbox: [],
      pendingViews: null,
      snapshots: { ok: true, value: [] },
      jobs: { ok: true, value: [] },
      secretStorage: { backend: "keychain", reason: null },
      mcpEndpoint: ENDPOINT,
      anytypeStatus: ANYTYPE,
    });
    const jobsList = region();
    const show = await mountApp(
      {
        nav: new FakeSection(),
        sections: new Map(PAGES.map((name) => [name, { hidden: false }])),
        status: { innerHTML: "", addEventListener: () => undefined },
        runtimeLines: [],
        inbox: {
          section: new FakeSection(),
          list: region(),
          detail: region(),
          message: region(),
          badge: region(),
        },
        snapshots: {
          section: new FakeSection(),
          list: region(),
          detail: region(),
          message: region(),
        },
        jobs: { section: new FakeSection(), list: jobsList, message: region() },
        settings: {
          section: new FakeSection(),
          secrets: region(),
          endpoint: region(),
          anytype: region(),
          login: region(),
          legacy: region(),
          message: region(),
        },
        packages: {
          section: new FakeSection(),
          list: region(),
          catalogue: region(),
          sources: region(),
          question: region(),
          message: region(),
        },
      },
      api,
    );
    const asked = () => calls.filter((call) => call[0] === "jobs").length;
    emit("jobs", undefined); // the editor is shown: nobody is looking at the jobs
    await settle();
    expect(asked()).toBe(0);
    await show("jobs");
    expect(asked()).toBe(1);
    emit("jobs", undefined);
    await settle();
    expect(asked()).toBe(2);
    expect(jobsList.innerHTML).toContain("jobs-empty");
  });
});
