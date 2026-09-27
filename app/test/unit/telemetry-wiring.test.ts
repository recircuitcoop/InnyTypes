// The shell's telemetry (WI-0018-22): crash reports that count the runtime's, the services
// process's and every node process's crashes, one usage report per launch, the page's question and
// switch over IPC, and the runtime's node crashes reaching the shell over the channel.
import { describe, expect, it } from "vitest";
import { CrashReports } from "../../src/application/crash-reports";
import { shellNodeCrashes } from "../../src/application/serve-shell";
import { parseChildMessage } from "../../src/domain/channel/messages";
import type { ChildStatus } from "../../src/domain/supervision/child-state";
import type { Versions } from "../../src/domain/telemetry/reports";
import { IPC } from "../../src/shell/ipc";
import {
  reportedPackages,
  telemetryEndpoints,
  wireTelemetry,
  type ListedPackage,
  type TelemetryWiring,
} from "../../src/shell/telemetry";
import type { TelemetryStatus } from "../../src/ui/contract";
import { exitsAtOnce, obedient, RecordingLogger } from "../fakes/children";
import { FakeClock } from "../fakes/clock";
import { supervised } from "../fakes/supervised";
import { MemoryQueue, MemorySetting, RecordingPoster, settle } from "../fakes/telemetry";

const VERSIONS: Versions = { appVersion: "1.0.0", os: "linux", osVersion: "6.8", arch: "x64" };

const status = (child: ChildStatus["child"], state: ChildStatus["state"]): ChildStatus => ({
  child,
  state,
  generation: 1,
  pid: null,
  port: null,
  error: null,
});

/** A supervisor as far as telemetry listens to it. */
class ListenedSupervisor {
  statusListeners: ((status: ChildStatus) => void)[] = [];
  nodeListeners: ((stopped: boolean) => void)[] = [];
  onStatus(listener: (status: ChildStatus) => void): void {
    this.statusListeners.push(listener);
  }
  onNodeCrash(listener: (stopped: boolean) => void): void {
    this.nodeListeners.push(listener);
  }
  publish(value: ChildStatus): void {
    for (const listener of this.statusListeners) {
      listener(value);
    }
  }
}

const PACKAGES: ListedPackage[] = [
  { name: "anytype", document: { version: "1.2.0" }, installed: false, signed: false },
  { name: "probekit", document: { version: "0.3.0" }, installed: true, signed: true },
  { name: "my-private-thing", document: { version: "0.0.1" }, installed: true, signed: false },
  { name: "odd", document: null, installed: true, signed: true },
];

function wired(answer: "on" | "off" | "unset") {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const setting = new MemorySetting(answer);
  const queue = new MemoryQueue();
  const poster = new RecordingPoster();
  const clock = new FakeClock();
  const runtime = new ListenedSupervisor();
  const services = new ListenedSupervisor();
  let identified = 0;
  const deps: TelemetryWiring = {
    ipc: {
      handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      },
    } as TelemetryWiring["ipc"],
    setting,
    queue,
    poster,
    machineIdentifier: () => {
      identified += 1;
      return "RAW-MACHINE-IDENTIFIER-0001";
    },
    hashIdentifier: () => "f".repeat(64),
    clock,
    logger: new RecordingLogger(),
    env: {
      INNYTYPES_GLITCHTIP_DSN: "https://key@glitchtip.test/1",
      INNYTYPES_UMAMI_URL: "https://umami.test",
      INNYTYPES_UMAMI_WEBSITE_ID: "site",
    },
    appVersion: "1.0.0",
    registry: { redact: (text) => text },
    sink: { protect: () => undefined },
    supervisors: new Map([
      ["runtime", runtime],
      ["services", services],
    ]),
    packages: () => PACKAGES,
  };
  const pipeline = wireTelemetry(deps);
  const call = (channel: string, ...args: unknown[]): TelemetryStatus =>
    handlers.get(channel)?.({}, ...args) as TelemetryStatus;
  return {
    pipeline,
    setting,
    queue,
    poster,
    clock,
    runtime,
    services,
    call,
    identified: () => identified,
  };
}

describe("the shell's telemetry", () => {
  it("nothing is reported while the telemetry question is unanswered", async () => {
    const world = wired("unset");
    world.runtime.publish(status("runtime", "down"));
    world.services.publish(status("services", "down-for-good"));
    for (const listener of world.runtime.nodeListeners) {
      listener(false);
    }
    world.clock.advance(60_000);
    await settle();
    expect(world.queue.reports).toEqual([]);
    expect(world.poster.sent).toEqual([]);
    expect(world.identified()).toBe(0);
  });

  it("the question is asked with its notice, and answers nothing yet", () => {
    const world = wired("unset");
    const asked = world.call(IPC.telemetry);
    expect(asked.answer).toBe("unset");
    expect(asked.question).toContain("Send anonymous usage and crash reports");
    expect(asked.notice).toContain("GDPR");
    // A call that is not an answer answers nothing.
    expect(world.call(IPC.setTelemetry, "yes").answer).toBe("unset");
    expect(world.setting.answer).toBe("unset");
  });

  it.each([
    ["Yes", true, "on"],
    ["No", false, "off"],
  ] as const)("answering the question %s records the answer and closes it", (_, on, stored) => {
    const world = wired("unset");
    expect(world.call(IPC.setTelemetry, on).answer).toBe(stored);
    expect(world.setting.answer).toBe(stored);
    expect(world.call(IPC.telemetry).answer).toBe(stored);
  });

  it("a yes is what lets the usage report be queued, naming only shipped and signed packages", () => {
    const world = wired("unset");
    expect(world.queue.reports).toEqual([]);
    world.call(IPC.setTelemetry, true);
    expect(world.queue.reports).toHaveLength(1);
    expect(world.queue.reports[0]?.kind).toBe("usage");
    expect(world.queue.reports[0]?.payload).toMatchObject({
      packages: [
        { id: "anytype", version: "1.2.0" },
        { id: "probekit", version: "0.3.0" },
        { id: "odd", version: "unknown" },
      ],
      unsigned_packages: 1,
    });
    expect(JSON.stringify(world.queue.reports)).not.toContain("my-private-thing");
  });

  it("a usage report carries this machine's packages when the switch is on at launch", () => {
    const world = wired("on");
    expect(world.queue.reports.map((report) => report.kind)).toEqual(["usage"]);
    expect(world.call(IPC.telemetry).queued).toBe(1);
  });

  it("crash reports cover the runtime, the services process and node processes, with counts", () => {
    const world = wired("on");
    world.queue.purge();
    world.runtime.publish(status("runtime", "running"));
    world.runtime.publish(status("runtime", "down"));
    world.services.publish(status("services", "down-for-good"));
    for (const listener of world.runtime.nodeListeners) {
      listener(false);
      listener(true);
    }
    const crashes = world.queue.reports.map((report) => report.payload);
    expect(crashes.map((payload) => [payload["crashed"], payload["stopped_for_good"]])).toEqual([
      ["runtime", false],
      ["services", true],
      ["node", false],
      ["node", true],
    ]);
    expect(crashes.at(-1)?.["crashes"]).toEqual({
      runtime: 1,
      services: 1,
      node: 2,
      node_stopped: 1,
    });
    expect(crashes.every((payload) => payload["kind"] === "error")).toBe(true);
  });

  it("turning telemetry off in the window empties the queue", () => {
    const world = wired("on");
    world.runtime.publish(status("runtime", "down"));
    expect(world.queue.reports).toHaveLength(2);
    expect(world.call(IPC.setTelemetry, false)).toMatchObject({ answer: "off", queued: 0 });
    expect(world.queue.reports).toEqual([]);
  });

  it("the build's endpoints come from the environment, and are empty without it", () => {
    expect(telemetryEndpoints({})).toEqual({ glitchtipDsn: "", umamiUrl: "", umamiWebsiteId: "" });
    expect(reportedPackages([])).toEqual({ named: [], unsigned: 0 });
  });
});

describe("crash counts", () => {
  it("counts each crash once and hands every report the counts so far", () => {
    const recorded: Readonly<Record<string, unknown>>[] = [];
    const reports = new CrashReports({
      record: (payload) => recorded.push(payload),
      versions: VERSIONS,
    });
    reports.childStatus(status("runtime", "starting"));
    reports.childStatus(status("runtime", "down"));
    reports.childStatus(status("runtime", "recovering"));
    reports.nodeCrashed(true);
    expect(reports.counts()).toEqual({ runtime: 1, services: 0, node: 1, nodeStopped: 1 });
    expect(recorded).toHaveLength(2);
    expect(recorded[1]).toMatchObject({
      exception_type: "NodeProcessCrashed",
      app_version: "1.0.0",
    });
  });
});

describe("a node's crash reaches the shell over the channel", () => {
  it("the runtime posts it, the channel parses it, and the supervisor tells its listeners", () => {
    const posted: unknown[] = [];
    const link = { post: (message: unknown) => posted.push(message) };
    shellNodeCrashes(link as unknown as Parameters<typeof shellNodeCrashes>[0]).nodeCrashed(true);
    expect(posted).toEqual([{ v: 1, t: "node-crash", stopped: true }]);
    expect(parseChildMessage(posted[0])).toEqual({ v: 1, t: "node-crash", stopped: true });
    expect(parseChildMessage({ v: 1, t: "node-crash", stopped: "yes" })).toBeNull();

    const { supervisor, launcher } = supervised(obedient);
    const heard: boolean[] = [];
    supervisor.onNodeCrash((stopped) => heard.push(stopped));
    supervisor.start();
    launcher.current.send({ v: 1, t: "node-crash", stopped: false });
    expect(heard).toEqual([false]);
  });

  it("a real supervisor's crash loop is counted crash by crash, to the limit", () => {
    const { supervisor, clock } = supervised(exitsAtOnce);
    const recorded: Readonly<Record<string, unknown>>[] = [];
    const reports = new CrashReports({
      record: (payload) => recorded.push(payload),
      versions: VERSIONS,
    });
    supervisor.onStatus((value) => {
      reports.childStatus(value);
    });
    supervisor.start();
    clock.advance(60_000);
    // The crash-loop limit (5 in 2 minutes): four restarts, then down for good.
    expect(reports.counts().runtime).toBe(5);
    expect(recorded.map((payload) => payload["stopped_for_good"])).toEqual([
      false,
      false,
      false,
      false,
      true,
    ]);
  });
});
