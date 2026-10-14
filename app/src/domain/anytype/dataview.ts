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

// The live shapes these read (at the pinned Anytype API version, read-only in the Cleanup space,
// 2026-10-14; recorded in plan 0024):
// * API-list-types is compact: {"data": [{"key": "ledger_item", "name": "Ledger item"}, ...],
//   "total", "offset", "limit", "has_more"}: no object id, no internal key.
// * API-get-type {space_id, type: <key>, ids: "full"} is the type document: "id" (the object id
//   a dataview's object_id must be), "internal_key" (the `<x>` of `type-<x>`), "kind":
//   "object_type" and "type_settings": {"api_key": ...}.
// * API-get-object does not accept the derived id `type-<internal_key>` (404 not_found).

/** The type keys (api_keys) on one page of an API-list-types answer. */
export function listedTypeKeys(page: unknown): string[] {
  const data = isObject(page) ? page["data"] : undefined;
  if (!Array.isArray(data)) {
    return [];
  }
  return data.flatMap((item) =>
    isObject(item) && typeof item["key"] === "string" ? [item["key"]] : [],
  );
}

/** Whether an API-list-types page says another page follows (flat, or under `pagination`). */
export function hasMoreTypes(page: unknown): boolean {
  if (!isObject(page)) {
    return false;
  }
  const pagination = page["pagination"];
  return page["has_more"] === true || (isObject(pagination) && pagination["has_more"] === true);
}

/** A type as API-get-type (ids full) describes it: what a target can be matched on. */
export interface TypeDocument {
  /** The type's object id: what a dataview's object_id must be. */
  readonly id: string;
  readonly apiKey: string;
  readonly internalKey: string | undefined;
}

/** The type document in an API-get-type answer (flat, or under `type`), asked for by `key`. */
export function typeDocument(answer: unknown, key: string): TypeDocument | undefined {
  const document =
    isObject(answer) && isObject(answer["type"]) ? answer["type"] : isObject(answer) ? answer : {};
  if (typeof document["id"] !== "string") {
    return undefined;
  }
  const settings = isObject(document["type_settings"]) ? document["type_settings"] : {};
  const apiKey =
    typeof settings["api_key"] === "string"
      ? settings["api_key"]
      : typeof document["key"] === "string"
        ? document["key"]
        : key;
  const internal = document["internal_key"];
  return {
    id: document["id"],
    apiKey,
    internalKey: typeof internal === "string" ? internal : undefined,
  };
}

/**
 * Whether `target` names this type: its object id, its api_key, its internal key, or the
 * derived spelling `type-<internal_key>` (or `type-<api_key>`) a Query object's source uses.
 */
export function typeMatches(type: TypeDocument, target: string): boolean {
  const keys = [type.apiKey, ...(type.internalKey === undefined ? [] : [type.internalKey])];
  return (
    type.id === target || keys.includes(target) || keys.some((key) => `type-${key}` === target)
  );
}

/** What an object id resolved to, read from an API-get-object answer. */
export type Resolved =
  | { readonly kind: "type"; readonly id: string }
  | { readonly kind: "collection"; readonly id: string }
  /** Anything else: `what` says what, for the refusal (a Query is layout "set"). */
  | { readonly kind: "other"; readonly what: string };

/** A string member of `value`, or of the object under `value[member]` as its `key`/`name`. */
function named(value: Json, member: string, inner: string): string | undefined {
  const item = value[member];
  if (typeof item === "string") {
    return item;
  }
  return isObject(item) && typeof item[inner] === "string" ? item[inner] : undefined;
}

/** What the object in an API-get-object answer (ids full) is; `fallbackId` when it has no id. */
export function resolvedObject(answer: unknown, fallbackId: string): Resolved {
  const object =
    isObject(answer) && isObject(answer["object"])
      ? answer["object"]
      : isObject(answer)
        ? answer
        : {};
  const id = typeof object["id"] === "string" ? object["id"] : fallbackId;
  const layout = typeof object["layout"] === "string" ? object["layout"] : undefined;
  const typeKey = named(object, "type", "key");
  if (object["kind"] === "object_type" || object["object"] === "type" || layout === "objectType") {
    return { kind: "type", id };
  }
  if (layout === "collection" || typeKey === "collection") {
    return { kind: "collection", id };
  }
  const typeName = named(object, "type", "name") ?? typeKey;
  const name = typeof object["name"] === "string" ? ` "${object["name"]}"` : "";
  const typed = typeName === undefined ? "an object" : `a ${typeName} object`;
  const laid = layout === undefined ? "" : ` (layout "${layout}")`;
  return { kind: "other", what: `${typed}${name}${laid}` };
}
