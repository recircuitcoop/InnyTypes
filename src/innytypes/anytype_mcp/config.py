"""Configuration for the wrapped Node server: the two version pins and the API key.

Two pins live here, and changing either is a dependency upgrade, not a tweak:

``PACKAGE_VERSION``
    The exact ``@anyproto/anytype-mcp`` release the supervisor launches. Kept in lockstep
    with ``package.json`` — ``tests/test_pinning.py`` fails the gate when they disagree.

``ANYTYPE_VERSION``
    The value of the ``Anytype-Version`` header. The server turns Anytype's OpenAPI spec
    into MCP tools, so the API version it speaks **determines which tools exist**. That
    makes the header a dependency with a version, and it is pinned like one.

The API key is never a constant in this file. It is read from the environment or from a
file outside the repository, and it never appears in a ``repr``.
"""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

from innytypes.addons.secrets import CREDENTIALS_DIRECTORY
from innytypes.logs import protect

# The npm package the host supervises. Not a Python dependency — a child process.
PACKAGE_NAME = "@anyproto/anytype-mcp"
PACKAGE_VERSION = "1.2.10"

# The pinned Anytype API version. See the module docstring for why this is a dependency.
ANYTYPE_VERSION = "2025-11-08"

# Anytype's local API, as served by the desktop app. `anytype-cli` listens on 31012
# instead, which is why the server reads ANYTYPE_API_BASE_URL.
DEFAULT_API_BASE_URL = "http://127.0.0.1:31009"

# Where the key may come from. Both are outside the repository, by construction. The
# directory is `innytypes.addons.secrets`'s, so the key and the per-plugin secrets share one
# answer to "where does innytypes keep credentials" — named there rather than here because
# that module also runs inside every addon's environment, which holds none of this package.
API_KEY_ENV_VAR = "ANYTYPE_API_KEY"
DEFAULT_KEY_FILE = CREDENTIALS_DIRECTORY / "anytype_api_key"


class ConfigError(RuntimeError):
    """Raised when the MCP server cannot be configured — a missing key, most often."""


@dataclass(frozen=True)
class ServerConfig:
    """Everything needed to launch the Node server, with the key kept out of reprs.

    ``repr=False`` on ``api_key`` is load-bearing rather than cosmetic: a supervisor logs
    its own configuration when a child dies, and a dataclass's default repr would put the
    credential into that log. ``repr=False`` only covers the repr, though — the key still
    has to travel to the child inside ``OPENAPI_MCP_HEADERS``, which is a plain string that
    any log line can render. So construction also registers the key with the package's log
    redactor, and that is the half that covers everything the repr does not.
    """

    api_key: str = field(repr=False)
    package_version: str = PACKAGE_VERSION
    anytype_version: str = ANYTYPE_VERSION
    api_base_url: str = DEFAULT_API_BASE_URL

    def __post_init__(self) -> None:
        # An empty key produces a server that starts and then 401s on every tool call,
        # which reads as a broken wrapper rather than a missing credential. Fail here.
        if not self.api_key:
            raise ConfigError("api_key is empty; set it from the environment or a key file")

        # The key now lives in a structure, so plan 0002's obligation attaches to it.
        # Registering here rather than at each log call site is what makes "never in a log"
        # a property of the credential instead of a habit of the programmer.
        protect(self.api_key)

    @property
    def package_spec(self) -> str:
        """The exact ``name@version`` spec handed to npx — never a floating tag."""
        return f"{PACKAGE_NAME}@{self.package_version}"

    def headers(self) -> dict[str, str]:
        """The header map the server expects, before JSON encoding."""
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Anytype-Version": self.anytype_version,
        }

    def openapi_mcp_headers(self) -> str:
        """The ``OPENAPI_MCP_HEADERS`` value: the header map, JSON-encoded into one string.

        The server parses this variable rather than reading discrete header variables, so
        the JSON encoding is part of the contract, not a convenience.
        """
        return json.dumps(self.headers())

    def environment(self, base: Mapping[str, str] | None = None) -> dict[str, str]:
        """The child process environment: ``base`` plus the two variables the server reads.

        ``base`` defaults to the current environment so the child keeps PATH and can find
        node. The credential is added last so it cannot be shadowed by an inherited value.
        """
        env = dict(os.environ if base is None else base)
        env["ANYTYPE_API_BASE_URL"] = self.api_base_url
        env["OPENAPI_MCP_HEADERS"] = self.openapi_mcp_headers()
        return env


def load_api_key(
    env: Mapping[str, str] | None = None,
    key_file: Path | None = None,
) -> str:
    """Resolve the API key from the environment, then from a file outside the repo.

    Never reads anything inside the repository. Obtain a key from Anytype's own settings
    (App Settings -> API Keys -> Create new), or via
    ``npx -y @anyproto/anytype-mcp@<pinned version> get-key``.
    """
    source = os.environ if env is None else env

    # Environment first: it is what a supervisor passes down, and what CI would inject.
    from_env = source.get(API_KEY_ENV_VAR, "").strip()
    if from_env:
        return from_env

    path = DEFAULT_KEY_FILE if key_file is None else key_file
    if path.is_file():
        from_file = path.read_text(encoding="utf-8").strip()
        if from_file:
            return from_file

    raise ConfigError(
        f"no Anytype API key: set ${API_KEY_ENV_VAR} or write one to {path}. "
        "Create a key in Anytype under App Settings -> API Keys."
    )


def load_config(
    env: Mapping[str, str] | None = None,
    key_file: Path | None = None,
) -> ServerConfig:
    """Build a :class:`ServerConfig` from the ambient environment and the pinned versions."""
    source: Mapping[str, str] = os.environ if env is None else env
    return ServerConfig(
        api_key=load_api_key(env=source, key_file=key_file),
        api_base_url=source.get("ANYTYPE_API_BASE_URL", DEFAULT_API_BASE_URL).strip()
        or DEFAULT_API_BASE_URL,
    )
