"""innytypes — a host application that wraps the Anytype desktop app.

Starting the host starts Anytype plus a sidecar. Every feature arrives as an **addon**:
the host owns process supervision, addon discovery and lifecycle, dependency resolution
and a cross-process event bus, and it depends on no addon. See docs/plans/0001-innytypes-host.md.

The official Anytype MCP server is part of the core rather than an addon: the host supervises
it, holds its API key and pins its versions. See ``innytypes.anytype_mcp`` and plan 0002.
"""

from __future__ import annotations

__all__ = ["__version__", "HOST_API_VERSION"]

__version__ = "0.1.0"

# The host API version an addon manifest targets. This is a contract number, not the
# host's release number: it changes only when the API an addon compiles against changes.
HOST_API_VERSION = 1
