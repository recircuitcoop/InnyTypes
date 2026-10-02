# The declaration: `inny-package.json`

Full contract: `docs/specs/node-protocol-v2.md` §2. This page is the shape of it, for reference
while you write one; InnyTypes checks a declaration against
`docs/specs/inny-package.v2.schema.json` (the spec's §2.6 schema, extracted verbatim) plus a
few rules a schema cannot express (unique ids, no reserved port names, an event type can only
be owned by your own package) — see `app/src/domain/packages/declaration.ts`.

## The shape

```json
{
  "protocol": 2,
  "package": "monty",
  "version": "0.1.0",
  "environment": { "kind": "uv-python", "python": "3.13" },
  "types": [
    {
      "id": "folder-watcher",
      "kind": "source",
      "label": "Folder watcher",
      "command": ["{python}", "{package}/folder_watcher.py"],
      "config": { "type": "object", "properties": { "folder": { "type": "string" } } },
      "outputs": [{ "port": "new", "event": "monty.new.v1" }]
    }
  ]
}
```

- **`package`** matches `^[a-z][a-z0-9_]{1,39}$` (no hyphens) and must be unique among
  installed packages. `user-events` is reserved.
- **`protocol`** is always `2`. A declaration for any other version is refused, naming both.
- **A type's `id`** matches `^[a-z][a-z0-9_-]{0,63}$` (hyphens allowed here) and is unique
  within your package. The Node-RED node type name is derived, never declared:
  `inny-<package>-<id>`.
- **`kind`** is `source` (0 inputs, unless `input: true`), `node` (1 input, 0+ outputs — 0
  makes it a sink), or `view` (1 input; needs `view: "action"` or `view: "snapshot"`, spec §8).
- **`command`** is an argv array, or `{darwin, win32, linux, default}` per platform. Three
  placeholders are substituted: `{python}`, `{node}`, `{package}` (the package's own,
  unpacked directory — a literal `{` is written `{{`).
- **`config`** is a JSON Schema 2020-12 object schema for the instance's settings. A property
  marked `"writeOnly": true` (or `"x-secret": true`) becomes a credential: encrypted at rest,
  delivered only in the `start` frame, never in a flow file.
- **`outputs`** is `[{port, event}]`. `port` matches `^[a-z][a-z0-9_]{0,39}$`; `event` is one
  of your own event type names (below). Ports are numbered in declaration order, and a node
  process refers to them by NAME, never by number.

## The environment

One of three kinds (`docs/authors/packaging.md` covers building each):

| `kind` | What you ship | What InnyTypes runs |
|---|---|---|
| `uv-python` | Your `.py` files, plus `requirements.lock` if you have any dependencies at all (a hash-locked `uv pip compile --generate-hashes` output; no lock at all means no dependencies). | A `uv` venv on InnyTypes' bundled Python 3.13, `uv pip sync --require-hashes` from your lock. |
| `node` | Pre-bundled JavaScript — one file with everything inlined (esbuild, or `inny-pack build` does this for you). No `package.json` dependencies, no install scripts, no native addon (`binding.gyp`): nothing ever runs `npm`. | InnyTypes' bundled Node, on your file directly. |
| `executable` | One binary per `{platform}-{arch}` you support, with its sha256 in the declaration. | That binary, verified against the hash before it is ever run. |

`python` must be `"3.13"` — InnyTypes bundles exactly one Python and refuses anything else.

## Event type names

`<your-package>.<name>.v<N>`, lower case (`monty.new.v1`, `monty.folder.updated.v1`). A
version is immutable once published: a payload shape change is a new `vN+1`, declared beside
the old one. You may only emit under your own package's name — never another package's, and
never `user.*` (reserved for event types the person creates in the app, spec §9).

## Views

A `view` type is `action` (the flow waits until the person answers; §8.1–8.2) or `snapshot`
(records state and the flow continues; §8.3). A snapshot view declares `actions`:
`[{id, label, event, form?}]` — pressing one starts a NEW run on that port, carrying the
snapshot's stored state. Declare a `window` config property (`enum: ["inline", "popout"]`) so
each instance can choose (§8.5); the SDK's `present`/`snapshot` calls are the same either way.

## Config forms

`title` gives the field's label, `description` a tip, `default` the default value. `enum`
becomes a select; `string`/`number`/`integer`/`boolean` become the obvious control; a secret
property becomes a password input backed by Node-RED credentials storage.

A string property can ask InnyTypes for its options through one `innytype` object (spec §2.4.1,
revision 2.1): `{"spaces": true}` offers the paired Anytype's spaces, `{"types": {"of":
"space"}}` the types of the space chosen in the sibling property `space`. The value saved is
still the plain string; the annotation never changes what validates.

```json
"space": { "type": "string", "title": "Space", "innytype": { "spaces": true } },
"type": { "type": "string", "title": "Type", "innytype": { "types": { "of": "space" } } }
```
