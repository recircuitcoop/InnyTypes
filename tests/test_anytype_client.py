"""The host's client for Anytype's local API — asserted without Anytype and without a socket.

Every request in this file goes through an ``httpx.MockTransport``, which is the same seam
``is_api_reachable`` already uses. Nothing here needs port 31009 to be listening, which is
what keeps ``docs/loop/verify.sh`` green from a clean clone (docs/loop/SKILL.md, "the gate
is hermetic").

Two things are checked here that a passing request never proves on its own: that the client
gets its credential from the ``ServerConfig`` it was handed and from nowhere else, and that
the credential is absent from every log record, every error message and the client's own
``repr``. The last test in the leak section unhooks the redactor and asserts the key *does*
escape — an acceptance check that cannot fail proves nothing, and this one can.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterator
from typing import Any

import httpx
import pytest

from conftest import FAKE_KEY
from innytypes import anytype_api
from innytypes.anytype_api import (
    AnytypeApiError,
    AnytypeClient,
    AnytypeNotFoundError,
    AnytypeServerError,
    AnytypeStatusError,
    AnytypeUnauthorizedError,
    AnytypeUnreachableError,
    Space,
)
from innytypes.anytype_mcp import logs
from innytypes.anytype_mcp.config import DEFAULT_API_BASE_URL, ServerConfig

ONE_SPACE: dict[str, Any] = {"data": [{"id": "space-1", "name": "Personal"}]}

# A base URL a user could plausibly set, and never the default, so a test that asserts on it
# cannot pass against a hardcoded host.
OTHER_BASE_URL = "http://127.0.0.1:41009"


class FakeAnytype:
    """An in-process Anytype: it answers the reachability probe and then the real request.

    The two are told apart by their order rather than their path, because the probe and
    ``list_spaces`` both hit ``/v1/spaces``. Answering them separately is the only way a
    test can put a 5xx on the call itself — the probe reads a 5xx as "not up", so a fake
    that answered both the same way could never reach the server-error branch at all.
    """

    def __init__(
        self,
        *,
        probe_status: int = 200,
        probe_raises: bool = False,
        status: int = 200,
        json_body: Any = None,
        text_body: str | None = None,
        raises: bool = False,
    ) -> None:
        self.probe_status = probe_status
        self.probe_raises = probe_raises
        self.status = status
        self.json_body = ONE_SPACE if json_body is None else json_body
        self.text_body = text_body
        self.raises = raises
        self.requests: list[httpx.Request] = []

    def handle(self, request: httpx.Request) -> httpx.Response:
        # Recorded before any refusal, so an unreachable API still proves the client went
        # through the injected transport rather than the real network.
        self.requests.append(request)
        is_probe = len(self.requests) % 2 == 1

        if is_probe:
            if self.probe_raises:
                raise httpx.ConnectError("connection refused", request=request)
            # The probe gets the same body as the call. It is thrown away by
            # ``is_api_reachable``, but a test that stubs the probe out entirely then still
            # gets a usable answer from the one request it does make.
            return httpx.Response(self.probe_status, json=self.json_body)

        if self.raises:
            raise httpx.ConnectError("connection refused", request=request)
        if self.text_body is not None:
            return httpx.Response(self.status, text=self.text_body)
        return httpx.Response(self.status, json=self.json_body)

    @property
    def probes(self) -> list[httpx.Request]:
        """The reachability probes only."""
        return self.requests[0::2]

    @property
    def calls(self) -> list[httpx.Request]:
        """The real requests only — what the client actually asked for."""
        return self.requests[1::2]


MakeClient = Callable[..., AnytypeClient]


@pytest.fixture
def make_client() -> Iterator[MakeClient]:
    """Build clients wired to a fake, never to a socket."""
    opened: list[httpx.Client] = []

    def _make(fake: FakeAnytype, config: ServerConfig | None = None) -> AnytypeClient:
        http = httpx.Client(transport=httpx.MockTransport(fake.handle))
        opened.append(http)
        return AnytypeClient(
            config=ServerConfig(api_key=FAKE_KEY) if config is None else config,
            client=http,
        )

    yield _make

    for http in opened:
        http.close()


# --- where the credential and the base URL come from --------------------------------------


def test_the_wire_carries_the_configs_key_and_not_the_environments(
    make_client: MakeClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A client that read the environment behind the caller's back would send this instead.
    monkeypatch.setenv("ANYTYPE_API_KEY", "fake-some-other-key-should-never-be-sent")
    fake = FakeAnytype()
    client = make_client(fake, ServerConfig(api_key=FAKE_KEY))

    client.list_spaces()

    assert fake.calls[0].headers["Authorization"] == f"Bearer {FAKE_KEY}"


def test_the_module_has_no_second_way_to_find_a_key() -> None:
    # The behavioural test above proves the key that was *sent*; this proves there is no
    # second code path that could ever find one. Importing os, or the key-file helpers,
    # turns this red.
    for name in ("os", "load_api_key", "API_KEY_ENV_VAR", "DEFAULT_KEY_FILE"):
        assert not hasattr(anytype_api, name), f"{name} has no business in this module"


def test_from_environment_delegates_to_load_config() -> None:
    env = {
        "ANYTYPE_API_KEY": FAKE_KEY,
        "ANYTYPE_API_BASE_URL": OTHER_BASE_URL,
    }

    client = AnytypeClient.from_environment(env=env)

    assert client.config.api_key == FAKE_KEY
    assert client.api_base_url == OTHER_BASE_URL


def test_the_default_base_url_is_anytypes_own_port(make_client: MakeClient) -> None:
    fake = FakeAnytype()
    client = make_client(fake)

    client.list_spaces()

    assert client.api_base_url == DEFAULT_API_BASE_URL
    assert str(fake.calls[0].url) == f"{DEFAULT_API_BASE_URL}/v1/spaces"
    assert fake.calls[0].url.port == 31009


def test_a_configured_base_url_is_where_the_request_goes(make_client: MakeClient) -> None:
    fake = FakeAnytype()
    client = make_client(fake, ServerConfig(api_key=FAKE_KEY, api_base_url=OTHER_BASE_URL))

    client.list_spaces()

    assert str(fake.calls[0].url) == f"{OTHER_BASE_URL}/v1/spaces"
    assert fake.probes[0].url.port == 41009


def test_a_base_url_with_a_trailing_slash_does_not_double_it(make_client: MakeClient) -> None:
    config = ServerConfig(api_key=FAKE_KEY, api_base_url=f"{OTHER_BASE_URL}/")
    fake = FakeAnytype()
    client = make_client(fake, config)

    client.list_spaces()

    assert str(fake.calls[0].url) == f"{OTHER_BASE_URL}/v1/spaces"


# --- the headers --------------------------------------------------------------------------


def test_every_request_carries_exactly_the_configs_headers(make_client: MakeClient) -> None:
    fake = FakeAnytype()
    config = ServerConfig(api_key=FAKE_KEY)
    client = make_client(fake, config)

    client.list_spaces()

    expected = config.headers()
    assert expected["Anytype-Version"] == "2025-11-08"
    for request in fake.requests:
        for name, value in expected.items():
            assert request.headers[name] == value


# --- reachability is decided in one place -------------------------------------------------


def test_a_call_consults_is_api_reachable(
    make_client: MakeClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A spy, so the delegation is proven rather than inferred from a request that happened
    # to look like a probe.
    seen: list[tuple[ServerConfig, httpx.Client | None]] = []

    def spy(config: ServerConfig, client: httpx.Client | None = None) -> bool:
        seen.append((config, client))
        return True

    monkeypatch.setattr(anytype_api, "is_api_reachable", spy)
    fake = FakeAnytype()
    client = make_client(fake)

    client.list_spaces()

    assert len(seen) == 1
    assert seen[0][0] is client.config
    assert seen[0][1] is client.client


def test_an_unreachable_api_is_refused_before_the_request(make_client: MakeClient) -> None:
    fake = FakeAnytype(probe_raises=True)
    client = make_client(fake)

    with pytest.raises(AnytypeUnreachableError):
        client.list_spaces()

    # The probe went through the injected transport, and the real request was never made.
    assert len(fake.probes) == 1
    assert fake.calls == []


def test_a_server_error_on_the_probe_reads_as_unreachable(make_client: MakeClient) -> None:
    # is_api_reachable already decides that a 5xx means "not up". The client inherits that
    # judgement rather than forming its own.
    fake = FakeAnytype(probe_status=503)
    client = make_client(fake)

    with pytest.raises(AnytypeUnreachableError):
        client.list_spaces()

    assert fake.calls == []


def test_an_api_that_goes_away_mid_call_is_unreachable_too(make_client: MakeClient) -> None:
    # It answered the probe and not the request: the user quit Anytype in between. Same
    # fix, so the same named error rather than a raw httpx exception reaching the caller.
    fake = FakeAnytype(raises=True)
    client = make_client(fake)

    with pytest.raises(AnytypeUnreachableError):
        client.list_spaces()

    assert len(fake.probes) == 1


def test_a_client_with_no_injected_transport_opens_and_closes_its_own(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The production path, exercised without a socket: the probe is stubbed out, so the
    # client builds its own httpx.Client, is refused, and closes it again.
    monkeypatch.setattr(anytype_api, "is_api_reachable", lambda config, client=None: False)
    client = AnytypeClient(config=ServerConfig(api_key=FAKE_KEY))

    with pytest.raises(AnytypeUnreachableError):
        client.list_spaces()


# --- what comes back ----------------------------------------------------------------------


def test_a_success_returns_the_decoded_body(make_client: MakeClient) -> None:
    fake = FakeAnytype(json_body={"data": [], "extra": 1})
    client = make_client(fake)

    assert client.get_json("/v1/spaces") == {"data": [], "extra": 1}


def test_list_spaces_returns_every_space(make_client: MakeClient) -> None:
    fake = FakeAnytype(
        json_body={"data": [{"id": "space-1", "name": "Personal"}, {"id": "space-2"}]}
    )
    client = make_client(fake)

    assert client.list_spaces() == [Space(id="space-1", name="Personal"), Space(id="space-2")]


def test_no_spaces_is_an_empty_list_and_not_an_error(make_client: MakeClient) -> None:
    fake = FakeAnytype(json_body={"data": []})
    client = make_client(fake)

    assert client.list_spaces() == []


@pytest.mark.parametrize(
    "body",
    [
        pytest.param([1, 2, 3], id="not-an-object"),
        pytest.param({"spaces": []}, id="no-data-list"),
        pytest.param({"data": ["space-1"]}, id="entry-is-not-an-object"),
        pytest.param({"data": [{"name": "Personal"}]}, id="entry-has-no-id"),
        pytest.param({"data": [{"id": ""}]}, id="entry-has-an-empty-id"),
    ],
)
def test_a_payload_that_is_not_a_space_list_is_an_error(make_client: MakeClient, body: Any) -> None:
    # "Anytype answered something else" and "you have no spaces" are different facts, and
    # a caller must never have to guess which one an empty list meant.
    fake = FakeAnytype(json_body=body)
    client = make_client(fake)

    with pytest.raises(AnytypeApiError):
        client.list_spaces()


def test_a_success_whose_body_is_not_json_is_an_error(make_client: MakeClient) -> None:
    fake = FakeAnytype(text_body="<html>not json at all</html>")
    client = make_client(fake)

    with pytest.raises(AnytypeApiError):
        client.get_json("/v1/spaces")


# --- a non-2xx is never a result ----------------------------------------------------------


@pytest.mark.parametrize(
    ("status", "expected"),
    [
        pytest.param(401, AnytypeUnauthorizedError, id="401"),
        pytest.param(404, AnytypeNotFoundError, id="404"),
        pytest.param(503, AnytypeServerError, id="503"),
        pytest.param(418, AnytypeStatusError, id="418"),
    ],
)
def test_a_non_success_raises_its_named_error_with_the_status(
    make_client: MakeClient, status: int, expected: type[AnytypeStatusError]
) -> None:
    fake = FakeAnytype(status=status)
    client = make_client(fake)

    with pytest.raises(expected) as caught:
        client.get_json("/v1/objects")

    assert caught.value.status_code == status
    assert str(status) in str(caught.value)


def test_every_named_status_error_is_an_anytype_api_error() -> None:
    # Callers that only care that the call failed keep working; callers that want to say
    # "start Anytype" or "your key was refused" can distinguish. Both need this.
    for error in (
        AnytypeUnreachableError,
        AnytypeStatusError,
        AnytypeUnauthorizedError,
        AnytypeNotFoundError,
        AnytypeServerError,
    ):
        assert issubclass(error, AnytypeApiError)


def test_a_non_success_is_not_returned_as_if_it_had_worked(make_client: MakeClient) -> None:
    fake = FakeAnytype(status=401, json_body={"data": [{"id": "space-1"}]})
    client = make_client(fake)

    # The body of a 401 is still a decodable JSON object. Returning it would hand the
    # caller a plausible-looking result for a request that was refused.
    with pytest.raises(AnytypeUnauthorizedError):
        client.list_spaces()


# --- the key is in none of it -------------------------------------------------------------


def test_the_repr_names_where_it_points_and_never_the_key() -> None:
    client = AnytypeClient(config=ServerConfig(api_key=FAKE_KEY))

    text = repr(client)

    assert FAKE_KEY not in text
    assert DEFAULT_API_BASE_URL in text
    assert "2025-11-08" in text


def test_no_error_message_contains_the_key(make_client: MakeClient) -> None:
    config = ServerConfig(api_key=FAKE_KEY)

    unreachable = make_client(FakeAnytype(probe_raises=True), config)
    with pytest.raises(AnytypeUnreachableError) as refused:
        unreachable.list_spaces()

    rejected = make_client(FakeAnytype(status=401), config)
    with pytest.raises(AnytypeUnauthorizedError) as unauthorized:
        rejected.get_json("/v1/objects")

    for message in (str(refused.value), str(unauthorized.value)):
        assert FAKE_KEY not in message
        assert config.openapi_mcp_headers() not in message
        assert config.api_base_url in message

    assert "401" in str(unauthorized.value)


def test_a_key_embedded_in_the_base_url_is_redacted_out_of_everything(
    make_client: MakeClient,
) -> None:
    # ANYTYPE_API_BASE_URL is user-supplied, so "the URL is never secret" is an assumption
    # rather than a fact — and this client puts that URL into its repr and its errors.
    config = ServerConfig(api_key=FAKE_KEY, api_base_url=f"http://u:{FAKE_KEY}@127.0.0.1:31009")
    client = make_client(FakeAnytype(probe_raises=True), config)

    with pytest.raises(AnytypeUnreachableError) as caught:
        client.list_spaces()

    assert FAKE_KEY not in str(caught.value)
    assert FAKE_KEY not in repr(client)
    assert "127.0.0.1:31009" in str(caught.value)


# --- the key never reaches a log record ---------------------------------------------------


def rendered(record: logging.LogRecord) -> str:
    """Everything a handler could print from ``record``, as one string."""
    parts = [record.getMessage(), str(record.msg), str(record.args)]
    if record.exc_text:
        parts.append(record.exc_text)
    return "\n".join(parts)


def our_records(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    """Only the records this module emitted.

    ``httpx`` logs every request at INFO through its own logger, rendering the URL it was
    handed — userinfo and all. That logger belongs to the library, not to this package, and
    installing this package's redactor on it would be reaching into somebody else's
    logging configuration from an import. The obligation invariant 7 puts on this module is
    that *its own* records never carry the credential, and that is what is asserted here.
    """
    return [record for record in caplog.records if record.name.startswith("innytypes")]


def leaky_config() -> ServerConfig:
    """A config whose *base URL* carries the key, which is the shape that can leak.

    The client logs the URL it is about to fetch and the base URL it could not reach. With
    the credential inside that URL, the redactor is the only thing standing between the key
    and the log file.
    """
    return ServerConfig(api_key=FAKE_KEY, api_base_url=f"http://u:{FAKE_KEY}@127.0.0.1:31009")


def test_a_failing_call_logs_something(
    make_client: MakeClient, caplog: pytest.LogCaptureFixture
) -> None:
    # Guards the two tests below: "no record contained the key" is trivially true of a
    # module that logs nothing at all.
    caplog.set_level(logging.DEBUG)
    client = make_client(FakeAnytype(status=404), leaky_config())

    with pytest.raises(AnytypeNotFoundError):
        client.get_json("/v1/objects")

    messages = [record.getMessage() for record in our_records(caplog)]
    assert any("GET" in message for message in messages)
    assert any("404" in message for message in messages)


def test_no_log_record_contains_the_credential(
    make_client: MakeClient, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    config = leaky_config()

    reachable = make_client(FakeAnytype(status=404), config)
    with pytest.raises(AnytypeNotFoundError):
        reachable.get_json("/v1/objects")

    unreachable = make_client(FakeAnytype(probe_raises=True), config)
    with pytest.raises(AnytypeUnreachableError):
        unreachable.list_spaces()

    gone = make_client(FakeAnytype(raises=True), config)
    with pytest.raises(AnytypeUnreachableError):
        gone.list_spaces()

    records = our_records(caplog)
    assert records
    for record in records:
        assert FAKE_KEY not in rendered(record)


def test_without_the_redactor_the_same_calls_leak_the_credential(
    make_client: MakeClient, caplog: pytest.LogCaptureFixture
) -> None:
    """Prove the test above can fail. Unhook the redactor and the key comes straight out."""
    caplog.set_level(logging.DEBUG)
    anytype_api.log.removeFilter(logs.REDACTOR)
    try:
        client = make_client(FakeAnytype(probe_raises=True), leaky_config())
        with pytest.raises(AnytypeUnreachableError):
            client.list_spaces()

        assert any(FAKE_KEY in rendered(record) for record in our_records(caplog))
    finally:
        anytype_api.log.addFilter(logs.REDACTOR)
