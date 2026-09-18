"""The telemetry pipeline: nothing leaves this machine that the user did not agree to.

Every seam that could touch the world outside the process is injected here, because this is
the one slice where a hermetic gate is not just hygiene: a test that read the real machine
identifier would be a test that put the developer's own machine id into a CI log.

  * the **HTTP transport** is an :class:`httpx.MockTransport` in every single test;
  * the **machine identifier source** is a counting fake, and the pipeline's constructor has
    no default for it, so there is no spelling of these tests that reaches the real one;
  * the **queue** lives under ``tmp_path``;
  * the **clock** and the **sleep** are injected, so a backoff is asserted rather than waited.

Several tests here are canaries: they assert that the *check* can fail. A leak test that
would pass against an unredacted payload proves nothing, so the ones that matter come in
pairs — the redacted payload has none of the forbidden values, and the raw payload has all
of them.
"""

from __future__ import annotations

import hashlib
import hmac
import inspect
import json
import subprocess
import threading
import time
from collections.abc import Callable, Iterator, Sequence
from pathlib import Path

import httpx
import pytest
from click.testing import CliRunner

from innytypes.anytype_mcp.logs import REDACTED, protect
from innytypes.children import Command, CommandName, CommandResult
from innytypes.cli import cli
from innytypes.helper.config import HelperSettings
from innytypes.helper.restart import RestartPolicy
from innytypes.helper.telemetry import (
    DEFAULT_BACKOFF,
    MACHINE_ID_KEY,
    PRIVACY_NOTICE,
    Endpoints,
    GlitchTipTransport,
    InstalledPlugin,
    QueuedReport,
    ReportKind,
    ReportQueue,
    TelemetryError,
    TelemetryPipeline,
    UmamiTransport,
    UsageSnapshot,
    answer_first_launch_question,
    machine_id,
    os_machine_identifier,
    question_is_unanswered,
    redact,
    stack_frames,
)

# Fake machine identifiers. Long and distinctive so registering one with the credential
# redactor cannot blank a fragment of unrelated text, and the word "fake" is on the line for
# tests/test_no_secrets.py.
FAKE_IDENTIFIER = "FAKE-6B4C1E2A-9D3F-4A18-8C7E-2F5B0A9D1C34"
OTHER_FAKE_IDENTIFIER = "FAKE-11111111-2222-3333-4444-555566667777"

# Endpoints that exist only here. Both are https, because the transports refuse anything else.
TEST_ENDPOINTS = Endpoints(
    glitchtip_dsn="https://fakepublickey0123456789@errors.innytypes.invalid/7",
    umami_url="https://usage.innytypes.invalid",
    umami_website_id="fake-website-0123",
)


# --- the fakes ------------------------------------------------------------------------------


class FakeClock:
    """Wall-clock seconds a test moves rather than waits."""

    def __init__(self, now: float = 1_700_000_000.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class FakeIdentifierSource:
    """The OS machine identifier, faked, counting every time it is asked for.

    The count is the evidence for F2's other half: while the first-launch question is
    unanswered, this is never called at all.
    """

    def __init__(self, value: str = FAKE_IDENTIFIER) -> None:
        self.value = value
        self.reads = 0

    def __call__(self) -> str:
        self.reads += 1
        return self.value


class RecordingTransport:
    """An `httpx.MockTransport` that records every request and can be made to fail or hang."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.fail = False
        self.hang = threading.Event()
        self.hang.set()  # set means "do not hang"
        self.entered = threading.Event()
        self.transport = httpx.MockTransport(self._handle)

    def _handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        self.entered.set()
        # Waits only when a test cleared the event; there is no timeout to wait out here.
        self.hang.wait()
        if self.fail:
            raise httpx.ConnectError("connection refused", request=request)
        return httpx.Response(200, json={"ok": True})

    @property
    def bodies(self) -> list[dict[str, object]]:
        return [json.loads(request.content.decode("utf-8")) for request in self.requests]


class SleepRecorder:
    """The backoff, recorded instead of slept."""

    def __init__(self) -> None:
        self.delays: list[float] = []

    def __call__(self, seconds: float) -> None:
        self.delays.append(seconds)


def write_switch(path: Path, value: bool | None) -> None:
    """Write `config.toml` with the telemetry switch on, off, or absent (unanswered)."""
    if value is None:
        path.write_text("auto_check_versions = true\n", encoding="utf-8")
        return
    path.write_text(f"telemetry = {'true' if value else 'false'}\n", encoding="utf-8")


@pytest.fixture
def config_file(tmp_path: Path) -> Path:
    path = tmp_path / "config.toml"
    write_switch(path, None)
    return path


@pytest.fixture
def queue_root(tmp_path: Path) -> Path:
    return tmp_path / "queue"


@pytest.fixture
def transport() -> RecordingTransport:
    return RecordingTransport()


@pytest.fixture
def identifier() -> FakeIdentifierSource:
    return FakeIdentifierSource()


@pytest.fixture
def sleeper() -> SleepRecorder:
    return SleepRecorder()


@pytest.fixture
def make_pipeline(
    config_file: Path,
    queue_root: Path,
    transport: RecordingTransport,
    identifier: FakeIdentifierSource,
    sleeper: SleepRecorder,
) -> Iterator[Callable[..., TelemetryPipeline]]:
    """Pipelines wired to fakes, stopped afterwards whether or not the test started them."""
    built: list[TelemetryPipeline] = []

    def _make(
        *,
        max_reports: int = 8,
        max_bytes: int = 1024 * 1024,
        endpoints: Endpoints = TEST_ENDPOINTS,
        backoff: Sequence[float] = DEFAULT_BACKOFF,
    ) -> TelemetryPipeline:
        pipeline = TelemetryPipeline(
            settings=HelperSettings(path=config_file),
            queue=ReportQueue(queue_root, max_reports=max_reports, max_bytes=max_bytes),
            machine_identifier=identifier,
            endpoints=endpoints,
            release="9.9.9",
            transport=transport.transport,
            clock=FakeClock(),
            sleep=sleeper,
            backoff=backoff,
            wake_interval=0.01,
        )
        built.append(pipeline)
        return pipeline

    yield _make

    for pipeline in built:
        pipeline.stop(timeout=2.0)


def a_usage_snapshot() -> UsageSnapshot:
    return UsageSnapshot(
        innytypes_version="9.9.9",
        os="Darwin",
        os_version="25.3.0",
        plugins=(InstalledPlugin(id="whodunnit", version="1.2.0", update_mode="auto"),),
        starts=3,
        stops=2,
        interventions={"restart": 4, "kill": 1},
        updates={"applied": "0.2.0", "rolled_back": "0.1.9"},
    )


def queue_files(root: Path) -> list[Path]:
    return sorted(root.glob("*.json")) if root.exists() else []


# --- the machine id ---------------------------------------------------------------------------


def test_the_machine_id_is_the_hmac_of_the_injected_identifier() -> None:
    source = FakeIdentifierSource()

    computed = machine_id(source)

    expected = hmac.new(MACHINE_ID_KEY, FAKE_IDENTIFIER.encode("utf-8"), hashlib.sha256)
    assert computed == expected.hexdigest()


def test_the_machine_id_is_the_same_every_time_for_the_same_machine() -> None:
    source = FakeIdentifierSource()

    # Repeated calls, and a second source object standing for a reinstall: one machine, one id.
    assert machine_id(source) == machine_id(source) == machine_id(FakeIdentifierSource())


def test_the_machine_id_neither_equals_nor_contains_the_raw_identifier() -> None:
    computed = machine_id(FakeIdentifierSource())

    assert computed != FAKE_IDENTIFIER
    assert FAKE_IDENTIFIER not in computed
    # Nor any recognisable piece of it: a hash that leaked half the input would still leak.
    assert not any(part.lower() in computed for part in FAKE_IDENTIFIER.split("-") if part)


def test_a_different_machine_gets_a_different_id() -> None:
    assert machine_id(FakeIdentifierSource()) != machine_id(
        FakeIdentifierSource(OTHER_FAKE_IDENTIFIER)
    )


def test_computing_the_id_arms_the_credential_redactor_against_the_raw_identifier() -> None:
    raw = "FAKE-ARMED-AAAA-BBBB-CCCC-DDDDEEEEFFFF"

    machine_id(FakeIdentifierSource(raw))

    assert redact({"reason": f"read {raw} from the OS"})["reason"] == f"read {REDACTED} from the OS"


def test_an_empty_or_stub_identifier_is_refused_rather_than_hashed() -> None:
    with pytest.raises(TelemetryError, match="returned nothing"):
        machine_id(FakeIdentifierSource(""))

    with pytest.raises(TelemetryError, match="not an operating system machine identifier"):
        machine_id(FakeIdentifierSource("abc"))


def test_the_macos_identifier_is_read_from_ioreg_and_nothing_else() -> None:
    calls: list[Sequence[str]] = []

    def run(argv: Sequence[str]) -> str:
        calls.append(argv)
        return (
            "  +-o IOPlatformExpertDevice  <class IOPlatformExpertDevice>\n"
            '      "IOPlatformUUID" = "FAKE-6B4C1E2A-9D3F-4A18-8C7E-2F5B0A9D1C34"\n'
            '      "IOPlatformSerialNumber" = "FAKESERIAL123"\n'
        )

    found = os_machine_identifier(system="Darwin", run=run)

    assert found == FAKE_IDENTIFIER
    assert calls == [["/usr/sbin/ioreg", "-rd1", "-c", "IOPlatformExpertDevice"]]
    # The serial number sits in the same output and is never what is returned (D20).
    assert "FAKESERIAL123" not in found


def test_ioreg_printing_no_uuid_is_refused() -> None:
    with pytest.raises(TelemetryError, match="no IOPlatformUUID"):
        os_machine_identifier(system="Darwin", run=lambda argv: "nothing useful here")


def test_a_failing_ioreg_is_refused_by_name() -> None:
    def run(argv: Sequence[str]) -> str:
        raise subprocess.CalledProcessError(1, list(argv))

    with pytest.raises(TelemetryError, match="could not be read"):
        os_machine_identifier(system="Darwin", run=run)


def test_every_platform_innytypes_ships_for_has_its_own_identifier_source() -> None:
    """macOS, Linux and Windows each answer from their own source, and never from each other's.

    A fallback between them would be some *other* identifier — a host name, a MAC address —
    which is precisely what D20 forbids.
    """
    assert os_machine_identifier(
        system="Darwin",
        run=lambda argv: '"IOPlatformUUID" = "2C4F1B3A-7D9E-4A55-8B21-6E0C3F5D9A47"',
    )
    assert os_machine_identifier(system="Linux", read=lambda path: "b9f3c1d47e2a4c58ad06\n")
    assert os_machine_identifier(
        system="Windows",
        read_registry=lambda key, value: "{2C4F1B3A-7D9E-4A55-8B21-6E0C3F5D9A47}",
    )


def test_an_operating_system_nobody_ships_for_has_no_machine_identifier_either() -> None:
    with pytest.raises(TelemetryError, match="no machine identifier source"):
        os_machine_identifier(system="Plan9", run=lambda argv: "")


# --- the one redaction function ------------------------------------------------------------------

# Every value on plan 0003's *never sent* list, each in the shape it would really arrive in.
FORBIDDEN_CONTENT = "Meeting notes: the acquisition closes in March"
FORBIDDEN_OBJECT_NAME = "Project Kingfisher"
FORBIDDEN_SPACE_NAME = "Martin's private space"
FORBIDDEN_API_KEY = "fake-anytype-key-0123456789abcdef"
FORBIDDEN_OTHER_CREDENTIAL = "fake-bearer-token-zyxwvutsrqponml"
FORBIDDEN_FILE_CONTENTS = "line one of the file\nline two of the file"
FORBIDDEN_TRANSCRIPT = "so then I told her the number was wrong"
FORBIDDEN_ENV_VALUE = "fake-env-value-mnopqrstuvwxyz0123"
FORBIDDEN_HOME_PATH = "/Users/someperson/Documents/private/notes.md"
FORBIDDEN_USER_NAME = "someperson"
FORBIDDEN_HOST_NAME = "somepersons-macbook.local"


def a_payload_holding_everything_forbidden() -> dict[str, object]:
    """A payload deliberately built to carry every one of the *never sent* things.

    Nothing in innytypes builds a payload like this — that is the point. The redaction
    function is asked to hold against a payload far worse than any it will meet.
    """
    return {
        # The legitimate fields, which must survive: a redactor that emptied everything
        # would pass every leak assertion below and be useless.
        "kind": "error",
        "machine_id": "a" * 64,
        "innytypes_version": "9.9.9",
        "os": "Darwin",
        "os_version": "25.3.0",
        "exception_type": "RuntimeError",
        "interventions": {"restart": 4},
        "starts": 3,
        # Anytype content, and the names of objects and spaces.
        "object_content": FORBIDDEN_CONTENT,
        "object_title": FORBIDDEN_OBJECT_NAME,
        "space_name": FORBIDDEN_SPACE_NAME,
        # The Anytype API key, and another credential.
        "anytype_api_key": FORBIDDEN_API_KEY,
        "authorization": f"Bearer {FORBIDDEN_OTHER_CREDENTIAL}",
        # File contents.
        "file_contents": FORBIDDEN_FILE_CONTENTS,
        # Audio and transcripts.
        "audio_transcript": FORBIDDEN_TRANSCRIPT,
        # Environment variable values.
        "environment": {"ANYTYPE_API_KEY": FORBIDDEN_ENV_VALUE, "USER": FORBIDDEN_USER_NAME},
        # Full home-directory paths, under a forbidden key AND inside a permitted one.
        "home_path": FORBIDDEN_HOME_PATH,
        "stack": [f"{FORBIDDEN_HOME_PATH}:12 in main"],
        # User names and host names.
        "user_name": FORBIDDEN_USER_NAME,
        "host_name": FORBIDDEN_HOST_NAME,
        # The raw OS machine identifier, under a forbidden key AND inside a permitted one.
        "machine_identifier": FAKE_IDENTIFIER,
        "reason": f"read {FAKE_IDENTIFIER} while restarting",
    }


FORBIDDEN_VALUES = (
    FORBIDDEN_CONTENT,
    FORBIDDEN_OBJECT_NAME,
    FORBIDDEN_SPACE_NAME,
    FORBIDDEN_API_KEY,
    FORBIDDEN_OTHER_CREDENTIAL,
    FORBIDDEN_FILE_CONTENTS,
    FORBIDDEN_TRANSCRIPT,
    FORBIDDEN_ENV_VALUE,
    FORBIDDEN_HOME_PATH,
    FORBIDDEN_USER_NAME,
    FORBIDDEN_HOST_NAME,
    FAKE_IDENTIFIER,
)


def leaked(document: object) -> list[str]:
    """Which of the forbidden values survived into a document, as rendered JSON.

    Both spellings are looked for: the value itself, and the form JSON escapes it into — a
    newline inside file contents is `\\n` on the wire, and a check that only knew the first
    spelling would call a leaked file "clean".
    """
    rendered = json.dumps(document, ensure_ascii=False)
    escaped = {value: json.dumps(value, ensure_ascii=False)[1:-1] for value in FORBIDDEN_VALUES}
    return [value for value in FORBIDDEN_VALUES if value in rendered or escaped[value] in rendered]


def test_the_leak_check_itself_can_fail() -> None:
    """The canary. An unredacted payload must trip every assertion the redacted one passes."""
    raw = a_payload_holding_everything_forbidden()

    # Not "some": all of them. If this ever shrinks, the test below has stopped proving
    # anything about the values it no longer covers.
    assert set(leaked(raw)) == set(FORBIDDEN_VALUES)


def test_one_redaction_function_removes_every_never_sent_thing() -> None:
    redacted = redact(a_payload_holding_everything_forbidden(), secrets=(FAKE_IDENTIFIER,))

    assert leaked(redacted) == []


def test_redaction_keeps_the_fields_a_report_is_actually_made_of() -> None:
    """The other half of the canary: a redactor that emptied everything would be no good."""
    redacted = redact(a_payload_holding_everything_forbidden(), secrets=(FAKE_IDENTIFIER,))

    assert redacted["kind"] == "error"
    assert redacted["machine_id"] == "a" * 64
    assert redacted["innytypes_version"] == "9.9.9"
    assert redacted["os"] == "Darwin"
    assert redacted["exception_type"] == "RuntimeError"
    assert redacted["interventions"] == {"restart": 4}
    assert redacted["starts"] == 3


def test_a_forbidden_key_keeps_its_name_so_the_removal_is_visible() -> None:
    redacted = redact(a_payload_holding_everything_forbidden(), secrets=(FAKE_IDENTIFIER,))

    assert redacted["space_name"] == REDACTED
    assert redacted["anytype_api_key"] == REDACTED
    assert redacted["environment"] == REDACTED


# One entry per *thing* on the never-sent list, in the spellings a caller would reach for.
# The value is a sentinel no other rule would catch — not a path, not a registered credential
# — so what this proves is precisely the key-name rule, field by field.
@pytest.mark.parametrize(
    "key",
    [
        # Anytype content.
        "content",
        "object_content",
        "body_text",
        "markdown",
        "snippet",
        # Object and space names, and the ids that point at them.
        "object_title",
        "page_title",
        "object_name",
        "object_id",
        "display_name",
        "space_name",
        "space_id",
        "spaceName",
        "relation_name",
        # The Anytype API key, and any other credential.
        "api_key",
        "anytype_api_key",
        "ANYTYPE_API_KEY",
        "access_token",
        "password",
        "authorization",
        "cookie",
        "session_id",
        # File contents.
        "file",
        "file_contents",
        "file_path",
        "attachment",
        "document",
        # Audio and transcripts.
        "audio",
        "recording",
        "transcript",
        "transcription",
        # Environment variable values.
        "env",
        "environ",
        "environment",
        "env_vars",
        # Full home-directory paths.
        "home",
        "home_path",
        "home_directory",
        "path",
        "directory",
        # User names.
        "user",
        "user_name",
        "username",
        "account",
        "email",
        # Host names.
        "host",
        "host_name",
        "hostname",
        "ip_address",
        "mac_address",
        # The raw OS machine identifier, and the rest of the hardware's identity.
        "machine_identifier",
        "platform_uuid",
        "IOPlatformUUID",
        "machine_guid",
        "serial_number",
        "device_id",
    ],
)
def test_every_never_sent_field_is_removed_by_the_one_redaction_function(key: str) -> None:
    sentinel = "SENTINEL-VALUE-THAT-NO-OTHER-RULE-WOULD-CATCH"

    redacted = redact({key: sentinel, "nested": {key: sentinel}})

    assert redacted[key] == REDACTED
    assert sentinel not in json.dumps(redacted)


def test_the_field_by_field_check_can_fail() -> None:
    """The canary for the table above: a key that is not on the list keeps its value."""
    sentinel = "SENTINEL-VALUE-THAT-NO-OTHER-RULE-WOULD-CATCH"

    assert redact({"starts": sentinel})["starts"] == sentinel


def test_a_path_inside_a_package_is_reduced_to_package_relative_form() -> None:
    frames = {
        "stack": [
            "/Users/someperson/.venv/lib/python3.13/site-packages/innytypes/helper/restart.py:9",
            "/Users/someperson/git/innytypes/src/innytypes/helper/breaker.py:12",
            "/usr/lib/python3.13/json/decoder.py:355",
        ]
    }

    redacted = redact(frames)

    assert redacted["stack"] == [
        "innytypes/helper/restart.py:9",
        "innytypes/helper/breaker.py:12",
        "json/decoder.py:355",
    ]


def test_a_path_that_belongs_to_no_package_is_removed_rather_than_shortened() -> None:
    redacted = redact({"stack": ["/Users/someperson/src/private-notes/draft.py:3 in main"]})

    assert redacted["stack"] == [f"{REDACTED}:3 in main"]
    assert "private-notes" not in json.dumps(redacted)


def test_a_registered_credential_is_removed_from_any_string() -> None:
    protect("fake-registered-credential-abcdefgh")

    redacted = redact({"reason": "failed with fake-registered-credential-abcdefgh"})

    assert redacted["reason"] == f"failed with {REDACTED}"


def test_a_value_that_cannot_be_serialized_is_removed_rather_than_guessed_at() -> None:
    redacted = redact({"reason": Path("/Users/someperson/secret.md"), "count": {1, 2}})

    assert redacted == {"reason": REDACTED, "count": REDACTED}
    json.dumps(redacted)  # must not raise: a redacted report is always sendable


def test_a_very_long_string_and_a_very_deep_structure_are_bounded() -> None:
    deep: dict[str, object] = {"reason": "bottom"}
    for _ in range(20):
        deep = {"outer": deep}

    redacted = redact({"reason": "x" * 10_000, "nested": deep})

    assert len(str(redacted["reason"])) < 10_000
    assert REDACTED in json.dumps(redacted["nested"])


def test_an_error_report_carries_the_type_and_the_frames_but_never_the_message() -> None:
    pipeline_message = "could not open /Users/someperson/Documents/private/notes.md"
    try:
        raise RuntimeError(pipeline_message)
    except RuntimeError as error:
        frames = stack_frames(error.__traceback__)
        rendered = json.dumps({"exception_type": type(error).__qualname__, "stack": frames})

    assert "RuntimeError" in rendered
    assert pipeline_message not in rendered
    assert "someperson" not in rendered
    # The frame for this test file is inside the repository but not inside the package, so it
    # is dropped whole rather than reported with a blanked path.
    assert all(REDACTED not in frame for frame in frames)


# --- F2: before the question is answered, nothing is sent and nothing is queued ------------------


# Every public method of the pipeline, with arguments a test can supply. The reflection test
# below asserts this covers the whole public surface, so a method added later is not silently
# exempt from F2.
def public_calls(pipeline: TelemetryPipeline) -> dict[str, Callable[[], object]]:
    a_report = QueuedReport(
        sequence=1,
        kind=ReportKind.USAGE,
        payload={"kind": "usage"},
        path=Path("nowhere.json"),
    )
    return {
        "record_usage": lambda: pipeline.record_usage(a_usage_snapshot()),
        "record_error": lambda: pipeline.record_error(RuntimeError("boom")),
        "pending": pipeline.pending,
        "describe": lambda: pipeline.describe(a_report),
        "flush": pipeline.flush,
        "start": pipeline.start,
        "stop": pipeline.stop,
    }


def test_the_f2_check_covers_every_public_method_of_the_pipeline(
    make_pipeline: Callable[..., TelemetryPipeline],
) -> None:
    """A new public method is a new way to leak, so it must show up here to be added."""
    pipeline = make_pipeline()
    public = {
        name
        for name, member in inspect.getmembers(type(pipeline), inspect.isfunction)
        if not name.startswith("_")
    }

    assert public == set(public_calls(pipeline))


def test_with_the_question_unanswered_nothing_is_sent_queued_or_even_identified(
    config_file: Path,
    queue_root: Path,
    transport: RecordingTransport,
    identifier: FakeIdentifierSource,
    make_pipeline: Callable[..., TelemetryPipeline],
) -> None:
    write_switch(config_file, None)
    pipeline = make_pipeline()

    for call in public_calls(pipeline).values():
        call()

    assert queue_files(queue_root) == []
    assert transport.requests == []
    # F2's quieter half: an install whose owner has not answered has not had its machine
    # identifier read at all.
    assert identifier.reads == 0


def test_the_unanswered_check_can_fail_when_the_switch_is_on(
    config_file: Path,
    queue_root: Path,
    identifier: FakeIdentifierSource,
    make_pipeline: Callable[..., TelemetryPipeline],
) -> None:
    """The canary for F2: with the switch on, the same calls do queue and do identify."""
    write_switch(config_file, True)
    pipeline = make_pipeline()

    pipeline.record_usage(a_usage_snapshot())

    assert len(queue_files(queue_root)) == 1
    assert identifier.reads == 1


def test_the_switch_is_re_read_rather_than_remembered(
    config_file: Path,
    queue_root: Path,
    make_pipeline: Callable[..., TelemetryPipeline],
) -> None:
    write_switch(config_file, None)
    pipeline = make_pipeline()

    assert pipeline.record_usage(a_usage_snapshot()) is None

    # No restart, no new pipeline: the user answers, and the very next report is queued.
    write_switch(config_file, True)

    assert pipeline.record_usage(a_usage_snapshot()) is not None
    assert len(queue_files(queue_root)) == 1


def test_an_unreadable_config_is_never_permission_to_send(
    config_file: Path,
    queue_root: Path,
    transport: RecordingTransport,
    make_pipeline: Callable[..., TelemetryPipeline],
) -> None:
    config_file.write_text("this is not = = valid toml", encoding="utf-8")
    pipeline = make_pipeline()

    assert pipeline.record_usage(a_usage_snapshot()) is None
    assert queue_files(queue_root) == []
    assert transport.requests == []


# --- the bounded queue ----------------------------------------------------------------------------


def test_the_queue_drops_the_oldest_rather_than_growing_past_its_bound(queue_root: Path) -> None:
    queue = ReportQueue(queue_root, max_reports=3)

    for index in range(5):
        queue.enqueue(ReportKind.USAGE, {"kind": "usage", "starts": index})

    kept = [report.payload["starts"] for report in queue.pending()]

    assert len(queue) == 3
    # The two oldest are the ones missing, and the newest is present.
    assert kept == [2, 3, 4]


def test_the_queue_bound_holds_through_the_pipeline_too(
    config_file: Path,
    queue_root: Path,
    make_pipeline: Callable[..., TelemetryPipeline],
) -> None:
    write_switch(config_file, True)
    pipeline = make_pipeline(max_reports=4)

    for index in range(10):
        pipeline.record_usage(
            UsageSnapshot(innytypes_version="9.9.9", os="Darwin", os_version="25.3.0", starts=index)
        )

    queued = pipeline.pending()

    assert len(queued) == 4
    assert [report.payload["starts"] for report in queued] == [6, 7, 8, 9]


def test_the_queue_drops_the_oldest_when_its_bytes_run_out(queue_root: Path) -> None:
    queue = ReportQueue(queue_root, max_reports=100, max_bytes=400)

    for index in range(10):
        queue.enqueue(ReportKind.USAGE, {"kind": "usage", "starts": index, "pad": "x" * 100})

    sequences = [report.sequence for report in queue.pending()]

    assert sum(path.stat().st_size for path in queue_files(queue_root)) <= 400
    assert sequences == sorted(sequences)
    assert sequences[-1] == 10  # the newest is never the one dropped


def test_order_survives_a_restart_of_the_helper(queue_root: Path) -> None:
    ReportQueue(queue_root).enqueue(ReportKind.USAGE, {"kind": "usage", "starts": 1})

    # A second queue object is a second run of the helper against the same directory.
    second = ReportQueue(queue_root)
    second.enqueue(ReportKind.ERROR, {"kind": "error", "exception_type": "RuntimeError"})

    assert [report.sequence for report in second.pending()] == [1, 2]


def test_an_unreadable_queue_file_is_dropped_rather_than_blocking_the_queue(
    queue_root: Path,
) -> None:
    queue = ReportQueue(queue_root)
    queue.enqueue(ReportKind.USAGE, {"kind": "usage"})
    (queue_root / "000000000009-usage.json").write_text("{ not json", encoding="utf-8")

    assert len(queue.pending()) == 1
    assert not (queue_root / "000000000009-usage.json").exists()


def test_the_queue_directory_is_readable_by_this_user_only(queue_root: Path) -> None:
    ReportQueue(queue_root).enqueue(ReportKind.USAGE, {"kind": "usage"})

    assert queue_root.stat().st_mode & 0o077 == 0


def test_a_queue_that_could_hold_nothing_is_refused(queue_root: Path) -> None:
    with pytest.raises(TelemetryError, match="at least one report"):
        ReportQueue(queue_root, max_reports=0)


def test_two_writers_never_take_the_same_place_in_the_queue(queue_root: Path) -> None:
    """The helper and the application's window both enqueue; neither may overwrite the other.

    Two `ReportQueue` objects stand for two processes: each picks a sequence by scanning the
    directory, so the one that writes second must notice the name is taken rather than
    replacing a report that was never sent.
    """
    first, second = ReportQueue(queue_root), ReportQueue(queue_root)

    first.enqueue(ReportKind.USAGE, {"kind": "usage", "starts": 1})
    second.enqueue(ReportKind.USAGE, {"kind": "usage", "starts": 2})

    assert [report.payload["starts"] for report in first.pending()] == [1, 2]


def test_a_queue_that_cannot_be_written_never_reaches_the_caller(
    config_file: Path,
    tmp_path: Path,
    transport: RecordingTransport,
    identifier: FakeIdentifierSource,
) -> None:
    """Reporting a problem must never become one: the restart that reported it carries on."""
    write_switch(config_file, True)
    blocked = tmp_path / "not-a-directory"
    blocked.write_text("a file where the queue directory should be", encoding="utf-8")

    pipeline = TelemetryPipeline(
        settings=HelperSettings(path=config_file),
        queue=ReportQueue(blocked),
        machine_identifier=identifier,
        endpoints=TEST_ENDPOINTS,
        transport=transport.transport,
        clock=FakeClock(),
        sleep=SleepRecorder(),
    )

    # No exception reaches the caller, and nothing is claimed to have been queued.
    assert pipeline.record_usage(a_usage_snapshot()) is None
    assert pipeline.record_error(RuntimeError("boom")) is None


# --- turning telemetry off ------------------------------------------------------------------------


def test_turning_telemetry_off_empties_the_queue_at_once_and_sends_nothing_more(
    config_file: Path,
    queue_root: Path,
    transport: RecordingTransport,
    make_pipeline: Callable[..., TelemetryPipeline],
) -> None:
    write_switch(config_file, True)
    pipeline = make_pipeline()
    pipeline.record_usage(a_usage_snapshot())
    pipeline.record_error(RuntimeError("boom"))
    assert len(queue_files(queue_root)) == 2

    write_switch(config_file, False)

    # The very next thing the pipeline is asked to do empties the queue: nothing drains.
    assert pipeline.flush() == 0
    assert queue_files(queue_root) == []
    assert transport.requests == []

    # And nothing queued afterwards either, so there is nothing left to send later.
    assert pipeline.record_usage(a_usage_snapshot()) is None
    assert pipeline.flush() == 0
    assert transport.requests == []


def test_the_switch_stops_a_drain_half_way_through(
    config_file: Path,
    queue_root: Path,
    transport: RecordingTransport,
    make_pipeline: Callable[..., TelemetryPipeline],
) -> None:
    """A user who flips the switch mid-drain stops it at that report, not after it."""
    write_switch(config_file, True)
    pipeline = make_pipeline()
    for _ in range(3):
        pipeline.record_usage(a_usage_snapshot())

    # The server turns the switch off while answering the first report.
    def handle(request: httpx.Request) -> httpx.Response:
        transport.requests.append(request)
        write_switch(config_file, False)
        return httpx.Response(200)

    pipeline_transport = httpx.MockTransport(handle)
    pipeline = TelemetryPipeline(
        settings=HelperSettings(path=config_file),
        queue=ReportQueue(queue_root),
        machine_identifier=FakeIdentifierSource(),
        endpoints=TEST_ENDPOINTS,
        transport=pipeline_transport,
        clock=FakeClock(),
        sleep=SleepRecorder(),
    )
    write_switch(config_file, True)

    sent = pipeline.flush()

    assert sent == 1
    assert len(transport.requests) == 1
    assert queue_files(queue_root) == []


# --- the two transports ---------------------------------------------------------------------------


def test_an_error_goes_to_glitchtip_over_the_sentry_protocol(
    config_file: Path,
    transport: RecordingTransport,
    make_pipeline: Callable[..., TelemetryPipeline],
) -> None:
    write_switch(config_file, True)
    pipeline = make_pipeline()
    pipeline.record_error(RuntimeError("boom"), intervention="restarted whodunnit")

    assert pipeline.flush() == 1

    request = transport.requests[0]
    assert str(request.url) == "https://errors.innytypes.invalid/api/7/store/"
    assert "sentry_key=fakepublickey0123456789" in request.headers["X-Sentry-Auth"]

    event = transport.bodies[0]
    exception = event["exception"]
    assert isinstance(exception, dict)
    values = exception["values"]
    assert isinstance(values, list)
    assert values[0]["type"] == "RuntimeError"
    # The exception's message is never sent, so the Sentry `value` is deliberately empty.
    assert values[0]["value"] == ""
    assert "boom" not in json.dumps(event)


def test_usage_goes_to_umami_as_a_custom_event_and_never_names_the_machine(
    config_file: Path,
    transport: RecordingTransport,
    make_pipeline: Callable[..., TelemetryPipeline],
) -> None:
    write_switch(config_file, True)
    pipeline = make_pipeline()
    pipeline.record_usage(a_usage_snapshot())

    assert pipeline.flush() == 1

    request = transport.requests[0]
    assert str(request.url) == "https://usage.innytypes.invalid/api/send"
    assert request.headers["User-Agent"] == "innytypes/9.9.9"

    body = transport.bodies[0]
    payload = body["payload"]
    assert isinstance(payload, dict)
    assert body["type"] == "event"
    assert payload["name"] == "usage"
    # The machine's own host name is on the *never sent* list, so every install says the same
    # reserved name here.
    assert payload["hostname"] == "helper.innytypes.invalid"
    data = payload["data"]
    assert isinstance(data, dict)
    assert data["starts"] == 3
    assert data["interventions.restart"] == 4


def test_a_dsn_that_is_not_https_is_refused() -> None:
    with pytest.raises(TelemetryError, match="never sent in the clear"):
        assert GlitchTipTransport(dsn="http://fakekey@errors.innytypes.invalid/7").destination

    with pytest.raises(TelemetryError, match="never sent in the clear"):
        assert UmamiTransport(url="http://usage.innytypes.invalid", website_id="fake-1").destination


def test_a_build_with_no_endpoint_queues_nothing(
    config_file: Path,
    queue_root: Path,
    transport: RecordingTransport,
    make_pipeline: Callable[..., TelemetryPipeline],
) -> None:
    write_switch(config_file, True)
    pipeline = make_pipeline(endpoints=Endpoints())

    assert pipeline.record_usage(a_usage_snapshot()) is None
    assert pipeline.record_error(RuntimeError("boom")) is None
    assert queue_files(queue_root) == []
    assert transport.requests == []


def test_no_report_that_reaches_a_server_carries_anything_from_the_never_sent_list(
    config_file: Path,
    transport: RecordingTransport,
    make_pipeline: Callable[..., TelemetryPipeline],
) -> None:
    """End to end: whatever a caller puts in, what reaches the wire is clean."""
    write_switch(config_file, True)
    pipeline = make_pipeline()
    pipeline.record_usage(
        UsageSnapshot(
            innytypes_version="9.9.9",
            os="Darwin",
            os_version="25.3.0",
            plugins=(InstalledPlugin(id="whodunnit", version="1.0.0", update_mode="auto"),),
            updates={"note": f"{FORBIDDEN_HOME_PATH} and {FAKE_IDENTIFIER}"},
        )
    )
    try:
        raise RuntimeError(f"could not read {FORBIDDEN_API_KEY}")
    except RuntimeError as error:
        pipeline.record_error(error)

    pipeline.flush()

    wire = json.dumps([request.content.decode("utf-8") for request in transport.requests])
    assert [value for value in FORBIDDEN_VALUES if value in wire] == []
    assert FAKE_IDENTIFIER not in wire


# --- background sending ---------------------------------------------------------------------------


class FakeChannel:
    """A host that answers the helper's commands at once, so a restart has a duration of ~0."""

    def __init__(self) -> None:
        self.commands: list[Command] = []

    def send(self, command: Command) -> CommandResult:
        self.commands.append(command)
        return CommandResult(name=command.name)


def test_a_hanging_server_never_delays_a_stabilization_action(
    config_file: Path,
    transport: RecordingTransport,
    make_pipeline: Callable[..., TelemetryPipeline],
) -> None:
    """The acceptance criterion this whole design exists for.

    The telemetry server hangs inside the request. Meanwhile a restart — the stabilization
    action of slice 05 — has to go through, and it has to go through *while* the send is
    stuck, not after it is released.
    """
    write_switch(config_file, True)
    pipeline = make_pipeline()
    transport.hang.clear()  # the server will not answer until this test says so

    pipeline.record_usage(a_usage_snapshot())
    pipeline.start()

    # The sender is now inside the hanging request, holding it.
    assert transport.entered.wait(timeout=5.0), "the background sender never reached the server"

    channel = FakeChannel()
    policy = RestartPolicy(channel=channel, now=lambda: 0.0)
    started = time.monotonic()
    result = policy.restart("whodunnit")
    elapsed = time.monotonic() - started

    assert result.name is CommandName.RESTART
    assert [command.name for command in channel.commands] == [CommandName.RESTART]
    # Not "eventually": the restart took no measurable part of the send's ten-second timeout.
    assert elapsed < 1.0
    # Still stuck: the restart did not wait for the send, and the send is still waiting.
    assert transport.hang.is_set() is False

    transport.hang.set()
    pipeline.stop(timeout=5.0)


def test_reporting_does_not_wait_on_the_server_at_all(
    config_file: Path,
    transport: RecordingTransport,
    make_pipeline: Callable[..., TelemetryPipeline],
) -> None:
    """A caller's cost is one small file and an event, never a socket."""
    write_switch(config_file, True)
    pipeline = make_pipeline()
    transport.hang.clear()

    # No `start()`, so nothing is draining: if `record_*` sent anything itself it would hang
    # here and the test would never finish.
    assert pipeline.record_usage(a_usage_snapshot()) is not None
    assert pipeline.record_error(RuntimeError("boom")) is not None
    assert transport.requests == []

    transport.hang.set()


def test_a_failing_server_backs_off_on_the_injected_sleep(
    config_file: Path,
    queue_root: Path,
    transport: RecordingTransport,
    sleeper: SleepRecorder,
    make_pipeline: Callable[..., TelemetryPipeline],
) -> None:
    write_switch(config_file, True)
    pipeline = make_pipeline(backoff=(1.0, 2.0, 4.0))
    pipeline.record_usage(a_usage_snapshot())
    transport.fail = True

    for _ in range(4):
        assert pipeline.flush() == 0

    # Increasing, and the last delay repeats rather than the policy quietly ending.
    assert sleeper.delays == [1.0, 2.0, 4.0, 4.0]
    # The report is still queued: a failed send is a retry, never a silent loss.
    assert len(queue_files(queue_root)) == 1

    transport.fail = False
    assert pipeline.flush() == 1
    assert queue_files(queue_root) == []


def test_the_sender_drains_the_queue_in_the_background(
    config_file: Path,
    queue_root: Path,
    transport: RecordingTransport,
    make_pipeline: Callable[..., TelemetryPipeline],
) -> None:
    write_switch(config_file, True)
    pipeline = make_pipeline()
    pipeline.record_usage(a_usage_snapshot())
    pipeline.start()

    deadline = threading.Event()
    for _ in range(200):
        if not queue_files(queue_root):
            break
        deadline.wait(0.01)

    assert queue_files(queue_root) == []
    assert len(transport.requests) == 1


def test_stopping_the_sender_twice_is_harmless(
    config_file: Path, make_pipeline: Callable[..., TelemetryPipeline]
) -> None:
    write_switch(config_file, True)
    pipeline = make_pipeline()
    pipeline.start()
    pipeline.start()  # idempotent
    pipeline.stop(timeout=5.0)
    pipeline.stop(timeout=5.0)


# --- the CLI: what the user is shown ------------------------------------------------------


def test_what_show_prints_is_byte_for_byte_what_the_transport_posts(
    config_file: Path,
    transport: RecordingTransport,
    make_pipeline: Callable[..., TelemetryPipeline],
) -> None:
    """D24, taken literally: the shown body and the sent body come from one function.

    Both sides of the comparison are real — the string `show` would print, and the bytes the
    transport actually put on the wire for that same report.
    """
    write_switch(config_file, True)
    pipeline = make_pipeline()
    pipeline.record_usage(a_usage_snapshot())
    queued = pipeline.pending()[0]
    destination, shown = pipeline.describe(queued)

    assert pipeline.flush() == 1

    assert destination == str(transport.requests[0].url)
    assert shown == transport.requests[0].content.decode("utf-8")


def test_telemetry_show_prints_every_queued_report(
    config_file: Path,
    queue_root: Path,
    make_pipeline: Callable[..., TelemetryPipeline],
) -> None:
    write_switch(config_file, True)
    pipeline = make_pipeline()
    pipeline.record_usage(a_usage_snapshot())
    queued = pipeline.pending()[0]

    result = CliRunner().invoke(
        cli,
        ["telemetry", "--config", str(config_file), "--queue", str(queue_root), "show"],
    )

    assert result.exit_code == 0, result.output
    assert f"usage report #{queued.sequence}" in result.output
    # The machine id and the counters are there to be read: `show` hides nothing that would
    # be sent. This repository's build has no endpoint, so the destination says so plainly
    # and the report is printed as the payload it is.
    assert str(queued.payload["machine_id"]) in result.output
    assert "this build has no endpoint" in result.output


def test_telemetry_show_says_plainly_when_the_real_queue_is_empty(
    config_file: Path, queue_root: Path
) -> None:
    write_switch(config_file, True)

    result = CliRunner().invoke(
        cli,
        ["telemetry", "--config", str(config_file), "--queue", str(queue_root), "show"],
    )

    assert result.exit_code == 0, result.output
    assert "No reports are queued." in result.output


def test_telemetry_show_after_off_shows_an_empty_queue_because_it_is_empty(
    config_file: Path,
    queue_root: Path,
    make_pipeline: Callable[..., TelemetryPipeline],
) -> None:
    write_switch(config_file, True)
    pipeline = make_pipeline()
    pipeline.record_usage(a_usage_snapshot())
    assert len(queue_files(queue_root)) == 1

    runner = CliRunner()
    assert runner.invoke(cli, ["telemetry", "--config", str(config_file), "off"]).exit_code == 0
    result = runner.invoke(
        cli, ["telemetry", "--config", str(config_file), "--queue", str(queue_root), "show"]
    )

    assert "No reports are queued." in result.output
    assert queue_files(queue_root) == []


# --- the first-launch question and its privacy notice --------------------------------------


def test_the_question_is_unanswered_only_before_it_is_answered(config_file: Path) -> None:
    settings = HelperSettings(path=config_file)
    write_switch(config_file, None)
    assert question_is_unanswered(settings)

    answer_first_launch_question(settings, enabled=False)

    assert not question_is_unanswered(settings)
    assert not settings.telemetry.may_send


def test_the_privacy_notice_says_what_d25_requires_it_to_say() -> None:
    assert "90 days" in PRIVACY_NOTICE
    assert "13 months" in PRIVACY_NOTICE
    assert "GDPR" in PRIVACY_NOTICE
    assert "pseudonymous personal data" in PRIVACY_NOTICE
    # And the never-sent list, in the words a person would recognise.
    for phrase in (
        "Anytype content",
        "API key",
        "contents of any file",
        "transcripts",
        "environment variables",
        "home directory",
        "user name",
        "host name",
        "raw identifier",
    ):
        assert phrase in PRIVACY_NOTICE, phrase


def test_telemetry_status_shows_the_notice_while_the_question_is_unanswered(
    config_file: Path,
) -> None:
    write_switch(config_file, None)

    result = CliRunner().invoke(cli, ["telemetry", "--config", str(config_file), "status"])

    assert "has not been answered yet" in result.output
    assert "GDPR" in result.output


def test_telemetry_status_does_not_repeat_the_notice_once_answered(config_file: Path) -> None:
    write_switch(config_file, True)

    result = CliRunner().invoke(cli, ["telemetry", "--config", str(config_file), "status"])

    assert "Telemetry: on" in result.output
    assert "GDPR" not in result.output
