---
type: plan
title: A body the child wraps twice
status: APPROVED
created: 2026-10-06
updated: 2026-10-13
---

# 0023 — A body the child wraps twice

Status: APPROVED 2026-10-13 under the owner's instruction "dont stop until all plans and work items done"; fix route: the InnyTypes shim (upstream patch left to the owner).

**Goal:** every tool the InnyTypes MCP endpoint lists can be called with the arguments its own
schema asks for. Today `API-create-object`, `API-update-type` and every other operation whose
request body is not a flat object cannot: the schema demands a `body` argument and the server
rejects that same `body` as an unknown field.

## The observation

On 2026-10-06 the owner asked Claude Code, through the InnyTypes MCP endpoint
(`http://127.0.0.1:31010/mcp`, the Electron app), to create Meeting objects in the Cleanup space.
The tool schema for `API-create-object` reads `required: ["space_id", "body"]`, with `body` an
`anyOf` of the create shortcut (`type, name, properties, markdown`) and a full AnyBlock document.
Sending exactly that:

```json
{"space_id": "y6oahq", "dry_run": true,
 "body": {"type": "meeting", "name": "test", "markdown": "Intro line."}}
```

was answered by the Anytype API with

```
400 validation_failed — unknown field in create shortcut
  /body: unknown key "body" — the shortcut accepts type, name, properties, markdown
```

Every body shape fails the same way (shortcut, `formatVersion: "2.0"` document, body as a JSON
string). The same answer was seen on 2026-09-30 for `API-update-type` ("unknown key body" for
every body shape), noted then as an unfixed bridge bug.

The call succeeds when the shortcut fields are sent as **top-level** tool arguments, bypassing
the schema:

```json
{"space_id": "y6oahq", "type": "meeting", "name": "test", "markdown": "Intro line."}
```

That is how the four Meeting objects and the summary page were created that day, by posting
JSON-RPC to the endpoint directly. A client that validates arguments against the tool schema
(Claude Code does) cannot take that road: it refuses the call before it leaves.

## What the code says

Read in `node_modules/@anyproto/anytype-mcp` 1.2.10, the child the app pins
(`app/package.json:45`, `package.json:24`).

1. **The schema side wraps.** `src/openapi/parser.ts:453-470` and `:600-622` flatten a JSON
   request body into the tool's `inputSchema` only when the body schema is `type: object` with
   `properties`. The create-object body is an `anyOf` (shortcut | AnyBlock document), so the
   generator takes the other branch at `:619-621`:

   ```ts
   // If the request body is not an object, just put it under "body"
   inputSchema.properties!["body"] = bodySchema;
   inputSchema.required!.push("body");
   ```

2. **The HTTP side never unwraps.** `src/client/http-client.ts:125` starts the request body as
   `{ ...params }`, removes path and query parameters (`:128-140`), and sends the rest as the JSON
   body (`:170`). Nothing looks for a `body` key. So the wire body is
   `{"body": {...}, ...}` — one level deeper than the API's schema — and the API rejects `body`
   as an unknown key.

3. **InnyTypes forwards untouched.** `app/src/application/mcp-dispatch.ts:122` passes
   `tools/call` params to the child as received; `tool_surface.json` pins the child's schemas by
   hash (`app/src/adapters/anytype/tool-surface.ts`), so the wrapped schema is what every client
   is shown.

4. **Which tools are hit.** Every operation whose JSON request body is not a flat object with
   `properties`: at least `API-create-object` and `API-update-type` (both `anyOf` bodies).
   An inventory is the first work item, because the list is a property of the pinned API spec,
   not of this report.

## The inventory (WI-0023-01, 2026-10-13)

Read off the child's `tools/list` as the InnyTypes endpoint serves it (51 tools), and checked
against `tool_surface.json`: the recorded input schema of each tool below hashes to its committed
signature, so it is the pinned schema byte for byte, not a reading of the API spec. Five tools
carry a minted `body`; the other 46 flatten their body (or have none), and none of them has a
property named `body`.

| Tool | Minted `body` holds |
|---|---|
| `API-create-object` | `anyOf`: the create shortcut (`type, name, properties, markdown, template`) \| an AnyBlock document |
| `API-create-type` | `anyOf`: the flat type body \| an AnyBlock document of kind `object_type` |
| `API-update-type` | `anyOf`: the flat type body \| a partial type document \| an ops envelope |
| `API-create-template` | an `object` with no `properties` (`additionalProperties: true`): an AnyBlock template document |
| `API-validate` | an `object` with no `properties` (`additionalProperties: true`): an AnyBlock document of any kind |

The last two are minted for the second reason the parser has (`type: object` without
`properties` is not flattened either), so they are wrapped on the wire exactly as the `anyOf`
ones are, although no refusal had been seen for them.

Where it lives: `app/src/domain/anytype/minted-body.ts` (`MINTED_BODY_TOOLS`, for the shim in
WI-0023-02 to import), with the five schemas recorded in
`app/test/fixtures/minted-body/input-schemas.json`. `app/test/unit/minted-body.test.ts`
re-derives the list from those schemas, proves each one against its committed signature, and
pins `INVENTORIED_SURFACE`, a hash of the whole committed `tools` map: re-recording
`tool_surface.json` (a pin move, or a changed Anytype) fails the gate until the inventory is
taken again.

The package's bundled spec is not the pinned surface: run offline against it, the child lists 34
tools, 30 of the committed ones are missing and 21 differ, and only `API-create-object` has a
minted `body`. That is why the inventory was taken from the served surface and proven by
signature, not derived from the bundled spec.

## The fix, in one sentence

The two sides must agree: either the schema flattens an `anyOf` body too (and the client sends
the flat fields, as the API expects), or the client unwraps a `body` argument the schema minted
(`bodyParams = params.body` when the operation's schema put the body under `body`). The second
is the smaller change and keeps the schema honest about the API's `anyOf`.

Where it lands depends on whether upstream takes it:

- **Upstream** (`@anyproto/anytype-mcp`): a patch to `http-client.ts` that unwraps `body` when
  `inputSchema.properties.body` was minted by the parser's fallback. Preferred: the fix reaches
  every user of the child.
- **In InnyTypes** meanwhile: `mcp-dispatch.ts` can unwrap `params.arguments.body` before
  forwarding, for the tools the inventory names. That is a shim, and it must be removed when the
  upstream fix lands and the pin moves; the tool-surface diff (plan 0007's mechanism) will show
  the moment the schema changes.

## The shim (WI-0023-02, 2026-10-14)

`app/src/application/minted-body-shim.ts`, one call in `mcpDispatch`'s tools/call branch. The
child's HTTP client (`http-client.ts:123-172`) sends as the request body every argument that is
not a path or query parameter of the operation, and validates nothing against the schema, so the
shim spreads `arguments.body` flat next to `space_id` and the other parameters, for exactly the
tools in `MINTED_BODY_TOOLS`. A `body` member named like an argument of the call or a parameter
the tool's schema declares (`dry_run`, `type`, …) cannot be sent flat (the child would take it for
that parameter), so that call is refused with JSON-RPC -32602 and nothing is forwarded. A call to
any other tool, a call with no `body`, or a `body` that is not an object is forwarded unchanged.

Proven in the loop without Anytype: `app/test/unit/minted-body-shim.test.ts` drives `mcpDispatch`
with the wrapped argument (fails with the shim removed), and
`app/test/integration/minted-body-wire.test.ts` runs the real pinned child behind `mcpDispatch`
against a local server serving the recorded `body` schemas: the POST/PATCH body it receives is the
shortcut, the AnyBlock document and the update-type body themselves, with no `body` key (and with
the shim removed it receives `{"body": ...}`, the live defect). **Whether a live Anytype then
answers `dry_run` instead of `validation_failed`, and accepts `API-update-type`, is the owner's
check** (the loop never contacts the owner's Anytype).

Not fixed by the shim: header parameters (`If-Match`, `Idempotency-Key`) are neither path nor
query, so the child sends those in the body too, wrapped or not; that is the upstream patch's to
address.

## Acceptance

- `API-create-object` called **with the schema's own `body` argument** (the shortcut shape, dry
  run) is answered `{"type": ..., "dry_run": true}` by the API, not `validation_failed`.
- The same for the full AnyBlock document shape (`formatVersion: "2.0"`).
- `API-update-type` with its documented body succeeds.
- A test in `app/test/unit/` drives `mcp-dispatch` (or the child, under `needs_node`) with the
  wrapped argument and asserts the wire body the Anytype API receives has no `body` key.
- No change to any tool whose body already flattens (create-property, patch-object, …): the
  tool-surface diff is empty for them.

## Work items

- WI-0023-01 — inventory: list every pinned tool whose `inputSchema` has a minted `body`
  property, from `tool_surface.json` and the child's `tools/list`.
- WI-0023-02 — the unwrap, upstream patch or InnyTypes shim per the owner's choice, with the
  test above.
- WI-0023-03 — if a shim: the removal note tied to the next pin move.

## Evidence

- Session 2026-10-06 (whodunnit, `c053e28b`): direct JSON-RPC probes of both shapes against the
  live endpoint; the working driver is `scratchpad/anytype/mcp_call.py` of that session (not
  durable).
- 2026-09-30 note in the owner's memory: `update-type` via MCP fails with "unknown key body" for
  every body shape.
