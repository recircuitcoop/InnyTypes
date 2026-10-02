// An ESLint rule for plan 0022 §O: a component or a screen never spells its own words. Every
// sentence, label and button a person reads comes from ui/strings.ts by key, so the wording lives
// in one place, matches docs/ux/ux-writing.md, and "no string carries an internal" can see it all.
//
// The rule is react/jsx-no-literals' core, written here because eslint-plugin-react is not a
// dependency and the gate admits no new one for twenty lines. It reports:
// 1. JSX text that is not only whitespace: `<p>Done</p>`;
// 2. a string literal or a template literal as a JSX child, a template literal with expressions
//    included when it spells words of its own: `<p>{"Done"}</p>`, <p>{`${n} notes`}</p>;
// 3. a string literal in an attribute a person reads or hears: aria-label, aria-description,
//    title, placeholder and alt (`<button aria-label="Close">`).
// Class names, test ids, data-* values and every other attribute are not words and pass.

/** The attributes whose value is read or heard by a person. */
const WORDED_ATTRIBUTES = new Set([
  "aria-label",
  "aria-description",
  "title",
  "placeholder",
  "alt",
]);

const isWordedString = (node) =>
  (node.type === "Literal" && typeof node.value === "string" && node.value.trim() !== "") ||
  (node.type === "TemplateLiteral" &&
    node.quasis.some((quasi) => /\p{L}/u.test(quasi.value.cooked ?? "")));

export default {
  rules: {
    "no-jsx-text": {
      meta: {
        type: "problem",
        docs: { description: "Words in components and screens come from ui/strings.ts by key." },
        schema: [],
        messages: {
          text: "JSX text {{text}}: take the words from ui/strings.ts by key (plan 0022 §O).",
          attribute:
            "The {{name}} attribute spells its words: take them from ui/strings.ts by key (plan 0022 §O).",
        },
      },
      create(context) {
        return {
          JSXText(node) {
            if (node.value.trim() !== "") {
              context.report({
                node,
                messageId: "text",
                data: { text: JSON.stringify(node.value.trim()) },
              });
            }
          },
          JSXExpressionContainer(node) {
            if (node.parent?.type === "JSXAttribute") {
              return;
            }
            if (isWordedString(node.expression)) {
              const text = node.expression.type === "Literal" ? node.expression.value : "`…`";
              context.report({ node, messageId: "text", data: { text: JSON.stringify(text) } });
            }
          },
          JSXAttribute(node) {
            const name = node.name.type === "JSXIdentifier" ? node.name.name : null;
            if (name === null || !WORDED_ATTRIBUTES.has(name) || node.value === null) {
              return;
            }
            const value =
              node.value.type === "JSXExpressionContainer" ? node.value.expression : node.value;
            if (isWordedString(value)) {
              context.report({ node, messageId: "attribute", data: { name } });
            }
          },
        };
      },
    },
  },
};
