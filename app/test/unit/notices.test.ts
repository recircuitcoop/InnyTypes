// Notices (WI-0018-21; plan 0018 §3 notification.py): the kinds and their words, the once-only
// rule, the notice file, and the channel that carries a child's notices to the shell's board.
import fs from "node:fs";
import os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { JsonNoticeFile } from "../../src/adapters/fs/notice-file";
import { NoticeBoard } from "../../src/application/notices";
import { shellNotifier } from "../../src/application/serve-shell";
import { parseChildMessage, type ChildMessage } from "../../src/domain/channel/messages";
import {
  compose,
  isNotice,
  NOTICE_KINDS,
  sameNotice,
  type Message,
  type Notice,
} from "../../src/domain/notices/notices";
import type { NoticeStore } from "../../src/ports/notifier";
import { obedient, RecordingLogger } from "../fakes/children";
import { supervised } from "../fakes/supervised";

function board(store: NoticeStore | null = null, deliver?: (message: Message) => void) {
  const shown: Message[] = [];
  const logger = new RecordingLogger();
  const subject = new NoticeBoard({
    deliver: deliver ?? ((message) => shown.push(message)),
    store,
    logger,
  });
  return { subject, shown, logger };
}

const crashLoop: Notice = {
  kind: "child-stopped",
  subject: "runtime",
  detail:
    "The InnyTypes runtime stopped unexpectedly 5 times in 2 minutes, so it is no longer " +
    "restarted. Press Restart to try again.",
};

describe("compose", () => {
  it("has words for every kind, a title and a body, each body ending as a sentence", () => {
    for (const kind of NOTICE_KINDS) {
      const message = compose({ kind, subject: "thing", version: "2.0.0", detail: "a reason" });
      expect(message.title, kind).not.toBe("");
      // A waiting view's body is the view's own title, as its author wrote it.
      expect(message.body, kind).toMatch(kind === "view-waiting" ? /^a reason$/ : /[.!?]$/);
    }
  });

  it("says what stopped and what to do about it, adding a full stop only where one is missing", () => {
    expect(compose(crashLoop)).toEqual({
      title: "InnyTypes stopped restarting the runtime",
      body: crashLoop.detail,
    });
    expect(compose({ kind: "node-stopped", subject: "raw", detail: "It exited" }).body).toBe(
      "It exited. Redeploy the flow to let it try again.",
    );
    expect(compose({ kind: "anytype-key-refused", subject: "Anytype" })).toEqual({
      title: "Anytype refused the InnyTypes key",
      body:
        "An Anytype node's request was refused, so its input failed and was not retried. " +
        "Pair again with Anytype in Settings.",
    });
    expect(
      compose({ kind: "endpoint-degraded", subject: "MCP endpoint", detail: "port taken" }),
    ).toEqual({
      title: "InnyTypes is running without its MCP endpoint",
      body: "port taken. Choose another address in Settings.",
    });
    expect(compose({ kind: "mcp-child-stopped", subject: "Anytype MCP child" }).body).toBe("");
    expect(compose({ kind: "view-waiting", subject: "v1", detail: "Approve?" })).toEqual({
      title: "InnyTypes is waiting for you",
      body: "Approve?",
    });
    expect(compose({ kind: "view-waiting", subject: "v1" }).body).toBe(
      "A view waits in the Inbox.",
    );
    expect(
      compose({ kind: "package-update-available", subject: "monty", version: "2.0.0" }),
    ).toEqual({ title: "monty 2.0.0 is available", body: "Install it on the Packages page." });
    expect(
      compose({ kind: "package-update-refused", subject: "monty", version: "2.0.0", detail: "!" })
        .title,
    ).toBe("monty 2.0.0 is being held back");
    expect(compose({ kind: "mcp-child-restarted", subject: "Anytype MCP child" }).title).toBe(
      "InnyTypes restarted the Anytype MCP child",
    );
    expect(
      compose({ kind: "core-update-available", subject: "InnyTypes", version: "1.2.3" }),
    ).toEqual({
      title: "InnyTypes 1.2.3 is ready",
      body: "It installs the next time you quit InnyTypes.",
    });
    expect(
      compose({ kind: "core-update-refused", subject: "InnyTypes", detail: "a tampered yml" })
        .title,
    ).toBe("An InnyTypes update was refused");
  });

  it("tells a notice from one in other words, and checks what crossed a process boundary", () => {
    expect(sameNotice(crashLoop, { ...crashLoop })).toBe(true);
    expect(sameNotice(crashLoop, { ...crashLoop, detail: "another reason" })).toBe(false);
    expect(
      sameNotice(
        { kind: "view-waiting", subject: "a", version: "" },
        { kind: "view-waiting", subject: "a" },
      ),
    ).toBe(true);
    expect(isNotice(crashLoop)).toBe(true);
    expect(isNotice({ kind: "no-such-kind", subject: "x" })).toBe(false);
    expect(isNotice({ kind: "child-stopped", subject: 1 })).toBe(false);
    expect(isNotice({ kind: "child-stopped", subject: "x", detail: 3 })).toBe(false);
    expect(isNotice(null)).toBe(false);
    expect(isNotice([])).toBe(false);
  });
});

describe("NoticeBoard: the once-only rule", () => {
  it("tells a notice once, however many times it is raised while it stays true", () => {
    const { subject, shown } = board();
    subject.raise(crashLoop);
    subject.raise(crashLoop);
    subject.raise({ ...crashLoop });
    expect(shown).toEqual([compose(crashLoop)]);
    expect(subject.current()).toEqual([crashLoop]);
  });

  it("tells it again in new words, and again after the condition went away and came back", () => {
    const { subject, shown } = board();
    subject.raise(crashLoop);
    const reworded = { ...crashLoop, detail: "It stopped for another reason." };
    subject.raise(reworded);
    expect(shown).toHaveLength(2);
    expect(subject.current()).toEqual([reworded]);
    subject.clear("child-stopped", "runtime");
    expect(subject.current()).toEqual([]);
    subject.raise(reworded);
    expect(shown).toHaveLength(3);
    // Clearing what is not current changes nothing.
    subject.clear("node-stopped", "raw");
    expect(subject.current()).toEqual([reworded]);
  });

  it("keeps one condition per kind and subject: two children are two notices", () => {
    const { subject, shown } = board();
    subject.raise(crashLoop);
    subject.raise({ ...crashLoop, subject: "services" });
    expect(shown.map((message) => message.title)).toEqual([
      "InnyTypes stopped restarting the runtime",
      "InnyTypes stopped restarting the services",
    ]);
  });

  it("records the conditions before anything is shown, and logs each notice once", () => {
    const order: string[] = [];
    const store: NoticeStore = {
      write: (notices) => order.push(`write ${String(notices.length)}`),
    };
    const { subject, logger } = board(store, (message) => order.push(`show ${message.title}`));
    subject.raise(crashLoop);
    subject.raise(crashLoop);
    subject.clear("child-stopped", "runtime");
    expect(order).toEqual(["write 1", "show InnyTypes stopped restarting the runtime", "write 0"]);
    expect(logger.lines.filter((line) => line.includes("notice:"))).toHaveLength(1);
  });

  it("carries on when the desktop will not show it or the file cannot be written", () => {
    const store: NoticeStore = {
      write: () => {
        throw new Error("disk full");
      },
    };
    const { subject, logger } = board(store, () => {
      throw new Error("no notification daemon");
    });
    subject.raise(crashLoop);
    expect(subject.current()).toEqual([crashLoop]);
    expect(logger.lines.join("\n")).toContain(
      "the notice file could not be written: Error: disk full",
    );
    expect(logger.lines.join("\n")).toContain(
      "would not show a notice: Error: no notification daemon",
    );
  });
});

describe("JsonNoticeFile", () => {
  it("writes every current condition, whole, and replaces the file on the next write", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inny-notices-"));
    const file = path.join(dir, "deeper", "notices.json");
    const store = new JsonNoticeFile(file);
    store.write([crashLoop, { kind: "view-waiting", subject: "v1" }]);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual([
      { kind: "child-stopped", subject: "runtime", version: "", detail: crashLoop.detail },
      { kind: "view-waiting", subject: "v1", version: "", detail: "" },
    ]);
    store.write([]);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual([]);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["notices.json"]);
  });

  it("leaves no scratch file behind when the write fails", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inny-notices-"));
    // A directory where the file should be: the rename fails.
    const file = path.join(dir, "notices.json");
    fs.mkdirSync(file);
    fs.writeFileSync(path.join(file, "keep"), "");
    expect(() => {
      new JsonNoticeFile(file).write([crashLoop]);
    }).toThrow();
    expect(fs.readdirSync(dir)).toEqual(["notices.json"]);
  });
});

describe("a child's notices reach the shell over the channel", () => {
  it("posts raise and clear as channel messages the shell parses back whole", () => {
    const posted: ChildMessage[] = [];
    const notifier = shellNotifier({
      post: (message) => posted.push(message),
      onMessage: () => undefined,
      onPeer: () => undefined,
    });
    notifier.raise(crashLoop);
    notifier.clear("child-stopped", "runtime");
    expect(posted.map((message) => parseChildMessage(structuredClone(message)))).toEqual([
      { v: 1, t: "notice", notice: crashLoop },
      { v: 1, t: "notice-clear", kind: "child-stopped", subject: "runtime" },
    ]);
  });

  it("refuses a notice of an unknown kind or shape", () => {
    expect(
      parseChildMessage({ v: 1, t: "notice", notice: { kind: "x", subject: "y" } }),
    ).toBeNull();
    expect(parseChildMessage({ v: 1, t: "notice-clear", kind: "x", subject: "y" })).toBeNull();
    expect(
      parseChildMessage({ v: 1, t: "notice-clear", kind: "node-stopped", subject: 2 }),
    ).toBeNull();
  });
});

describe("the supervisor hands a child's notices to the shell's notifier", () => {
  it("raises and clears what the child sent, and clears its own crash loop on Restart", () => {
    const { clock, launcher, notifier, supervisor } = supervised(obedient);
    supervisor.start();
    clock.advance(1);
    launcher.current.send({ v: 1, t: "notice", notice: crashLoop });
    launcher.current.send({ v: 1, t: "notice-clear", kind: "node-stopped", subject: "raw" });
    expect(notifier.notices).toEqual([crashLoop]);
    expect(notifier.cleared).toEqual(["node-stopped raw"]);

    // The crash-loop limit raises the child's own notice; Restart clears it.
    for (let crash = 0; crash < 10 && supervisor.status().state !== "down-for-good"; crash++) {
      launcher.current.exit(1);
      clock.advance(5_000);
    }
    expect(notifier.notices.at(-1)).toMatchObject({ kind: "child-stopped", subject: "runtime" });
    expect(supervisor.recover()).toBe(true);
    expect(notifier.cleared.at(-1)).toBe("child-stopped runtime");
  });
});
