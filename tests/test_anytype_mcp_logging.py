"""The API key never reaches a log record, and the proof that this is not a coincidence.

Plan 0002 puts it plainly: the useful thing to print when the child dies is the environment
it was launched with, and that environment is exactly where the key lives. So the supervisor
does print it, and this file is what keeps that safe. The last test in the redaction section
unhooks the redactor and asserts the key *does* escape — an acceptance check that cannot
fail proves nothing, and this one can.
"""

from __future__ import annotations

import logging
from collections.abc import Callable

import pytest

from conftest import FAKE_KEY, SupervisorHarness
from innytypes.anytype_mcp import logs
from innytypes.anytype_mcp import supervisor as supervisor_module
from innytypes.anytype_mcp.config import ServerConfig

MakeSupervisor = Callable[..., SupervisorHarness]


def rendered(record: logging.LogRecord) -> str:
    """Everything a handler could print from ``record``, as one string.

    Not just ``getMessage()``: a record also carries the unrendered template, its
    arguments and any traceback a formatter has already produced, and a credential that
    survives in any of them has survived.
    """
    parts = [record.getMessage(), str(record.msg), str(record.args)]
    if record.exc_text:
        parts.append(record.exc_text)
    return "\n".join(parts)


def run_a_full_cycle(harness: SupervisorHarness) -> None:
    """Start the child, let it die on its own, then stop the supervisor over the corpse."""
    process = harness.supervisor.start()
    process.exit_with(70)
    harness.supervisor.stop()


# --- redaction --------------------------------------------------------------------------


def test_a_full_cycle_logs_something(
    make_supervisor: MakeSupervisor, caplog: pytest.LogCaptureFixture
) -> None:
    # Guards every other test here: "no record contained the key" is trivially true of a
    # module that logs nothing at all.
    caplog.set_level(logging.DEBUG)
    harness = make_supervisor()

    run_a_full_cycle(harness)

    messages = [record.getMessage() for record in caplog.records]
    assert any("starting" in message for message in messages)
    assert any("exited" in message for message in messages)
    assert any("stopping" in message for message in messages)


def test_a_full_cycle_never_logs_the_credential(
    make_supervisor: MakeSupervisor, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    harness = make_supervisor()

    run_a_full_cycle(harness)

    for record in caplog.records:
        text = rendered(record)
        assert FAKE_KEY not in text
        assert harness.config.openapi_mcp_headers() not in text


def test_the_exit_report_shows_the_launch_environment_with_the_key_removed(
    make_supervisor: MakeSupervisor, caplog: pytest.LogCaptureFixture
) -> None:
    # This is the record that would leak. It has to stay useful after redaction, or the
    # next person to debug a dying child deletes the redaction instead of the log line.
    caplog.set_level(logging.DEBUG)
    harness = make_supervisor()

    run_a_full_cycle(harness)

    exits = [record.getMessage() for record in caplog.records if "exited" in record.getMessage()]
    assert len(exits) == 1
    assert "OPENAPI_MCP_HEADERS" in exits[0]
    assert logs.REDACTED in exits[0]
    assert harness.config.api_base_url in exits[0]
    assert "70" in exits[0]


def test_without_the_redactor_the_same_cycle_leaks_the_credential(
    make_supervisor: MakeSupervisor, caplog: pytest.LogCaptureFixture
) -> None:
    """Prove the test above can fail. Unhook the redactor and the key comes straight out."""
    caplog.set_level(logging.DEBUG)
    harness = make_supervisor()
    supervisor_module.log.removeFilter(logs.REDACTOR)
    try:
        run_a_full_cycle(harness)
        assert any(FAKE_KEY in rendered(record) for record in caplog.records)
    finally:
        supervisor_module.log.addFilter(logs.REDACTOR)


def test_the_inherited_environment_is_never_logged(
    make_supervisor: MakeSupervisor,
    caplog: pytest.LogCaptureFixture,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The child inherits PATH and everything else the host was started with, and the
    # user's own environment is full of credentials that have nothing to do with Anytype.
    # Redaction cannot help with those, because this package has never seen them.
    monkeypatch.setenv("SOME_UNRELATED_TOKEN", "fake-unrelated-secret-value")
    caplog.set_level(logging.DEBUG)
    harness = make_supervisor()

    run_a_full_cycle(harness)

    for record in caplog.records:
        assert "SOME_UNRELATED_TOKEN" not in rendered(record)
        assert "fake-unrelated-secret-value" not in rendered(record)


def test_a_stop_we_asked_for_does_not_print_the_launch_environment(
    make_supervisor: MakeSupervisor, caplog: pytest.LogCaptureFixture
) -> None:
    # A child we terminated needs no diagnosis, so the one record carrying (redacted)
    # credential material stays out of every routine shutdown.
    caplog.set_level(logging.DEBUG)
    harness = make_supervisor()
    harness.supervisor.start()

    harness.supervisor.stop()

    messages = [record.getMessage() for record in caplog.records]
    assert any("exited with code 0" in message for message in messages)
    assert not any("OPENAPI_MCP_HEADERS" in message for message in messages)


# --- the redactor itself ------------------------------------------------------------------


def make_record(message: str, *args: object) -> logging.LogRecord:
    return logging.LogRecord(
        name="innytypes.anytype_mcp.test",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg=message,
        args=args,
        exc_info=None,
    )


def test_a_config_registers_its_key_the_moment_it_is_built() -> None:
    # "By construction" means here: nothing has to remember to call protect().
    config = ServerConfig(api_key="fake-freshly-built-key-2468")

    assert logs.redact(f"key={config.api_key}") == f"key={logs.REDACTED}"


def test_the_redactor_scrubs_a_credential_hidden_in_an_argument() -> None:
    # A log argument can be any object; the credential hides in its str(), not in the
    # template. Rendering the message before scrubbing is what covers that.
    record = make_record("launched with %s", {"OPENAPI_MCP_HEADERS": f"Bearer {FAKE_KEY}"})

    logs.REDACTOR.filter(record)

    assert FAKE_KEY not in rendered(record)
    assert "OPENAPI_MCP_HEADERS" in record.getMessage()


def test_the_redactor_scrubs_an_already_formatted_traceback() -> None:
    record = make_record("the child would not start")
    record.exc_text = f"Traceback (most recent call last):\nRuntimeError: {FAKE_KEY}"

    logs.REDACTOR.filter(record)

    assert record.exc_text is not None
    assert FAKE_KEY not in record.exc_text
    assert logs.REDACTED in record.exc_text


def test_the_redactor_leaves_a_clean_record_alone() -> None:
    # A record with nothing to hide keeps its arguments, so structured handlers still see
    # fields rather than one pre-rendered string.
    record = make_record("exited with code %d", 70)

    logs.REDACTOR.filter(record)

    assert record.args == (70,)
    assert record.getMessage() == "exited with code 70"


def test_the_redactor_keeps_every_record() -> None:
    # A filter that returns False drops the record. Redaction removes credentials, never
    # evidence: a supervisor whose logs vanish is worse than one that logs too much.
    assert logs.REDACTOR.filter(make_record("anything at all")) is True


def test_an_empty_secret_is_refused() -> None:
    # str.replace("") inserts the marker between every character, so an empty secret would
    # not merely be useless — it would destroy every log line in the process.
    logs.protect("")

    assert logs.redact("untouched") == "untouched"


def test_the_redactor_is_installed_once_per_logger() -> None:
    logger = logs.get_logger("innytypes.anytype_mcp.test_idempotence")
    again = logs.get_logger("innytypes.anytype_mcp.test_idempotence")

    assert logger is again
    assert logger.filters.count(logs.REDACTOR) == 1


def test_the_redactor_does_not_print_its_secrets() -> None:
    # The one object in the process whose state is entirely credentials does not get a
    # revealing repr: a debugger, or a log of the logging configuration, would print it.
    assert FAKE_KEY not in repr(logs.REDACTOR)
