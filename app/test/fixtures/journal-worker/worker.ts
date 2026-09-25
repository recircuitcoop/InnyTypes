// A worker that writes to the SQLite journal as fast as it can until it is killed, saying on
// stdout what it is about to do and what has returned. journal-kill.test.ts bundles it with
// esbuild, runs it, kills it with SIGKILL at a random moment, and checks the file.
//
// Its writes are the runtime's: an entry put (a new input), put again as awaiting (a present),
// and cleared (a done). argv: the journal file, the id prefix of this run, a start number.
import * as fs from "node:fs";

import { openSqliteJournal } from "../../../src/adapters/sqlite/journal";
import { newEntry, presented } from "../../../src/domain/journal/entry";

const [file, prefix, from] = process.argv.slice(2) as [string, string, string];
const journal = openSqliteJournal(file);

/** One line, written before the next operation starts: a kill cannot reorder these. */
function say(line: string): void {
  fs.writeSync(1, `${line}\n`);
}

say("open");
for (let n = Number(from); ; n += 1) {
  const id = `${prefix}-${String(n)}`;
  const entry = newEntry({
    inputId: id,
    instanceId: `i${String(n % 5)}`,
    type: "inny-kill-test",
    message: { payload: { n, pad: "x".repeat(n % 300) }, topic: "kill.t.v1", _msgid: id },
    now: n,
  });
  say(`begin put ${id}`);
  journal.put(entry);
  say(`done put ${id}`);
  if (n % 3 === 0) {
    say(`begin present ${id}`);
    journal.put(presented(entry, { title: `view ${String(n)}` }, n));
    say(`done present ${id}`);
  }
  if (n % 2 === 0) {
    const old = `${prefix}-${String(n - 2)}`;
    say(`begin clear ${old}`);
    journal.clear(old);
    say(`done clear ${old}`);
  }
}
