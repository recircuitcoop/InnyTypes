---
type: plan
title: A plugin's own words reach the log
status: TODO
created: 2026-09-24
updated: 2026-09-24
---

# 0014 — A plugin's own words reach the log

## The observation

The live test of plan 0012 on 2026-09-24 proved the story with the real BOYA. It mounted at
16:26:42 as `/Volumes/BOYA`, and ten seconds later the log gained exactly two lines:

```
16:26:52,760 DEBUG 58310 innytypes.events.emitter: event emitted: monty.mounted.v1 by monty, fields ...
16:26:52,761 INFO  58142 innytypes.events.channel: event accepted: monty.mounted.v1 from monty
```

The line that says *which* drive and *how* it matched never arrived: monty's own
`monty matched 'BOYA' to /Volumes/BOYA on uuid`. The event lines name fields and never values,
by design, because values are the person's content. So the log proves that a mount event fired
and was accepted, but not that it was the BOYA or that it matched on UUID. That link came from
outside the log: BOYA is the only declared recorder, and the event followed the mount by ten
seconds.

## Why

`innytypes.logs.start_logging` attaches its one file handler to the `innytypes` package logger
only. monty writes with `logging.getLogger(__name__)`, which is `monty.addon`, the standard Python
idiom. That record propagates to the root logger, which has no handler, so Python's last-resort
handler drops anything below WARNING. A WARNING from monty would reach stderr instead, and plan
0012's stdout/stderr drain would record it without monty's logger name or level. An INFO is lost
entirely.

Plan 0012 slice 04 hands a plugin a logger through `AddonContext.log`, but monty predates that and
never adopted it. Any plugin written the ordinary way has the same problem. So does any library a
plugin uses.

## The decision this plan makes

**The runtime owns this, not each plugin.** The owner's rule from plan 0012: *"logging must be a
basic in INNYTYPES API"*. A plugin that logs the way every Python tutorial shows must reach the
application's log without knowing InnyTypes exists. Asking every plugin to switch to
`context.log` repeats the pattern this project keeps finding: an API that works when used and
does nothing silently when not used.

The recommended shape, to be confirmed by the slice. In an addon child, the runner also attaches
the application's handler to the plugin's own top-level package logger, which it already knows
from the entry point it loaded (`monty` for monty). It does not attach to the root logger. Root
would pull in every third-party library's DEBUG output at the test-mode level and bury the event
lines. A plugin's dependencies stay at WARNING and above, through root, like any unconfigured
library.

Considered and not chosen:
- **Change only monty to use `context.log`.** It fixes one plugin and leaves the trap for the
  next. Worth doing in monty anyway, as a separate small change in that repository. It is not this
  plan's fix.
- **Log event values on the host side.** This would prove the drive from InnyTypes' own lines,
  but it writes the person's content (volume names, paths) into every event line for every plugin.
  Field names only stays the rule.

## Slices

| Slice | Work item | What |
|---|---|---|
| 01 | `WI-0014-01-a-plugins-own-logger-reaches-the-file` | Route an addon's own package logger to the application log. Prove it in a real child and on the machine with the BOYA. |

## Non-goals

- Routing third-party library loggers below WARNING.
- Changing what the event lines record.
- Changing monty. That belongs to the monty repository.

## Status

Seeded 2026-09-24 from the live test, not started.
