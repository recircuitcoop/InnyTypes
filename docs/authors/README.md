# Writing a node package for InnyTypes

This is the author-facing map. The contract itself is
[`docs/specs/node-protocol-v2.md`](../specs/node-protocol-v2.md); these pages summarise it and
point at the code an author actually calls — nothing here says something the spec does not
already say, so when the two disagree the spec wins.

| Page | What it covers |
|---|---|
| [`declaration.md`](declaration.md) | `inny-package.json`: what a type is, what fields it needs, the JSON Schema InnyTypes checks it against. |
| [`python-sdk.md`](python-sdk.md) | `innytypes-node`: the Python SDK, standard library only. |
| [`typescript-sdk.md`](typescript-sdk.md) | `@innytypes/node`: the TypeScript SDK, no runtime dependencies. |
| [`packaging.md`](packaging.md) | `inny-pack`: building, signing and verifying the archive you publish. |
| [`catalogue.md`](catalogue.md) | Getting your package listed somewhere InnyTypes can find it. |

## The shortest path

1. Pick a language. Both SDKs implement the whole of the protocol (spec §12.1's checklist) and
   pass the same conformance suite (spec §12.2, C1–C14); neither is a "lite" version of the
   other.
2. Write `inny-package.json` at your package's root ([`declaration.md`](declaration.md)).
3. Write your node process against the SDK ([`python-sdk.md`](python-sdk.md) or
   [`typescript-sdk.md`](typescript-sdk.md)). `sdk/python/examples/echo` and
   `sdk/ts/examples/echo` are two minimal, complete packages — copy one and rename it.
4. Generate a signing key once (`inny-pack keygen`), then build and sign your archive
   (`inny-pack build`) — [`packaging.md`](packaging.md).
5. Publish the archive somewhere over HTTPS and list it in a catalogue
   ([`catalogue.md`](catalogue.md)), or install it locally by folder for development
   (`{package}` then points at that folder directly; no signature is needed for a path
   install, but its content is still hashed and compared the same way — spec 2.3.5).

## What "conformance" buys you

Both SDKs are exercised, not just documented, by
`app/test/conformance/sdk-node.test.ts` and `sdk-views.test.ts`: a real reference package
built on each SDK is run under a harness that plays the runtime, frame by frame, through the
runtime's own frame codec. A package built the way `sdk/python/examples/echo` or
`sdk/ts/examples/echo` is built inherits that: you are not the first author to run this
protocol through this SDK.
