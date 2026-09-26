// The Anytype node package in the real app (WI-0018-20, plan 0018 §4.2): a watched-folder
// fixture source, then Create object against a fake Anytype, then a snapshot view whose content
// is the created object as an Anytype link, opened in its pop-out. Then the canary scan: the
// key the run put in its scratch home is found in no file of the run but its own (flows.json,
// flows_cred.json, the journal, the snapshots, the log), and in nothing the app printed.
//
// Never the owner's Anytype or key: the fake is on a free loopback port and the key is the
// run's canary, read by the node from the file the shell located under the scratch home.
import fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { FakeAnytypeServer } from "../fakes/anytype";
import {
  anytypeKeyFile,
  launchApp,
  processesNaming,
  quit,
  scratchDirectories,
  waitForRunning,
} from "./app-harness";

const SPACE = "e2e-space";

function deploy(port: number, flow: object[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(flow);
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

/** Every regular file below `root` whose bytes hold `needle`. */
function filesHolding(root: string, needle: string): string[] {
  return fs
    .readdirSync(root, { recursive: true, encoding: "utf8" })
    .map((relative) => path.join(root, relative))
    .filter((file) => fs.lstatSync(file).isFile())
    .filter((file) => fs.readFileSync(file).includes(needle));
}

type Api = {
  inny: {
    app: {
      snapshot(id: string): Promise<{ ok: boolean; value: Record<string, unknown> | null }>;
      openSnapshot(id: string): Promise<void>;
    };
  };
};

test("a watched folder's file becomes an Anytype object, recorded as a snapshot with its Anytype link, and the key is in no flow, journal, snapshot or log", async () => {
  test.setTimeout(90_000);
  const { scratch, userData, env, canaryKey } = scratchDirectories();
  const anytype = new FakeAnytypeServer(canaryKey);
  const url = await anytype.start();
  const inbox = path.join(scratch, "inbox");
  fs.mkdirSync(inbox);
  const logFile = path.join(scratch, "innytypes.log");
  try {
    const { app, window, output } = await launchApp({ ...env, INNYTYPES_LOG_FILE: logFile });
    const said = () => output.join("");
    const runtime = await waitForRunning(window, "runtime");
    const flow = [
      { id: "tab1", type: "tab", label: "Anytype" },
      { id: "watch", type: "inny-folderflow-watch", folder: inbox, wires: [["create"]] },
      {
        id: "create",
        type: "inny-anytype-create-object",
        space_id: SPACE,
        name_field: "/name",
        body_field: "/body",
        api_base_url: url,
        wires: [["link"]],
      },
      { id: "link", type: "inny-folderflow-link", window: "inline", wires: [[]] },
    ].map((node, n) => (n === 0 ? node : { z: "tab1", x: 100, y: 40 * n, ...node }));
    expect(await deploy(Number(runtime.port), flow)).toBe(204);
    await expect
      .poll(said, { timeout: 20_000 })
      .toMatch(/\[inny-anytype-create-object create\] ready/);
    await expect.poll(said, { timeout: 20_000 }).toMatch(/\[inny-folderflow-watch watch\] ready/);

    // ── a file appears; Anytype gets exactly one object for it ──────────────────────────
    fs.writeFileSync(path.join(inbox, "meeting.md"), "# Meeting\nNotes.");
    const recorded = /snapshot (\S+) recorded from \[inny-folderflow-link link\]/;
    await expect.poll(() => recorded.exec(said())?.[1], { timeout: 20_000 }).toBeDefined();
    const snapshotId = recorded.exec(said())?.[1] as string;
    const created = anytype.to("POST", `/v1/spaces/${SPACE}/objects`);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      authorization: `Bearer ${canaryKey}`,
      body: { type_key: "page", name: "meeting.md", body: "# Meeting\nNotes." },
    });

    // ── the snapshot holds the object as an Anytype link, and its pop-out shows it ──────
    const snapshot = await window.evaluate(
      (id) => (window as unknown as Api).inny.app.snapshot(id),
      snapshotId,
    );
    expect(snapshot).toMatchObject({
      ok: true,
      value: {
        content: {
          title: "Created in Anytype",
          anytype: { objectId: "obj1", spaceId: SPACE, name: "meeting.md" },
        },
      },
    });
    await window.evaluate((id) => (window as unknown as Api).inny.app.openSnapshot(id), snapshotId);
    await expect
      .poll(() => app.windows().filter((page) => page.url().startsWith("inny-view://")).length, {
        timeout: 15_000,
      })
      .toBe(1);
    const popout = app.windows().find((page) => page.url().startsWith("inny-view://"));
    await expect(popout?.getByTestId("view-anytype") ?? window.locator("none")).toHaveAttribute(
      "href",
      `anytype://object?objectId=obj1&spaceId=${SPACE}`,
    );

    await quit(app);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);

    // ── the canary scan: only the key's own file holds it ───────────────────────────────
    for (const kept of ["flows.json", "journal.sqlite", "snapshots.sqlite"]) {
      expect(
        fs
          .readdirSync(userData, { recursive: true, encoding: "utf8" })
          .some((file) => file.endsWith(kept)),
        `${kept} was written`,
      ).toBe(true);
    }
    // The log is one of the files scanned: the node's own lines reached it.
    expect(fs.readFileSync(logFile, "utf8")).toContain("[inny-anytype-create-object create]");
    expect(filesHolding(scratch, canaryKey)).toEqual([anytypeKeyFile(scratch)]);
    expect(said()).not.toContain(canaryKey);
  } finally {
    await anytype.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
