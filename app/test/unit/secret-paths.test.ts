// The Anytype key and proxy token paths travel in `init` (WI-0018-18's incident hardening): the
// shell resolves them once from its own HOME, and the services process looks nothing up itself.
import { describe, expect, it } from "vitest";
import { Supervisor } from "../../src/application/supervisor";
import { parseShellMessage } from "../../src/domain/channel/messages";
import { DEFAULT_SUPERVISION } from "../../src/domain/supervision/child-state";
import { FakeLauncher, obedient, RecordingLogger, RecordingNotifier } from "../fakes/children";
import { FakeClock } from "../fakes/clock";

const FILES = {
  "anytype-api-key": { file: "/scratch/.config/innytypes/anytype_api_key", legacy: "/l/key" },
  "mcp-proxy-token": { file: "/scratch/.config/innytypes/mcp_proxy_token" },
};
const CONFIG = { generation: 1, port: null, userDir: "/u", restart: null, forkedAt: 0 };

describe("secret paths in init", () => {
  it("are accepted in their own shape and refused in any other", () => {
    expect(
      parseShellMessage({ v: 1, t: "init", config: { ...CONFIG, secretFiles: FILES } }),
    ).toEqual({ v: 1, t: "init", config: { ...CONFIG, secretFiles: FILES } });
    for (const secretFiles of [
      [],
      { "anytype-api-key": { file: "" } },
      { "anytype-api-key": { file: 1 } },
      { "anytype-api-key": { file: "/k", legacy: 2 } },
      { "some-other-secret": { file: "/k" } },
      { "anytype-api-key": "/k" },
    ]) {
      expect(parseShellMessage({ v: 1, t: "init", config: { ...CONFIG, secretFiles } })).toBeNull();
    }
  });

  it("reach the services process in every generation's init", () => {
    const clock = new FakeClock();
    const launcher = new FakeLauncher(clock, obedient);
    const supervisor = new Supervisor({
      child: "services",
      fork: {
        modulePath: "/app/dist/services/main.cjs",
        serviceName: "InnyTypes services",
        env: {},
      },
      childSettings: { port: null, userDir: "/u", secretFiles: FILES },
      settings: DEFAULT_SUPERVISION,
      launcher,
      clock,
      logger: new RecordingLogger(),
      notifier: new RecordingNotifier(),
      newId: () => "rid",
    });
    supervisor.start();
    clock.advance(1);
    launcher.current.exit(1);
    clock.advance(1_000);
    expect(launcher.children).toHaveLength(2);
    for (const child of launcher.children) {
      expect(child.posted[0]).toMatchObject({ t: "init", config: { secretFiles: FILES } });
    }
  });
});
