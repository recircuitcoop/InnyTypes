// vitest for the new application (plan 0018 §1, §6).
//
// Three projects, one per gate stage that runs vitest: unit and integration run together
// with coverage; conformance runs on its own (WI-0018-05). Every project loads the home
// guard first, so no test can write into this user's real home.
import { defineConfig } from "vitest/config";

const HOME_GUARD = "./test/home-guard.ts";

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: { name: "unit", include: ["test/unit/**/*.test.ts"], setupFiles: [HOME_GUARD] },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          setupFiles: [HOME_GUARD],
        },
      },
      {
        extends: true,
        test: {
          name: "conformance",
          include: ["test/conformance/**/*.test.ts"],
          setupFiles: [HOME_GUARD],
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // The composition roots start Electron or a utilityProcess, and the preload bridge runs
      // only in Electron's sandboxed renderer, so no unit test can load them. The e2e stage
      // runs them through the real app instead.
      exclude: [
        "src/shell/main.ts",
        "src/shell/preload.ts",
        "src/runtime/main.ts",
        "src/services/main.ts",
        // The generated types' form code runs only in the Node-RED editor's page; the e2e
        // drives it there (test/e2e/generated-types.e2e.ts).
        "src/adapters/nodered/editor-forms.ts",
      ],
      // The thresholds of plan 0018 §6. A glob's files still count towards the global figure.
      thresholds: {
        lines: 90,
        branches: 85,
        "src/domain/**": { lines: 95, branches: 90 },
        "src/application/**": { lines: 95, branches: 90 },
        "src/{ports,adapters,shell,runtime,services,ui}/**": { lines: 85, branches: 80 },
      },
    },
  },
});
