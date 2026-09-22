"""The configuration contract: the header JSON, the version pins, and key handling."""

from __future__ import annotations

import json
import logging
from pathlib import Path

import pytest

from innytypes.anytype_mcp import config as config_module
from innytypes.anytype_mcp.config import (
    ANYTYPE_VERSION,
    API_KEY_ENV_VAR,
    DEFAULT_API_BASE_URL,
    PACKAGE_NAME,
    ConfigError,
    ServerConfig,
    load_api_key,
    load_config,
)
from test_anytype_mcp_keys import leaks

# Obviously-fake, and deliberately short enough not to look like a credential to the
# secret scanner in tests/test_no_secrets.py.
FAKE_KEY = "test-key"

# Two more, and distinct from each other on purpose: a precedence test whose two files hold
# the same string cannot say which of them was read. The word "fake" on the line is what
# tells tests/test_no_secrets.py these are placeholders.
FAKE_CANONICAL_KEY = "fake-canonical-anytype-key-stu234"  # fake
FAKE_LEGACY_KEY = "fake-legacy-anytype-key-vwx567"  # fake


def test_openapi_mcp_headers_matches_the_servers_contract() -> None:
    config = ServerConfig(api_key=FAKE_KEY)

    decoded = json.loads(config.openapi_mcp_headers())

    assert decoded == {
        "Authorization": f"Bearer {FAKE_KEY}",
        "Anytype-Version": ANYTYPE_VERSION,
    }


def test_environment_carries_both_variables_the_server_reads() -> None:
    config = ServerConfig(api_key=FAKE_KEY)

    env = config.environment(base={"PATH": "/usr/bin"})

    assert env["PATH"] == "/usr/bin"
    assert env["ANYTYPE_API_BASE_URL"] == DEFAULT_API_BASE_URL
    assert json.loads(env["OPENAPI_MCP_HEADERS"])["Anytype-Version"] == ANYTYPE_VERSION


def test_inherited_headers_cannot_shadow_the_configured_credential() -> None:
    config = ServerConfig(api_key=FAKE_KEY)

    env = config.environment(base={"OPENAPI_MCP_HEADERS": "{}"})

    assert json.loads(env["OPENAPI_MCP_HEADERS"])["Authorization"] == f"Bearer {FAKE_KEY}"


def test_package_spec_pins_an_exact_version() -> None:
    config = ServerConfig(api_key=FAKE_KEY, package_version="1.2.10")

    assert config.package_spec == f"{PACKAGE_NAME}@1.2.10"
    assert "latest" not in config.package_spec


def test_repr_never_leaks_the_api_key() -> None:
    # A supervisor logs its config when a child dies; the credential must not ride along.
    #
    # The literal carries "fake" on purpose: it is long enough to trip the credential
    # scanner in tests/test_no_secrets.py, and that marker is what tells the scanner this
    # is a placeholder. Renaming it to something that looks like a real key turns the gate
    # red — which is the scanner doing its job, not a bug to work around.
    fake_key = "fake-key-that-must-never-reach-a-log"
    config = ServerConfig(api_key=fake_key)

    assert fake_key not in repr(config)


def test_empty_key_is_refused_at_construction() -> None:
    with pytest.raises(ConfigError):
        ServerConfig(api_key="")


def test_key_comes_from_the_environment_first() -> None:
    assert load_api_key(env={API_KEY_ENV_VAR: FAKE_KEY}) == FAKE_KEY


def test_key_falls_back_to_a_file_outside_the_repo(tmp_path) -> None:  # type: ignore[no-untyped-def]
    key_file = tmp_path / "api_key"
    key_file.write_text(f"  {FAKE_KEY}\n", encoding="utf-8")

    assert load_api_key(env={}, key_file=key_file) == FAKE_KEY


def test_legacy_key_is_a_read_only_fallback(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    canonical = tmp_path / "canonical" / "anytype_api_key"
    legacy = tmp_path / "legacy" / "anytype_api_key"
    legacy.parent.mkdir()
    legacy.write_text(FAKE_KEY, encoding="utf-8")
    monkeypatch.setattr(config_module, "DEFAULT_KEY_FILE", canonical)

    assert load_api_key(env={}, legacy_key_file=legacy) == FAKE_KEY
    assert legacy.read_text(encoding="utf-8") == FAKE_KEY
    assert not canonical.exists()


def test_the_canonical_key_wins_and_the_legacy_one_reaches_nothing(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Both files exist: the documented path is the answer, and the other value goes nowhere.

    Precedence, not refusal — which is what separates this from the test below it. The
    legacy path is a read-only compatibility fallback for a machine that has not been
    migrated (plan 0007, *Key-path compatibility*), and a fallback that can win when the
    canonical file is present is not a fallback: the application would then say a key lives
    in one place and build a host from another, which is the disagreement slice 01 exists
    to end.

    The two values are distinct so "the canonical one won" is a fact rather than an
    assumption, and the one this test hunts for afterwards is the *legacy* one — the
    canonical key is registered with the redactor by :class:`ServerConfig` the moment it is
    read, so a leak of it would be masked, and a leak of the value nothing is protecting
    would not be.
    """
    caplog.set_level(logging.DEBUG)
    canonical = tmp_path / "canonical" / "anytype_api_key"
    legacy = tmp_path / "legacy" / "anytype_api_key"
    canonical.parent.mkdir()
    legacy.parent.mkdir()
    canonical.write_text(FAKE_CANONICAL_KEY, encoding="utf-8")
    legacy.write_text(FAKE_LEGACY_KEY, encoding="utf-8")
    monkeypatch.setattr(config_module, "DEFAULT_KEY_FILE", canonical)

    key = load_api_key(env={}, legacy_key_file=legacy)
    config = ServerConfig(api_key=key)

    assert key == FAKE_CANONICAL_KEY

    # Configuration: everything the child is handed, and everything a log line could render
    # of the structure that holds it.
    assert FAKE_LEGACY_KEY not in config.openapi_mcp_headers()
    assert FAKE_LEGACY_KEY not in json.dumps(config.environment(base={}))
    assert FAKE_LEGACY_KEY not in repr(config)

    # Output and logs, by the same leak check the key tests use.
    assert leaks(FAKE_LEGACY_KEY, capsys, caplog) == []

    # Read-only in both directions: neither file changed and none was created, so the
    # canonical path did not quietly acquire a copy of the legacy value either.
    assert canonical.read_text(encoding="utf-8") == FAKE_CANONICAL_KEY
    assert legacy.read_text(encoding="utf-8") == FAKE_LEGACY_KEY
    assert {path.relative_to(tmp_path).as_posix() for path in tmp_path.rglob("*")} == {
        "canonical",
        "canonical/anytype_api_key",
        "legacy",
        "legacy/anytype_api_key",
    }


def test_an_explicit_key_file_never_falls_through_to_legacy(tmp_path) -> None:
    legacy = tmp_path / "legacy-key"
    legacy.write_text(FAKE_KEY, encoding="utf-8")

    with pytest.raises(ConfigError):
        load_api_key(env={}, key_file=tmp_path / "missing", legacy_key_file=legacy)


def test_missing_key_names_both_places_it_could_come_from(tmp_path) -> None:  # type: ignore[no-untyped-def]
    with pytest.raises(ConfigError) as excinfo:
        load_api_key(env={}, key_file=tmp_path / "absent")

    message = str(excinfo.value)
    assert API_KEY_ENV_VAR in message
    assert "absent" in message


def test_base_url_is_overridable_for_anytype_cli(tmp_path) -> None:  # type: ignore[no-untyped-def]
    config = load_config(
        env={API_KEY_ENV_VAR: FAKE_KEY, "ANYTYPE_API_BASE_URL": "http://localhost:31012"},
        key_file=tmp_path / "absent",
    )

    assert config.api_base_url == "http://localhost:31012"
