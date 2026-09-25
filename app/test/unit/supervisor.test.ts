// The generic supervisor (plan 0018 §2.2, spec 10.4–10.8), against fake children on a fake
// clock: explicit fork settings, the stable port, planned stops, quit and its kill deadline.
import { describe, expect, it } from "vitest";
import type { ShellMessage } from "../../src/domain/channel/messages";
import { CHILD_NAMES, isChildName } from "../../src/domain/supervision/child-state";
import { deaf, obedient, type Behaviour } from "../fakes/children";
import { supervised, TEST_PORT } from "../fakes/supervised";

describe("the supervised children", () => {
  it("are the runtime and the services process, and nothing else", () => {
    expect(CHILD_NAMES).toEqual(["runtime", "services"]);
    expect(CHILD_NAMES.every(isChildName)).toBe(true);
    for (const other of ["shell", "", null, 1]) {
      expect(isChildName(other)).toBe(false);
    }
  });
});

const inits = (posted: ShellMessage[]) =>
  posted.flatMap((message) => (message.t === "init" ? [message.config] : []));

describe("forking", () => {
  it("forks with exactly the settings it was given, env included", () => {
    const { supervisor, launcher } = supervised(obedient);
    supervisor.start();
    expect(launcher.specs).toEqual([
      {
        modulePath: "/app/dist/runtime/main.cjs",
        serviceName: "InnyTypes runtime",
        env: { HOME: "/home/test" },
      },
    ]);
  });

  it("sends init first, with the generation, port and user dir", () => {
    const { supervisor, launcher, clock } = supervised(obedient);
    clock.advance(42);
    supervisor.start();
    expect(launcher.current.posted[0]).toEqual({
      v: 1,
      t: "init",
      config: {
        generation: 1,
        port: TEST_PORT,
        userDir: "/user-data",
        restart: null,
        forkedAt: 42,
      },
    });
  });

  it("forks once however often start is called", () => {
    const { supervisor, launcher } = supervised(obedient);
    supervisor.start();
    supervisor.start();
    expect(launcher.children).toHaveLength(1);
  });

  it("is running once the child says ready, with the pid and port it reported", () => {
    const { supervisor, launcher, clock, states } = supervised(obedient);
    supervisor.start();
    expect(supervisor.status()).toMatchObject({ state: "starting", pid: null, port: null });
    clock.advance(1);
    expect(supervisor.status()).toEqual({
      child: "runtime",
      state: "running",
      generation: 1,
      pid: launcher.current.pid,
      port: TEST_PORT,
      error: null,
    });
    expect(states()).toEqual(["starting", "running"]);
  });
});

describe("the stable port", () => {
  it("is the same for every generation: after a crash and after a planned restart", () => {
    const { supervisor, launcher, clock } = supervised(obedient);
    supervisor.start();
    clock.advance(1);
    launcher.current.exit(1); // a crash
    clock.advance(251);
    expect(supervisor.restart("types")).toBe(true); // a planned restart
    clock.advance(2);

    const configs = launcher.children.flatMap((child) => inits(child.posted));
    expect(configs.map((config) => config.generation)).toEqual([1, 2, 3]);
    expect(configs.map((config) => config.port)).toEqual([TEST_PORT, TEST_PORT, TEST_PORT]);
    expect(supervisor.status()).toMatchObject({ state: "running", generation: 3, port: TEST_PORT });
  });
});

describe("the credential secret (WI-0018-06)", () => {
  it("is handed to every generation in init, the same one each time", () => {
    const secret = "fake-credential-secret-0f1e2d3c";
    const { supervisor, launcher, clock } = supervised(obedient, { credentialSecret: secret });
    supervisor.start();
    clock.advance(1);
    launcher.current.exit(1); // a crash
    clock.advance(251);
    expect(supervisor.restart("types")).toBe(true);
    clock.advance(2);

    const configs = launcher.children.flatMap((child) => inits(child.posted));
    expect(configs.map((config) => config.credentialSecret)).toEqual([secret, secret, secret]);
  });

  it("is absent from init when the child was given none", () => {
    const { supervisor, launcher } = supervised(obedient);
    supervisor.start();
    expect(inits(launcher.current.posted)[0]).not.toHaveProperty("credentialSecret");
  });
});

describe("a planned restart", () => {
  it("stops the child, forks the next generation with the restart info, and never counts", () => {
    const { supervisor, launcher, clock, states, notifier } = supervised(obedient);
    supervisor.start();
    clock.advance(1);
    const info = { reason: "types", added: ["x.v1"], removed: [], requestedAt: 1 };

    // Far more planned restarts than the crash-loop limit: none of them is a crash.
    for (let restart = 0; restart < 8; restart++) {
      expect(supervisor.restart("types", info)).toBe(true);
      clock.advance(2);
    }
    expect(supervisor.status()).toMatchObject({ state: "running", generation: 9 });
    expect(notifier.notices).toEqual([]);
    expect(launcher.children[0]?.posted).toContainEqual({ v: 1, t: "stop", reason: "types" });
    expect(inits(launcher.current.posted)[0]?.restart).toEqual(info);
    expect(states().slice(1, 5)).toEqual([
      "running",
      "restarting-planned",
      "restarting",
      "running",
    ]);
  });

  it("makes up restart info when none is given", () => {
    const { supervisor, launcher, clock } = supervised(obedient);
    supervisor.start();
    clock.advance(10);
    supervisor.restart("restart");
    clock.advance(1);
    expect(inits(launcher.current.posted)[0]?.restart).toEqual({
      reason: "restart",
      added: [],
      removed: [],
      requestedAt: 10,
    });
  });

  it("kills a child that does not stop within 10 s, then carries on", () => {
    const { supervisor, launcher, clock } = supervised(deaf);
    supervisor.start();
    clock.advance(1);
    supervisor.restart("types");
    const old = launcher.current;
    clock.advance(9_999);
    expect(old.kills).toBe(0);
    clock.advance(1);
    expect(old.kills).toBe(1);
    old.exit(137);
    expect(launcher.children).toHaveLength(2);
    expect(supervisor.status().state).toBe("restarting");
  });

  it("is refused unless the child is running", () => {
    const { supervisor } = supervised(obedient);
    expect(supervisor.restart("types")).toBe(false);
    supervisor.start();
    expect(supervisor.restart("types")).toBe(false);
  });
});

describe("quit", () => {
  it("sends stop quit and settles once the child is gone", async () => {
    const { supervisor, launcher, clock } = supervised(obedient);
    supervisor.start();
    clock.advance(1);
    const stopped = supervisor.stop();
    expect(launcher.current.posted.at(-1)).toEqual({ v: 1, t: "stop", reason: "quit" });
    clock.advance(1);
    await stopped;
    expect(supervisor.status().state).toBe("stopped");
    expect(launcher.current.kills).toBe(0);
    expect(launcher.children).toHaveLength(1); // nothing is restarted after quit
    expect(clock.pending).toBe(0);
  });

  it("kills a child still alive 10 s after stop quit", async () => {
    const { supervisor, launcher, clock, logger } = supervised(deaf);
    supervisor.start();
    clock.advance(1);
    const stopped = supervisor.stop();
    clock.advance(9_999);
    expect(launcher.current.kills).toBe(0);
    clock.advance(1);
    expect(launcher.current.kills).toBe(1);
    expect(logger.lines).toContain("WARN the runtime did not stop in 10000 ms; killing it");
    launcher.current.exit(137);
    await stopped;
    expect(supervisor.status().state).toBe("stopped");
  });

  it("cancels a crash restart that is waiting for its backoff", async () => {
    const { supervisor, launcher, clock } = supervised(obedient);
    supervisor.start();
    clock.advance(1);
    launcher.current.exit(1);
    await supervisor.stop();
    clock.advance(60_000);
    expect(launcher.children).toHaveLength(1);
    expect(supervisor.status().state).toBe("stopped");
  });

  it("treats a crash during quit as the quit: not restarted, not counted as a crash", async () => {
    // A child that dies with code 1 the instant `stop` reaches it, before `stop()` returns:
    // the quit must already be on record when the stop leaves.
    const crashesOnStop: Behaviour = {
      onPost(child, message, clock) {
        if (message.t === "stop") {
          child.exit(1);
          return;
        }
        obedient.onPost?.(child, message, clock);
      },
    };
    const { supervisor, launcher, clock, logger, notifier } = supervised(crashesOnStop);
    supervisor.start();
    clock.advance(1);
    await supervisor.stop();
    clock.advance(60_000);
    expect(supervisor.status().state).toBe("stopped");
    expect(launcher.children).toHaveLength(1);
    expect(logger.lines).toContain("INFO the runtime exited (code 1) on quit");
    expect(logger.lines.filter((line) => line.includes("unexpectedly"))).toEqual([]);
    expect(notifier.notices).toEqual([]);
  });

  it("restarts the same exit when no quit is under way", () => {
    const { supervisor, launcher, clock, logger } = supervised(obedient);
    supervisor.start();
    clock.advance(1);
    launcher.current.exit(1);
    clock.advance(251);
    expect(launcher.children).toHaveLength(2);
    expect(supervisor.status().state).toBe("running");
    expect(logger.lines).toContain(
      "ERROR the runtime exited unexpectedly (code 1); restart 1 in 250 ms",
    );
  });

  it("answers every caller, however often it is asked", async () => {
    const { supervisor, clock } = supervised(obedient);
    supervisor.start();
    clock.advance(1);
    const first = supervisor.stop();
    const second = supervisor.stop();
    clock.advance(1);
    await Promise.all([first, second]);
    expect(supervisor.status().state).toBe("stopped");
  });

  it("wins over a planned restart in progress", async () => {
    const { supervisor, launcher, clock } = supervised(obedient);
    supervisor.start();
    clock.advance(1);
    supervisor.restart("types");
    const stopped = supervisor.stop();
    clock.advance(1);
    await stopped;
    expect(launcher.children).toHaveLength(1);
    expect(supervisor.status().state).toBe("stopped");
  });

  it("does not report running for a ready that arrives during quit", () => {
    const { supervisor, clock } = supervised(obedient);
    supervisor.start();
    void supervisor.stop();
    clock.advance(1);
    expect(supervisor.status().state).not.toBe("running");
  });
});

describe("what the child says", () => {
  it("ignores and logs a message the channel does not know", () => {
    const { supervisor, launcher, clock, logger } = supervised(obedient);
    supervisor.start();
    launcher.current.send({ v: 2, t: "ready", pid: 1, generation: 1, port: null });
    launcher.current.send("hello");
    expect(supervisor.status().state).toBe("starting");
    expect(logger.lines.filter((line) => line.includes("does not know"))).toHaveLength(2);
    clock.advance(1);
    expect(supervisor.status().state).toBe("running");
  });

  it("logs failed and stopped", () => {
    const { supervisor, launcher, logger } = supervised(deaf);
    supervisor.start();
    launcher.current.send({ v: 1, t: "failed", error: "port taken" });
    launcher.current.send({ v: 1, t: "stopped", reason: "restart" });
    expect(logger.lines).toContain("ERROR the runtime failed to start: port taken");
    expect(logger.lines).toContain("INFO the runtime stopped (restart)");
  });

  it("ignores everything from a generation it has moved on from", () => {
    const { supervisor, launcher, clock } = supervised(obedient);
    supervisor.start();
    clock.advance(1);
    const old = launcher.current;
    old.exit(1);
    clock.advance(252);
    expect(supervisor.status()).toMatchObject({ state: "running", generation: 2 });

    old.send({ v: 1, t: "ready", pid: 1, generation: 1, port: null });
    old.exit(1);
    expect(supervisor.status()).toMatchObject({ state: "running", generation: 2 });
    expect(launcher.children).toHaveLength(2);
  });
});

describe("the runtime's view messages (WI-0018-10)", () => {
  it("present and pending reach every view listener", () => {
    const { supervisor, launcher, clock } = supervised(obedient);
    const heard: unknown[] = [];
    supervisor.onViewEvent((event) => heard.push(event));
    supervisor.start();
    clock.advance(1);
    const present = { v: 1, t: "present", id: "i", window: "inline", first: true, title: "T" };
    launcher.current.send(present);
    launcher.current.send({ v: 1, t: "pending", count: 1 });
    expect(heard).toEqual([present, { v: 1, t: "pending", count: 1 }]);
  });
});
