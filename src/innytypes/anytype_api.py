"""The host's own client for Anytype's local API on port 31009.

This is how **innytypes itself** asks Anytype a question. It is not the MCP server: that
server exists so that *addons* reach Anytype through MCP tools, and the host does not
speak MCP to its own child to find out which spaces exist.

It lives beside :mod:`innytypes.anytype_mcp` rather than inside it. Plan 0002 locks that
package's scope to exactly three things — supervising the Node process, holding the key,
and pinning the two versions — so request-making does not belong there. What this module
does instead is **build on** it, and that word is meant literally:

* the credential and the base URL come from a :class:`~innytypes.anytype_mcp.config.ServerConfig`,
  and there is no second code path here that reads ``$ANYTYPE_API_KEY`` or the key file;
* every request carries exactly the headers :meth:`ServerConfig.headers` produces, so the
  bearer token and the pinned ``Anytype-Version`` cannot drift from what the MCP child sends;
* connectivity is decided once, in :func:`~innytypes.anytype_mcp.health.is_api_reachable`,
  and this module calls it rather than growing a second opinion about what "up" means;
* everything logged goes through :mod:`innytypes.logs`, and every error message
  is redacted on the way in, because a client is exactly the kind of object that ends up in
  a stack trace when a request fails.

**Why the endpoint list stops where it does.** Exactly one endpoint is wrapped by name:
``GET /v1/spaces``, as :func:`list_spaces`. That is the one the reachability check already
probes, so it is the one endpoint this repository has verified against the pinned API
version — everything else would be a guess with a method signature on it. Addons get the
full surface through the MCP server's tools, and the host's own needs beyond "which spaces
exist" do not exist yet. When a later slice needs another endpoint it can reach for
:meth:`AnytypeClient.get_json`, which is the generic helper the named call is built on, and
give it a name in the slice that actually has a caller.

Nothing here opens a socket in the gate: the ``httpx.Client`` is injected exactly as
:func:`is_api_reachable` already takes one.
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from innytypes.anytype_mcp.config import ServerConfig, load_config
from innytypes.anytype_mcp.health import is_api_reachable
from innytypes.logs import get_logger, redact

log = get_logger(__name__)

# Seconds. The API is on the loopback interface, but the desktop app can be busy indexing,
# so this is generous rather than snappy. A request that hangs forever is worse than one
# that fails with a name.
DEFAULT_TIMEOUT = 10.0

# The one endpoint wrapped by name here. See the module docstring for why it is the one.
SPACES_PATH = "/v1/spaces"


class AnytypeApiError(RuntimeError):
    """A call to Anytype's local API did not produce a usable result.

    The base of every failure this module raises, so a caller that only wants to know that
    the call failed catches one thing, and a caller that wants to *say* something specific
    catches a subclass.
    """


class AnytypeUnreachableError(AnytypeApiError):
    """Anytype's local API did not answer, so there was nothing to ask.

    Named rather than generic because the user's fix is specific: start the Anytype desktop
    app. It is not a wrong key, not a wrong path and not a bug in the caller.
    """

    def __init__(self, api_base_url: str) -> None:
        # Built from the base URL alone — the key is never part of it. It still goes through
        # the redactor, because ``ANYTYPE_API_BASE_URL`` is user-supplied: a credential
        # embedded in that URL would otherwise ride out in an exception message that every
        # caller is free to log.
        super().__init__(
            redact(
                f"Anytype's local API did not answer at {api_base_url}; "
                "start the Anytype desktop app, or point ANYTYPE_API_BASE_URL at it"
            )
        )
        self.api_base_url = api_base_url


class AnytypeStatusError(AnytypeApiError):
    """Anytype answered, and the answer was not a success.

    Carries :attr:`status_code` so a caller can branch on it without parsing the message.
    The response *body* is deliberately absent: it is whatever the server felt like sending,
    it can echo a request header straight back, and a truncated HTML error page has never
    once helped anybody debug a local API.
    """

    def __init__(self, method: str, url: str, status_code: int) -> None:
        super().__init__(redact(f"{method} {url} answered HTTP {status_code}"))
        self.status_code = status_code


class AnytypeUnauthorizedError(AnytypeStatusError):
    """401: the API is up and the key is not accepted. Create a new one in Anytype."""


class AnytypeNotFoundError(AnytypeStatusError):
    """404: the API is up, the key works, and that path or object does not exist."""


class AnytypeServerError(AnytypeStatusError):
    """5xx: Anytype itself failed. Nothing the caller sent can be blamed for it."""


def status_error(method: str, url: str, status_code: int) -> AnytypeStatusError:
    """The named error for ``status_code`` — the specific one where there is one."""
    if status_code == 401:
        return AnytypeUnauthorizedError(method, url, status_code)
    if status_code == 404:
        return AnytypeNotFoundError(method, url, status_code)
    if status_code >= 500:
        return AnytypeServerError(method, url, status_code)
    # Every other non-2xx still gets a named type carrying the code, rather than being
    # returned to the caller as if the request had worked.
    return AnytypeStatusError(method, url, status_code)


@dataclass(frozen=True)
class Space:
    """One Anytype space, as ``GET /v1/spaces`` describes it."""

    id: str
    # Empty when the space has no name, which the API allows. Never ``None``, so callers
    # do not each invent their own placeholder.
    name: str = ""


@dataclass
class AnytypeClient:
    """Talks to Anytype's local API using an existing :class:`ServerConfig`.

    The config is the single source of the credential, the base URL and the pinned API
    version; this class adds no way to supply any of them separately, which is what makes
    "the client cannot drift from the MCP child" a property rather than a habit.

    ``client`` is a test seam of the same shape :func:`is_api_reachable` already takes:
    ``None`` means each call opens its own short-lived client, which is what production
    does, and an injected one means the gate never touches a socket.
    """

    config: ServerConfig
    client: httpx.Client | None = None
    timeout: float = DEFAULT_TIMEOUT

    @classmethod
    def from_environment(
        cls,
        env: Mapping[str, str] | None = None,
        key_file: Path | None = None,
        client: httpx.Client | None = None,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> AnytypeClient:
        """Build a client from :func:`~innytypes.anytype_mcp.config.load_config`.

        The only entry point here that touches the ambient environment, and it does so by
        delegating: the key discovery rules live in one place and this is not it.
        """
        return cls(config=load_config(env=env, key_file=key_file), client=client, timeout=timeout)

    @property
    def api_base_url(self) -> str:
        """Where this client sends, which is whatever the config says and nothing else."""
        return self.config.api_base_url

    def __repr__(self) -> str:
        """Names where it points and what it speaks, and never the credential.

        The dataclass default would be safe today — ``ServerConfig.api_key`` is
        ``repr=False`` — but a client is the object that lands in a stack trace, so this
        does not rest on a field flag two modules away staying the way it is. Redacted for
        the same reason as the errors: the base URL is user-supplied.
        """
        return redact(
            f"{type(self).__name__}(api_base_url={self.config.api_base_url!r}, "
            f"anytype_version={self.config.anytype_version!r})"
        )

    @contextmanager
    def _session(self) -> Iterator[httpx.Client]:
        """The injected client, or a short-lived one closed on the way out."""
        if self.client is not None:
            yield self.client
            return

        http = httpx.Client(timeout=self.timeout)
        try:
            yield http
        finally:
            http.close()

    def _url(self, path: str) -> str:
        """An absolute URL under the configured base — never a hardcoded host."""
        return f"{self.config.api_base_url.rstrip('/')}/{path.lstrip('/')}"

    def get_json(self, path: str) -> Any:
        """``GET path`` under the configured base URL, decoded.

        Raises :class:`AnytypeUnreachableError` when Anytype is not answering,
        :class:`AnytypeStatusError` (or one of its named subclasses) on a non-2xx, and
        :class:`AnytypeApiError` when a success carries a body that is not JSON. A non-2xx
        is never returned as if it had worked.
        """
        url = self._url(path)

        with self._session() as http:
            # The one place connectivity is decided is is_api_reachable, so this asks it
            # rather than classifying a transport error itself. Checking on every call
            # rather than once per client is deliberate: a desktop app the user can quit at
            # any moment has no "still up" to remember, and the probe is one loopback GET.
            if not is_api_reachable(self.config, client=http):
                log.warning("Anytype's local API did not answer at %s", self.config.api_base_url)
                raise AnytypeUnreachableError(self.config.api_base_url)

            log.debug("GET %s", url)
            try:
                # The headers come from the config, whole, so the bearer token and the
                # pinned Anytype-Version are the same pair the MCP child is launched with.
                response = http.get(url, headers=self.config.headers())
            except httpx.HTTPError as exc:
                # It answered the probe a moment ago and not this. Same fix, same error:
                # the app went away mid-call.
                log.warning("Anytype's local API stopped answering at %s", self.config.api_base_url)
                raise AnytypeUnreachableError(self.config.api_base_url) from exc

        if not response.is_success:
            log.warning("GET %s answered HTTP %s", url, response.status_code)
            raise status_error("GET", url, response.status_code)

        try:
            return response.json()
        except ValueError as exc:
            raise AnytypeApiError(redact(f"GET {url} returned a body that is not JSON")) from exc

    def list_spaces(self) -> list[Space]:
        """Every space Anytype knows about, in the order it returned them.

        A payload that is not shaped like ``{"data": [{"id": ..., "name": ...}]}`` is an
        error rather than an empty list: "Anytype answered something else" and "you have no
        spaces" are different facts and the caller must not have to guess which it got.
        """
        payload = self.get_json(SPACES_PATH)
        url = self._url(SPACES_PATH)

        if not isinstance(payload, dict):
            kind = type(payload).__name__
            raise AnytypeApiError(redact(f"GET {url} returned {kind}, not an object"))

        entries = payload.get("data")
        if not isinstance(entries, list):
            raise AnytypeApiError(redact(f"GET {url} returned no `data` list of spaces"))

        spaces: list[Space] = []
        for entry in entries:
            if not isinstance(entry, dict):
                raise AnytypeApiError(redact(f"GET {url} listed a space that is not an object"))

            identifier = entry.get("id")
            if not isinstance(identifier, str) or not identifier:
                raise AnytypeApiError(redact(f"GET {url} listed a space with no id"))

            name = entry.get("name")
            spaces.append(Space(id=identifier, name=name if isinstance(name, str) else ""))

        return spaces
