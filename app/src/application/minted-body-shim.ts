// The unwrap shim (plan 0023, WI-0023-02): one named step of mcpDispatch's tools/call branch,
// run on a call's params just before they are forwarded to the child.
//
// TEMPORARY. The pinned @anyproto/anytype-mcp mints a `body` argument for every tool whose JSON
// request body is not a flat object with properties (MINTED_BODY_TOOLS, the inventory of
// WI-0023-01), and its HTTP client then sends `{"body": {...}}` as the request body, which
// Anytype's API refuses as an unknown key. The child's HTTP client builds the request body from
// every argument that is not a path or query parameter of the operation, so a call whose
// arguments carry the document's members flat, next to `space_id` and the other parameters,
// reaches Anytype as the document itself. This step does exactly that, for those five tools:
//
// * a call to a tool in MINTED_BODY_TOOLS whose `body` argument is an object is forwarded with
//   that object's members in place of `body`, every other argument as it came;
// * a member of `body` that shares its name with another argument of the call, or with any
//   parameter the tool's listed schema declares, is refused here and nothing is forwarded: sent
//   flat, the child would take it for that parameter and it would never reach the body;
// * every other call (another tool, no `body`, a `body` that is not an object) is forwarded
//   exactly as it came, the same object.
//
// Remove it, with its tests, once the pinned package sends a minted `body` unwrapped itself
// (the upstream patch to src/client/http-client.ts is the owner's). Every pin move re-records
// tool_surface.json, which fails the inventory's pin (INVENTORIED_SURFACE): that is the moment
// to check whether the new child still sends `body` wrapped, and to drop this step if not.

import { MINTED_BODY_TOOLS } from "../domain/anytype/minted-body";
import type { McpTool } from "../ports/anytype";

type Json = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export type UnwrapOutcome =
  | { readonly kind: "forward"; readonly params: Json }
  /** A `body` member that cannot be sent flat: what it clashes with, in words for the client. */
  | { readonly kind: "refused"; readonly message: string };

/** The names the tool's listed schema declares besides `body`: its path, query and header ones. */
function parameterNames(tool: McpTool): readonly string[] {
  const properties = tool.inputSchema["properties"];
  return isObject(properties) ? Object.keys(properties).filter((key) => key !== "body") : [];
}

/**
 * `params` as they should reach the child: a minted tool's `body` spread flat into its
 * arguments, or the refusal of one whose members clash with a parameter. Every other call comes
 * back as it came, the same object.
 */
export function unwrapMintedBody(tool: McpTool, params: Json): UnwrapOutcome {
  const name = params["name"];
  const args = params["arguments"];
  if (typeof name !== "string" || !Object.hasOwn(MINTED_BODY_TOOLS, name) || !isObject(args)) {
    return { kind: "forward", params };
  }
  const { body, ...rest } = args;
  if (!isObject(body)) {
    // Nothing to unwrap (already flat, or not a document); forwarded for Anytype to judge.
    return { kind: "forward", params };
  }
  const parameters = parameterNames(tool);
  const clashing = Object.keys(body).filter(
    (key) => parameters.includes(key) || Object.hasOwn(rest, key),
  );
  if (clashing.length > 0) {
    const named = clashing.map((key) => JSON.stringify(key)).join(", ");
    return {
      kind: "refused",
      message:
        `${name}: body member ${named} is also an argument of the tool; InnyTypes sends the ` +
        `body flat (the pinned child would send it wrapped), so it cannot be told apart ` +
        `(refused by InnyTypes, nothing was forwarded)`,
    };
  }
  return { kind: "forward", params: { ...params, arguments: { ...rest, ...body } } };
}
