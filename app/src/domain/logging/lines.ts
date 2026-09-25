// Text arriving in chunks, as lines: a child's stdout and stderr pipes, read by the shell, and
// a node's stderr, read by the runtime (spec 3.4).
//
// A pipe hands over whatever it holds, so a chunk can end mid-line and a line can span many
// chunks. A line with no end must not grow without bound either: a process that prints a
// gigabyte with no newline would otherwise hold it all in the reader's memory. Past
// MAX_PENDING the rest of the line is dropped until its newline, and the line is marked cut.

/** The longest line kept whole: well above any record, far below a flood. */
export const MAX_PENDING = 64 * 1024;

export interface Line {
  readonly text: string;
  /** The line was longer than MAX_PENDING and its end was dropped. */
  readonly cut: boolean;
}

export class LineSplitter {
  readonly #max: number;
  #pending = "";
  #cut = false;

  constructor(max: number = MAX_PENDING) {
    this.#max = max;
  }

  /** The complete lines `chunk` finishes, without their line ends. */
  push(chunk: string): Line[] {
    const lines: Line[] = [];
    let start = 0;
    for (let end = chunk.indexOf("\n"); end !== -1; end = chunk.indexOf("\n", start)) {
      this.#take(chunk.slice(start, end));
      lines.push(this.#finish());
      start = end + 1;
    }
    this.#take(chunk.slice(start));
    return lines;
  }

  /** What is left when the stream ends: a last line with no newline, or null. */
  end(): Line | null {
    return this.#pending === "" && !this.#cut ? null : this.#finish();
  }

  #take(text: string): void {
    if (this.#cut) {
      return;
    }
    const room = this.#max - this.#pending.length;
    if (text.length > room) {
      this.#pending += text.slice(0, room);
      this.#cut = true;
      return;
    }
    this.#pending += text;
  }

  #finish(): Line {
    // A CRLF line end (a Windows process) is a line end, not a character of the line.
    const text = this.#pending.endsWith("\r") ? this.#pending.slice(0, -1) : this.#pending;
    const line = { text, cut: this.#cut };
    this.#pending = "";
    this.#cut = false;
    return line;
  }
}

/** A stream of text as an adapter hands it over: chunks, then an end. */
export interface TextSource {
  on(event: "data", listener: (chunk: string) => void): unknown;
  on(event: "end", listener: () => void): unknown;
}

/** Call `onLine` for every line `source` delivers, the last one included, until it ends. */
export function forEachLine(source: TextSource, onLine: (line: Line) => void): void {
  const splitter = new LineSplitter();
  source.on("data", (chunk) => {
    for (const line of splitter.push(chunk)) {
      onLine(line);
    }
  });
  source.on("end", () => {
    const last = splitter.end();
    if (last !== null) {
      onLine(last);
    }
  });
}
