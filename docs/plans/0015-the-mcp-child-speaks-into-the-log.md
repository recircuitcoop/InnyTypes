---
type: plan
title: The MCP child speaks into the log
status: TODO
created: 2026-09-24
updated: 2026-09-24
---

# 0015 — The MCP child speaks into the log

## The observation

Plans 0012 and 0014 gave InnyTypes one log, `~/Library/Logs/innytypes/innytypes.log`. The helper,
the host and every plugin write to it, and a plugin's stdout and stderr are drained into it. **The
Anytype MCP child is the exception.** It is a core child, the Node process
`npx @anyproto/anytype-mcp@1.2.10`, and everything it says about itself goes nowhere a person can
read:

- `anytype_mcp/supervisor.py:118-129` spawns it with stdin and stdout piped, because they carry
  the MCP protocol, and **stderr inherited** (`stderr=None`). The reason given there: a pipe
  nobody drains eventually blocks the child.
- Inherited means it goes to the host's stderr. The helper starts the host without redirecting
  stderr, so for an app opened from the Finder it ends up with launchd, which is to say nowhere.
  Slice 01 confirms where it actually goes before changing anything.
- `record_child_output`, the drain that fixed this for plugins, is called only from
  `_spawn_addon` (`children.py:1491`). Nothing calls it for the MCP child.

The host already logs **about** the child: when it starts and exits, how it was launched on an
unexpected exit (with the environment redacted), and missed pings. What is lost is the child's
**own** account: npm and npx warnings, a failed package fetch, Anytype refusing the key, a
changed tool surface, a crash trace. The cost is on record. Diagnosing a stale tool surface took
a walkthrough and about twenty commands, because the sentence explaining it *"existed inside the
process and reached nobody"* (`cli.py:417`).

## The decision

**Drain the MCP child's stderr into the application log, and never touch its stdout.**

- stderr gets piped and drained by the same machinery plugins use: `record_child_output` or its
  stderr half. That means a single drain, not a second implementation. A drained pipe cannot
  block the child, which removes the reason stderr was inherited in the first place.
- **stdout is the protocol and stays untouched.** Draining it into the log would steal MCP
  frames. The slice must prove the protocol still works with stderr piped, not just that lines
  appear.
- Level: WARNING, which is what plugin stderr already uses. A Node child's stderr mixes chatter
  with failures, and InnyTypes cannot tell them apart, so every line keeps one honest level
  rather than a guessed one. Each line is attributed to the `anytype-mcp` child and its process
  id.
- **Credentials.** The Anytype API key reaches the child in `OPENAPI_MCP_HEADERS`
  (`anytype_mcp/config.py:111`) and is registered with the redactor (`config.py:81`). The
  redaction filter sits on the log handler, so it covers these lines too. A test proves it by
  having a fake child print the key, and the proxy bearer token, to stderr, then checking that
  neither reaches the file. Reuse the `leak_sources`/`leaks` idiom from
  `tests/test_anytype_mcp_keys.py`.
- Size: the existing truncation (2000 characters per line) and the log's size limit (2 MiB × 3)
  apply. A child that loops on an error cannot fill the disk.

Not chosen:
- **Turning up the npm package's own log level.** Nothing in this repository shows it has one.
  Capture what it already says first. Asking it to say more is a later question, once the log
  shows whether that is needed.
- **Parsing its stderr into levels.** That means guessing another program's format, which
  breaks when the package updates.

## Slices

| Slice | Work item | What |
|---|---|---|
| 01 | `WI-0015-01-the-mcp-childs-own-words-reach-the-log` | Pipe and drain the MCP child's stderr into the log. Prove the protocol still works, redaction holds, and a restart drains again. Show one real line on the machine. |

## Done when

- A fake MCP child that writes to stderr and speaks the protocol on stdout: its stderr lines
  appear in the log attributed to the MCP child, and a ping over stdout still succeeds.
- The key and the proxy token printed by the child never reach the file.
- After the child is killed and the helper restarts it, the new process's stderr is drained too.
- Break it and watch it fail: without the drain, the test fails.
- On the machine: rebuild and relaunch, then the log shows at least one line from the real MCP
  child's process id. If it prints nothing on a healthy start, the slice says so, and a forced
  failure (for example a wrong API base URL in a scratch config) proves the path instead.
- `docs/loop/verify.sh` prints `gate: GREEN`.

## Non-goals

- The Anytype desktop app's own logs.
- Changing what the host logs about the child.
- A log viewer in the window.

## Status

Seeded 2026-09-24 on the owner's request, not started.
