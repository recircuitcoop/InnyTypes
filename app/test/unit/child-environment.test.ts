// Every child's whole environment (shell/child-environment.ts): HOME, the log canary, the
// services' own variables, the packaged runtimes, and the runtime's templates folder only with
// the e2e gate's hooks on.
import { describe, expect, it } from "vitest";
import { childEnvironment } from "../../src/shell/child-environment";

const ENV = {
  INNYTYPES_LOG_CANARY: "canary",
  ANYTYPE_API_BASE_URL: "http://127.0.0.1:9",
  INNYTYPES_MCP_PORT: "",
  INNYTYPES_TEMPLATES_DIR: "/fixtures/templates",
  PATH: "/usr/bin",
};

describe("childEnvironment", () => {
  it("hands the services their variables, never the shell's whole environment", () => {
    expect(
      childEnvironment("services", { home: "/h", env: ENV, runtimesDir: null, e2eHooks: true }),
    ).toEqual({
      HOME: "/h",
      INNYTYPES_LOG_CANARY: "canary",
      ANYTYPE_API_BASE_URL: "http://127.0.0.1:9",
    });
  });

  it("hands the runtime the templates folder only with the e2e hooks on", () => {
    expect(
      childEnvironment("runtime", { home: "/h", env: ENV, runtimesDir: "/rt", e2eHooks: true }),
    ).toEqual({
      HOME: "/h",
      INNYTYPES_LOG_CANARY: "canary",
      INNYTYPES_TEMPLATES_DIR: "/fixtures/templates",
      INNYTYPES_RUNTIMES_DIR: "/rt",
    });
    expect(
      childEnvironment("runtime", { home: "/h", env: {}, runtimesDir: null, e2eHooks: false }),
    ).toEqual({ HOME: "/h" });
    expect(
      childEnvironment("runtime", { home: "/h", env: ENV, runtimesDir: null, e2eHooks: false }),
    ).not.toHaveProperty("INNYTYPES_TEMPLATES_DIR");
  });
});
