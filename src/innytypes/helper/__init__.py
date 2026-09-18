"""InnyTypesHelper — the separate process that watches, restarts, updates and reports.

The helper sits outside the host, the MCP server and every addon, because a watchdog inside
the process it watches dies with it (docs/plans/0003-innytypes-helper.md). It owns every
restart, the core and plugin updates, and the telemetry the user switched on.

This package holds the helper's own code. Like every module under ``innytypes``, it imports
no addon: it learns about plugins from the manifests recorded at install time and from the
heartbeats they publish.

What has landed so far is :mod:`innytypes.helper.config` — the config file every other part
of the helper reads before it acts.

:mod:`innytypes.helper.processes` is the other half of that ground floor: the run-state
file's reader, and the identity check — process ID, start time and executable path, all
three — that every signal this helper sends has to pass first.
"""

from __future__ import annotations
