// The folder package's one process entry (plan 0022 D18, WI-0022-25): bundled by esbuild into
// dist/folder.cjs with the SDK, and run with {node}. One process per instance of its one type,
// `watch` (`inny-folder-watch`), a source: every new file that has finished writing in the
// configured folder is emitted on `created` as `folder.file.created.v1`, a new run each.
// Which files count, and when, is watcher.ts.

import { emit, log, run, start, status } from "../../../sdk/ts/src/node";
import { FolderWatcher, SCAN_MS, settingsOf } from "./watcher";

const TYPE = "inny-folder-watch";
/** The status while the files passed on cannot be written down in the data folder. */
const CANNOT_WRITE = "cannot write down the files passed on";

async function main(): Promise<void> {
  const info = await start();
  if (info.node.type !== TYPE) {
    process.stderr.write(`this package has no type ${JSON.stringify(info.node.type)}\n`);
    process.exit(2);
  }
  const settings = settingsOf(info.config);
  const watcher = new FolderWatcher(settings, info.dataDir);
  /** Whether the start-up warnings were said; on the first tick, once `run` has sent ready. */
  let started = false;
  /** The status last shown, so a scan says it again only when it changed. */
  let shown = "";
  const show = (text: string, fill: "green" | "red", shape: "dot" | "ring"): void => {
    if (text !== shown) {
      shown = text;
      status(text, fill, shape);
    }
  };

  const tick = (): void => {
    if (!started) {
      started = true;
      if (watcher.recordUnreadable !== null) {
        // Taken as a first run: what arrived while this was stopped is not passed on (watcher.ts).
        log(
          `cannot read the record of the files passed on, so files that arrived while stopped are not passed on: ${watcher.recordUnreadable}`,
          "warn",
        );
      }
    }
    try {
      // Early out: a folder that is not there (a drive not mounted yet) is not scanned, so
      // nothing remembered is forgotten and its files are not passed on again when it is back.
      if (!watcher.folderExists()) {
        show("the folder is not there", "red", "ring");
        return;
      }
      // Passed on first, then written down (watcher.ts): a file seen while running is never lost.
      const created = watcher.scan(Date.now());
      // Early out: there but not readable (its permissions); red until it can be read.
      if (created === null) {
        show("cannot read the folder", "red", "ring");
        return;
      }
      for (const file of created) {
        emit("created", file);
      }
      const failed = watcher.persist();
      if (failed !== null) {
        // Red until a write succeeds: the files are passed on, but a restart could repeat them.
        if (shown !== CANNOT_WRITE) {
          log(`cannot write down the files passed on: ${failed.message}`, "warn");
        }
        show(CANNOT_WRITE, "red", "ring");
        return;
      }
      show("watching", "green", "dot");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      show("cannot keep track of the folder", "red", "ring");
      log(message, "warn");
    }
  };

  const timer = setInterval(tick, SCAN_MS);
  await run({
    close: () => {
      clearInterval(timer);
    },
  });
}

void main();
