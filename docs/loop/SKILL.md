# Loop pack — anytype-mcp

Per-project codified knowledge for the loop (docs-and-code-agree gate input).
See `docs/plans/` for numbered plans; `docs/plans/0001-anytype-mcp-wrapper.md` is the one
that defines this project.

## What this project is, and what it is not

A thin **wrapper around the official Anytype MCP server**, exposing its tools to the
`innytypes` host.

The wrapped thing is **a Node package, not a Python library**. `@anyproto/anytype-mcp`
(official, MIT) converts Anytype's OpenAPI specification into MCP tools. This project
**supervises an npm child process**; it imports nothing from it, and the entire interface
between the two ecosystems is an argv and an environment.

This project owns exactly three things:

1. Supervising the Node process.
2. Holding the Anytype API key safely.
3. Pinning the npm package version and the `Anytype-Version` API version.

**It owns nothing else.** Audio, transcription, speakers, summaries, source watching, and
the host's own contracts belong to `whodunnit`, `monty`, `summarize` and `innytypes`. A
WorkItem here that touches one of those is mis-filed, and a checker should send it back.

## The three constraints a maker must not break

### 1. Pinning, across two ecosystems

The owner's instruction, verbatim:

> innytype and the addons MUST pin their dependencies

Here that crosses a language boundary:

- **Python**: every runtime dependency uses `==`. Never `>=`. Lint/test tooling may use a
  range, but never an unbounded one — an upper bound is mandatory.
- **`requires-python` is one minor version**: `>=3.13,<3.14`.
- **`uv.lock` is committed**, and the gate's first step is `uv sync --frozen`.
- **Node**: `@anyproto/anytype-mcp` at an exact version — no caret, no tilde, no tag — with
  **`package-lock.json` committed**.
- **`Anytype-Version` is pinned in configuration.** The server turns Anytype's OpenAPI spec
  into tools, so the API version *decides which tools exist*. It is a dependency. Changing
  it is a dependency upgrade, with the tool-surface diff as its evidence — never a tweak.
- Two files name the npm version (`package.json` and `config.PACKAGE_VERSION`). They must
  agree; `tests/test_pinning.py` fails the gate when they do not.

This is **enforced, not documented**: `tests/test_pinning.py` parses both manifests. A maker
who adds a `>=` runtime dependency will find the gate red, which is the intent.

### 2. The gate is hermetic

A sibling project taught this the expensive way: a fresh clone failed the gate for reasons
unrelated to any change.

**`docs/loop/verify.sh` must pass from a clean clone with no manual steps.** In particular
it must NOT require:

- the Node MCP server to be installed (`node_modules/` is gitignored — **never depend on a
  gitignored file**), or
- Anytype to be running.

The way this is kept true is dependency injection, not mocking frameworks: `Supervisor`
takes a `spawn` callable, `is_api_reachable` takes an `httpx.Client`. A test that genuinely
cannot be written that way is marked `needs_node` or `needs_anytype` and skipped when the
environment is absent — **marked and skipped, never silently passing**.

A maker who needs `npm ci` to make the gate green has made a mistake somewhere else.

### 3. The API key never enters the tree

This addon holds a credential. Rules:

- The key is read from `$ANYTYPE_API_KEY`, falling back to `~/.config/anytype-mcp/api_key`.
  Both are outside the repository.
- `ServerConfig.api_key` is declared `repr=False`. This is load-bearing: a supervisor logs
  its own configuration when a child dies, and a default dataclass `repr` would put the
  credential into that log. Any new structure carrying the key inherits this obligation.
- `tests/test_no_secrets.py` scans every **git-tracked** file for credential-shaped strings,
  and proves the scanner can fail by planting one. Do not weaken it to make a commit pass —
  if it fires, the fix is to remove the credential.

## Acceptance conventions

Every acceptance criterion must be able to **fail**. "The supervisor works" is not a
criterion; "a fake spawn that always exits non-zero produces exactly N spawn calls with
increasing delays" is.

Two specific traps in this repo:

- **An acceptance criterion is never "the real server returns the right tools".** That
  requires Node and a running Anytype, so it cannot be a gate condition. The gate-side
  criterion is about the *comparison code* and the *committed fixture*.
- **A criterion that only passes because something is skipped is not satisfied.** If a check
  depends on `needs_node`, say so in the criterion and give the gate-side equivalent too.

## Done

A slice is done when `docs/loop/verify.sh` is green in its worktree, its acceptance list is
satisfied, and an independent fresh-context checker agrees.

## Parallel execution (git worktrees)

**Run ready work in parallel.** When several WorkItems have every dependency satisfied,
dispatching them concurrently — one worktree per slice — is the default and preferred mode.
Working a ready set one item at a time is the choice that needs a justification; concurrency
does not. What is never allowed is running an item whose predecessor is unfinished: eligibility
comes from the dependency graph, never from "these two slices touch different files".

The rules below are how to run concurrently *safely*. They are not a case for doing less of it.

The loop runs slices in worktrees under `.claude/worktrees/`. They isolate the **working
files** and nothing else — not the project's test database, not the git remote, not any
shared branch. These rules are not optional, and **every executor spec must carry them**:
an agent cannot follow a policy it was never handed.

1. **An agent never pushes a shared branch** (`main`, and whatever the project promotes
   through). Not to fix it, not to sync it. An agent pushes only its own branch.
2. **Never force-push; never push a shared branch that is behind its remote.** A
   non-fast-forward push silently discards merged work.
3. **`MERGED` is not proof.** After a merge that matters, verify the artifact —
   `git cat-file -e <shared-branch>:<a file the PR added>` — not the forge's status field.
   Then fast-forward the local branch so it cannot go stale.
4. **Never reprovision or re-stamp shared test state to go green.** If the suite fails on
   state you did not create, prove it: stash your whole diff, re-run, report identical
   failures. CI provisions its own and is the authority.
5. **`docs/log.md` conflicts are resolved by keeping BOTH entries**, chronologically.
6. **A worktree has no virtualenv of its own** if the project's is gitignored. Use the main
   checkout's environment, or the project's canonical gate command.

**Owner action — the half no hook can give you.** loopify installs a `pre-push` guard in
every managed worktree, but that is the *client-side* half: it is bypassable with
`--no-verify` and simply absent from any checkout the engine did not create. The
authoritative protection is **branch protection on the forge** (GitHub/GitLab settings:
require a PR, forbid force-push, forbid deletion) on every branch listed in
`protected_branches`. Set it once, per repo, by hand. Until it is set, rule 1 above is a
convention the tooling helps you keep — not a guarantee it enforces.

Observed on a real project, one afternoon: a migration in one worktree stamped the shared
test DB and gave an unrelated agent 20+ failures reading as migration bugs; a stale shared
branch was pushed and moved backwards, discarding a merged commit while the forge still
said `MERGED`; branch cleanup failed against a worktree-held branch so the merge gate
exited non-zero after a *successful* merge; and every second branch conflicted on the log.

The structural fixes live with the loop engine itself, in the loopify repo — this project
vendors the pack, not the engine's plans, so there is no such document here. Note the one
that looks like a fix and is not: a project that already had an exclusive lock on its test
database still suffered the contamination. A lock serializes *access*; that failure was
persistent *state*.
