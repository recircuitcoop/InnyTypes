---
type: plan
title: A dataview the app cannot see
status: TODO
created: 2026-10-07
updated: 2026-10-07
---

# 0024 — A dataview the app cannot see

Status: TODO 2026-10-07 (reported by the owner from a whodunnit session; not yet approved)

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

## The fix

The server owns the block shape, so the server converts or refuses:

- On any write of a `dataview` block (`insert_blocks`, `replace_subtree`, a full-document
  create), **resolve the source to the type object and write `object_id`**: accept
  `source: ["type-<key>"]`, `source: ["<type object id>"]`, a type's `api_key`, or `object_id`
  already set; write the block with `object_id` only.
- **Refuse** a dataview whose `object_id` resolves to something that is not a type (or a
  collection): `validation_failed` naming the member and what it resolved to, so a Query object
  id is caught at write time, not on the owner's screen.
- **Say so in the schema**: the dataview block definition names `object_id` as the type to
  query and marks `source` as an accepted alias that is rewritten.
- Mirror the view fields the app writes by hand where they differ from ours (the hand-made view
  carried `id: "default"` and a `type` on the table view) only if WI-0024-02 shows they matter;
  the fixed block rendered with server-minted view ids, so this is a check, not a change.

## Acceptance

- A dataview inserted with `source: ["type-<key>"]` reads back with `object_id` = that type's
  object id and no `source`; the same for `source: ["<type object id>"]`.
- A dataview inserted with `object_id` = a Query object's id is refused with
  `validation_failed`.
- A test in `app/test/unit/` covers both, driving the write path and asserting the stored block.
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
- WI-0024-03 — the schema text: `object_id` documented on the dataview block, `source` marked
  as an alias.

## Evidence

- Session 2026-10-07 (whodunnit, `c053e28b`): six blank variants, the standalone Query that
  rendered, the full read of the project page showing the hand-made blocks' `object_id`, the
  rebuilt block rendering. Screenshots were the owner's; the block ids are in this plan.
- Plan 0023 (same server, same day): the `body` double-wrap. Both are the same class of fault —
  the server accepts a shape its own schema or the app does not — and should be fixed together.
