---
type: plan
title: A file that is not text
status: DRAFT
created: 2026-10-01
updated: 2026-10-01
---

# 0019 — A file that is not text

Status: DRAFT, awaiting the owner

**Goal:** a file that is not text reaches an MCP client intact, and a large file never takes the
Anytype MCP child down.

## The observation

On 2026-10-01 the owner asked Claude Desktop, through the InnyTypes MCP endpoint, to read a
7.3 MB, 293-page PDF stored in Anytype. Claude Desktop called `API-download-file`. What came back
was unusable as a PDF, and from 12:51 the endpoint answered nothing more. The app running was the
old Python one (`src/innytypes/`).

## What the code says

**1. Upstream never sends bytes.** `@anyproto/anytype-mcp` 1.2.10 has no download code of its
own. It turns Anytype's OpenAPI spec into tools. `download_file` is
`GET /v2/spaces/{space_id}/files/{file_id}/content`, answered `application/octet-stream`, with
Range, If-None-Match and If-Range header parameters (Anytype's own spec, served at
`127.0.0.1:31009/docs/openapi.json`). Every tool result is built the same way
(`node_modules/@anyproto/anytype-mcp/src/mcp/proxy.ts:92-99`):

```ts
content: [{ type: "text", text: JSON.stringify(response.data) }]
```

`response.data` comes from axios 1.18.1 with no `responseType` set. Its Node adapter turns the
body into a string with `responseData.toString(responseEncoding)`, which is UTF-8 by default
(`node_modules/axios/lib/adapters/http.js:1226-1231`). Invalid UTF-8 sequences become U+FFFD,
so the bytes are destroyed inside the child, before InnyTypes sees them. The proxy has a
`getContentType` helper that knows "binary" (`proxy.ts:145-155`), but nothing calls it.

**2. The relay bounds a reply at 1 MiB in both apps.** A JSON-RPC line from the child may be at
most `MAX_FRAME_BYTES`, one MiB:

- New app: `app/src/domain/anytype/pins.ts:35`. A longer reply calls `#fail("the Anytype MCP
  child sent an oversized frame")` (`app/src/adapters/anytype/mcp-session.ts:199-214`). That
  closes the session and fails every pending call, but it does not stop the child process.
- Old app: `src/innytypes/anytype_mcp/session.py:14`, read with `readline(max + 1)` and closed
  the same way (`session.py:185-194`).

A 7.3 MB file, decoded and JSON-escaped, is a line of at least 7.3 MB. It cannot pass either
bound. The other bounds on the path are the gateway's request body, 1 MiB
(`app/src/domain/endpoint/limits.ts:11`, old `gateway.py:46`), and 60 s per call
(`pins.ts:39`). The gateway does not bound the size of an answer (`gateway.ts:219-233`).

**3. The tool surface pins input schemas only.** `tool_surface.json` maps each of 51 tool names,
`API-download-file` and `API-upload-file` among them, to a sha256 of its `inputSchema`
(`app/src/adapters/anytype/tool-surface.ts:56-59`). `verifyToolSurface` compares what the child
lists with the record and throws on any difference (`tool-surface.ts:112-127`). Output is not
pinned. So InnyTypes may change what a call returns without touching the record, provided the
child still lists the tool unchanged and the gateway still serves the child's definition.

**4. MCP has a block for bytes.** A tool result may carry an embedded resource,
`{type: "resource", resource: {uri, mimeType, blob}}`, with `blob` base64. A server that embeds
resources SHOULD declare the `resources` capability. A `resource_link` names a URI the client
fetches with `resources/read`. Custom URI schemes are allowed under RFC 3986. Sources:
<https://modelcontextprotocol.io/specification/2025-06-18/server/tools> and
<https://modelcontextprotocol.io/specification/2025-06-18/server/resources>.
What clients do with a PDF blob is **not documented**. Claude Code's documentation
(<https://code.claude.com/docs/en/mcp>) covers images only: shown inline and saved to disk. It
caps tool output at 25,000 tokens by default, and a tool may raise its own cap to 500,000
characters at most. A 7.3 MB PDF is about 9.7 MB of base64, so no Claude client will put it in
the model's context. Delivering it intact is still the endpoint's job; what a client does next
is the client's.

## Why the child died

**What the log proves** (`~/Library/Logs/innytypes/innytypes.log`, host process 18995):

- At 12:51:15 the child answered a ping. The DEBUG line "beat reached no helper" is written only
  after an answered ping (`src/innytypes/host.py:328-352`).
- At 12:51:46 the next ping found "the Anytype MCP child session is closed". The session closed
  inside those 31 seconds. The same line repeats every 30 s, 64 times, until 13:23:22.
- Nothing restarted it. The old child supervisor has no restart by design; the helper owns it
  (`supervisor.py:23-24`). Every beat since 2026-09-30 11:27 says no helper is listening. The
  owner was running the host without its helper, so a closed session stayed closed.
- The child process 18997 was gone by 13:26:24, when the helper forgot its record. When it
  exited is not in the log.

**What the log does not hold:** the `tools/call` itself, because the old gateway logs no calls;
the reason the session closed, because `session._fail` logs nothing; and the child's stderr,
which the old app never drained (plan 0015).

**What is inferred, consistent but unproven:** the download reply exceeded the 1 MiB frame
bound, and the session closed itself. The child did not crash. The host stopped listening to it.
The child then likely blocked on a full stdout pipe until the app quit.

**What does not fit:** the old gateway could not have relayed a 7.3 MB reply, so Claude Desktop
should have received the error "the Anytype MCP child sent an oversized frame", not text. The
garbled text the owner saw may come from a smaller call, such as a ranged download. That is
unproven, and slice 01 records the calls Claude Desktop actually makes.

**In the new app** the same reply also closes the session. The heartbeat's next ping then fails
at once. The child is judged stale after three missed pings, 90 s
(`app/src/domain/supervision/staleness.ts:30-47`). The service then restarts it with a notice
(`app/src/application/anytype-service.ts:286-299`). That restart counts against the breaker of
5 in 120 s (`app/src/domain/supervision/breaker.ts:22`). Five large downloads in two minutes
would therefore stop the child for good. Recovery works, but slowly, and a closed session is
known at the instant it closes.

## Where the fix lives

- **(a) Rewrite the child's result in the gateway.** Not possible. The bytes are UTF-8-decoded
  inside the child, so no rewrite downstream can recover them. The reply would also still cross
  the 1 MiB frame.
- **(b) InnyTypes answers `API-download-file` itself.** The services process already holds the
  key and an Anytype client (`app/src/adapters/anytype/api-client.ts`). The dispatch answers this
  one tool from Anytype's REST API and never forwards it to the child. The bytes never cross the
  child's pipes.
- **(c) Fix it upstream.** It needs `responseType: "arraybuffer"` and a resource block in
  `proxy.ts`, and a new pin. The reply would still be one stdout line of about 9.7 MB, so the
  frame bound would have to rise too. An upstream release is slow and not ours to schedule.

**Recommendation: (b).** It keeps the child and its tool surface untouched, keeps the bytes off
the child entirely, and is the only option that works on today's pin. The tool keeps its name
and its input schema, and it is still served only when the validated child lists it. The
answer becomes one embedded `resource` block:

- `uri`: `anytype-file://<space_id>/<file_id>`, a custom scheme.
- `mimeType`: Anytype's `Content-Type`.
- `blob`: the base64 bytes. For `text/*` or JSON that decodes as strict UTF-8, it is `text`
  instead, so a text file stays text.

The gateway declares `resources: {}` and answers `resources/read` for the same scheme by the
same code. `resources/list` stays empty. Range, If-None-Match, If-Range and width are passed to
Anytype as the spec defines them, so a client can fetch part of a large file.

**The bound.** At most `MAX_FILE_BYTES` of file content per answer. The recommendation is 16 MiB,
which is about 21.4 MiB of base64. It is judged first from `Content-Length` (Anytype's
`head_file` or the response header). It is then judged again while reading, so a body that runs
past its header is stopped at the bound. At most two downloads run at once; a third is refused,
not queued. A bound is a refusal, never a crash. The refusal is a tool result with
`isError: true` and this sentence:

> "This file is 40 MB. InnyTypes sends files up to 16 MB, so it wasn't sent. Ask for part of it
> with a byte range."

The log gets one line with the space, the file id and both sizes, never the key.

**The restart.** The service restarts a child whose session closed while its process lives at
once, instead of waiting 90 s for the heartbeat. A closed session already fails every pending
call. Waiting adds nothing but a dead endpoint.

**The old app** gets no code fix. It is being retired (WI-0018-31), and a fix there would be a
second implementation of the same thing in Python. The interim is a known issue in
`docs/INSTALL.md` and the CHANGELOG: downloading a file larger than about 1 MB through the old
app's endpoint stops the endpoint until InnyTypes is quit and opened again.

## Decisions for the owner

- **D1, where the fix lives.** Recommended: (b), InnyTypes answers `API-download-file` itself as
  an embedded resource. The alternative is a `resource_link` plus `resources/read` only. It keeps
  tool results small, but a client that cannot read resources then gets nothing.
- **D2, the bound.** Recommended: 16 MiB of file bytes per answer, and two downloads at once.
  10 MiB would match Anytype's own cap on document bodies but would refuse the 7.3 MB PDF once
  it grows past it.
- **D3, upload.** Recommended: no mirror in this plan. A base64 upload would change the tool's
  input schema, and the surface check would then refuse the child. It is also capped by the
  1 MiB request body. Separately, the child's upload reads a local file path the client names
  (`node_modules/@anyproto/anytype-mcp/src/client/http-client.ts:87-90`). That deserves a
  security review of its own.
- **D4, the old app.** Recommended: a known-issue note only, no code.
- **D5, redaction of the blob.** Every string the endpoint returns is redacted
  (`app/src/application/mcp-dispatch.ts:41-55`), because the child writes most of them.
  Recommended: exempt `blob`, which InnyTypes writes from Anytype's bytes. Base64 cannot hold
  the key verbatim, and replacing a substring would corrupt the file. `text` stays redacted.

## Acceptance

- A 7.3 MB generated PDF served by a fake Anytype comes back as one `resource` block whose
  `blob` decodes to bytes with the same sha256, and whose `mimeType` is `application/pdf`.
  Proved by `app/test/unit/anytype-file-download.test.ts` "a PDF round-trips intact".
- A UTF-8 text file comes back as a `resource` with `text` equal to the file. A file that claims
  `text/plain` but is not valid UTF-8 comes back as `blob`. Proved by
  `anytype-file-download.test.ts` "a text file is still text".
- A file over the bound is refused with the sentence above and `isError: true`, before its body
  is read when `Content-Length` says so, and at the bound when it does not. Proved by
  `anytype-file-download.test.ts` "an oversized file is refused, not read".
- No download reaches the child: the fake child records no `tools/call` for
  `API-download-file`, and it answers a ping after each refusal. Proved by
  `app/test/unit/mcp-dispatch.test.ts` "download never crosses the child's pipes".
- A third concurrent download is refused while two are running. Proved by
  `anytype-file-download.test.ts` "two downloads at once, the third refused".
- Range and width reach Anytype unchanged, and a 206 answer is returned as the partial bytes.
  Proved by `anytype-file-download.test.ts` "a byte range is passed through".
- `initialize` declares `resources`, and `resources/read` on an `anytype-file://` URI returns
  the same contents as the tool. Proved by `mcp-dispatch.test.ts` "resources/read serves the
  same file".
- The blob is not passed through redaction, and a text file holding the key is redacted. Proved
  by `mcp-dispatch.test.ts` "blob exempt, text redacted".
- The committed surface still matches: `tool_surface.json` is unchanged in the diff, and the
  existing `app/test/unit/anytype-pins.test.ts` and the surface tests pass untouched.
- A session closed by an oversized frame while the child process lives is restarted at once,
  with a notice, and counts once against the breaker. Proved by
  `app/test/unit/anytype-service.test.ts` "a closed session restarts the child at once".
- End to end: the app starts against a fake Anytype REST server that serves a generated 7.3 MB
  binary. An independent Streamable HTTP client calls `API-download-file` and gets the same
  sha256, then calls a second tool successfully. Proved by `app/test/e2e/mcp-endpoint.e2e.ts`
  "a binary file round-trips through the endpoint".
- On the owner's machine: Claude Desktop downloads the 293-page PDF through the new app, the
  endpoint keeps answering, and what Claude Desktop does with the block is written down. This
  is a manual check, like plan 0007's.
- `docs/loop/verify.sh` exits zero and prints `gate: GREEN`.

## Work items

Listed here only; nothing goes to `docs/loop/inbox/` until the owner approves.

```yaml
- id: WI-0019-01-download-calls-are-seen
  title: The endpoint logs which tool was called, how big the answer was, and why a session closed
  intent: The incident left no record of the call or the closure. Record both before changing them.
  acceptance:
  - Each tools/call logs its tool name, duration and answer size at INFO, never its arguments.
  - A session closure logs its reason once, at WARNING.
  - 'docs/loop/verify.sh exits zero and prints gate: GREEN.'
  canonical_id: '0019'
  canonical_source: plans
  slice: '01'
  size: S
  status: TODO
  depends_on: []
- id: WI-0019-02-innytypes-answers-download-file
  title: API-download-file is answered from Anytype's REST API as an embedded resource, bounded
  intent: The child destroys bytes and a large reply closes its session. Keep files off its pipes.
  acceptance:
  - The download, text, oversized, concurrency, range, resources/read and redaction bullets of
    plan 0019 pass, with the tests named there.
  - tool_surface.json is unchanged.
  - 'docs/loop/verify.sh exits zero and prints gate: GREEN.'
  canonical_id: '0019'
  canonical_source: plans
  slice: '02'
  size: M
  status: TODO
  depends_on: [WI-0019-01-download-calls-are-seen]
- id: WI-0019-03-a-closed-session-restarts-at-once
  title: A session that closes while the child lives restarts the child without waiting 90 s
  intent: Closure is known at once. Waiting for the heartbeat only lengthens the outage.
  acceptance:
  - The restart bullet of plan 0019 passes with its named test.
  - 'docs/loop/verify.sh exits zero and prints gate: GREEN.'
  canonical_id: '0019'
  canonical_source: plans
  slice: '03'
  size: S
  status: TODO
  depends_on: []
- id: WI-0019-04-a-binary-round-trips-end-to-end
  title: The e2e harness proves a generated binary round-trips through the endpoint
  intent: Unit tests cannot see the assembled path. Run the real app against a fake Anytype.
  acceptance:
  - The end-to-end bullet of plan 0019 passes.
  - The manual Claude Desktop check is run and its result recorded in this plan.
  - The old app's known issue is in docs/INSTALL.md and the CHANGELOG.
  - 'docs/loop/verify.sh exits zero and prints gate: GREEN.'
  canonical_id: '0019'
  canonical_source: plans
  slice: '04'
  size: S
  status: TODO
  depends_on: [WI-0019-02-innytypes-answers-download-file, WI-0019-03-a-closed-session-restarts-at-once]
```

## Non-goals

- Changing `@anyproto/anytype-mcp`, its pin, or `tool_surface.json`.
- Raising the 1 MiB frame or request-body bounds.
- Turning a PDF into text for the model.
- Any code change to the old app.
- The new app's packaged child failing with `MODULE_NOT_FOUND` for `cli.mjs` inside `app.asar`
  (log, 13:24:02 to 13:24:04). That is a packaging defect, outside this plan.
