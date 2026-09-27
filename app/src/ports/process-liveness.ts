// Whether a recorded process id is still alive (WI-0018-25's helper.lock check). Injected so a
// test can fake a pid that is alive, and one that is not, without touching a real process.

export interface ProcessLiveness {
  isAlive(pid: number): boolean;
}
