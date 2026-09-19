"""innytypes — a host application that wraps the Anytype desktop app.

One application icon starts InnyTypesHelper, which starts Anytype and the host and owns every
restart (docs/plans/0003-innytypes-helper.md). Every feature arrives as an **addon**: the host
owns its child processes, addon discovery and lifecycle, dependency resolution and a
cross-process event bus, and it depends on no addon. See docs/plans/0001-innytypes-host.md.

The official Anytype MCP server is part of the core rather than an addon: the host supervises
it, holds its API key and pins its versions. See ``innytypes.anytype_mcp`` and plan 0002. The
host's own way to talk to Anytype's local API is ``innytypes.anytype_api``, which is built on
that package's key discovery and reachability check and is not how addons reach Anytype — they
use the MCP server's tools.

``innytypes.host`` is the host itself: it starts the MCP server and the addon processes,
degrades rather than crashing when one of them cannot start, and answers
``anytype_tools()`` — the host API function an addon reads the Anytype tool surface through,
without importing ``innytypes.anytype_mcp``.
"""

from __future__ import annotations

__all__ = ["__version__", "HOST_API_VERSION"]

__version__ = "0.1.0"

# The host API version an addon manifest targets. This is a contract number, not the
# host's release number: it changes only when the API an addon compiles against changes.
#
# 1 — `AddonContext` is `id`, `manifest` and `emitter`.
# 2 — it also carries `settings`, `secret` and `write_settings` (plan 0004, D3). A manifest
#     still declaring 1 starts and is given an empty settings mapping, so moving the number
#     took nothing away from an addon written against 1.
HOST_API_VERSION = 2
