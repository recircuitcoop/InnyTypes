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
