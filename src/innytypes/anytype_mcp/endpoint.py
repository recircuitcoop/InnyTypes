"""The one rule about the MCP endpoint's address, and the one way to write it as a URL.

Split out of :mod:`innytypes.anytype_mcp.gateway` by plan 0008 slice 01, and for one reason:
the address stopped being something only the listener knows. It is now a **stored setting**
(`[mcp]` in the helper's `config.toml`), so :mod:`innytypes.helper.config` has to refuse a
value the listener could never bind — at the moment it is written, not at the next start —
and :mod:`innytypes.anytype_mcp.gateway` has to read that stored value to decide what to
serve. Those two need each other, and a module that holds the rule both of them apply is
what keeps the need from being a circle.

Nothing here opens a socket, reads a file or looks at the environment. It is the rule and
the spelling, and every process that has an opinion about the address gets both from here.
"""

from __future__ import annotations

import ipaddress

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 31010
MCP_PATH = "/mcp"


class GatewayError(RuntimeError):
    """The loopback MCP service cannot be configured or started safely.

    Kept under its original name, and still exported from
    :mod:`innytypes.anytype_mcp.gateway`, because it is what every existing caller catches
    and what the helper's window already prints verbatim when the address is refused.
    """


def endpoint_url(host: str, port: int) -> str:
    """The Streamable HTTP MCP URL one numeric loopback address is served at.

    One formatter, because the address is now written in two processes: the host serves it
    and the helper's window shows it. Two spellings of the same rule is how a window ends up
    telling a person to configure a client for an address nothing is listening on.
    """
    bracketed = f"[{host}]" if ":" in host else host
    return f"http://{bracketed}:{port}{MCP_PATH}"


def checked_address(host: str, port: int) -> tuple[str, int]:
    """``host`` and ``port`` if this service may serve them, or the reason it may not.

    Separate from :class:`~innytypes.anytype_mcp.gateway.GatewayConfig` so the address can be
    judged without a token: the helper shows the configured address, and the settings file
    refuses an unservable one as it is written, and neither has any business reading — or
    creating — the proxy token file to do it.
    """
    try:
        address = ipaddress.ip_address(host)
    except ValueError as error:
        raise GatewayError("the MCP address must be a numeric loopback address") from error
    if not address.is_loopback:
        raise GatewayError(
            "the MCP address must be loopback; wildcard and network binds are refused"
        )
    if not 1 <= port <= 65535:
        raise GatewayError("the MCP port must be between 1 and 65535")
    return host, port
