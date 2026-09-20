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
