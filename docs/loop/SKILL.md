# Loop pack — innytypes

Per-project codified knowledge for the loop (docs-and-code-agree gate input), so the maker
and the checker share intent. The numbered plans are in `docs/plans/`; plan 0001 is the host, plan 0002 the Anytype MCP
server inside it.

## What this project is

`innytypes` is a **host application that wraps the Anytype desktop app**. Starting it starts
Anytype plus a sidecar. Features arrive as **addons**. The host owns process supervision,
addon discovery and lifecycle, dependency resolution, a cross-process event bus, the stable
API contracts addons depend on, and the official Anytype MCP server (`innytypes.anytype_mcp`).

Three addons will exist — `monty`, `whodunnit`, `summarize` — and **this repo builds none of
them**. They appear in acceptance criteria only as the consumers the host's contracts are
designed against. `anytype-mcp` was once planned as a fourth addon; it is core now (plan 0002),
and a WorkItem that turns it back into an addon is a change to plans 0001 and 0002.

## Invariants a checker sends work back for

1. **The host depends on NO addon.** Addons depend on the host; addons may depend on each
   other. No module under `src/innytypes/` may import an addon package, and no host test may
   require one to be installed. This is the invariant the whole design rests on — a change
   that inverts it is a change to plan 0001, never an implementation detail.
2. **Dependencies are pinned.** Every runtime dependency in `pyproject.toml` uses `==`, never
   `>=`. Lint/test tools may use ranges but always with an upper bound. `requires-python` is
   pinned to one minor version (`==3.13.*`, the family interpreter, matched by
   `.python-version`; moving it is a family decision, never a per-repo one). `uv.lock` is
   committed. `@anyproto/anytype-mcp` is an exact version in `package.json` with
   `package-lock.json` committed, and `config.PACKAGE_VERSION` agrees with it. A WorkItem that
   adds a floating dependency is not done, however green the tests are. `tests/test_pinning.py`
   enforces this.
3. **An event kind is a public API.** Kinds are `<addon-id>.<name>.v<N>`. Changing a payload
   means a **new kind**; the old one keeps working. An addon may only emit kinds it owns, and
   only kinds it registered. Payloads are JSON-serializable, because every event crosses a
   process boundary.
4. **An emitter never blocks on a subscriber.** Delivery is fire-and-forget over a bounded
   per-subscriber queue. A subscriber that dies, hangs or falls behind is dropped and the host
   emits `innytypes.listener-failed`. Any design where a slow listener can stall a publisher is
   wrong even if it passes.
5. **A missing requirement degrades, it does not crash.** The addon does not start, the host
   reports what is missing, everything else keeps running. This is designed behaviour and needs
   a test that actually removes a requirement — not an error path nobody exercises.
6. **Installation is explicit.** `innytypes addons install`, never an implicit install at
   startup. A startup that mutates the environment is a startup nobody can debug.
7. **The Anytype API key never enters the tree.** It is read from `$ANYTYPE_API_KEY`, falling
   back to `~/.config/innytypes/anytype_api_key`. `ServerConfig.api_key` is `repr=False`, and
   that is load-bearing: a supervisor logs its configuration when a child dies. Any new
   structure carrying the key inherits the obligation. `tests/test_no_secrets.py` scans every
   tracked file; if it fires, remove the credential, never weaken the scanner.
8. **The `Anytype-Version` pin is a dependency.** The MCP server turns Anytype's OpenAPI spec
   into tools, so that header decides which tools exist. Changing it is a dependency upgrade
   with the tool-surface diff as evidence, never a tweak. `innytypes.anytype_mcp` owns the
   Node process, the key and the two pins, and nothing else: a WorkItem that puts audio,
   transcription, summaries or source watching into it is mis-filed.

## What "done" means here

A WorkItem is done when **all** of these hold:

- `docs/loop/verify.sh` exits zero and prints `gate: GREEN`.
- Every acceptance line in the WorkItem is demonstrably true, checked by something that could
  have failed. An acceptance criterion that passes with no work done is a defect in the
  WorkItem, and a checker rejects it rather than ticking it.
- The behaviour is covered by a test that fails if the behaviour is removed. Refusals
  (an unowned kind, a cycle, an unregistered kind, a non-serializable payload) need a test that
  asserts the refusal — the easiest way to "pass" a refusal requirement is to not implement it.
- Documentation and code agree: if the slice changed a contract, plan 0001 says the new thing.

## The gate is hermetic — do not regress this

`docs/loop/verify.sh` must pass **from a clean clone with no manual steps**. It runs
`uv sync --frozen` first and every tool afterwards with `--no-sync`.

This is a lesson paid for on a sibling project, where a fresh worktree failed the gate for
reasons unrelated to any change: a bare `uv run` built a venv missing an optional extra, and
tests depended on gitignored fixture files present only in the main checkout.

So: **no test may depend on a gitignored file.** A fixture is either committed, or generated by
the test that needs it. If you find yourself writing "run X first, then the tests pass", the
gate is broken and that is the bug to fix.

The gate needs neither Node (`node_modules/` is gitignored) nor a running Anytype. This is kept
true by dependency injection, not mocking frameworks: `Supervisor` takes a `spawn` callable and
`is_api_reachable` takes an `httpx.Client`. A test that genuinely cannot be written that way is
marked `needs_node` or `needs_anytype` and skipped when the environment is absent. A criterion
that only passes because its test is skipped is not satisfied, and "the real server returns the
right tools" is never a gate condition. A maker who needs `npm ci` to go green has made a
mistake somewhere else.

## Anytype integration

`innytypes.anytype_mcp` holds key discovery, a reachability check against Anytype's **local API
on port 31009**, and the two version pins. Build on it rather than beside it. There is also a
key file at `~/git/cleanup_automation` on this machine, a pointer to where authentication was
already solved, to be read when that slice is worked. **Secrets are never copied into this
repository.**

## Parallel execution (git worktrees)

**Run ready work in parallel.** When several WorkItems have every dependency satisfied,
dispatching them concurrently — one worktree per slice — is the default and preferred mode.
Working a ready set one item at a time is the choice that needs a justification; concurrency
does not. What is never allowed is running an item whose predecessor is unfinished: eligibility
comes from the dependency graph, never from "these two slices touch different files".

The rules below are how to run concurrently *safely*. They are not a case for doing less of it.

The loop runs slices in worktrees under `.claude/worktrees/`. They isolate the **working
files** and nothing else — not the git remote, not any shared branch. These rules are not
optional, and **every executor spec must carry them**: an agent cannot follow a policy it was
never handed.

1. **An agent never pushes a shared branch** (`main`, and whatever the project promotes
   through). Not to fix it, not to sync it. An agent pushes only its own branch.
2. **Never force-push; never push a shared branch that is behind its remote.** A
   non-fast-forward push silently discards merged work.
3. **`MERGED` is not proof.** After a merge that matters, verify the artifact —
   `git cat-file -e <shared-branch>:<a file the PR added>` — not the forge's status field.
   Then fast-forward the local branch so it cannot go stale.
4. **Never reprovision or re-stamp shared state to go green.** If the suite fails on state you
   did not create, prove it: stash your whole diff, re-run, report identical failures.
5. **`docs/log.md` conflicts are resolved by keeping BOTH entries**, chronologically. The
   repo's `.gitattributes` gives that file the union merge driver for exactly this reason.
6. **A worktree has no virtualenv of its own** — `.venv/` is gitignored. Run the canonical
   gate command, `docs/loop/verify.sh`, which builds its own environment from `uv.lock`.

**Owner action — the half no hook can give you.** loopify installs a `pre-push` guard in every
managed worktree, but that is the *client-side* half: bypassable with `--no-verify`, and simply
absent from any checkout the engine did not create. The authoritative protection is **branch
protection on the forge** (require a PR, forbid force-push, forbid deletion) on every protected
branch. Set it once, by hand. Until it is set, rule 1 is a convention the tooling helps you
keep — not a guarantee it enforces.
