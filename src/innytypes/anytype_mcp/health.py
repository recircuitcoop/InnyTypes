"""Is Anytype's local API reachable?

The Node server is useless without the desktop app behind it, and the failure is much
clearer when reported here than as a tool call that times out. Nothing in this module is
exercised by the gate against a real Anytype — the tests inject a transport.
"""

from __future__ import annotations

import httpx

from innytypes.anytype_mcp.config import ServerConfig


def is_api_reachable(config: ServerConfig, client: httpx.Client | None = None) -> bool:
    """True when Anytype's local API answers at the configured base URL.

    Any transport-level failure is a "no", not an exception: an absent desktop app is an
    expected state for a supervisor, not an error it should propagate.
    """
    owns_client = client is None
    http = httpx.Client(timeout=2.0) if client is None else client
    try:
        response = http.get(
            f"{config.api_base_url}/v1/spaces",
            headers=config.headers(),
        )
    except httpx.HTTPError:
        return False
    else:
        # 401 still proves the API is up — it is the key that is wrong, not the app that
        # is absent, and the two need different fixes.
        return response.status_code < 500
    finally:
        if owns_client:
            http.close()
