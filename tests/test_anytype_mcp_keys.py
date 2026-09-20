"""Obtaining the Anytype API key and storing it where only its owner can read it.

Three things are being kept true here, and each of them is the kind that quietly stops
being true: the command that is run is the **pinned** one, the stored file is readable by
nobody but its owner, and the credential never reaches a stream, a log or an exception
message on the way through.

Nothing in this file runs ``npx`` or touches the network. The runner is injected exactly
like ``Supervisor.spawn`` is (docs/loop/SKILL.md, "the gate is hermetic"), and every key
file is written under ``tmp_path`` — never under the real ``~/.config/innytypes``.
"""

from __future__ import annotations

import logging
import stat
import sys
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path

import httpx
import pytest
from click.testing import CliRunner, Result

from innytypes import cli as cli_module
from innytypes import logs
from innytypes.anytype_mcp import keys
from innytypes.anytype_mcp.config import PACKAGE_NAME, PACKAGE_VERSION
from innytypes.cli import cli

# Obviously-fake credentials. The word "fake" on the same line is what tells the scanner in
# tests/test_no_secrets.py that these are placeholders rather than a leak.
FAKE_ACQUIRED_KEY = "fake-acquired-anytype-key-abc123"  # fake
FAKE_STORED_KEY = "fake-stored-anytype-key-def456"  # fake
FAKE_UNREDACTED_KEY = "fake-never-registered-key-ghi789"  # fake
FAKE_CANARY_KEY = "fake-canary-key-jkl012"  # fake


def get_key_output(key: str) -> str:
    """What ``@anyproto/anytype-mcp@1.2.10`` prints on a successful ``get-key``.

    Reproduced from that version's ``src/auth/get-key.ts``: a preamble, the key on its own
    marked line, and a settings snippet that carries the key a second time inside a
    ``Bearer`` header. Both copies matter — a storing path that leaks would leak either.
    """
    return "\n".join(
        [
            "Starting authentication to get API key...",
            "Please check Anytype Desktop for the 4-digit code",
            "Authenticated successfully!",
            "",
            "Your API KEY: " + key,
            "",
            "Add this to your MCP settings file as:",
            '  "OPENAPI_MCP_HEADERS": "{\\"Authorization\\":\\"Bearer ' + key + '\\"}"',
            "",
        ]
    )


@dataclass
class FakeRunner:
    """A ``get-key`` runner that records its call instead of launching a process."""

    result: keys.GetKeyResult | None = None
    error: Exception | None = None
    calls: list[tuple[list[str], dict[str, str]]] = field(default_factory=list)

    def __call__(self, argv: Sequence[str], env: Mapping[str, str]) -> keys.GetKeyResult:
        self.calls.append((list(argv), dict(env)))
        if self.error is not None:
            raise self.error
        assert self.result is not None, "a FakeRunner needs either a result or an error"
        return self.result


def succeeding_runner(key: str = FAKE_ACQUIRED_KEY) -> FakeRunner:
    return FakeRunner(result=keys.GetKeyResult(0, get_key_output(key), ""))


def rendered(record: logging.LogRecord) -> str:
    """Everything a handler could print from ``record``, as one string."""
    parts = [record.getMessage(), str(record.msg), str(record.args)]
    if record.exc_text:
        parts.append(record.exc_text)
    return "\n".join(parts)


def leak_sources(
    key: str,
    out: str,
    err: str,
    records: list[logging.LogRecord],
) -> list[str]:
    """Every place ``key`` survived: the captured streams, then each log record."""
    found: list[str] = []
    if key in out:
        found.append("stdout")
    if key in err:
        found.append("stderr")
    found.extend(f"log:{record.name}" for record in records if key in rendered(record))
    return found


def leaks(
    key: str,
    capsys: pytest.CaptureFixture[str],
    caplog: pytest.LogCaptureFixture,
) -> list[str]:
    """``leak_sources`` over what pytest captured for the test that calls it."""
    captured = capsys.readouterr()
    return leak_sources(key, captured.out, captured.err, caplog.records)


def mode_of(path: Path) -> int:
    return stat.S_IMODE(path.stat().st_mode)


# --- the pinned command -------------------------------------------------------------------


def test_the_command_names_get_key_at_the_exact_pinned_version() -> None:
    argv = keys.get_key_command()

    assert argv == ["npx", "-y", f"{PACKAGE_NAME}@{PACKAGE_VERSION}", "get-key"]
    # A floating tag would resolve to whatever npm publishes next, and the key it produces
    # would be for a server the host never tested against.
    assert "latest" not in " ".join(argv)
    assert PACKAGE_VERSION in argv[2]


def test_pairing_starts_with_anytype_and_stores_the_key_owner_only(tmp_path: Path) -> None:
    requests: list[httpx.Request] = []

    def answer(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path.endswith("/challenges"):
            return httpx.Response(201, json={"challenge_id": "challenge-1"})
        return httpx.Response(201, json={"api_key": FAKE_ACQUIRED_KEY})

    with httpx.Client(transport=httpx.MockTransport(answer)) as client:
        session = keys.start_pairing(client)
        path = keys.complete_pairing(session, "1234", client, key_file=tmp_path / "anytype_api_key")

    assert [request.url.path for request in requests] == [
        "/v1/auth/challenges",
        "/v1/auth/api_keys",
    ]
    assert b'"app_name":"InnyTypes"' in requests[0].content
    assert b'"challenge_id":"challenge-1"' in requests[1].content
    assert b'"code":"1234"' in requests[1].content
    assert mode_of(path) == 0o600
    assert path.read_text(encoding="utf-8") == FAKE_ACQUIRED_KEY


def test_pairing_refuses_anything_other_than_four_digits(tmp_path: Path) -> None:
    called = False

    def answer(request: httpx.Request) -> httpx.Response:
        nonlocal called
        called = True
        return httpx.Response(500)

    with (
        httpx.Client(transport=httpx.MockTransport(answer)) as client,
        pytest.raises(keys.KeyAcquisitionError, match="four-digit"),
    ):
        keys.complete_pairing(
            keys.PairingSession("challenge-1"),
            "12x4",
            client,
            key_file=tmp_path / "anytype_api_key",
        )

    assert not called
    assert not (tmp_path / "anytype_api_key").exists()


def test_running_get_key_invokes_that_exact_argv() -> None:
    runner = succeeding_runner()

    keys.run_get_key(runner)

    argv, _ = runner.calls[0]
    assert argv[-1] == "get-key"
    assert f"{PACKAGE_NAME}@{PACKAGE_VERSION}" in argv


def test_the_child_is_pointed_at_the_configured_anytype(monkeypatch: pytest.MonkeyPatch) -> None:
    # get-key fetches Anytype's OpenAPI spec before it authenticates, and it finds it
    # through ANYTYPE_API_BASE_URL. It also needs the inherited PATH to find node at all.
    monkeypatch.setenv("PATH", "/usr/bin")
    runner = succeeding_runner()

    keys.run_get_key(runner, api_base_url="http://127.0.0.1:31012")

    _, env = runner.calls[0]
    assert env["ANYTYPE_API_BASE_URL"] == "http://127.0.0.1:31012"
    assert env["PATH"] == "/usr/bin"


# --- the stored file ----------------------------------------------------------------------


def test_the_key_file_is_readable_by_nobody_but_its_owner(tmp_path: Path) -> None:
    path = keys.store_api_key(FAKE_STORED_KEY, tmp_path / "anytype_api_key")

    assert path.stat().st_mode & 0o077 == 0
    assert mode_of(path) == 0o600
    assert path.read_text(encoding="utf-8") == FAKE_STORED_KEY


def test_the_parent_directory_is_created_owner_only(tmp_path: Path) -> None:
    path = tmp_path / "config" / "innytypes" / "anytype_api_key"

    keys.store_api_key(FAKE_STORED_KEY, path)

    assert mode_of(path.parent) == 0o700


def test_an_existing_directory_is_left_as_its_owner_made_it(tmp_path: Path) -> None:
    # ~/.config is not this function's to re-permission; only the directory it creates is.
    existing = tmp_path / "config"
    existing.mkdir(mode=0o755)

    keys.store_api_key(FAKE_STORED_KEY, existing / "anytype_api_key")

    assert mode_of(existing) == 0o755


def test_the_stored_key_is_what_load_api_key_reads_back(tmp_path: Path) -> None:
    from innytypes.anytype_mcp.config import load_api_key

    path = keys.store_api_key(FAKE_STORED_KEY, tmp_path / "anytype_api_key")

    assert load_api_key(env={}, key_file=path) == FAKE_STORED_KEY


def test_an_empty_key_is_never_stored(tmp_path: Path) -> None:
    path = tmp_path / "anytype_api_key"

    with pytest.raises(keys.UnusableKeyError):
        keys.store_api_key("   ", path)

    assert not path.exists()


# --- refusing to overwrite ----------------------------------------------------------------


def test_an_existing_key_file_is_not_replaced(tmp_path: Path) -> None:
    path = keys.store_api_key(FAKE_STORED_KEY, tmp_path / "anytype_api_key")
    original = path.read_bytes()

    with pytest.raises(keys.KeyFileExistsError):
        keys.store_api_key(FAKE_ACQUIRED_KEY, path)

    assert path.read_bytes() == original


def test_acquisition_refuses_before_the_user_authenticates(tmp_path: Path) -> None:
    # Refused up front: a flow that makes someone walk through Anytype's challenge and then
    # throws the result away is a flow they will run twice.
    path = keys.store_api_key(FAKE_STORED_KEY, tmp_path / "anytype_api_key")
    runner = succeeding_runner()

    with pytest.raises(keys.KeyFileExistsError):
        keys.acquire_api_key(runner, key_file=path)

    assert runner.calls == []
    assert path.read_text(encoding="utf-8") == FAKE_STORED_KEY


def test_the_key_is_never_written_through_a_symlink(tmp_path: Path) -> None:
    # The cheapest way to get a key out of an owner-only directory is to make the key path
    # point somewhere else. Even --force refuses, and the link's target stays as it was.
    target = tmp_path / "somewhere_readable"
    target.write_text("not a key", encoding="utf-8")
    link = tmp_path / "anytype_api_key"
    link.symlink_to(target)

    with pytest.raises(keys.KeyAcquisitionError):
        keys.store_api_key(FAKE_STORED_KEY, link, force=True)

    assert target.read_text(encoding="utf-8") == "not a key"


def test_force_replaces_the_key_and_tightens_a_loose_mode(tmp_path: Path) -> None:
    # A file somebody created by hand with `>` is world-readable; replacing it must not
    # inherit that mode, which truncation alone would.
    path = tmp_path / "anytype_api_key"
    path.write_text("older-key", encoding="utf-8")
    path.chmod(0o644)

    keys.acquire_api_key(succeeding_runner(), key_file=path, force=True)

    assert path.read_text(encoding="utf-8") == FAKE_ACQUIRED_KEY
    assert mode_of(path) == 0o600


# --- the key never escapes ----------------------------------------------------------------


def test_storing_a_key_prints_it_nowhere(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)

    keys.store_api_key(FAKE_STORED_KEY, tmp_path / "anytype_api_key")

    assert leaks(FAKE_STORED_KEY, capsys, caplog) == []


def test_the_whole_acquisition_prints_the_key_nowhere(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)

    keys.acquire_api_key(succeeding_runner(), key_file=tmp_path / "anytype_api_key")

    assert leaks(FAKE_ACQUIRED_KEY, capsys, caplog) == []


def test_the_leak_check_can_fail(
    capsys: pytest.CaptureFixture[str], caplog: pytest.LogCaptureFixture
) -> None:
    """The canary. A leak check that cannot fail proves nothing, so this one leaks on purpose.

    The literal below is never handed to :func:`~innytypes.logs.protect`, and
    the logger is a bare one without the package's redactor — so both halves of
    :func:`leak_sources` are exercised against a credential nothing is protecting.
    """
    caplog.set_level(logging.DEBUG)

    sys.stdout.write(FAKE_CANARY_KEY + "\n")
    logging.getLogger("innytypes.anytype_mcp.canary").warning("leaked %s", FAKE_CANARY_KEY)

    assert leaks(FAKE_CANARY_KEY, capsys, caplog) == [
        "stdout",
        "log:innytypes.anytype_mcp.canary",
    ]


def test_the_storing_path_never_even_tries_to_log_the_key(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], caplog: pytest.LogCaptureFixture
) -> None:
    """Redaction is the net, not the plan: unhook it and the key still reaches no record."""
    caplog.set_level(logging.DEBUG)
    keys.log.removeFilter(logs.REDACTOR)
    try:
        keys.store_api_key(FAKE_UNREDACTED_KEY, tmp_path / "anytype_api_key")

        assert leaks(FAKE_UNREDACTED_KEY, capsys, caplog) == []
    finally:
        keys.log.addFilter(logs.REDACTOR)


def test_a_key_is_registered_with_the_redactor_the_moment_it_is_read() -> None:
    # Before it is stored, before it is returned: run_get_key is public, and a caller that
    # only wants the key still gets one this package's loggers know to remove.
    keys.run_get_key(succeeding_runner("fake-read-key-pqr678"))

    assert logs.redact("key=fake-read-key-pqr678") == f"key={logs.REDACTED}"


def test_an_acquired_key_is_registered_with_the_redactor(tmp_path: Path) -> None:
    # Every structure that carries the key inherits plan 0002's obligation, and the way it
    # is discharged is registration — not each call site remembering.
    keys.acquire_api_key(succeeding_runner("fake-registered-key-mno345"), key_file=tmp_path / "k")

    assert logs.redact("key=fake-registered-key-mno345") == f"key={logs.REDACTED}"


def test_the_runners_result_does_not_show_the_key_in_its_repr() -> None:
    result = keys.GetKeyResult(0, get_key_output(FAKE_ACQUIRED_KEY), "")

    assert FAKE_ACQUIRED_KEY not in repr(result)


# --- failure modes ------------------------------------------------------------------------


def test_a_missing_npx_is_reported_as_such() -> None:
    runner = FakeRunner(error=FileNotFoundError(2, "No such file or directory", "npx"))

    with pytest.raises(keys.GetKeyUnavailableError) as excinfo:
        keys.run_get_key(runner)

    assert "npx" in str(excinfo.value)


def test_the_default_runner_reports_a_missing_binary_without_node() -> None:
    # Exercises the real subprocess call while launching nothing: the binary does not
    # exist, so the failure happens in exec, before any child could produce output.
    with pytest.raises(FileNotFoundError):
        keys._default_run_get_key(["innytypes-no-such-binary-4c1f"], {})


def test_a_failed_get_key_names_the_exit_code_and_repeats_no_output(tmp_path: Path) -> None:
    # get-key exits 1 when Anytype is not reachable or the code was wrong — and its output
    # at that point may still contain a partially printed credential.
    runner = FakeRunner(result=keys.GetKeyResult(1, get_key_output(FAKE_ACQUIRED_KEY), "boom"))
    path = tmp_path / "anytype_api_key"

    with pytest.raises(keys.GetKeyFailedError) as excinfo:
        keys.acquire_api_key(runner, key_file=path)

    message = str(excinfo.value)
    assert "1" in message
    assert FAKE_ACQUIRED_KEY not in message
    assert "boom" not in message
    assert not path.exists()


def test_empty_output_is_refused(tmp_path: Path) -> None:
    runner = FakeRunner(result=keys.GetKeyResult(0, "   \n", ""))
    path = tmp_path / "anytype_api_key"

    with pytest.raises(keys.UnusableKeyError):
        keys.acquire_api_key(runner, key_file=path)

    assert not path.exists()


def test_garbage_output_is_refused_without_being_quoted(tmp_path: Path) -> None:
    garbage = f"npm ERR! could not determine executable to run {FAKE_ACQUIRED_KEY}"
    runner = FakeRunner(result=keys.GetKeyResult(0, garbage, ""))
    path = tmp_path / "anytype_api_key"

    with pytest.raises(keys.UnusableKeyError) as excinfo:
        keys.acquire_api_key(runner, key_file=path)

    assert FAKE_ACQUIRED_KEY not in str(excinfo.value)
    assert not path.exists()


def test_a_bare_key_on_stdout_is_still_read(tmp_path: Path) -> None:
    # The marked line is what 1.2.10 prints, but a lone key is unambiguous and accepting
    # it costs nothing.
    runner = FakeRunner(result=keys.GetKeyResult(0, f"  {FAKE_ACQUIRED_KEY}\n", ""))

    path = keys.acquire_api_key(runner, key_file=tmp_path / "anytype_api_key")

    assert path.read_text(encoding="utf-8") == FAKE_ACQUIRED_KEY


def test_every_named_failure_is_a_config_error() -> None:
    # A caller that already handles "the server cannot be configured" handles these too.
    from innytypes.anytype_mcp.config import ConfigError

    for error in (
        keys.GetKeyUnavailableError,
        keys.GetKeyFailedError,
        keys.UnusableKeyError,
        keys.KeyFileExistsError,
    ):
        assert issubclass(error, ConfigError)


# --- the command a user actually types ----------------------------------------------------


def invoke(args: list[str]) -> Result:
    return CliRunner().invoke(cli, args)


def _acquire_with(runner: FakeRunner) -> Callable[..., Path]:
    """``acquire_api_key`` with the subprocess runner replaced, for the CLI to call.

    The CLI owns the default runner, so this is where a CLI test keeps npx out of the
    gate: same function, same arguments, a fake process behind it.
    """

    def acquire(*, key_file: Path | None = None, force: bool = False) -> Path:
        return keys.acquire_api_key(runner, key_file=key_file, force=force)

    return acquire


def test_the_cli_exposes_get_key_as_an_explicit_command() -> None:
    # Explicit, never implicit: nothing acquires a key at startup (docs/loop/SKILL.md,
    # invariant 6). The user asks for it.
    result = invoke(["anytype-mcp", "get-key", "--help"])

    assert result.exit_code == 0
    assert "--force" in result.output


def test_the_cli_stores_the_key_and_reports_only_where(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    path = tmp_path / "anytype_api_key"
    monkeypatch.setattr(cli_module, "acquire_api_key", _acquire_with(succeeding_runner()))

    result = invoke(["anytype-mcp", "get-key", "--key-file", str(path)])

    assert result.exit_code == 0
    assert str(path) in result.output
    assert mode_of(path) == 0o600
    assert leak_sources(FAKE_ACQUIRED_KEY, result.output, "", caplog.records) == []


def test_the_cli_reports_a_refusal_instead_of_a_traceback(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = keys.store_api_key(FAKE_STORED_KEY, tmp_path / "anytype_api_key")
    monkeypatch.setattr(cli_module, "acquire_api_key", _acquire_with(succeeding_runner()))

    result = invoke(["anytype-mcp", "get-key", "--key-file", str(path)])

    assert result.exit_code == 1
    assert "--force" in result.output
    assert path.read_text(encoding="utf-8") == FAKE_STORED_KEY


def test_the_cli_passes_force_through(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = keys.store_api_key(FAKE_STORED_KEY, tmp_path / "anytype_api_key")
    monkeypatch.setattr(cli_module, "acquire_api_key", _acquire_with(succeeding_runner()))

    result = invoke(["anytype-mcp", "get-key", "--key-file", str(path), "--force"])

    assert result.exit_code == 0
    assert path.read_text(encoding="utf-8") == FAKE_ACQUIRED_KEY
