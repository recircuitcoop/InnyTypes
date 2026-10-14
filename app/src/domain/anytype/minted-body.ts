// The pinned tools whose request body the child wraps under a `body` argument (plan 0023,
// WI-0023-01). @anyproto/anytype-mcp flattens a JSON request body into the tool's inputSchema
// only when it is `type: object` with `properties`; any other body (an anyOf, or an object
// with no properties) is put whole under a minted `body` property, and the child's HTTP client
// then sends it still wrapped, so Anytype refuses `body` as an unknown key.
//
// The list is a property of the pinned surface, not of any report: it was read off the child's
// tools/list and checked against tool_surface.json signature by signature. It holds only for
// the surface it was taken against, so INVENTORIED_SURFACE names that surface, and the unit test
// fails the moment tool_surface.json is re-recorded, until the inventory is taken again.

/** What a minted `body` holds, as the pinned schema describes it. */
export type MintedBodyShape = "anyOf" | "object-without-properties";

export interface MintedBodyTool {
  readonly shape: MintedBodyShape;
  /** The forms the schema offers under `body`, in its order. */
  readonly forms: readonly string[];
}

/** sha256 over the canonical JSON of tool_surface.json's `tools` map this list was taken from. */
export const INVENTORIED_SURFACE =
  "sha256:c54d55fcb07013f07073f9d1933935992a546fa31da2b538206f2b1f23f40a4d";

/** Every pinned tool with a minted `body` argument; every other tool's body is flattened. */
export const MINTED_BODY_TOOLS: Readonly<Record<string, MintedBodyTool>> = {
  "API-create-object": {
    shape: "anyOf",
    forms: ["create shortcut (type, name, properties, markdown, template)", "AnyBlock document"],
  },
  "API-create-template": {
    shape: "object-without-properties",
    forms: ["AnyBlock document of kind template"],
  },
  "API-create-type": {
    shape: "anyOf",
    forms: ["flat type body", "AnyBlock document of kind object_type"],
  },
  "API-update-type": {
    shape: "anyOf",
    forms: ["flat type body", "partial type document", "ops envelope"],
  },
  "API-validate": {
    shape: "object-without-properties",
    forms: ["AnyBlock document of any kind"],
  },
};
