"""InnyTypesHelper — the separate process that watches, restarts, updates and reports.

The helper sits outside the host, the MCP server and every addon, because a watchdog inside
the process it watches dies with it (docs/plans/0003-innytypes-helper.md). It owns every
restart, the core and plugin updates, and the telemetry the user switched on.

This package holds the helper's own code. Like every module under ``innytypes``, it imports
no addon: it learns about plugins from the manifests recorded at install time and from the
heartbeats they publish.

What has landed so far:

* :mod:`innytypes.helper.config` — the config file every other part of the helper reads before
  it acts.
* :mod:`innytypes.helper.heartbeat` — what a managed process tells the helper it is alive with,
  the per-user socket it says it on, and the latest beat per process.
* :mod:`innytypes.helper.control` — the wire between this process and the host: the helper's
  own socket, the commands it sends over it, and the child exits that come back on it.
* :mod:`innytypes.helper.watch` — what each process is watched against: its resolved limits,
  whether it promised heartbeats at all, and its own health check.
* :mod:`innytypes.helper.supervision` — the tick itself: the one pass that reads those sockets,
  judges what it samples, acts through the control channel and tells the user, and the two
  loops that repeat it.
* :mod:`innytypes.helper.settings_watch` — the one reason a healthy plugin is restarted: a
  recorded setting of its changed, so it is brought back on the new value through the same
  control channel every other restart uses.
"""

from __future__ import annotations
