"""The configuration contract: the header JSON, the version pins, and key handling."""

from __future__ import annotations

import json

import pytest

from anytype_mcp.config import (
    ANYTYPE_VERSION,
    API_KEY_ENV_VAR,
    DEFAULT_API_BASE_URL,
    PACKAGE_NAME,
    ConfigError,
    ServerConfig,
    load_api_key,
    load_config,
)

# Obviously-fake, and deliberately short enough not to look like a credential to the
# secret scanner in tests/test_no_secrets.py.
FAKE_KEY = "test-key"


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
