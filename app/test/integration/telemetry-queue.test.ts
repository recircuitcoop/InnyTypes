// The telemetry queue on disk (WI-0018-22), the port of ReportQueue (telemetry.py:709-896): in
// order, owner-only, bounded at 128 reports and 1 MiB by dropping the oldest, and never blocked by a
// file it cannot read. Plus the switch in shell-settings.json. Everything in a scratch folder.
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonSettingsStore } from "../../src/adapters/fs/settings-store";
import {
  DEFAULT_MAX_QUEUE_BYTES,
  DEFAULT_MAX_REPORTS,
  DiskReportQueue,
} from "../../src/adapters/telemetry/disk-queue";
import { RecordingLogger } from "../fakes/children";

let scratch = "";
let root = "";

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "inny-telemetry-"));
  root = path.join(scratch, "telemetry-queue");
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

const files = (): string[] => fs.readdirSync(root).filter((name) => !name.startsWith("."));

describe("the telemetry queue", () => {
  it("keeps reports in order, and the order survives a restart", () => {
    const queue = new DiskReportQueue(root, new RecordingLogger());
    queue.enqueue("usage", { n: 1 });
    queue.enqueue("error", { n: 2 });
    const again = new DiskReportQueue(root, new RecordingLogger());
    again.enqueue("error", { n: 3 });
    expect(again.pending().map((report) => [report.sequence, report.kind, report.payload])).toEqual(
      [
        [1, "usage", { n: 1 }],
        [2, "error", { n: 2 }],
        [3, "error", { n: 3 }],
      ],
    );
    expect(files()).toEqual([
      "000000000001-usage.json",
      "000000000002-error.json",
      "000000000003-error.json",
    ]);
  });

  it("the queue directory is readable by this user only", () => {
    new DiskReportQueue(root, new RecordingLogger()).enqueue("usage", { n: 1 });
    expect(fs.statSync(root).mode & 0o777).toBe(0o700);
  });

  it("the defaults are 128 reports and 1 MiB", () => {
    expect(DEFAULT_MAX_REPORTS).toBe(128);
    expect(DEFAULT_MAX_QUEUE_BYTES).toBe(1024 * 1024);
  });

  it("drops the oldest rather than growing past its report bound", () => {
    const queue = new DiskReportQueue(root, new RecordingLogger());
    for (let n = 1; n <= DEFAULT_MAX_REPORTS + 5; n += 1) {
      queue.enqueue("error", { n });
    }
    const pending = queue.pending();
    expect(pending).toHaveLength(DEFAULT_MAX_REPORTS);
    expect(pending[0]?.payload).toEqual({ n: 6 });
    expect(pending.at(-1)?.payload).toEqual({ n: DEFAULT_MAX_REPORTS + 5 });
  });

  it("drops the oldest when its bytes run out, but never the newest", () => {
    const queue = new DiskReportQueue(root, new RecordingLogger(), { maxBytes: 250 });
    const big = "x".repeat(100);
    queue.enqueue("usage", { n: 1, big });
    queue.enqueue("usage", { n: 2, big });
    queue.enqueue("usage", { n: 3, big });
    expect(queue.pending().map((report) => report.payload["n"])).toEqual([2, 3]);
    // One report bigger than the whole bound is still kept: it is the newest.
    queue.enqueue("usage", { n: 4, big: "y".repeat(1000) });
    expect(queue.pending().map((report) => report.payload["n"])).toEqual([4]);
  });

  it("an unreadable queue file is dropped rather than blocking the queue", () => {
    const logger = new RecordingLogger();
    const queue = new DiskReportQueue(root, logger);
    queue.enqueue("error", { n: 1 });
    fs.writeFileSync(path.join(root, "000000000002-error.json"), "{not json");
    fs.writeFileSync(path.join(root, "000000000003-usage.json"), "[1, 2]");
    fs.writeFileSync(path.join(root, "notes.txt"), "not a report");
    queue.enqueue("usage", { n: 4 });
    expect(queue.pending().map((report) => report.payload["n"])).toEqual([1, 4]);
    expect(files().sort()).toEqual([
      "000000000001-error.json",
      "000000000004-usage.json",
      "notes.txt",
    ]);
    expect(logger.lines.join("\n")).toContain("dropping an unreadable telemetry report");
    expect(logger.lines.join("\n")).toContain("not an object");
  });

  it("two writers never take the same place in the queue", () => {
    const one = new DiskReportQueue(root, new RecordingLogger());
    const two = new DiskReportQueue(root, new RecordingLogger());
    one.enqueue("usage", { from: "one" });
    // Another writer claimed the next sequence between this one's scan and its write.
    fs.writeFileSync(path.join(root, "000000000002-error.json"), JSON.stringify({ from: "two" }));
    // The scan sees the folder as it was before the other writer wrote, as a racing one would.
    const scan = vi
      .spyOn(fs, "readdirSync")
      .mockReturnValueOnce(["000000000001-usage.json"] as never);
    try {
      expect(two.enqueue("usage", { from: "three" }).sequence).toBe(3);
    } finally {
      scan.mockRestore();
    }
    expect(one.pending().map((report) => report.payload["from"])).toEqual(["one", "two", "three"]);
  });

  it("purge deletes every report and says how many; remove forgets one", () => {
    const queue = new DiskReportQueue(root, new RecordingLogger());
    expect(queue.purge()).toBe(0);
    const first = queue.enqueue("usage", { n: 1 });
    queue.enqueue("usage", { n: 2 });
    queue.remove(first);
    expect(queue.pending().map((report) => report.payload["n"])).toEqual([2]);
    expect(queue.purge()).toBe(1);
    expect(queue.pending()).toEqual([]);
  });

  it("a queue that could hold nothing is refused", () => {
    expect(() => new DiskReportQueue(root, new RecordingLogger(), { maxReports: 0 })).toThrow(
      "must hold at least one report",
    );
  });

  it("a queue folder that cannot be listed is an error, not an empty queue", () => {
    fs.writeFileSync(path.join(scratch, "a-file"), "");
    const queue = new DiskReportQueue(path.join(scratch, "a-file"), new RecordingLogger());
    expect(queue.pending()).toEqual([]);
    expect(() => queue.enqueue("usage", {})).toThrow();
  });
});

describe("the telemetry switch in shell-settings.json", () => {
  it("is unanswered until written, keeps every other setting, and refuses a bad value", () => {
    const file = path.join(scratch, "shell-settings.json");
    const store = new JsonSettingsStore(file);
    expect(store.readTelemetry()).toBe("unset");
    store.writeLaunchAtLogin(true);
    store.writeTelemetry(true);
    expect(store.readTelemetry()).toBe("on");
    store.writeTelemetry(false);
    expect(store.readTelemetry()).toBe("off");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
      launchAtLogin: true,
      telemetry: false,
    });
    fs.writeFileSync(file, JSON.stringify({ telemetry: "yes" }));
    expect(() => store.readTelemetry()).toThrow("must be true or false");
    fs.writeFileSync(file, "{broken");
    expect(() => store.readTelemetry()).toThrow("is not JSON");
  });
});
