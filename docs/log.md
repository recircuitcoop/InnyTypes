# Log — durable loop outcomes

## 2026-09-15 — anytype-mcp absorbed into the core

The `anytype-mcp` repository (planned as an addon) moved into the host as
`innytypes.anytype_mcp`, with its plan renumbered to 0002 and its WorkItems to `WI-0002-*`.
Restart-with-backoff moved out of its slice 03 into plan 0001 slice 07, so there is one restart
policy for every child kind. Its history is merged into this repository; the original
repository was deleted.

## 2026-09-15 — plan 0002 revised form approved; MCP host integration reordered

The owner approved plan 0002 as revised during the absorption (restart policy moved to plan
0001 slice 07; slice 05 is host integration rather than an addon contract). Plan 0001 slice 07
is now seeded as `WI-0001-07-process-supervision`, and `WI-0002-05-host-integration` depends on
it, so the MCP server cannot be wired into the host before the host's supervisor exists.

## 2026-09-17 — plan 0003 (InnyTypesHelper) approved; plans 0001 and 0002 amended

The owner answered all 27 decisions of plan 0003. The helper is a separate process started by a
single application icon; it starts Anytype and the host, owns every restart, updates the core and
the addons, and sends telemetry keyed by a machine hash detached from personal information.
Consequences for the approved plans: the host keeps spawning its children but restarts nothing
(plan 0001 slice 07, `WI-0001-07` rewritten); each addon gets its own environment and discovery
reads recorded manifests (plan 0001 slice 02, `WI-0001-02` rewritten); invariant 6 names the
helper as its one exception; plan 0002 points restart policy at plan 0003. Seven follow-up
decisions (F1–F7) are open in plan 0003. No WorkItems are seeded for plan 0003 yet.

## 2026-09-17 — plan 0003 follow-ups F1–F7 answered

The host relaunches a crashed helper, and the owner required "a clear and easy way of turning the
whole InnyTypes application off": Quit in the app, the Dock/taskbar, `innytypes quit`, an external
stop of the helper, logout, and `innytypes quit --force` all stop everything with nothing
relaunched. Telemetry sends and queues nothing until the first-launch question is answered. Usage
telemetry goes to Umami. Controls live only in the application's own window and menus, never in the
system tray. Bundles are built with BeeWare Briefcase without OS code signing for now, so users see
the unidentified-developer warnings. A running Anytype is adopted and stopped on quit only if the
application started it. `launch_at_login` exists and is off by default.

## 2026-09-18 — plans 0001 and 0002 built out; plan 0003 two thirds done

Both earlier plans are complete: the host (manifest, discovery, resolution, events, transport,
children, install/CLI, Anytype client) and the Anytype MCP server (key acquisition, health-gated
start with redacted logs, the committed tool surface, the bump procedure, host integration).

A fresh-context audit of the first sixteen finished slices came back REFUTED, and its findings
became WorkItems rather than quiet patches. Three were real: `innytypes up` crashed where plan
0001 invariant 5 promises degradation, and the suite asserted BOTH behaviours in different files;
the addon runner every child is spawned as (`innytypes.addons.run`) did not exist, so the event
bus was wired to nothing in production; and a circular import made a cold `import
innytypes.children` fail. Two smaller ones — a credential scanner that skipped any line
containing the word "example", and two config writers sharing one scratch file — were fixed in
place. Every one of them lived BETWEEN slices, where no per-slice acceptance list could see it.

Building the helper also found a defect in the host's own records: the MCP child was recorded as
the resolved `npx` path, while the OS reports the Node binary as that process's image, so the
record could never pass the helper's three-fact identity check. The fix was to record what the OS
reports rather than to loosen the comparison.

Left when this entry was written: the launcher and quit, the application window, telemetry, core
apply and rollback, plugin update apply, notifications, Linux and Windows.

## 2026-09-18 — the bundles, the icon, and the first clickable InnyTypes

Plan 0003 slice 17 packaged the application with Briefcase, and building it for real on a macOS
machine found three things no hermetic test could have.

**What was built.** A `[tool.briefcase]` configuration whose bundle identifier is D27's
`it.l1nx.innytypes.helper` — one string now spelled once, in `innytypes.helper.config`, and
imported by the macOS, Linux and Windows modules that used to each carry their own copy. The
icon is a white arrow pointing downwards on a black background, as the owner asked, drawn by
`tools/make_icon.py` with nothing but the standard library and committed at every size the three
platforms ask for. The two things that had been waiting for a bundle landed: `MacLoginItem`, a
LaunchAgent naming the installed bundle's launcher, and `TogaDesktop`, the drawing the window's
model had been missing. `UnpackagedLoginItem` still refuses, for a run with no bundle.

**What building it actually found.** Three real defects, none of which a test would have caught,
because all three are about what happens when an application is a bundle rather than a script:

1. **A bundle has no Python to start the host with.** Briefcase ships the interpreter as a
   framework and exactly one executable, so `python -m innytypes up` could not be spelled: the
   helper was launching its own stub, which re-ran the helper. The application now starts a
   second copy of itself with `--innytypes-host`, and an unpackaged install is unchanged.
2. **A signal-based quit does nothing inside an event loop.** A handler installed with
   `signal.signal` runs between Python bytecodes, and an application sitting in the operating
   system's own run loop executes none — a terminate left the helper running until something
   killed it. The handlers are registered on the toolkit's loop now, through the `register` seam
   that already existed.
3. **The toolkit's own Quit had to be wired to the application's.** ⌘Q and the Dock's Quit would
   otherwise have ended the helper and left the host, the MCP server and the plugins running.

**What was seen on the machine, and what was not.** The built `InnyTypes.app` opens with no
warning, shows its window with the two switches and **Quit InnyTypes**, starts the host, and
adopts the Anytype that was already running. Pressing Quit records the quit as `menu`, stops the
host, ends the helper, releases the lock — and leaves the adopted Anytype alone, which is F6
working. A `SIGTERM` to the helper does the same and is recorded as `external-stop`. What was
**not** seen: Anytype being *started*, because it was already running and the executor did not
close the owner's; and the Windows and Linux packages, because each platform builds on itself.

**The warning-after-update question is still open, and narrower.** A locally built bundle is not
quarantined and shows no warning at all; `spctl` *rejects* the ad-hoc signed bundle, so the
question is whether Gatekeeper looks rather than what it would say; and a file the helper
downloads with `httpx` gains `com.apple.provenance` and not `com.apple.quarantine`. Settling it
needs a release a user actually downloaded, and there is none yet.

## 2026-09-18 — the four questions that needed a real machine, answered

Plan 0003 and `WI-0003-17` each carried open lines that no test could close, because they are
properties of operating systems and of packaging tools rather than of this code. All four were
run on this Mac. Three are now settled; one is settled as *impossible from here*, which is an
answer too.

**Does the unidentified-developer warning come back after an update? On macOS, no.** The bundle
was built (`briefcase create macOS`, `briefcase build macOS`) and copied twice. One copy was
made to look downloaded — `xattr -w -r com.apple.quarantine "0083;<hex>;Safari;<uuid>"`, read
back on the bundle and on `Contents/MacOS/InnyTypes`, `spctl --assess --type execute` answering
*rejected* — and the other left as built. Then the swap the updater really performs was run over
them: `innytypes.helper.swap`'s own `_remove(previous)`, `_rename(live, previous)`,
`_rename(incoming, live)`, against a real `ReleaseRoots`, on real `.app` bundles. Afterwards the
bundle at the live path had **no** `com.apple.quarantine` at all, and the attribute was found
intact on the displaced copy now called `previous` — because an extended attribute belongs to
the inode, and the quarantined bundle was renamed aside rather than written over. The swapped-in
bundle was then opened with `open -n` at that same path: it started the helper, started Anytype
and started the host, unattended, nothing to click. `spctl` still says *rejected*, which is the
point — Gatekeeper would refuse this ad-hoc signed bundle if it assessed it, and it does not
assess it, because there is no attribute to make it look. **Not covered:** the swap today
replaces a release directory under Application Support, and nothing in the helper replaces a
`.app` yet; the answer holds for the bundle-replacing updater as long as it stays two renames.
**Windows was not observed** and stays open: SmartScreen needs a Windows machine.

**The Anytype branch slice 17 could not see.** With Anytype closed, the built bundle was opened.
The run-state file came back with helper, host and `innytypes.anytype-app`, and the Anytype
record's `parent_pid` was the helper's pid — the file saying *this application started it*.
`innytypes quit` then ended the helper and **Anytype went with it**: no `Anytype.app` process
left, the run-state file back to `{"records": []}`. That is the half of F6 that had never been
run; the adopted half, seen in slice 17, is unchanged.

**A Linux package can be built from this Mac, and one was.** Briefcase builds Linux inside a
container of the *target* distribution rather than against the host, and what it looks for is a
binary called `docker` — a two-line shim execing `podman` satisfied every call it made
(`info`, `buildx version`, `images`, `pull`, a host-write test, `buildx build`, `run --volume`).
Three things had to be right, each found by a failure: the target must ship Python 3.13, so
`ubuntu:jammy` is refused by Briefcase itself and `debian:trixie` works; cairo's and GObject
introspection's headers must be installed in the build container, or `pycairo` stops the build
at `metadata-generation-failed` — that is the new
`[tool.briefcase.app.helper.linux.system.debian]` section; and `briefcase package` wants
`--adhoc-sign` or it stops to ask for a GPG identity. It produced
`dist/helper_0.1.0-1~debian-trixie_arm64.deb`, 2.1 MB, carrying `/usr/bin/helper`,
`/usr/share/applications/it.l1nx.innytypes.helper.desktop` and the icon at every `hicolor` size.
**Two things still stand between that and a clean-checkout build, and both are the owner's to
write:** a licence file named in `license-files`, and a changelog — Briefcase refuses a Linux
package without either, because Debian requires them. The build above was proved with
placeholders that were deliberately **not** committed.

**Windows cannot be built from macOS, and that is the end of it.** `briefcase create windows`
on this machine exits with *"Windows applications can only be built on Windows"* before doing
any work. There is no container and no cross-compile for that backend. The real path is a
Windows machine or a Windows CI runner.

**One defect found on the way, and fixed.** With Anytype closed, five tests in
`tests/test_mcp_child_identity.py` failed: they build a `Supervisor` with no `health_client`, so
its health gate asked the *real* machine whether Anytype's local API was answering. The gate
calls itself hermetic, and those five passed only while the developer happened to have Anytype
open. They now inject a mock-transport client, as every other test of that supervisor already
did. Nothing about the health gate is what they test; it was only a precondition on the way to
the record they do test.

## 2026-09-18 — the first addon installed for real: monty, from a checkout

**`innytypes addons install /Users/martinteller/git/monty` works**, with real `uv`, on a machine
where `innytypes` is published nowhere. Verbatim:

```
$ uv run --no-sync innytypes addons --addons-root /tmp/innytypes-monty-test \
      install /Users/martinteller/git/monty
Installed monty 0.1.0 in /tmp/innytypes-monty-test/monty/env.
Recorded its manifest at /tmp/innytypes-monty-test/monty/manifest.json.

$ uv run --no-sync innytypes addons --addons-root /tmp/innytypes-monty-test list
monty  0.1.0  installed
```

`--addons-root` belongs to the `addons` **group**, before the subcommand; written after
`install` it is refused as an unknown option, which is what the first attempt did.

**What made it possible** is that the host no longer asks an index for itself. Until this run,
every install ended at *"Because innytypes was not found in the package registry and you require
innytypes==0.1.0, we can conclude that your requirements are unsatisfiable"* — the host's own
rule, resolved against an index this project has never been published to. The host now builds a
wheel of its own source tree and the environment installs that. The recorded lock shows both
artifacts side by side, each with the digest of the file it was installed from:

```
innytypes @ file:///tmp/.innytypes-install-9h5ht4nj/host/innytypes-0.1.0-py3-none-any.whl \
    --hash=sha256:b0842419dd94dfc36d3c1f1bb941032f7f36796756cee3ae436a9d351d2b117c
monty @ file:///tmp/.innytypes-install-9h5ht4nj/build/monty-0.1.0-py3-none-any.whl \
    --hash=sha256:...
```

185 lines in that lock — the two artifacts and every transitive dependency of both, pinned and
hashed, installed with `--require-hashes --no-deps`. The two `file://` paths point into the
scratch directory the install built in and removed; the lock records what was installed, not a
place to install it from again.

**The environment holds what it should.** `monty/env/bin/python -c "import innytypes, monty"`
reports `innytypes 0.1.0` — the running host's own version — and imports the addon, and the
recorded manifest is the one monty's entry point returned (`host_api: 1`, emits
`monty.copied.v1`).

**What is still open.** A bundled host has no source tree to build a wheel from, so
`addons install` refuses there by design, naming the directories it looked in; until a bundle
ships a wheel of itself, addons are installed from a checkout. And `innytypes addons outdated`
still resolves a candidate against `innytypes==<version>` (`helper.versions.UvLockResolver`), so
it will fail on this machine for the reason install used to — the same fix, one slice along.

## 2026-09-18 — monty installed as the first real addon

`innytypes addons install /Users/martinteller/git/monty` works, and discovery reports
`monty 0.1.0` emitting `monty.copied.v1`, broken: none. monty itself needed no change: it
already carried both entry points and was written against the documented contract rather than
against an innytypes import.

Getting there took two host-side fixes and found a third defect, none of which any test had
caught, because all three are about the world outside the gate:

1. **Install accepted only `name==version` from an index**, so an addon on no index could not be
   installed at all — which is every addon there is (`WI-0001-08c`). A directory is built into a
   wheel first, because a resolver writes a local directory into a lock with no hash.
2. **Every addon environment pinned `innytypes==<host version>` and resolved it from an index**
   where innytypes has never been published: *"Because innytypes was not found in the package
   registry and you require innytypes==0.1.0, we can conclude that your requirements are
   unsatisfiable."* The host now builds a wheel of itself (`WI-0001-08d`).
3. **A `file://` reference was written unencoded**, so the space in the default macOS addons
   root — `~/Library/Application Support/innytypes` — split the requirement into two tokens and
   the lock refused its own entry. Paths are now written with `Path.as_uri()`. Every install on
   a stock Mac would have failed this way; it was found by running one.
## 2026-09-20 — WI-0006-02c plugin catalogue lists

The application's tab model now carries the installed list, the official catalogue and each
registered source in configuration order. Catalogue rows name their publisher and requirement,
mark unverified publishers at the decision point, refuse an already installed or officially
shadowed entry, and route Install through one injected existing install path. A successful
source install records its catalogue in `[plugins.<id>]`, making that source's auto-update
switch effective immediately.

Source registration, removal and auto-update changes use `HelperSettings`; bad URLs, duplicate
names and unusable minisign keys become messages without changing `config.toml`. A failed or
unreachable catalogue removes only its own entries and leaves the installed and other catalogue
groups intact. Plan 0004's superseded D12 and `PluginView`'s old installed-only-page wording now
point to plan 0006 D4. The canonical gate passed with 2,229 tests and 97.16% coverage.
## 2026-09-20 — WI-0006-04 tabbed drawing

The Toga window now draws the model's persistent tab strip with the application first and one
pane per installed plugin.  Selection is model-owned in both directions; leaving a plugin tab
folds scalar and table widgets into that tab's working copy without writing settings.  Save and
Cancel route through `PluginTab`, a failing pane is replaced by its reason without losing the
window, and the sole Quit control is outside the strip.  The tabbed platform sweep covers macOS,
Linux and Windows stand-ins.  The canonical gate passed 2,246 tests at 97.04% coverage.

## 2026-09-21 — plan 0007 approved: expose the host-owned Anytype MCP child

The owner approved one live MCP path from clients such as Codex through InnyTypes to the existing
official Anytype MCP child, then corrected the transport before implementation: InnyTypes starts
an authenticated Streamable HTTP MCP endpoint on loopback TCP, and independently started clients
connect to its URL. Neither application launches or supervises the other. The host alone owns and
speaks to the child's private stdio pipes; no second MCP child starts, no client calls Anytype on
port 31009, and the API key never crosses the HTTP boundary. Live tools must match the committed
surface before exposure. Four ordered WorkItems cover key-path agreement, the internal child
session, the loopback HTTP service and independent client verification.

## 2026-09-22 — plan 0007 built: the loopback MCP endpoint

All four slices landed. One loader answers where the Anytype key lives, and the host, the helper
and acquisition all use it; the legacy helper path stays a read-only fallback. The supervisor
that already owned the Node child now speaks one bounded MCP session over its private pipes,
validating the live tool surface against the committed one before anything may use it, and
failing every waiting call rather than retrying a request that could change Anytype twice. The
host serves that validated child over authenticated Streamable HTTP on a loopback port, refusing
anything that is not a numeric loopback bind, checking the token before parsing a body, and
passing every response through one redaction point on the way out.

An independent check refuted the first attempt and was right twice. The redaction had been put
on the one reply shape an Anytype refusal never takes, and the request timeout bounded a single
socket operation rather than a whole request, so eight clients dribbling a byte at a time still
held every slot. Both are fixed, and three tests that had been passing against broken code were
rewritten to fail against it first.

The application shows the address it is actually configured with, after a defect that displayed a
confident wrong one, and reports the endpoint's state apart from the child's because the two
disagree. Source tests hold the independence the plan promises in both directions.

Left open: the by-hand confirmation that Codex reaches the endpoint. The service sends no
session id, offers no event stream and requires a content length, all permitted and none proven
against the real client. The work also found that the helper-to-host control channel has no
production caller, which plan 0008 now owns. The canonical gate passed with 2,395 tests at
96.83% coverage.

## 2026-09-22 — plan 0008 built: the endpoint is configurable where a person can reach it

The address and port became stored settings that win over the environment variables, key by key,
with an unstored key left absent rather than defaulted so a machine that was never configured
behaves exactly as it did. The gateway learned to move a serving listener: bind the new address
while the old one is still answering, swap, and only then stop accepting and release, so an
address that cannot be served is refused with its reason and the endpoint that was working is
still working. The panel offers both fields, refuses what the endpoint would refuse before
anything is sent, reports the address the host answered rather than the one typed, and warns
that clients must be updated only when the address actually moved.

Carrying a change from the panel to the host needed the control channel, which turned out to be
built and never joined up: `connect_to_helper` had no caller, so `innytypes up` dialled nothing
and every command plan 0003 defines reached nothing in the shipped application. Connecting it
exposed two more defects underneath. The helper opened a second control listener on the same
path, lost the race with its own, swallowed the refusal and polled a socket that never opened,
so the supervision tick reported no child exits ever. Beneath that, the application was built
with no restart policy, so an exit that did arrive was dropped on the first line, silently.
Repairing only the first would have made the tick look healthy while nothing acted on a crash,
so both landed together.

Three tests were found asserting things that were not true: one claimed a whole credential
requirement while checking one shape of reply, one insisted on a courtesy the receive bound
never promised and failed two runs in five because of it, and one was narrowed by its own
repair until it could no longer catch what it was written for. Each was rewritten to fail
against the behaviour it guards. The proxy token is now registered with the redactor, as the
Anytype key already was.

Left open: the by-hand check that the endpoint really moves for a person whose port is taken.
The canonical gate passed with 2,501 tests at 96.78% coverage.
- 2026-10-13 21:35:23Z · attempt 0001 for WI-0015-01-the-mcp-childs-own-words-reach-the-log · MCP child stderr proven end to end in the Electron app; fixed cut-before-redact leak; raised a load-sensitive lint test timeout. Worktree was wiped once by an orchestrator --gc and rebuilt from recovered staged blobs.
- 2026-10-13 21:49:24Z · attempt 0001 for WI-0019-03-a-closed-session-restarts-at-once · A session that closes over a protocol fault while the child lives restarts the child at once (backoff and breaker kept). Attempt 1 refuted: a fault in the handshake's last chunk left the service ready on a dead session for ~120 s; fixed by late-subscriber notification and a pre-ready check. Merged main (WI-0015-01) in-branch.
- 2026-10-13 22:28:21Z · attempt 0001 for WI-0019-01-download-calls-are-seen · Each tools/call logged at INFO (name, duration, redacted answer size, status, never arguments); each session closure logged once (WARNING, or INFO when the service asked). Attempt 1 refuted: an unrequested 100-char name cut before redaction leaked part of a secret; removed. Merged with WI-0019-03's onBroken in-branch.
- 2026-10-13 22:39:25Z · attempt 0001 for WI-0024-01-where-dataview-blocks-are-written · The dataview write path is Anytype's own API: insert_blocks/replace_subtree are ops inside API-patch-object, tools built at start from the live openapi.json; the pinned package and InnyTypes forward arguments unchanged. The only in-repo interception point is mcpDispatch's tools/call branch.
- 2026-10-14 04:17:26Z · attempt 0001 for WI-0023-01-inventory-of-wrapped-body-tools · Inventory of the five pinned tools whose body the child mints (create-object, create-type, update-type, create-template, validate) recorded in plan 0023, with MINTED_BODY_TOOLS and a surface-pinned test for WI-0023-02.
- 2026-10-14 04:47:03Z · attempt 0001 for WI-0019-02-innytypes-answers-download-file · InnyTypes answers API-download-file from Anytype's REST API instead of the MCP child: bounded while streaming, ids validated, redirects refused, resources/read logged; the child never sees the call.
- 2026-10-14 05:02:12Z · attempt 0001 for WI-0023-02-the-unwrap-shim · InnyTypes unwraps the body argument the pinned child mints for the five inventoried tools before forwarding; a wire test with the real child against a fake API shows the document arrives with no body key. The live Anytype answer is the owner's check (acceptance rewritten as for plan 0024).
- 2026-10-14 05:11:01Z · attempt 0001 for WI-0023-03-shim-removal-note · Removal of the body-unwrap shim recorded in plan 0023 and at its call in mcp-dispatch.ts: triggered by the anytype-mcp pin move, signalled by a re-recorded tool surface without a minted body, with a checklist of every file the shim owns.
- 2026-10-14 06:37:05Z · attempt 0001 for WI-0019-04-a-binary-round-trips-end-to-end · Real app against a fake Anytype: a 7.3 MB non-UTF-8 binary round-trips byte-exact through API-download-file; known issue in INSTALL and CHANGELOG; Claude Desktop check left to the owner
- 2026-10-14 06:51:45Z · attempt 0001 for WI-0022-11-app-frame-routing-and-status · App frame, routing and status: 0.2.1 users with flows land on Live (flows read from disk), quit dialog independent of Setup, escape test restored, crash-loop limit from the supervisor, strings key, band removal recorded for WI-21
- 2026-10-14 07:16:29Z · attempt 0003 for WI-0024-02-dataview-object-id-rewrite-and-refusal · Dataview shim: a type target is written as object_id (api_key, internal_key, type-<key>, object id), a collection forwarded, a Query or malformed target refused with nothing forwarded; create-object, create-template and patch-object blocks judged; composed before the unwrap shim
- 2026-10-14 07:36:16Z · attempt 0003 for WI-0020-01-media-audio-in-the-contract · Audio media in the view contract: a data: or package-file sample, a Listen control that plays once, image wins, 768 KiB limit at the runtime, media-src 'self' data:; package-file samples served on the package's view origin only and drawn as a sentence where the page cannot play them
- 2026-10-14 07:50:59Z · attempt 0002 for WI-0021-01-json-answers-judged-in-the-runtime · View answers are JSON, judged once in the runtime for pop-out, in-app and snapshot presses: bounds (64 KiB, depth 8, 1000 keys, 16 KiB UTF-8 strings, forbidden keys, plain JSON only), the type's answer schema or the default flat shape; a dismissal forwards only its marker; sanitizeValues gone; spec 2.4, 2.6, 8.2.2, 8.5.7 updated
- 2026-10-14 08:02:09Z · attempt 0003 for WI-0022-25-folder-source-package · The folder source package: one setting (folder), a fixed 2 s quiet period, one created event per new file with its text when it fits a frame, recorded only after a successful emit, a persisted record across restarts, honest limits (a)-(g) in D18; the starter template uses it
- 2026-10-14 08:22:30Z · attempt 0001 for WI-0020-03-sdks-and-conformance · Both SDKs type the audio media item (ImageItem, AudioItem, MediaItem; media one item or a list); conformance C24 drives both SDKs to present image, labelled data: sample, package .ogg and a 600 KiB sample, all received intact; spec 12.2 names C24
- 2026-10-14 08:43:47Z · attempt 0001 for WI-0022-14-configuration-flows-and-canvas · Configuration: the Flows list (switch, Last run, health, Edit, Run history, the ⋯ menu), the Delete dialog, template cards, the canvas frame with Save and run and Unsaved changes, palette categories Sources, Steps, Questions and results
- 2026-10-14 08:45:18Z · attempt 0001 for WI-0022-18-general-tab · General: Anytype (Pair, Connect), Recorders and folders from the deployed folder sources, AI apps with the served address, Change port and Copy setup for Codex, Start at login, Reports with See what would be sent in full, Advanced with status details, retention 7/30/90/365/Forever; the anytype, mcp-endpoint, telemetry and desktop behaviours on General
- 2026-10-14 09:24:52Z · attempt 0001 for WI-0021-02-props-drafts-and-the-five-call-bridge · Component props declared (action views only), judged once at present by bounds and the declared schema, journaled and returned after restart; drafts kept within bounds, cleared on submit or dismiss, never sent to the node; the five-call bridge (get, submit, action, draft, setValid); Continue · Later · Skip this step only where a component is drawn, Continue drawn from the last validity; spec 2.4, 2.6, 4.5, 8.1, 8.2.1, 8.5.6, 10.2
- 2026-10-14 09:39:53Z · attempt 0001 for WI-0022-12-live-board-and-edit-layout · Live: one board per flow kept in boards.json and reconciled on read; Edit layout with its bar, Add tab, Tab name and Remove tab (dialog, last-tab refusal), Hidden (n), sizes S/M/L, keyboard move and resize, drag; a once-only New on the board line; the last good board kept through refused reads; focus returned only on a kept change
- 2026-10-14 10:51:10Z · attempt 0001 for WI-0021-03-fallback-tokens-and-pop-up-only · A widget that fails to load (3 s, missing or CSP-breaking component.js, throws while drawn) falls back to its form or a sentence and Skip; tokens.css and view-kit.css served by the shell under the byte-identical CSP; widget views are pop-up only, the Inbox shows Waiting for you + Answer
- 2026-10-14 11:08:59Z · attempt 0001 for WI-0022-16-setup-walkthrough · Setup from Welcome to Ready: Welcome, Reports, Connect Anytype, Source folder, the starter's node forms (Step n of N), Ready with Try with a sample, Open Live, I'll build my own; the starter installed exactly once in every state and adopted if already made; Try with a sample waits for the folder source's declared first-scan status and a real run reaches Done; resumable; 0.2.1 migration kept
- 2026-10-14 11:39:54Z · attempt 0001 for WI-0022-20-app-updates-and-go-back · InnyTypes' own updates in General: state pushed, Check now, Quit and update, Go back within 7 days verified exactly like an update, the crash-loop offer never automatic; electron-updater bound to the minisign-verified version, files, sha512 and size before any download; feed and downgrade restored after any Go back; trust variables ignored in a packaged build; 0.3.0 records only itself
- 2026-10-14 12:04:37Z · attempt 0001 for WI-0022-13-run-cards-questions-and-notifications · Run cards in every state from real run records (Copying, Safe to unplug on phase copied, step lines, questions with Answer, failed, done), inline questions, Later and Skip, notifications with buttons bound per run, the start notification stopping after five good runs, the dock badge counting waiting questions; the Question pop-out drawn with tokens.css under the byte-identical CSP, reconciled with WI-0021-02/03's widget rules
- 2026-10-14 14:12:25Z · attempt 0002 for WI-0020-02-the-listen-control · Penpot 04 Organisms checked live: the question pop-out and all six Question slot variants show the Listen to speaker 2 control as package content; design-system.md names it in the contract table; the e2e test and gate landed with the code merge.
- 2026-10-14 14:56:57Z · attempt 0001 for WI-0021-04-sdks-inny-pack-and-conformance · defineView (TS, @innytypes/node/view), Python present with a component and props, inny-pack compiles view schemas and refuses a missing widget script, C16-C19 and the sandbox probes in the widgetkit reorder pop-up; gate GREEN on a56bab7; fast-forwarded to main.
- 2026-10-14 15:32:59Z · attempt 0001 for WI-0021-05-preview-and-the-design-contract · Develop > Preview a view… (unpackaged or INNY_DEV=1, per plan 0021 §9) opens the widgetkit reorder in the real sandbox with sample props from the props schema's examples and logs the answer it would send; design-system.md rows per plan 0021 §10; Penpot question-popout gains Form=Widget; gate GREEN on 3d41e02.
- 2026-10-14 16:00:01Z · attempt 0001 for WI-0022-26-telemetry-endpoints · Umami Cloud endpoint and website id baked into app/package.json's innytypes block and read by wireTelemetry; consent gates every post (main process, CSP unchanged); GlitchTip DSN empty and Reports says crash reports aren't sent yet; unit test: zero posts before consent, one /api/send event after. Gate GREEN on 6bd0f18.
- 2026-10-14 20:28:37Z · attempt 0005 for WI-0022-15-run-history-and-rerun · Round 5 on a40835c confirmed: Run history with filters, search, selection, Re-run (from the source event through any lineage), Re-run from a step, bulk Re-run and Delete capped at the page (100), Delete that marks the batch deleted first, cancels journaled and held inputs, survives restart and refuses late inputs; Open in Anytype through openExternal; the caption from the run's own record. Journal migration 1->2 (rerun_of_started_at, deleted_runs).
- 2026-10-14 20:55:08Z · attempt 0002 for WI-0022-19-package-management · Confirmed on beaada2 (parked), then merged with main after WI-0022-15 landed (5fdc7e4): two hand-resolved conflicts in shell/main.ts and app-api-v2.test.ts verified correct, runtime/main.ts constructs RunActions and the snapshots handle once, one journal migration chain (version 2). Gate GREEN on the merged tree: 100 e2e passed.
- 2026-10-15 03:05:53Z · attempt 0003 for WI-0022-21-cutover-old-pages · Round 3 on c9ae09b confirmed, gate GREEN (93/93 e2e, parity: ledger holds, 2638 rows, 101 undecided for the owner). The seven old pages, 31 AppApi calls and 22 IPC channels are gone; the frame band is gone and the frame fills the 960x640 window; the e2e suite is rewritten around Setup, Live and Configuration and finds every element by data-testid, enforced by test/unit/e2e-finders.test.ts; 149 ledger rows cite the new spec titles; the cutover's retirements are batched for the owner in docs/parity/owner-review.md with their WI-0018 ids kept until WI-0022-22 reassigns them (check.ts accepts only those ids today).
