// The dataview shim (plan 0024, WI-0024-02): one named step of mcpDispatch's tools/call branch,
// run on a call's params before they are forwarded to the child.
//
// TEMPORARY. Anytype's API stores a dataview block's `source` verbatim and the app renders an
// inline set only from `object_id` = the type's (or collection's) object id; a dataview whose
// object_id is a Query renders nothing. Until Anytype converts or refuses that itself, this step
// does it on the way through:
//
// * a dataview whose `source` names a type (`type-<internal_key>`, its object id or api_key) is
//   forwarded with `object_id` = that type's object id and no `source`; one naming a collection
//   is forwarded with `object_id` = the collection's id;
// * a dataview whose `source` or `object_id` names anything else (a Query object, nothing) is
//   refused here, structurally, and nothing at all is forwarded;
// * an object_id that is null or "" is read as unset (as Anytype reads it), so `source` is
//   judged; an object_id of any other non-string, or a source that is not a list of exactly
//   one string, is refused naming what is wrong, with no lookup and nothing forwarded;
// * a dataview whose object_id names a type by its key or `type-<x>` (accepted by Anytype and
//   rendered as nothing) is forwarded with object_id = the type's object id, and no source;
// * a dataview whose object_id is a type's or a collection's object id, and every call with no
//   dataview, is forwarded exactly as it came.
//
// Remove it, with domain/anytype/dataview.ts and its tests, once Anytype's API takes the fix
// upstream; re-check it on every Anytype update or pin move, since the op shapes it reads are
// Anytype's and can change under it.
//
// Its lookups (API-list-types, API-get-type, API-get-object) go straight to the child session:
// they are not a client's calls, so they are neither logged nor answered as one, and nothing
// they return reaches the client except the few words a refusal names, which the dispatch
// redacts with the rest of its answer.

import {
  dataviewSites,
  dataviewTarget,
  hasMoreTypes,
  listedTypeKeys,
  resolvedObject,
  typeDocument,
  typeMatches,
  type Resolved,
  type TypeDocument,
} from "../domain/anytype/dataview";
import type { McpSession } from "../ports/anytype";

type Json = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A dataview InnyTypes will not forward: where it is, which member, and what is wrong. */
export interface DataviewRefusal {
  /** Where the block sits in the arguments, e.g. `ops[0].blocks[1]`. */
  readonly path: string;
  readonly member: "source" | "object_id";
  /** What the member said, as the client wrote it. */
  readonly value: unknown;
  /**
   * What is wrong with it, said after the value: e.g. `resolves to a Query object "Costs"
   * (layout "set"), not a type or a collection; ...`, or `is not a string; ...`.
   */
  readonly reason: string;
}

/** The reason for a target that resolved to something a dataview cannot show. */
const resolvesTo = (what: string): string =>
  `resolves to ${what}, not a type or a collection; a dataview shows a type's or a ` +
  `collection's objects`;

export type DataviewShimOutcome =
  | { readonly kind: "forward"; readonly params: Json }
  | { readonly kind: "refused"; readonly refusal: DataviewRefusal }
  /** A lookup the shim needed was itself refused by Anytype: nothing was forwarded. */
  | { readonly kind: "failed"; readonly message: string };

/** One page of API-list-types: as many as one page holds, and a bound on how many are read. */
const TYPES_PAGE = 100;
const TYPES_PAGES_MAX = 50;

/** The parsed JSON a child's tool result carries, or what Anytype refused it with. */
type ChildData =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly status: number | undefined; readonly what: string };

/** The JSON in a tool result's first text content, the way the pinned package answers. */
function childData(answer: unknown): ChildData {
  const content = isObject(answer) ? answer["content"] : undefined;
  const first: unknown = Array.isArray(content) ? content[0] : undefined;
  const text = isObject(first) ? first["text"] : undefined;
  let data: unknown;
  try {
    data = typeof text === "string" ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    data = undefined;
  }
  if (!isObject(data)) {
    return { ok: false, status: undefined, what: "an answer that is not JSON" };
  }
  const status = typeof data["status"] === "number" ? data["status"] : undefined;
  const refused =
    (isObject(answer) && answer["isError"] === true) ||
    data["object"] === "error" ||
    data["status"] === "error" ||
    (status !== undefined && status >= 400);
  if (!refused) {
    return { ok: true, data };
  }
  const code = typeof data["code"] === "string" ? data["code"] : "error";
  return { ok: false, status, what: `${String(status ?? "an")} ${code}` };
}

/** What a target turned out to be, after the lookups. */
type Resolution =
  Resolved | { readonly kind: "missing" } | { readonly kind: "failed"; readonly message: string };

/** The child lookups of one call, each made at most once and only when a dataview needs it. */
class Lookups {
  private keys: readonly string[] | undefined;
  private readonly types = new Map<string, TypeDocument | undefined>();
  private readonly objects = new Map<string, Resolution>();

  constructor(
    private readonly session: McpSession,
    private readonly spaceId: string,
  ) {}

  private async call(name: string, args: Json): Promise<ChildData> {
    return childData(await this.session.request("tools/call", { name, arguments: args }));
  }

  /** Every type key in the space (all pages), or the refusal that stopped the reading. */
  private async typeKeys(): Promise<readonly string[] | string> {
    if (this.keys !== undefined) {
      return this.keys;
    }
    const keys: string[] = [];
    for (let page = 0; page < TYPES_PAGES_MAX; page++) {
      const answer = await this.call("API-list-types", {
        space_id: this.spaceId,
        offset: page * TYPES_PAGE,
        limit: TYPES_PAGE,
      });
      if (!answer.ok) {
        return `API-list-types answered ${answer.what}`;
      }
      keys.push(...listedTypeKeys(answer.data));
      if (!hasMoreTypes(answer.data)) {
        break;
      }
    }
    this.keys = keys;
    return keys;
  }

  /** The type document of `key` (API-get-type, ids full), or the refusal that stopped it. */
  private async typeOf(key: string): Promise<TypeDocument | undefined | string> {
    if (this.types.has(key)) {
      return this.types.get(key);
    }
    const answer = await this.call("API-get-type", {
      space_id: this.spaceId,
      type: key,
      ids: "full",
    });
    if (!answer.ok) {
      return `API-get-type answered ${answer.what}`;
    }
    const document = typeDocument(answer.data, key);
    this.types.set(key, document);
    return document;
  }

  /**
   * The space's type `target` names (object id, api_key, internal key or `type-<x>`): the type
   * whose key it is asked first, then every listed type in turn, stopping at the first match.
   * A type Anytype would not describe does not stop the search: it is the answer only when no
   * other type matches, since the target could have been that type.
   */
  private async typeNamed(target: string): Promise<TypeDocument | undefined | string> {
    const keys = await this.typeKeys();
    if (typeof keys === "string") {
      return keys;
    }
    let failure: string | undefined;
    const first = keys.includes(target) ? [target] : [];
    for (const key of [...first, ...keys.filter((key) => key !== target)]) {
      const type = await this.typeOf(key);
      if (typeof type === "string") {
        failure ??= type;
        continue;
      }
      if (type !== undefined && typeMatches(type, target)) {
        return type;
      }
    }
    return failure;
  }

  /** A type of the space first; otherwise the object of that id (a collection, a Query, ...). */
  async resolve(target: string): Promise<Resolution> {
    const type = await this.typeNamed(target);
    if (typeof type === "string") {
      return { kind: "failed", message: type };
    }
    if (type !== undefined) {
      return { kind: "type", id: type.id };
    }
    const known = this.objects.get(target);
    if (known !== undefined) {
      return known;
    }
    const answer = await this.call("API-get-object", {
      space_id: this.spaceId,
      object_id: target,
      ids: "full",
    });
    let resolution: Resolution;
    if (answer.ok) {
      resolution = resolvedObject(answer.data, target);
    } else if (answer.status === 404 || answer.status === 400) {
      resolution = { kind: "missing" };
    } else {
      resolution = { kind: "failed", message: `API-get-object answered ${answer.what}` };
    }
    this.objects.set(target, resolution);
    return resolution;
  }
}

/**
 * `params` as they should reach the child: dataview targets resolved to `object_id`, or the
 * refusal of one that is not a type or a collection. Params with no dataview come back as they
 * came, the same object, with no lookup made.
 */
export async function dataviewShim(
  session: McpSession,
  params: Json,
): Promise<DataviewShimOutcome> {
  const name = params["name"];
  const args = params["arguments"];
  if (typeof name !== "string" || dataviewSites(name, args).length === 0) {
    return { kind: "forward", params };
  }
  // Rewritten in a copy: the client's own params are never changed under it.
  const copy = structuredClone(args) as Record<string, unknown>;
  const spaceId = copy["space_id"];
  if (typeof spaceId !== "string") {
    // No space to look in; Anytype refuses a write without one anyway.
    return { kind: "forward", params };
  }
  const lookups = new Lookups(session, spaceId);
  let changed = false;
  for (const site of dataviewSites(name, copy)) {
    const target = dataviewTarget(site.block);
    if (target.kind === "none") {
      continue;
    }
    if (target.kind === "malformed") {
      // Refused before any lookup: a shape that names no target is never forwarded.
      return {
        kind: "refused",
        refusal: {
          path: site.path,
          member: target.member,
          value: target.value,
          reason: target.problem,
        },
      };
    }
    const resolution = await lookups.resolve(target.target);
    if (resolution.kind === "failed") {
      return { kind: "failed", message: resolution.message };
    }
    if (resolution.kind === "missing" || resolution.kind === "other") {
      const what = resolution.kind === "missing" ? "nothing in this space" : resolution.what;
      return {
        kind: "refused",
        refusal: {
          path: site.path,
          member: target.kind,
          value: target.target,
          reason: resolvesTo(what),
        },
      };
    }
    // A source, or an object_id spelled as a key, becomes the object id; a real id stays.
    if (target.kind === "source" || resolution.id !== target.target) {
      delete site.block["source"];
      site.block["object_id"] = resolution.id;
      changed = true;
    }
  }
  return { kind: "forward", params: changed ? { ...params, arguments: copy } : params };
}
