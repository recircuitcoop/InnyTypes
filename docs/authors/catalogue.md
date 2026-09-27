# Getting listed: the catalogue

Full format: `app/src/domain/packages/catalogue.ts`. There is no registry to apply to —
"any plugin developer who follows this convention can become a plugin source" (plan 0006 F1).
Publishing the file below at an HTTPS URL, next to your signed archives, IS becoming a source.

## The document

Published at some `https://.../catalogue.json`, alongside its detached minisign signature at
the same URL plus `.minisig` (`minisign -Sm catalogue.json`, or your own key from
`inny-pack keygen` the same way `inny-pack build` signs a package archive):

```json
{
  "catalogue": 1,
  "plugins": [
    {
      "id": "monty",
      "summary": "Watches a folder and turns new files into events.",
      "source": "index",
      "archive": "monty-0.1.0.tgz",
      "version": "0.1.0"
    }
  ]
}
```

| Field | Rule |
|---|---|
| `id` | Lowercase letters and digits joined by single hyphens (`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`) — not the same pattern as the declaration's `package` field, which has no hyphens; the two may differ. |
| `summary` | One line, at most 200 characters, no control characters — it is drawn beside a button. |
| `source` | `index`, `index:<name>`, `pypi:<project>`, or `git+https://...` (HTTPS only). Legacy install kinds; a modern listing uses `archive` instead (below) and this can be `"index"`. |
| `archive` | The signed `.tgz` `inny-pack build` produced, as an HTTPS URL or a path resolved against the catalogue's own URL. What the Packages page installs from. |
| `version` | The version the archive holds — compared against what is installed to offer an update. |

Unknown keys inside an entry are ignored (a future field can be added without breaking old
readers); unknown top-level keys are refused outright, and a bad catalogue is refused whole —
never partially trusted.

## Registering your catalogue

The person adds your catalogue as a source in their own settings — nothing here requires you
to contact anyone:

```toml
[sources.acme]
url = "https://packages.acme.example/catalogue.json"
public_key = "RWQf6LRCGA9i5..."   # the single base64 line of your minisign .pub file
auto_update = false
```

`public_key` is the bare base64 line only — the second line of the `.pub` file `inny-pack
keygen` wrote, no comment line, no whitespace. Without it, entries from your catalogue install
but are marked unverified.

## Verification is not consent

A catalogue signature settles that a listing came from you and was not altered in transit. It
vouches for nothing about any one package's code — the package's own signature
(`docs/authors/packaging.md`) does that — and whether a person's machine acts on your listing
at all is their own switch, never your signature.
