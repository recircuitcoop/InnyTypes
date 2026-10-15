// ui/general.ts (plan 0022 §M, ux-writing "Configuration › General"): each section's one-line
// state, the address AI apps are told, the setup a client is given, a refused move in words, and
// retention's five choices (D8). No DOM: the screen only draws these.
import { describe, expect, it } from "vitest";
import type { AnytypeStatus, FlowSummary, McpEndpointStatus } from "../../src/ui/contract";
import {
  aiAppsLine,
  anytypeLine,
  clientSetup,
  codeParts,
  FOLDER_SOURCE_TYPE,
  folderName,
  folderSteps,
  recorderLine,
  moveRefusal,
  nameParts,
  PACKAGE_ACTIONS,
  packagesLine,
  reportsLine,
  RETENTION_OPTIONS,
  retentionDays,
  retentionLine,
  retentionValue,
  servedAddress,
  servedHost,
  servedPort,
  withoutMarks,
} from "../../src/ui/general";
import type { PackagesView } from "../../src/ui/general-contract";
import { wordChecked } from "../../src/ui/words";
import { checkedAddress } from "../../src/domain/endpoint/address";
import {
  INSTALLATION_STATES,
  PACKAGE_UPDATE_STATES,
  rowActions,
  type Installation,
  type Package,
  type PackageUpdate,
} from "../../src/domain/packages/states";
import type { AppApiV2 } from "../../src/ui/app-api-v2";
import { STRINGS } from "../../src/ui/strings";

const anytype = (state: AnytypeStatus["state"]): AnytypeStatus => ({
  state,
  detail: "added=[API-x] differ from the committed surface",
  childPid: 4242,
  beats: 3,
  pairing: false,
});

const spaces = (n: number) => ({
  ok: true as const,
  value: { options: Array.from({ length: n }, (_, i) => ({ value: `s${String(i)}`, label: "S" })) },
});

const endpoint = (served: string | null): McpEndpointStatus => ({
  served,
  saved: served,
  stored: false,
  ignoredVariables: [],
  problem: null,
  warning: "clients must be updated",
});

describe("the Anytype section's state line", () => {
  it("says Connected · n spaces once paired and Not paired yet. before, with Pair or Pair again", () => {
    expect(anytypeLine(anytype("ready"), spaces(8))).toEqual({
      line: "Connected · 8 spaces",
      paired: true,
    });
    expect(anytypeLine(anytype("ready"), spaces(1)).line).toBe("Connected · 1 space");
    expect(anytypeLine(anytype("no-key"), null)).toEqual({
      line: STRINGS["general.anytype.notPaired"],
      paired: false,
    });
  });

  it("names an unreachable Anytype, a refused key and a start, never the detail or a path", () => {
    expect(anytypeLine(anytype("unreachable"), null).line).toBe(
      STRINGS["error.anytypeUnreachable"],
    );
    expect(anytypeLine(anytype("starting"), null).line).toBe(STRINGS["general.anytype.starting"]);
    expect(anytypeLine(anytype("ready"), null).line).toBe(STRINGS["general.anytype.starting"]);
    const refused = (reason: "not-paired" | "unreachable" | "failed") => ({
      ok: false as const,
      refused: { reason, sentence: "refused.failed" as const },
    });
    expect(anytypeLine(anytype("ready"), refused("not-paired")).line).toBe(
      STRINGS["error.keyRefused"],
    );
    expect(anytypeLine(anytype("ready"), refused("unreachable")).line).toBe(
      STRINGS["error.anytypeUnreachable"],
    );
    expect(anytypeLine(anytype("ready"), refused("failed")).line).toBe(
      STRINGS["general.anytype.connected"],
    );
    for (const state of ["tool-surface-mismatch", "down", "down-for-good", "stopped"] as const) {
      const line = anytypeLine(anytype(state), null);
      expect(line.line).toBe(STRINGS["general.anytype.unavailable"]);
      expect(line.line).not.toContain("added=");
    }
  });
});

describe("the AI apps section", () => {
  it("tells the address served as host:port, and pre-fills Change port with its port", () => {
    const status = endpoint("http://127.0.0.1:31010/mcp");
    expect(servedAddress(status)).toBe("127.0.0.1:31010");
    expect(servedPort(status)).toBe(31010);
    expect(aiAppsLine(status)).toBe(
      "Claude, Codex and other apps can use your Anytype through InnyTypes at `127.0.0.1:31010`.",
    );
  });

  it("says nothing is served when nothing is, with no port to pre-fill", () => {
    expect(servedAddress(endpoint(null))).toBeNull();
    expect(servedPort(endpoint(null))).toBeNull();
    expect(aiAppsLine(endpoint(null))).toBe(STRINGS["general.aiApps.notServed"]);
  });

  it("words a taken port with ux-writing's line and anything else with the generic one", () => {
    expect(moveRefusal("Error: could not bind 127.0.0.1:40001: EADDRINUSE", 40001)).toBe(
      "Port 40001 is used by another app. Choose another port.",
    );
    expect(moveRefusal("Error: the MCP endpoint setting could not be saved", 40001)).toBe(
      STRINGS["refused.failed"],
    );
  });
});

describe("the AI apps section's host", () => {
  it("pre-fills the host field with the host served, an IPv6 one unbracketed, and nothing when nothing is", () => {
    expect(servedHost(endpoint("http://127.0.0.1:31010/mcp"))).toBe("127.0.0.1");
    expect(servedHost(endpoint("http://[::1]:40001/mcp"))).toBe("::1");
    expect(servedPort(endpoint("http://[::1]:40001/mcp"))).toBe(40001);
    expect(servedHost(endpoint(null))).toBeNull();
  });

  it.each(["0.0.0.0", "::", "192.168.1.2", "localhost", "example.org"])(
    "words the runtime's own refusal of %s with the host line, never as a taken port",
    (host) => {
      // The refusal the services process sends is the endpoint rule's, judged here the same way.
      let reason = "";
      try {
        checkedAddress(host, 40001);
      } catch (error) {
        reason = `Error invoking remote method 'inny:mcp-endpoint-move': ${String(error)}`;
      }
      expect(reason).not.toBe("");
      expect(moveRefusal(reason, 40001)).toBe(STRINGS["general.aiApps.hostRefused"]);
    },
  );

  it("leaves a loopback host of either family to the runtime: the rule passes it", () => {
    expect(checkedAddress("127.0.0.1", 40001)).toEqual({ host: "127.0.0.1", port: 40001 });
    expect(checkedAddress("::1", 40001)).toEqual({ host: "::1", port: 40001 });
  });
});

describe("Copy setup", () => {
  it("copies strings.ts's command with the URL served filled in, and no token", () => {
    const url = "http://127.0.0.1:31010/mcp";
    expect(clientSetup(url)).toBe(STRINGS["general.aiApps.setup"].replace("{url}", url));
    expect(clientSetup(url)).toContain(`--url ${url} `);
    expect(clientSetup(url)).not.toContain("{");
  });
});

describe("the Reports section's state line", () => {
  it("says sending only when on; unanswered is not sending", () => {
    expect(reportsLine("on")).toBe("Sending anonymous usage counts.");
    expect(reportsLine("off")).toBe("Not sending.");
    expect(reportsLine("unset")).toBe("Not sending.");
  });
});

describe("retention (D8)", () => {
  it("offers 7, 30, 90, 365 days and Forever, in that order, and reads each back", () => {
    expect(RETENTION_OPTIONS.map((option) => option.label)).toEqual([
      "7 days",
      "30 days",
      "90 days",
      "365 days",
      "Forever",
    ]);
    for (const days of [7, 30, 90, 365, null]) {
      expect(retentionDays(retentionValue(days))).toBe(days);
    }
    expect(retentionDays("14")).toBeUndefined();
  });

  it("states how long runs are kept", () => {
    expect(retentionLine(90)).toBe("Runs are kept for 90 days.");
    expect(retentionLine(null)).toBe("Runs are kept until you delete them.");
  });
});

describe("Recorders and folders", () => {
  const flow = (id: string, on: boolean, sources: FlowSummary["sources"]): FlowSummary => ({
    id,
    name: id,
    template: null,
    on,
    health: { kind: "ready" },
    lastRun: null,
    viewNodes: [],
    steps: [],
    sources,
  });
  const step = (id: string, type: string, setUp = true) => ({ id, name: id, type, setUp });

  it("finds every folder source that is set up, with its flow's switch", () => {
    expect(
      folderSteps([
        flow("a", true, [step("w1", FOLDER_SOURCE_TYPE), step("f1", "inny-anytype-create-object")]),
        flow("b", false, [step("w2", FOLDER_SOURCE_TYPE), step("w3", FOLDER_SOURCE_TYPE, false)]),
      ]),
    ).toEqual([
      { flowId: "a", nodeId: "w1", on: true },
      { flowId: "b", nodeId: "w2", on: false },
    ]);
    expect(folderSteps([flow("c", true, [step("x", "inny-anytype-create-object")])])).toEqual([]);
  });

  it("names a folder by its own name, never its path, watching or not", () => {
    expect(folderName("/Volumes/BOYA")).toBe("BOYA");
    expect(folderName("/Users/me/Recordings/")).toBe("Recordings");
    expect(folderName("C:\\Users\\me\\Inbox")).toBe("Inbox");
    expect(recorderLine("/Volumes/BOYA", true)).toBe("BOYA · watching");
    expect(recorderLine("/Volumes/BOYA", false)).toBe("BOYA · not watching: its flow is off");
  });
});

describe("a line with code in it", () => {
  it("marks the backticked part as code and drops the backticks", () => {
    expect(codeParts("apps reach it at `127.0.0.1:31010`.")).toEqual([
      { code: false, text: "apps reach it at " },
      { code: true, text: "127.0.0.1:31010" },
      { code: false, text: "." },
    ]);
    expect(codeParts("no code")).toEqual([{ code: false, text: "no code" }]);
  });
});

describe("Packages (plan 0022 §F)", () => {
  const at = new Date(2026, 9, 14, 9, 14);
  const view = (updates: number): PackagesView => ({
    offers: [],
    packages: ["anytype", "folder", "monty", "innyrize"].map((name, index) => ({
      publisher: null,
      actions: { enabled: [], disabled: [] },
      package: {
        name,
        version: "0.3",
        source: { kind: "catalogue" },
        signed: true,
        shipped: false,
        registration: null,
        installation: null,
        update:
          index < updates
            ? { state: "available", version: "0.4", verifiedAt: at }
            : { state: "up-to-date", verifiedAt: at },
      },
    })),
  });

  it("the state line: '4 installed · 1 update', and no count of none", () => {
    expect(packagesLine(view(1))).toBe("4 installed · 1 update");
    expect(packagesLine(view(2))).toBe("4 installed · 2 updates");
    expect(packagesLine(view(0))).toBe("4 installed");
  });

  it("every state says when it was checked: 'checked today 09:14'", () => {
    expect(wordChecked(at, new Date(2026, 9, 14, 17, 0))).toBe("checked today 09:14");
    expect(wordChecked(at, new Date(2026, 9, 15, 8, 0))).toBe("checked yesterday 09:14");
  });

  it("a name between asterisks is a name; a title without italics drops them", () => {
    expect(nameParts("Can't unregister *monty*: no.")).toEqual([
      { name: false, text: "Can't unregister " },
      { name: true, text: "monty" },
      { name: false, text: ": no." },
    ]);
    expect(withoutMarks("Go back to *monty* 0.3?")).toBe("Go back to monty 0.3?");
  });
});

describe("every action a Package row draws has its call", () => {
  const at = new Date(2026, 9, 14, 9, 14);
  const installation = (state: Installation["state"]): Installation =>
    state === "installing"
      ? { state, progress: 50, verifiedAt: at }
      : state === "failed-check"
        ? { state, reason: "content-moved", verifiedAt: at }
        : { state, verifiedAt: at };
  const update = (state: PackageUpdate["state"]): PackageUpdate =>
    state === "updated"
      ? {
          state,
          version: "0.4",
          previous: "0.3",
          at,
          rollbackUntil: new Date(2026, 9, 20),
          verifiedAt: at,
        }
      : state === "up-to-date"
        ? { state, verifiedAt: at }
        : state === "blocked"
          ? { state, version: "0.4", reason: "it sent no ready", rolledBack: true, verifiedAt: at }
          : { state, version: "0.4", verifiedAt: at };
  const sources: Package["source"][] = [
    { kind: "catalogue" },
    { kind: "folder", path: "/p" },
    { kind: "folder", path: "/p", unreadable: true },
  ];
  /** Every call a press can make, recorded by the method it reached. */
  const called: string[] = [];
  const api = new Proxy({} as AppApiV2, {
    get: (_target, method: string) => () => {
      called.push(method);
      return Promise.resolve({ ok: true, value: null });
    },
  });

  it("on every state, source, registration and shipping, each drawn action reaches its call", async () => {
    let drawn = 0;
    for (const source of sources)
      for (const shipped of [false, true])
        for (const registered of ["registered", "not-registered"] as const)
          for (const inst of INSTALLATION_STATES)
            for (const upd of [...PACKAGE_UPDATE_STATES, null]) {
              const pkg: Package = {
                name: "monty",
                version: "0.3",
                source,
                signed: true,
                shipped,
                registration: { state: registered, verifiedAt: at },
                installation: installation(inst),
                update: upd === null ? null : update(upd),
              };
              const { enabled, disabled } = rowActions(pkg, at);
              for (const action of [...enabled, ...disabled]) {
                drawn += 1;
                const what = PACKAGE_ACTIONS[action](api, pkg.name);
                if (what.kind === "call") {
                  called.length = 0;
                  await what.call();
                  expect(called, `${action} reaches one call`).toHaveLength(1);
                }
              }
              // A shipped package that failed its check offers neither Install nor Remove.
              if (shipped && inst === "failed-check") {
                expect([...enabled, ...disabled]).not.toContain("install");
                expect([...enabled, ...disabled]).not.toContain("remove");
              }
            }
    expect(drawn).toBeGreaterThan(0);
  });

  it("each action reaches the call that does it", async () => {
    const reached: Record<string, string> = {};
    for (const [action, press] of Object.entries(PACKAGE_ACTIONS)) {
      const what = press(api, "monty");
      called.length = 0;
      if (what.kind === "call") await what.call();
      reached[action] = what.kind === "call" ? (called[0] ?? "") : "confirm-go-back";
    }
    expect(reached).toEqual({
      register: "registerPackage",
      unregister: "unregisterPackage",
      install: "reinstallPackage",
      remove: "uninstallPackage",
      update: "updatePackage",
      "check-for-changes": "checkFolder",
      "go-back": "confirm-go-back",
    });
  });
});
