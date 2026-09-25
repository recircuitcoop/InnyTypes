// A Supervisor wired to fakes, with every status it published recorded.

import { Supervisor } from "../../src/application/supervisor";
import {
  DEFAULT_SUPERVISION,
  type ChildName,
  type ChildStatus,
  type SupervisionSettings,
} from "../../src/domain/supervision/child-state";
import { FakeClock } from "./clock";
import { FakeLauncher, RecordingLogger, RecordingNotifier, type Behaviour } from "./children";

export const TEST_PORT = 18_800;

export function supervised(
  behaviour: Behaviour,
  options: { child?: ChildName; settings?: SupervisionSettings } = {},
) {
  const clock = new FakeClock();
  const launcher = new FakeLauncher(clock, behaviour);
  const logger = new RecordingLogger();
  const notifier = new RecordingNotifier();
  const statuses: ChildStatus[] = [];
  let ids = 0;
  const supervisor = new Supervisor({
    child: options.child ?? "runtime",
    fork: {
      modulePath: "/app/dist/runtime/main.cjs",
      serviceName: "InnyTypes runtime",
      env: { HOME: "/home/test" },
    },
    childSettings: { port: TEST_PORT, userDir: "/user-data" },
    settings: options.settings ?? DEFAULT_SUPERVISION,
    launcher,
    clock,
    logger,
    notifier,
    newId: () => `rid-${String(++ids)}`,
  });
  supervisor.onStatus((status) => statuses.push(status));
  const states = (): string[] => statuses.map((status) => status.state);
  return { clock, launcher, logger, notifier, statuses, states, supervisor };
}
