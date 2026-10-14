---
type: plan
title: A dataview the app cannot see
status: DONE
created: 2026-10-07
updated: 2026-10-14
---

# 0024 — A dataview the app cannot see

Status: APPROVED 2026-10-13 under the owner's instruction "dont stop until all plans and work items done".

**Done 2026-10-14** (WI-0024-01, -02). Open for the owner: the live check that a dataview written
through the endpoint renders in the Anytype app like one made by hand; which member `replace_subtree`
carries its block in (the shim judges `blocks` only); the `update_block` op (see Known limits).

**Goal:** an inline query (dataview block) written through the InnyTypes MCP endpoint renders
in the Anytype app exactly as one made by hand in the app. Today the server accepts a block
shape the app never renders, and says nothing.

## The observation

On 2026-10-07 the owner asked for a "Cost ledger" page in the Cleanup space holding an inline
query over a new type, Ledger item, filtered on `linked_projects`. The block was inserted with
`insert_blocks`:

```json
{"type": "dataview", "source": ["type-6ac6008f7b591f0ae16b7d0b"],
 "properties": [...], "views": [{"name": "Cost ledger", "type": "table", ...}]}
```

The server answered 200 with a minted block id and three minted view ids, and read the block
back exactly as written. In the app the block showed the view tabs and an empty five-row
skeleton: no column headers, no rows, no "+ New". Six variants over an hour were all blank:
`source` as `type-<internal_key>`, `source` as the type object's id, with and without sum
footers, one view or three, a copy of a query that works elsewhere, on a Page host and on a
Project host, before and after a full app restart. A standalone Query object made with
`API-create-query` rendered the same 12 rows correctly.

The working blocks on the OpenDrawing project page, read back with `ids: full`, revealed the
difference. They were hand-made in the app and carry

```json
{"type": "dataview", "object_id": "bafyreic6m65g4x4q4dmferfqcvy2fid56rzeeluh6z74yq5bwul2mbvfcq", ...}
```

**`object_id` = the type object's id; no `source` member at all.** Rewriting the Cost ledger
block with `object_id` set to the Ledger item type's object id rendered immediately, sum footers
and all three views included.

Two further things happened on the way that belong in the same plan:

- The only block written with `object_id` before the fix pointed it at a Query object (the one
  `API-create-query` had made). It rendered nothing, not even the view tabs. A dataview whose
  `object_id` is not a type (or a collection) is dead on arrival, and the server accepted it.
- The owner's two inline queries on the project page, written on 2026-10-06 with `source`, were
  blank too; someone rebuilt them by hand in the app. The server-written blocks were gone when
  the page was read on 10-07, so the first report ("they render") was about the hand-made ones.

## What the code says

To be read before WI-0024-01; the paths below are where the behaviour must live, not a claim
that it does.

1. **The block schema allows both spellings and requires neither.** `get_schema` for kind
   `object` lists `dataview` among `blockCore.type`'s enum, and the `insert_blocks` block
   definition carries `object_id` (documented for link blocks) beside `property`, `rows`,
   `columns`. `source` is accepted on a dataview block (`got object, want array` is the only
   validation it gets) and stored verbatim. Nothing says which member an inline set needs.
2. **`querySource` is documented for Query objects, not blocks.** Its description says a type
   target is "the type's derived id `type-<internal_key>`". That is the Query object's
   `query_source` property. Copying that spelling into a block's `source` is the obvious thing
   to do and the wrong one.
3. **Dry run and read-back both pass.** `dry_run: true` reported `blocks_added: 1`,
   `created_views` for each view, and the full read showed the block as sent. Neither path
   knows what the app will render.

### Who owns the write path (WI-0024-01, read 2026-10-13)

**The dataview write path is not in this repository.** Validation, the block schema, the write
and whatever `source` becomes inside Anytype all happen in Anytype's own local API (the desktop
app's server on `127.0.0.1:31009`, or wherever `ANYTYPE_API_BASE_URL` points). Neither InnyTypes
nor the pinned `@anyproto/anytype-mcp@1.2.10` has a line of code that knows what a dataview is.
Read from the code; no Anytype was contacted.

1. **The tools are Anytype's, not ours.** `insert_blocks` and `replace_subtree` are not MCP tools:
   they are values of `ops[].op` in the request body of `API-patch-object`
   (`PATCH /v1/spaces/{space_id}/objects/{object_id}`); `get_schema` is `API-get-schema` and
   `get_op_schema` is `API-get-op-schema`. All three are recorded in the tool surface by hash only
   (`app/src/adapters/anytype/tool_surface.json:31`, `:34`, `:47`; `anytype_version` `2025-11-08`). Their
   input schemas, including the op enum and "Each op's members, schema and example come from
   get_op_schema", are what the live child lists; this repo holds no copy of them. A search of
   the whole tree outside `docs/` and `node_modules/` for `dataview`, `insert_blocks`,
   `replace_subtree`, `querySource` or `patch-object` finds only the `API-patch-object` hash line,
   in that file and its Python twin `src/innytypes/anytype_mcp/tool_surface.json:47`.
2. **The pinned package builds its tools from Anytype's live spec at start.** InnyTypes launches
   `<node> <package>/bin/cli.mjs` with no arguments (`app/src/services/main.ts:95-103`,
   `args: substitutes.args ?? []`) and the environment `ANYTYPE_API_BASE_URL` plus
   `OPENAPI_MCP_HEADERS` (`app/src/domain/anytype/pins.ts:51-61`). With no command and no spec
   path the package runs `initProxy(undefined)`
   (`node_modules/@anyproto/anytype-mcp/scripts/start-server.ts:12-15`), which fetches
   `${ANYTYPE_API_BASE_URL}/docs/openapi.json` (`src/utils/base-url.ts:61-67`,
   `src/init-server.ts:16-25`) and turns each operation into a tool named `API-<operationId>`
   (`src/mcp/proxy.ts:45-73`). The spec bundled in the package (`scripts/openapi.json`) has no
   `patch_object`, `get_schema`, `get_op_schema` or `validate` operation at all: the tools the
   plan names exist only because the running Anytype publishes them.
3. **The package forwards the arguments verbatim.** On `tools/call` it looks the operation up
   (`src/mcp/proxy.ts:76-89`) and `executeOperation` copies the arguments, moves only the
   path and query parameters (`space_id`, `object_id`) out, and sends the rest as the JSON
   body unchanged (`src/client/http-client.ts:123-172`). There is no per-op or per-block code.
4. **InnyTypes forwards untouched too.** `app/src/application/mcp-dispatch.ts:113-122` checks
   that the tool name is one the child listed and passes `params` to the child as they came;
   the only transformation anywhere is the redaction of the answer (`:65-71`). The retired
   Python gateway did the same (`src/innytypes/anytype_mcp/gateway.py:551-558`).

**What `source` becomes on the wire to Anytype:** exactly what the client sent. A block
`{"type": "dataview", "source": ["type-6ac6…"], …}` inside an `insert_blocks` op reaches
`PATCH /v1/spaces/{space_id}/objects/{object_id}` unchanged in content (parsed and re-encoded
on the way, not byte for byte) as the member `source`,
an array of strings, inside `ops[n].blocks[m]`. Nothing in InnyTypes or the package renames,
resolves or drops it. What Anytype then stores, and why it reads `source` back while the app
renders only `object_id`, is inside Anytype and cannot be read from this repository.

**What this means for WI-0024-02.** "The server converts or refuses" cannot be done where the
plan assumed: the server that owns the block shape is Anytype's API, outside this repository,
so the real fix is an upstream change left to the owner. The one place in this repository that
sees the arguments before Anytype does is `mcpDispatch`'s `tools/call` branch
(`app/src/application/mcp-dispatch.ts:117-122`), the same seam plan 0023 chose for its unwrap
shim. A dataview shim there can work but is bigger than 0023's:

- To rewrite `source` to `object_id` it must resolve `type-<key>` (or an `api_key`) to the type
  object's id, which means its own `API-list-types` or `API-get-object` call on the child session
  before forwarding; to refuse a Query object id it must look that id up and answer
  `validation_failed` itself, an error Anytype did not write.
- It must find dataview blocks in every write that can carry one: `insert_blocks` and
  `replace_subtree` ops in `API-patch-object`, and the full-document body of `API-create-object`
  (which plan 0023's unwrap also touches; the two shims meet there).
- Its unit test can assert the body forwarded to the child, not "the stored block": storage is
  Anytype's. The read-back acceptance belongs to the owner's live check.
- It is a shim, to be removed when Anytype takes the fix upstream, and every pin move or
  Anytype update can change the op shapes it parses (see the tool-surface hashes above).

## The fix

**Route decided by the owner 2026-10-13: the InnyTypes shim** in `mcpDispatch`'s `tools/call`
branch, as described under "What this means for WI-0024-02". The upstream fix in Anytype's API is
not built here. Everything below that Anytype's server would have done, the shim does on the way
through, and it is removed when Anytype takes the fix upstream. The schema text (originally
WI-0024-03) is Anytype's to publish and is not rewritten here: with the shim accepting `source`,
a client that follows today's schema is converted anyway. WI-0024-03 is cancelled.

What the server would own, now done by the shim before forwarding:

- On any write of a `dataview` block (`insert_blocks`, `replace_subtree`, a full-document
  create), **resolve the source to the type object and write `object_id`**: accept
  `source: ["type-<key>"]`, `source: ["<type object id>"]`, a type's `api_key`, or `object_id`
  already set; write the block with `object_id` only.
- **Refuse** a dataview whose `object_id` resolves to something that is not a type (or a
  collection): `validation_failed` naming the member and what it resolved to, so a Query object
  id is caught at write time, not on the owner's screen.
- ~~Say so in the schema~~: Anytype's schema, not ours (see above; WI-0024-03 cancelled).
- Mirror the view fields the app writes by hand where they differ from ours (the hand-made view
  carried `id: "default"` and a `type` on the table view) only if WI-0024-02 shows they matter;
  the fixed block rendered with server-minted view ids, so this is a check, not a change.

### What WI-0024-02 built (2026-10-14)

The shim is `app/src/application/dataview-shim.ts` (with the pure half in
`app/src/domain/anytype/dataview.ts`), called as its own step from the `tools/call` branch of
`mcp-dispatch.ts`; both files say they are temporary and when to remove them. Tests:
`app/test/unit/dataview-shim.test.ts`.

- **The live shapes it is built on** (read-only, Cleanup space, 2026-10-14, by the loop's lead;
  no writes, no key read):
  - `API-list-types` is compact: `{"data": [{"key": "ledger_item", "name": "Ledger item"}, ...],
    "total", "offset", "limit", "has_more"}`: no object id, no internal key.
  - `API-get-type {space_id, type: "ledger_item", ids: "full"}` returns the type document with
    `"id": "bafyreiheojvvckygpirvhfn5tmjwzbxhv7ygixrmcizmwaxnrcy4m65ncq"` (the type's object id,
    what `object_id` must be), `"internal_key": "6ac6008f7b591f0ae16b7d0b"`,
    `"type_settings": {"api_key": "ledger_item", ...}` and `"kind": "object_type"`.
  - `API-get-object {object_id: "type-6ac6008f7b591f0ae16b7d0b"}` answers 404 `not_found`: the
    derived id is not an object id Anytype accepts.
- **Resolution.** A dataview's `source`, or its `object_id`, is matched against the space's types:
  every page of `API-list-types` for the keys, then `API-get-type` (ids full) per key, its own
  key first and then each in turn, stopping at the first match. A type matches by its object id,
  its api_key, its internal key or `type-<internal_key>` (also `type-<api_key>`); the owner's
  spelling `type-6ac6008f…` therefore becomes `object_id` = the Ledger item type's object id.
  Every lookup is made once per call, and only when the call carries a dataview. A target that is
  no type is looked up with `API-get-object` (ids full): a `collection`-layout object is accepted,
  anything else (a Query is layout `set`) or nothing found is refused with `validation_failed`,
  answered the way the child answers a refusal Anytype wrote. One bad block refuses the whole
  call; nothing is forwarded.
- **An `object_id` spelled as a key** (`"ledger_item"`, `type-<internal_key>`, the bare internal
  key) is rewritten to the type's object id, like a `source`: Anytype accepts it and the app
  renders nothing. Only a real type or collection object id passes unchanged. This is what the
  WI's "a dataview already carrying object_id is forwarded unchanged" means: an object_id that is
  already a type's or a collection's object id; a key-spelled one is rewritten (owner decision).
- **Where it looks.** Only where blocks live: the `blocks` of a full-document
  `API-create-object` or an `API-create-template` (a template document), the `blocks` of an
  `insert_blocks` or `replace_subtree` op of `API-patch-object`, and each block's `children`,
  flat or inside a schema-minted `body`. A dataview-shaped value anywhere else (a property's
  value) is not a block and passes untouched. `API-create-type` is not judged: its recorded
  input schema describes a type definition with no blocks.
- **Unset and malformed targets.** An `object_id` of `null` or `""` is read as unset, as
  Anytype's server reads it, so `source` is judged. An `object_id` of any other non-string, or a
  `source` that is not a list of exactly one string, is refused saying what is wrong, before any
  lookup.
- **Known limits.**
  - A dataview naming a collection fails closed (an MCP error, nothing forwarded) when
    `API-get-type` fails for some other listed type: the failed type could have been the target,
    so the shim does not guess. Conservative; nothing wrong is forwarded.
  - `API-patch-object`'s `update_block` op is not judged: its op schema exists only on the live
    API, not in anything the loop can read. Whether it can set a dataview's `source` or
    `object_id` is for the owner's live check.
- **No longer open: `type-<internal_key>`.** Resolved through `API-get-type`'s `internal_key`.
- **Open for the owner's live check: view mirroring.** Whether the view `id` (`"default"`) and the
  table view's `type` that the app writes by hand need mirroring cannot be observed by the loop
  (it cannot see rendering). The shim does not touch `views`; the reference block `b5d3b` rendered
  with server-minted view ids, so the expectation is that no mirroring is needed. Undecided until
  the owner's live check.

## Acceptance

Rewritten 2026-10-13 for the shim: storage is Anytype's, so the loop proves what is forwarded,
and the read-back is the owner's live check.

- A dataview sent with `source: ["type-<key>"]` is forwarded to the child with `object_id` = that
  type's object id and no `source`; the same for `source: ["<type object id>"]` and a type's
  `api_key`; in `insert_blocks` and `replace_subtree` ops of `API-patch-object` and in a
  full-document `API-create-object` body.
- A dataview whose target resolves to something that is not a type or a collection (a Query
  object id) is refused by InnyTypes with `validation_failed` naming the member and what it
  resolved to, and nothing is forwarded.
- Tests in `app/test/unit/` drive `mcpDispatch` with a fake child and assert the body the child
  receives, for every shape above, and that every other tool call is forwarded unchanged.
- A live check against the owner's Anytype (`needs_node`, or manual): a dataview written through
  the endpoint onto a Page renders rows in the app without a restart. The Cost ledger block
  `b5d3b` on `bafyreidxvktwhbtlevajl3gaxkyqxg2lekpwrlhk6zsmdllvudrdzlviq4` (Cleanup) is the
  reference: it renders.
- No change for dataview blocks already stored with `object_id`.

## Work items

- WI-0024-01 — find where dataview blocks are validated and written, and what `source` becomes
  on the wire to Anytype; record it under "What the code says".
- WI-0024-02 — the rewrite to `object_id` plus the refusal of a non-type target, with the unit
  test; confirm whether view `id`/`type` need mirroring.
- ~~WI-0024-03 — the schema text~~: cancelled 2026-10-13; the schema is Anytype's.

## Evidence

- Session 2026-10-07 (whodunnit, `c053e28b`): six blank variants, the standalone Query that
  rendered, the full read of the project page showing the hand-made blocks' `object_id`, the
  rebuilt block rendering. Screenshots were the owner's; the block ids are in this plan.
- Plan 0023 (same server, same day): the `body` double-wrap. Both are the same class of fault —
  the server accepts a shape its own schema or the app does not — and should be fixed together.
