---
type: plan
title: Configure the MCP endpoint in the panel, and move it while the host runs
status: APPROVED
created: 2026-09-22
updated: 2026-09-22
---

# 0008 — Configure the MCP endpoint in the panel

## Outcome

A person changes the loopback address and port of the MCP endpoint in the application's own
panel, and the running host moves to it without being restarted. A change that cannot be served
is refused before anything is torn down, so a mistake never costs the endpoint that was already
working.

```text
Application panel (helper process)
        |
        | save address and port  -> validated, then sent over the existing control channel
        v
InnyTypes host --closes the old listener only after the new one is bound--> 127.0.0.1:<port>/mcp
```

## Why the environment variable is not enough

Plan 0007 made the address a host setting so a collision could be resolved explicitly, and
implemented that as `INNYTYPES_MCP_HOST` and `INNYTYPES_MCP_PORT`, read once at startup by
`configured_address()`. That works for someone starting InnyTypes from a command line. It does
not work for the application this project actually ships: a Briefcase bundle started by clicking
an icon cannot be given an environment variable. Today such a person, whose port 31010 is already
taken, sees a degraded MCP service, reads documentation telling them to set a variable, and has
no way to do it from the application they are holding.

The endpoint is also the one setting whose value another program must be told. Showing it is not
enough; a person has to be able to choose it.

## Where the setting lives

The endpoint address becomes a helper setting stored with the others, and **the stored value
wins**. The environment variables remain, and are the default for a machine that has never been
configured — nothing more. When a variable is set and a stored value exists, the stored value is
served and the panel says the variable is being ignored, because a setting that silently loses to
the environment is worse than no setting.

This inverts what plan 0007 documented, so the change is not confined to new code. Both
`docs/anytype-mcp-connection.md` and the README describe the variables as the way to select the
port, and the existing test suite sets `INNYTYPES_MCP_PORT` to a kernel-assigned port on every
run that builds a serving host. Those tests must keep working without a real user port: they
either write the stored setting or assert that no stored setting exists, and the slice that
changes precedence is the slice that carries them.

Only numeric loopback addresses are accepted, exactly as plan 0007 requires. A hostname, a
wildcard, a LAN address or a public address is refused at the panel, with the reason shown, and
never reaches the host.

## Changing it while it runs

The panel is drawn by the helper; the listener belongs to the host. A saved change therefore has
to cross a process boundary, and the host performs the move.

**The channel this needs is built but not connected.** `innytypes.helper.control` implements both
ends and is thoroughly tested, but `connect_to_helper` — documented as "what the host process
calls once it is up" — is called from no production code. The helper starts the host through
`cli(["up"])` and `build_terminal_host`, which dials nothing and prints its degradations to its
own output. `WI-0003-18` passed honestly: every one of its acceptance bullets says a test drives
both ends "over an in-test connection with no process spawned". Both halves work; nothing joins
them in the shipped application, so every command plan 0003 promises still reaches nothing there.

This plan therefore does not get to assume a channel. Slice 03 assembles it first — the host
connecting to the helper's socket as part of its own startup — and only then carries an endpoint
change across it. That assembly is plan 0003's debt, not this plan's feature, and it is called
out here so it is costed rather than discovered. A slice that quietly widened from "send a
message" to "build the wire" is how the last plan's estimates went wrong.

Once the change reaches the host, the host keeps the ordering that makes a failure harmless:

1. validate the requested address and port;
2. bind the new address **first**, while the old listener is still serving;
3. only once the new listener holds its socket, stop accepting on the old one, let requests
   already received finish inside the existing receive bound, and close it;
4. report the address now being served.

If the new address cannot be bound — taken, refused, or invalid — the request is rejected with
the reason named, nothing is closed, and the endpoint carries on exactly as before. The host
still never silently selects a port nobody asked for. A rebind restarts no child and touches no
session: the same validated child continues to answer through the new listener.

## What the panel shows

The Anytype section shows the address currently being served, and the address that is saved when
those differ. It shows why the service is unavailable when it is — the port is taken, the child
is not validated — and it never shows either credential: not the Anytype API key, not the proxy
bearer token.

Changing the address invalidates every client already configured with the old one. The panel
says so at the point of change, because a person who moves the endpoint and then finds Codex
silently unable to reach it has been failed by the interface, not by the client.

## Acceptance

- The endpoint address and port are stored helper settings; a stored value is served in
  preference to the environment variables, and the panel states plainly when a variable is being
  ignored.
- A machine with no stored value behaves exactly as it does today, environment variables and all,
  so an existing installation changes nothing until someone edits the setting.
- The panel refuses a hostname, a wildcard, a LAN address, a public address and an out-of-range
  port, naming the reason; the refusal never reaches the host and never changes the stored value.
- Saving a servable address moves the running endpoint without restarting InnyTypes, without
  restarting the Anytype child, and without invalidating the validated session.
- A rebind onto an address that cannot be bound is refused with its reason, the previous listener
  is still serving afterwards, and no port other than the one requested is ever chosen.
- Requests already received when a rebind begins finish within the existing receive bound; the
  old listener stops accepting immediately.
- The panel shows the address being served, the saved address when it differs, and the reason the
  service is unavailable, with neither credential present in any state it can display.
- The panel states, at the point of change, that clients configured with the old address must be
  updated.
- `docs/anytype-mcp-connection.md` and the README describe the stored setting as the way to
  choose the endpoint, keep the environment variables documented as the unconfigured default, and
  agree with the code.
- `docs/loop/verify.sh` exits zero and prints `gate: GREEN` without Node, Anytype, a real
  credential or a real user port.

## Slices

| # | slice | what lands |
|---|---|---|
| 01 | the stored endpoint | the setting, its validation, stored-wins precedence, and every existing reader, test and document carried across |
| 02 | moving a live listener | bind-before-close, refusal without losing the running service, draining, and the named failure |
| 03 | the change reaches the host | the helper's saved change travelling over the existing control channel, and what the host answers |
| 04 | the panel | editable address and port, refusals shown, served versus saved, and the warning that clients must be updated |

**Order:** 01 → 02 → 03 → 04. Slice 04 is the stop condition: a person with a taken port changes
it in the application and the endpoint moves, without a terminal and without a restart.

## Non-goals

- binding outside loopback, or making a non-loopback address reachable by any route;
- moving restart policy out of InnyTypesHelper — a rebind is not a restart;
- reconfiguring any client automatically, or writing to a client's configuration file;
- discovering a free port automatically when the chosen one is taken;
- changing the proxy bearer token's storage, lifecycle or rotation;
- changing the committed tool surface, the child's ownership, or its private stdio transport;
- a general settings-driven listener for anything other than this endpoint.

## Rollback and compatibility

The setting is additive and absent by default, so an installation that never opens the panel
keeps plan 0007's behaviour exactly. Deleting the stored value returns the host to the
environment variables. Rolling back the release leaves an unread setting behind, which is inert.
A refused rebind changes nothing, and a failed bind never kills the host or unrelated addons.

Approved by the owner on 2026-09-22, who answered the three decisions that shape it: the stored
setting wins over the environment variable; a saved change rebinds immediately rather than at the
next start; and the address is editable alongside the port, not the port alone.
