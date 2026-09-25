// The two rules of plan 0018 §2.3 that are not about imports, so dependency-cruiser cannot
// see them. The architecture stage runs this config over src/ right after depcruise.
//
// Inline `eslint-disable` comments are switched off here: a layer rule that a comment can
// silence is a convention again.
//
// It also holds the one rule about embedding Node-RED (WI-0018-08): never RED.stop() followed
// by RED.start() in one process, and never the internal RED.nodes (eslint-rules/).
import tseslint from "typescript-eslint";
import nodeRedEmbedding from "./eslint-rules/node-red-embedding.mjs";

/** The three composition roots (§2.2), the only files that may read process.env. */
const COMPOSITION_ROOTS = ["src/shell/main.ts", "src/runtime/main.ts", "src/services/main.ts"];

const PROCESS_ENV_MESSAGE =
  "process.env is read only in the three composition roots (plan 0018 §2.3); pass the value in.";

export default [
  {
    files: ["src/**/*.ts"],
    languageOptions: { parser: tseslint.parser },
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: "off" },
    plugins: { "innytypes-node-red": nodeRedEmbedding },
    rules: {
      "innytypes-node-red/no-node-red-restart": "error",
      // No file may exceed 600 lines, blank lines and comments included: no god modules.
      "max-lines": ["error", { max: 600, skipBlankLines: false, skipComments: false }],
      // `process.env.X` and `const { env } = process`.
      "no-restricted-properties": [
        "error",
        { object: "process", property: "env", message: PROCESS_ENV_MESSAGE },
      ],
      // `globalThis.process.env`, which the rule above does not see.
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[property.name='env'][object.property.name='process']",
          message: PROCESS_ENV_MESSAGE,
        },
      ],
      // `import { env } from "node:process"`.
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "node:process", importNames: ["env"], message: PROCESS_ENV_MESSAGE },
            { name: "process", importNames: ["env"], message: PROCESS_ENV_MESSAGE },
          ],
        },
      ],
    },
  },
  {
    files: COMPOSITION_ROOTS,
    rules: {
      "no-restricted-properties": "off",
      "no-restricted-syntax": "off",
      "no-restricted-imports": "off",
    },
  },
];
