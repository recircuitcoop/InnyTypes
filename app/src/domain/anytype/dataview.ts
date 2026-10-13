// What a dataview block in a write says it shows, and what that turns out to be (plan 0024).
//
// TEMPORARY, with the shim in application/dataview-shim.ts: Anytype's API stores a dataview
// block's `source` verbatim, and the app renders an inline set only from `object_id` = the
// type's (or collection's) object id. Remove this file with the shim once Anytype converts or
// refuses `source` itself (re-check on every Anytype update or pin move: the op shapes read
// here are Anytype's, recorded in the tool surface by hash only).
//
// Pure: no lookups here. The shim asks the child, and this file judges what came back.

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The tools whose arguments can carry a dataview block. */
export const CREATE_OBJECT_TOOL = "API-create-object";
export const PATCH_OBJECT_TOOL = "API-patch-object";

/** The ops of API-patch-object that write blocks. */
const BLOCK_WRITING_OPS: ReadonlySet<unknown> = new Set(["insert_blocks", "replace_subtree"]);

/** One dataview block in a call's arguments, and where it sits, for a refusal to name. */
export interface DataviewSite {
  /** Where the block is in the arguments, e.g. `ops[0].blocks[1]`. */
  readonly path: string;
  /** The block itself: the shim rewrites it in place, in its own copy of the arguments. */
  readonly block: Json;
}

/** Every block in `value` (at `path`) whose type is dataview, nested blocks included. */
function dataviewsIn(value: unknown, path: string, into: DataviewSite[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      dataviewsIn(item, `${path}[${String(index)}]`, into);
    });
    return;
  }
  if (!isObject(value)) {
    return;
  }
  if (value["type"] === "dataview") {
    into.push({ path, block: value });
  }
  for (const [key, item] of Object.entries(value)) {
    dataviewsIn(item, path === "" ? key : `${path}.${key}`, into);
  }
}

/** The block-writing ops anywhere in `value`: under `ops`, or under a minted `body.ops`. */
function blockOpsIn(value: unknown, path: string, into: DataviewSite[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      blockOpsIn(item, `${path}[${String(index)}]`, into);
    });
    return;
  }
  if (!isObject(value)) {
    return;
  }
  if (BLOCK_WRITING_OPS.has(value["op"])) {
    dataviewsIn(value, path, into);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    blockOpsIn(item, path === "" ? key : `${path}.${key}`, into);
  }
}

/**
 * The dataview blocks a call to `tool` writes: every one in a full-document API-create-object,
 * and every one inside an insert_blocks or replace_subtree op of API-patch-object. The whole
 * argument tree is walked, so a document still wrapped in a schema-minted `body` (plan 0023)
 * is found as well as an unwrapped one. Any other tool writes none.
 */
export function dataviewSites(tool: string, args: unknown): DataviewSite[] {
  const sites: DataviewSite[] = [];
  if (tool === CREATE_OBJECT_TOOL) {
    dataviewsIn(args, "", sites);
  } else if (tool === PATCH_OBJECT_TOOL) {
    blockOpsIn(args, "", sites);
  }
  return sites;
}

/** What a dataview block names as the set it shows. */
export type DataviewTarget =
  | { readonly kind: "object_id"; readonly target: string }
  | { readonly kind: "source"; readonly target: string }
  /** A `source` that names no single target: not a list of exactly one string. */
  | { readonly kind: "unreadable-source"; readonly count: number }
  /** Neither member, or an object_id that is not a string: not the shim's to judge. */
  | { readonly kind: "none" };

export function dataviewTarget(block: Json): DataviewTarget {
  const objectId = block["object_id"];
  if (typeof objectId === "string") {
    return { kind: "object_id", target: objectId };
  }
  if (objectId !== undefined || !("source" in block)) {
    return { kind: "none" };
  }
  const source = block["source"];
  if (Array.isArray(source) && source.length === 1 && typeof source[0] === "string") {
    return { kind: "source", target: source[0] };
  }
  return { kind: "unreadable-source", count: Array.isArray(source) ? source.length : 0 };
}

/** A type as API-list-types lists it: only what a target can be matched on. */
export interface ListedType {
  readonly id: string;
  readonly key?: string;
}

/** The types in one page of an API-list-types answer, skipping anything without an id. */
export function listedTypes(page: unknown): ListedType[] {
  const data = isObject(page) ? page["data"] : undefined;
  if (!Array.isArray(data)) {
    return [];
  }
  return data.flatMap((item): ListedType[] => {
    if (!isObject(item) || typeof item["id"] !== "string") {
      return [];
    }
    const key = item["key"];
    return [typeof key === "string" ? { id: item["id"], key } : { id: item["id"] }];
  });
}

/** Whether an API-list-types page says another page follows. */
export function hasMoreTypes(page: unknown): boolean {
  const pagination = isObject(page) ? page["pagination"] : undefined;
  return isObject(pagination) && pagination["has_more"] === true;
}

/**
 * The listed type `target` names: by its object id, by its key (the api_key), or by the
 * derived spelling `type-<key>` a Query object's source uses.
 */
export function typeNamed(types: readonly ListedType[], target: string): ListedType | undefined {
  return types.find(
    (type) =>
      type.id === target ||
      (type.key !== undefined && (type.key === target || `type-${type.key}` === target)),
  );
}

/** What an object id resolved to, read from an API-get-object answer. */
export type Resolved =
  | { readonly kind: "type"; readonly id: string }
  | { readonly kind: "collection"; readonly id: string }
  /** Anything else: `what` says what, for the refusal (a Query is layout "set"). */
  | { readonly kind: "other"; readonly what: string };

/** What the object in an API-get-object answer is; `fallbackId` when it carries no id. */
export function resolvedObject(answer: unknown, fallbackId: string): Resolved {
  const object = isObject(answer) && isObject(answer["object"]) ? answer["object"] : {};
  const id = typeof object["id"] === "string" ? object["id"] : fallbackId;
  const layout = typeof object["layout"] === "string" ? object["layout"] : undefined;
  if (object["object"] === "type" || layout === "objectType") {
    return { kind: "type", id };
  }
  if (layout === "collection") {
    return { kind: "collection", id };
  }
  const type = isObject(object["type"]) ? object["type"]["name"] : undefined;
  const name = typeof object["name"] === "string" ? ` "${object["name"]}"` : "";
  const typed = typeof type === "string" ? `a ${type} object` : "an object";
  const laid = layout === undefined ? "" : ` (layout "${layout}")`;
  return { kind: "other", what: `${typed}${name}${laid}` };
}
