// An ESLint rule for the one way InnyTypes may embed Node-RED (arch_pivot P9–P10, WI-0018-08).
//
// 1. `RED.stop()` followed by `RED.start()` in one process breaks Node-RED: every type becomes
//    "already registered", then "missing", and every flow stops (arch_pivot P9 surprise 1). A
//    runtime that must restart Node-RED exits and is forked again. So, in a file:
//    - `start()` on the Node-RED module is called at most once;
//    - never after a `stop()` in the file's order;
//    - never in a function that also calls `stop()`.
// 2. `RED.nodes` is "the internal nodes module of the runtime… should not be used directly"
//    (node-red/lib/red.js). The documented `RED.runtime.nodes` is used instead.
//
// The rule follows the Node-RED module itself: a default or namespace import of "node-red",
// `require("node-red")`, and plain aliases of either. Destructuring the module is refused, as
// it would hide these calls. The `RED` a node file is handed by Node-RED (the node-module API,
// where `RED.nodes.createNode` is public) is a different object, and not this rule's concern.

const MODULE = "node-red";

/** The property a member expression reads, when it can be known without running the code. */
function propertyName(member) {
  if (!member.computed && member.property.type === "Identifier") {
    return member.property.name;
  }
  if (member.computed && member.property.type === "Literal") {
    return String(member.property.value);
  }
  return null;
}

function isRequireOfNodeRed(node) {
  return (
    node?.type === "CallExpression" &&
    node.callee.type === "Identifier" &&
    node.callee.name === "require" &&
    node.arguments[0]?.type === "Literal" &&
    node.arguments[0].value === MODULE
  );
}

/** The nearest enclosing function, or the program. */
function scopeOf(node) {
  let current = node.parent;
  while (current !== null && current !== undefined) {
    if (
      current.type === "FunctionDeclaration" ||
      current.type === "FunctionExpression" ||
      current.type === "ArrowFunctionExpression"
    ) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

/** @type {import("eslint").Rule.RuleModule} */
const noNodeRedRestart = {
  meta: {
    type: "problem",
    docs: { description: "Embed Node-RED once per process, through its public API only." },
    messages: {
      startAfterStop:
        "RED.start() after RED.stop() in one process breaks Node-RED (arch_pivot P9 surprise 1); restart the runtime process instead.",
      startTwice:
        "RED.start() is called at most once per process (arch_pivot P9 surprise 1); restart the runtime process instead.",
      internalNodes:
        "RED.nodes is Node-RED's internal nodes module; use the documented RED.runtime.nodes (arch_pivot P9–P10 §2).",
      destructured:
        "Do not destructure the Node-RED module: call RED.<name> so its use can be checked.",
    },
    schema: [],
  },
  create(context) {
    const bindings = new Set();
    const aliases = []; // [alias, of]
    const members = [];
    const patterns = [];

    return {
      ImportDeclaration(node) {
        if (node.source.value !== MODULE) {
          return;
        }
        for (const specifier of node.specifiers) {
          if (
            specifier.type === "ImportDefaultSpecifier" ||
            specifier.type === "ImportNamespaceSpecifier"
          ) {
            bindings.add(specifier.local.name);
          } else {
            patterns.push(specifier); // `import { nodes } from "node-red"` is destructuring too
          }
        }
      },
      VariableDeclarator(node) {
        if (node.id.type === "Identifier" && isRequireOfNodeRed(node.init)) {
          bindings.add(node.id.name);
        } else if (node.id.type === "Identifier" && node.init?.type === "Identifier") {
          aliases.push([node.id.name, node.init.name]);
        } else if (node.id.type === "ObjectPattern") {
          if (isRequireOfNodeRed(node.init)) {
            patterns.push(node);
          } else if (node.init?.type === "Identifier") {
            patterns.push({ node, of: node.init.name });
          }
        }
      },
      MemberExpression(node) {
        if (node.object.type === "Identifier") {
          members.push(node);
        }
      },
      "Program:exit"() {
        // Aliases of aliases: follow until nothing new is bound.
        let grew = true;
        while (grew) {
          grew = false;
          for (const [alias, of] of aliases) {
            if (bindings.has(of) && !bindings.has(alias)) {
              bindings.add(alias);
              grew = true;
            }
          }
        }

        for (const pattern of patterns) {
          if (pattern.of === undefined) {
            context.report({ node: pattern, messageId: "destructured" });
          } else if (bindings.has(pattern.of)) {
            context.report({ node: pattern.node, messageId: "destructured" });
          }
        }

        const starts = [];
        const stops = [];
        for (const member of members) {
          if (!bindings.has(member.object.name)) {
            continue;
          }
          const name = propertyName(member);
          if (name === "nodes") {
            context.report({ node: member, messageId: "internalNodes" });
          }
          const call = member.parent;
          if (call?.type !== "CallExpression" || call.callee !== member) {
            continue;
          }
          if (name === "start") {
            starts.push(call);
          } else if (name === "stop") {
            stops.push(call);
          }
        }

        const firstStop = Math.min(...stops.map((call) => call.range[0]));
        const stopScopes = new Set(stops.map(scopeOf));
        starts.forEach((call, index) => {
          const scope = scopeOf(call);
          if (call.range[0] > firstStop || (scope !== null && stopScopes.has(scope))) {
            context.report({ node: call, messageId: "startAfterStop" });
          } else if (index > 0) {
            context.report({ node: call, messageId: "startTwice" });
          }
        });
      },
    };
  },
};

export default {
  meta: { name: "innytypes-node-red" },
  rules: { "no-node-red-restart": noNodeRedRestart },
};
