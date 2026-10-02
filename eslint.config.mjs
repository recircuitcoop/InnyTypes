// ESLint for the new application's TypeScript and JavaScript (plan 0018 §1, §6 lint stage).
//
// The old Python app is linted by ruff; this config only looks at the new folders. The
// layer rules are not here: they are the architecture stage (app/.dependency-cruiser.cjs and
// app/eslint.architecture.config.mjs).
import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/",
      "**/dist/",
      "**/coverage/",
      "app/test-results/",
      "app/playwright-report/",
      "app/test/fixtures/",
      // Packaging output (git-ignored): fetched runtimes and electron-builder's scratch under
      // app/build/, its packaged artefacts under app/release/. The owner lifted the no-ignores
      // rule for build output (decision 15).
      "app/build/",
      "app/release/",
      // Everything outside the new application's folders belongs to the old app.
      "src/",
      "tests/",
      "docs/",
      "build/",
      ".venv/",
      ".briefcase/",
      ".claude/",
      ".serena/",
      "scan-output/",
    ],
  },
  eslint.configs.recommended,
  {
    // .tsx too: the React components (plan 0022 §J) are .tsx, and were linted by nothing until
    // WI-0022-10 widened this.
    files: ["**/*.{ts,tsx}"],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: { globals: globals.node },
  },
);
