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
