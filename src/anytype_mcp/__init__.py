"""anytype-mcp — a thin Python supervisor around the official Anytype MCP server.

The thing this package wraps is a **Node process**, not a Python library: the official,
MIT-licensed ``@anyproto/anytype-mcp`` converts Anytype's OpenAPI specification into MCP
tools. Nothing here imports it; this package starts it, holds its API key, and pins the
versions it speaks.

Scope (plan 0001): supervising that process, the API key, and the two version pins.
Nothing else.
"""

from anytype_mcp.config import (
    ANYTYPE_VERSION,
    DEFAULT_API_BASE_URL,
    PACKAGE_NAME,
    PACKAGE_VERSION,
    ServerConfig,
)
from anytype_mcp.supervisor import Supervisor

__all__ = [
    "ANYTYPE_VERSION",
    "DEFAULT_API_BASE_URL",
    "PACKAGE_NAME",
    "PACKAGE_VERSION",
    "ServerConfig",
    "Supervisor",
]
