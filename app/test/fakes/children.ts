// Fake children for the supervisor: a launcher whose children do what a test says, on the
// fake clock, so a crash, a restart or a hang is a scripted event rather than a real process.

import type { ShellMessage } from "../../src/domain/channel/messages";
import type { Logger } from "../../src/ports/logger";
import type { Notice, Notifier } from "../../src/ports/notifier";
import type { ChildHandle, ForkSpec, ProcessLauncher } from "../../src/ports/process-launcher";
import type { FakeClock } from "./clock";

export class FakeChild implements ChildHandle {
  readonly posted: ShellMessage[] = [];
  kills = 0;
  exited = false;
  readonly #messageListeners: ((raw: unknown) => void)[] = [];
  readonly #exitListeners: ((code: number) => void)[] = [];
  readonly #onPost: (child: FakeChild, message: ShellMessage) => void;

  constructor(
    readonly pid: number,
    onPost: (child: FakeChild, message: ShellMessage) => void,
  ) {
    this.#onPost = onPost;
  }

  post(message: ShellMessage): void {
    this.posted.push(message);
    this.#onPost(this, message);
  }

  kill(): void {
    this.kills += 1;
  }

  onMessage(listener: (raw: unknown) => void): void {
    this.#messageListeners.push(listener);
  }

  onExit(listener: (code: number) => void): void {
    this.#exitListeners.push(listener);
  }

  /** The child posts `raw` to the shell. */
  send(raw: unknown): void {
    for (const listener of this.#messageListeners) {
      listener(raw);
    }
  }

  /** The child is gone with `code`. */
  exit(code: number): void {
    this.exited = true;
    for (const listener of this.#exitListeners) {
      listener(code);
    }
  }
}

/** What a fake child does: at fork, and on each message the shell posts to it. */
export interface Behaviour {
  onFork?(child: FakeChild, clock: FakeClock): void;
  onPost?(child: FakeChild, message: ShellMessage, clock: FakeClock): void;
}

/** Obeys the channel, answering one tick later: ready on init, stopped then exit on stop. */
export const obedient: Behaviour = {
  onPost(child, message, clock) {
    clock.after(1, () => {
      switch (message.t) {
        case "init":
          child.send({
            v: 1,
            t: "ready",
            pid: child.pid,
            generation: message.config.generation,
            port: message.config.port,
          });
          return;
        case "stop":
          child.send({ v: 1, t: "stopped", reason: message.reason });
          child.exit(0);
          return;
        case "call":
          child.send({
            v: 1,
            t: "reply",
            rid: message.rid,
            result: { ok: true, value: message.op },
          });
          return;
      }
    });
  },
};

/** Exits with code 1 the moment it starts: the crash loop. */
export const exitsAtOnce: Behaviour = {
  onFork(child, clock) {
    clock.after(0, () => {
      child.exit(1);
    });
  },
};

/** Comes up, then ignores everything: never replies, never stops. */
export const deaf: Behaviour = {
  onPost(child, message, clock) {
    if (message.t === "init") {
      obedient.onPost?.(child, message, clock);
    }
  },
};

export class FakeLauncher implements ProcessLauncher {
  readonly children: FakeChild[] = [];
  readonly specs: ForkSpec[] = [];
  behaviour: Behaviour;
  readonly #clock: FakeClock;
  #nextPid = 1000;

  constructor(clock: FakeClock, behaviour: Behaviour) {
    this.#clock = clock;
    this.behaviour = behaviour;
  }

  fork(spec: ForkSpec): ChildHandle {
    const behaviour = this.behaviour;
    const child = new FakeChild(this.#nextPid++, (self, message) =>
      behaviour.onPost?.(self, message, this.#clock),
    );
    this.specs.push(spec);
    this.children.push(child);
    behaviour.onFork?.(child, this.#clock);
    return child;
  }

  /** The newest child. */
  get current(): FakeChild {
    const child = this.children.at(-1);
    if (child === undefined) {
      throw new Error("nothing was forked");
    }
    return child;
  }
}

export class RecordingLogger implements Logger {
  readonly lines: string[] = [];
  info(message: string): void {
    this.lines.push(`INFO ${message}`);
  }
  warn(message: string): void {
    this.lines.push(`WARN ${message}`);
  }
  error(message: string): void {
    this.lines.push(`ERROR ${message}`);
  }
}

export class RecordingNotifier implements Notifier {
  readonly notices: Notice[] = [];
  readonly cleared: string[] = [];
  raise(notice: Notice): void {
    this.notices.push(notice);
  }
  clear(kind: Notice["kind"], subject: string): void {
    this.cleared.push(`${kind} ${subject}`);
  }
}
