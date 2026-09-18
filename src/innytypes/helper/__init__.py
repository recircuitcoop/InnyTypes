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
* :mod:`innytypes.helper.watch` — what each process is watched against: its resolved limits,
  whether it promised heartbeats at all, and its own health check.
"""

from __future__ import annotations
