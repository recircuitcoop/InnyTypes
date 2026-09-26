// The crash-loop limit end to end, without Electron (plan 0018 §7): a fake child that exits
// at once is restarted with backoff until 5 crashes fall inside 2 minutes. Then the state is
// down-for-good, the status page (driven only through AppApi) shows the error and a Restart
// button, exactly one notice is raised, and pressing Restart starts the child again.
import { ANYTYPE_UNUSED } from "../fakes/anytype";
import { VIEWS_UNUSED } from "../fakes/views";
import { describe, expect, it } from "vitest";
import { Supervisor } from "../../src/application/supervisor";
import {
  crashLoopMessage,
  DEFAULT_SUPERVISION,
  type ChildName,
} from "../../src/domain/supervision/child-state";
import type { Notifier } from "../../src/ports/notifier";
import type { AppApi, ChildStatus } from "../../src/ui/contract";
import { mountStatusPage, type StatusRoot } from "../../src/ui/pages/status";
import {
  exitsAtOnce,
  FakeLauncher,
  obedient,
  RecordingLogger,
  RecordingNotifier,
  type Behaviour,
} from "../fakes/children";
import { compose } from "../../src/domain/notices/notices";
import { FakeClock } from "../fakes/clock";
import { supervised } from "../fakes/supervised";

/** AppApi over one supervisor, the way the shell's IPC handlers and preload bridge do it. */
function appApiOver(supervisor: Supervisor): AppApi {
  return {
    childStatus: () => Promise.resolve([supervisor.status()]),
    onChildStatus: (listener) => {
      supervisor.onStatus((status: ChildStatus) => {
        listener(status);
      });
    },
    restartChild: (child) => {
      if (child === supervisor.child) {
        supervisor.recover();
      }
      return Promise.resolve();
    },
    secretStorage: () => Promise.resolve({ backend: "keychain", reason: null }),
    launchAtLogin: () => Promise.resolve({ on: false, problem: null }),
    setLaunchAtLogin: (on) => Promise.resolve({ on, problem: null }),
    ...ANYTYPE_UNUSED,
    ...VIEWS_UNUSED,
  };
}

class Page implements StatusRoot {
  innerHTML = "";
  #click: (event: { readonly target: unknown }) => void = () => undefined;
  addEventListener(_type: "click", listener: (event: { readonly target: unknown }) => void) {
    this.#click = listener;
  }
  /** Press the element with this data-testid, if the page shows one. */
  press(testId: string): boolean {
    const match = new RegExp(`data-testid="${testId}" data-restart="([a-z]+)"`).exec(
      this.innerHTML,
    );
    if (match === null) {
      return false;
    }
    this.#click({ target: { getAttribute: () => match[1] } });
    return true;
  }
}

describe("the crash-loop limit", () => {
  it("stops restarting a child that exits at once, shows Restart, and raises one notice", async () => {
    const harness = supervised(exitsAtOnce);
    const { clock, launcher, notifier, supervisor, states, logger } = harness;
    const page = new Page();
    await mountStatusPage(page, appApiOver(supervisor));

    supervisor.start();
    // Five crashes: at 0, then after 250, 500, 750 and 1000 ms of backoff (2.5 s in all),
    // well inside the 2-minute window.
    clock.advance(2_500);
    expect(launcher.children).toHaveLength(5);
    expect(supervisor.status().state).toBe("down-for-good");
    expect(states()).toEqual([
      "starting",
      "down",
      "recovering",
      "down",
      "recovering",
      "down",
      "recovering",
      "down",
      "recovering",
      "down-for-good",
    ]);

    // Nothing more is forked, however long it waits.
    clock.advance(3_600_000);
    expect(launcher.children).toHaveLength(5);
    expect(clock.pending).toBe(0);

    // One notice, and the page shows the error and the Restart button.
    const message = crashLoopMessage("runtime", DEFAULT_SUPERVISION.crashLoop);
    expect(notifier.notices).toEqual([
      { kind: "child-stopped", subject: "runtime", detail: message },
    ]);
    expect(message).toBe(
      "The InnyTypes runtime stopped unexpectedly 5 times in 2 minutes, so it is no longer " +
        "restarted. Press Restart to try again.",
    );
    expect(page.innerHTML).toContain(`data-testid="child-error-runtime">${message}</p>`);
    expect(page.innerHTML).toContain('data-testid="child-restart-runtime"');
    // Said once, with the exit code the child last died with.
    expect(logger.lines.filter((line) => line.includes("crash-loop limit reached"))).toEqual([
      "ERROR the runtime exited unexpectedly (code 1); crash-loop limit reached, no more restarts",
    ]);

    // Restart: the child now behaves, so it comes up and the error goes.
    launcher.behaviour = obedient;
    expect(page.press("child-restart-runtime")).toBe(true);
    clock.advance(1);
    expect(supervisor.status()).toMatchObject({ state: "running", generation: 6, error: null });
    expect(page.innerHTML).not.toContain("child-restart-runtime");
    expect(page.innerHTML).toContain('data-testid="child-state-runtime">running</p>');
    expect(notifier.notices).toHaveLength(1);
  });

  it("gives a restarted child the whole limit again, and a second trip a second notice", () => {
    const { clock, launcher, notifier, supervisor } = supervised(exitsAtOnce);
    supervisor.start();
    clock.advance(2_500);
    expect(supervisor.status().state).toBe("down-for-good");

    expect(supervisor.recover()).toBe(true);
    clock.advance(1_000); // four crashes: 0, +250, +500 (750), +750 (1500) is past 1000
    expect(supervisor.status().state).not.toBe("down-for-good");
    clock.advance(1_500);
    expect(launcher.children).toHaveLength(10);
    expect(supervisor.status().state).toBe("down-for-good");
    expect(notifier.notices).toHaveLength(2);
  });

  it("does not trip when the crashes are spread wider than the window", () => {
    const { clock, launcher, supervisor, notifier } = supervised(obedient);
    supervisor.start();
    clock.advance(1);
    // One crash every 40 s: never five inside two minutes.
    for (let crash = 0; crash < 10; crash++) {
      launcher.current.exit(1);
      clock.advance(40_000);
      expect(supervisor.status().state, `crash ${String(crash)}`).toBe("running");
    }
    expect(notifier.notices).toEqual([]);
  });

  it("counts each child apart: one stopped for good leaves the other running", () => {
    // Both children on one clock, the way the shell runs them; only the runtime crashes.
    const clock = new FakeClock();
    const logger = new RecordingLogger();
    const notifier = new RecordingNotifier();
    const make = (child: ChildName, behaviour: Behaviour) => {
      const launcher = new FakeLauncher(clock, behaviour);
      const supervisor = new Supervisor({
        child,
        fork: { modulePath: `/dist/${child}/main.cjs`, serviceName: child, env: {} },
        childSettings: { port: null, userDir: "/u" },
        settings: DEFAULT_SUPERVISION,
        launcher,
        clock,
        logger,
        notifier,
        newId: () => "rid",
      });
      supervisor.start();
      return { launcher, supervisor };
    };
    const runtime = make("runtime", exitsAtOnce);
    const services = make("services", obedient);

    clock.advance(2_500);
    expect(runtime.supervisor.status().state).toBe("down-for-good");
    expect(services.supervisor.status()).toMatchObject({ state: "running", generation: 1 });
    expect(services.launcher.children).toHaveLength(1);
    expect(notifier.notices.map((notice) => compose(notice).title)).toEqual([
      "InnyTypes stopped restarting the runtime",
    ]);

    // The services process then crashes once: its own first crash, not the runtime's sixth.
    services.launcher.current.exit(1);
    expect(services.supervisor.status().state).toBe("down");
    clock.advance(251);
    expect(services.supervisor.status().state).toBe("running");
  });

  it("is down for good, with its error, even when the notice cannot be raised", () => {
    const clock = new FakeClock();
    const logger = new RecordingLogger();
    const refusing: Notifier = {
      raise: () => {
        throw new Error("notifications are switched off");
      },
      clear: () => undefined,
    };
    const throwing = new Supervisor({
      child: "runtime",
      fork: { modulePath: "/m", serviceName: "s", env: {} },
      childSettings: { port: null, userDir: "/u" },
      settings: DEFAULT_SUPERVISION,
      launcher: new FakeLauncher(clock, exitsAtOnce),
      clock,
      logger,
      notifier: refusing,
      newId: () => "rid",
    });
    throwing.start();
    clock.advance(2_500);
    expect(throwing.status().state).toBe("down-for-good");
    expect(throwing.status().error).toContain("5 times in 2 minutes");
    expect(logger.lines).toContain(
      "ERROR the crash-loop notice could not be raised: Error: notifications are switched off",
    );
  });

  it("is refused by recover unless the child is down for good", () => {
    const { clock, supervisor } = supervised(obedient);
    expect(supervisor.recover()).toBe(false);
    supervisor.start();
    clock.advance(1);
    expect(supervisor.recover()).toBe(false);
  });
});
