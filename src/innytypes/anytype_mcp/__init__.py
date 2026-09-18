"""The Anytype MCP server — a core part of the innytypes host, not an addon.

The thing this package supervises is a **Node process**, not a Python library: the official,
MIT-licensed ``@anyproto/anytype-mcp`` converts Anytype's OpenAPI specification into MCP
tools. Nothing here imports it; this package starts it, holds its API key, and pins the
versions it speaks.

Scope (plan 0002): supervising that process, the API key — obtaining it as well as
holding it — and the two version pins, including the tool surface those pins determine.
Nothing else. Like every host module, it imports no addon.
"""

from innytypes.anytype_mcp.config import (
    ANYTYPE_VERSION,
    DEFAULT_API_BASE_URL,
    PACKAGE_NAME,
    PACKAGE_VERSION,
    ServerConfig,
    load_config,
)
from innytypes.anytype_mcp.health import is_api_reachable
from innytypes.anytype_mcp.keys import (
    GetKeyFailedError,
    GetKeyUnavailableError,
    KeyAcquisitionError,
    KeyFileExistsError,
    UnusableKeyError,
    acquire_api_key,
    get_key_command,
    run_get_key,
    store_api_key,
)
from innytypes.anytype_mcp.supervisor import ApiUnreachableError, Supervisor, SupervisorError
from innytypes.anytype_mcp.tools import (
    FIXTURE_PATH,
    ToolSurface,
    ToolSurfaceDiff,
    ToolSurfaceError,
    compare_surfaces,
    load_tool_surface,
)

__all__ = [
    "ANYTYPE_VERSION",
    "DEFAULT_API_BASE_URL",
    "FIXTURE_PATH",
    "PACKAGE_NAME",
    "PACKAGE_VERSION",
    "ApiUnreachableError",
    "GetKeyFailedError",
    "GetKeyUnavailableError",
    "KeyAcquisitionError",
    "KeyFileExistsError",
    "ServerConfig",
    "Supervisor",
    "SupervisorError",
    "ToolSurface",
    "ToolSurfaceDiff",
    "ToolSurfaceError",
    "UnusableKeyError",
    "acquire_api_key",
    "compare_surfaces",
    "get_key_command",
    "is_api_reachable",
    "load_config",
    "load_tool_surface",
    "run_get_key",
    "store_api_key",
]
