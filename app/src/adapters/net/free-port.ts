// The runtime's stable port (plan 0018 §2.2): the shell asks the OS for one free loopback
// port at launch and gives it to every runtime generation, so the editor's URL never
// changes across restarts (arch_pivot P11b).

import { createServer } from "node:net";

export const LOOPBACK = "127.0.0.1";

/** A port that was free on 127.0.0.1 a moment ago: bound to port 0, read, and released. */
export function pickFreeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, LOOPBACK, () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === "string") {
          reject(new Error("the OS gave no TCP port for 127.0.0.1"));
          return;
        }
        resolve(address.port);
      });
    });
  });
}
