// Text to a file descriptor, synchronously: how a child hands its log records to the shell.
//
// Not `process.stdout.write`: on macOS a pipe is written asynchronously, so a line can wait
// in the process's own memory and die with it at a kill -9. `fs.writeSync` returns only once
// the bytes are in the pipe. A full pipe on a non-blocking descriptor answers EAGAIN, which is
// waited out briefly rather than dropped.

import fs from "node:fs";

/** How long one full pipe is waited on before the rest of the text is given up. */
const FULL_PIPE_GIVE_UP_MS = 5_000;

const pause = new Int32Array(new SharedArrayBuffer(4));

export function syncWriter(fd: number): (text: string) => void {
  return (text) => {
    const bytes = Buffer.from(text, "utf8");
    let offset = 0;
    let waited = 0;
    while (offset < bytes.length) {
      try {
        offset += fs.writeSync(fd, bytes, offset);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EAGAIN" || waited >= FULL_PIPE_GIVE_UP_MS) {
          throw error;
        }
        Atomics.wait(pause, 0, 0, 1);
        waited += 1;
      }
    }
  };
}
