# Packaging and signing: `inny-pack`

Source: `tools/inny-pack/`. `inny-pack` builds the archive spec §2.3.5 defines, signs it with
minisign, and then re-verifies what it just built through the **same code InnyTypes itself
runs on install** — `domain/packages/archive.ts`, `domain/packages/environment.ts`,
`adapters/signature/minisign.ts`, `adapters/fs/package-source.ts` — so a package `inny-pack`
finished building is one InnyTypes has already, in that same run, agreed to accept.

Build it once (or `node tools/inny-pack/cli.ts` directly, which runs from source):

```sh
npx esbuild tools/inny-pack/cli.ts --bundle --platform=node --target=node22 --format=cjs \
  --outfile=tools/inny-pack/dist/cli.cjs
alias inny-pack="node $(pwd)/tools/inny-pack/dist/cli.cjs"
```

## 1. Generate a signing key, once

```sh
inny-pack keygen ~/.inny-pack --name my-name
```

Writes `~/.inny-pack/my-name.pub` (share this — it is what people trust your packages by) and
`~/.inny-pack/my-name.key` (never share, never commit; mode `0600`). This is **not** a
minisign secret key file — minisign's own secret key format is passphrase-encrypted, and
reimplementing that container is out of scope here. Nothing in InnyTypes ever reads a secret
key, only the public key and the signatures you make with it, and those ARE the format
minisign itself produces (`docs/domain/signature/minisign.ts` parses either equally). If you
already run real `minisign` and want its public key format specifically, that also works —
`inny-pack verify` and the app's own installer read a bare minisign `.pub` file either way.

`inny-pack build` also refuses outright if it finds a `.key` file inside the package folder
you point it at, so a signing key can never ship by accident.

## 2. Prepare your files

**`uv-python`:** if you have any dependency at all, generate a hash-locked
`requirements.lock` at your package's root:

```sh
uv pip compile requirements.in --generate-hashes -o requirements.lock
```

Exact pins (`name==version`) with `--hash=sha256:...` and nothing else — no ranges, no git
references, no local wheels (`domain/packages/lock.ts` refuses anything else, and `inny-pack
build` runs that same check before it signs a byte). No dependencies at all means no
`requirements.lock` file — its absence IS the declaration of "nothing to install".

**`node`:** bundle your entry point into one file that runs with no `npm install` step ever
(spec §2.3.3 refuses a `package.json` with dependencies, an install script, or a
`binding.gyp`):

```sh
npx esbuild src/main.ts --bundle --platform=node --target=node22 --format=cjs \
  --outfile=dist/main.cjs
```

Then your `inny-package.json` command names `["{node}", "{package}/dist/main.cjs"]`.

**`executable`:** build your binary for each `<platform>-<arch>` you support, and declare its
path and sha256 under `environment.binaries` (`docs/authors/declaration.md`).

## 3. Build and sign

```sh
inny-pack build path/to/your-package --key ~/.inny-pack/my-name.key --out your-package-1.0.0.tgz
```

This:

1. reads and validates `inny-package.json` — the same JSON Schema and the same rules beyond it
   (`domain/packages/declaration.ts`) the app checks on install, so a broken declaration is
   refused here, before anything is signed, with the same wording;
2. judges your environment the way the app would (`domain/packages/environment.ts`) — the
   Python version, the hash lock, the "no install step" rule, the binary hashes;
3. hashes every file into `files.json`;
4. signs `files.json` with your key, `files.json.minisig`;
5. tars and gzips everything into the archive;
6. **re-reads that archive** through the app's own verification path and prints its content
   hash — if this step disagrees with what was just built, `inny-pack` refuses to hand you the
   file rather than publish something broken.

## 4. Verify an archive on its own

```sh
inny-pack verify your-package-1.0.0.tgz --key ~/.inny-pack/my-name.pub
```

Exactly the check the app runs before it ever unpacks a file from the archive: the signature
over `files.json`, every listed file against its hash (and nothing present that is not
listed), and the content hash (the sha256 of the sorted `sha256sum`-style lines of every file
— plan 0013's "one version, one content" rule: a version whose bytes moved without a new
version number is refused the same way here as it is on install).

## A path install, for local development

While developing, point InnyTypes at your package's folder directly — no archive, no
signature. It is still hashed and compared by content the same way (spec §2.3.5): the content
hash is what stops a version silently changing under you, archive or not.
