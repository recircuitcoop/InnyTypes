"""A plugin's `secret` settings: where they live, and every place they must not appear.

The failure this file exists to prevent is one string reaching one place it should not: a
settings file, a log record, an exception message, a `repr`, or a telemetry report. Each of
those is asserted directly, and each assertion is paired with a **canary** — a test that
plants the same value somewhere unprotected and proves the check would have caught it.

Nothing here touches the real per-user config directory or the real Anytype key location:
every store in this file is rooted at `tmp_path`, and the one test that looks at the real
location does path arithmetic without creating anything.
"""

from __future__ import annotations

import json
import logging
import os
import stat
from collections.abc import Sequence
from pathlib import Path

import pytest

from innytypes.addons import secrets as secrets_module
from innytypes.addons.manifest import SettingsField, parse_settings
from innytypes.addons.secrets import (
    SECRET_DIRECTORY_MODE,
    SECRET_FILE_MODE,
    PluginSecretError,
    SecretStore,
    default_secrets_root,
    secret_is_set_for,
    secret_states,
    store_secret,
)
from innytypes.addons.settings import USER, PluginAvailability, SettingsStore
from innytypes.anytype_mcp.config import DEFAULT_KEY_FILE
from innytypes.helper.telemetry import REDACTED
from innytypes.helper.telemetry import redact as redact_payload

# The value that must never turn up anywhere. The word "fake" is on this line deliberately:
# it is the marker tests/test_no_secrets.py reads to tell a placeholder from a real leak.
SECRET = "fake-plugin-secret-0f1e2d3c4b5a6978"

# A second one, for the tests that need two plugins or two fields.
OTHER_SECRET = "fake-plugin-secret-abcdef9876543210"

# Two more, each written by exactly one test below. The credential redactor is a registry
# for the life of the process, so a value another test has already registered would make a
# test of "storing it registers it" pass without the storing doing anything at all. These
# two are stored nowhere else in this file, which is what keeps those two tests honest.
REDACTOR_ONLY_SECRET = "fake-plugin-secret-only-for-the-log-test"
TELEMETRY_ONLY_SECRET = "fake-plugin-secret-only-for-the-report-test"
REFUSAL_ONLY_SECRET = "fake-plugin-secret-only-for-the-partition-test"

ADDON_ID = "monty"


# --- the declaration these tests are written against ------------------------------------------


def declaration() -> tuple[SettingsField, ...]:
    """One ordinary field and one secret, which is the shape every test below needs."""
    return parse_settings(
        [
            {"id": "folder", "type": "path", "label": "Folder", "kind": "folder"},
            {"id": "token", "type": "secret", "label": "API token", "written_by": "both"},
        ]
    )


def store_at(root: Path) -> SecretStore:
    return SecretStore(root=root)


def mode_of(path: Path) -> int:
    return stat.S_IMODE(path.lstat().st_mode)


# --- the real settings store, wired to the real secret store ------------------------------------
#
# The store for ordinary values is slice 02's, and it is the one used here rather than a
# stand-in: "the secret is not in the settings file" is only worth asserting against the file
# that is actually written. The two are wired together the way the form will wire them — the
# settings store asks `secret_is_set_for` whether a required secret has been answered, and
# nothing else passes between them.


def wired(tmp_path: Path) -> tuple[SettingsStore, SecretStore]:
    store = store_at(tmp_path / "secrets")
    settings = SettingsStore(
        ADDON_ID,
        declaration(),
        path=tmp_path / "plugins" / f"{ADDON_ID}.toml",
        secret_is_set=secret_is_set_for(ADDON_ID, store),
    )
    return settings, store


# --- where a secret is stored --------------------------------------------------------------


def test_the_secrets_directory_sits_beside_the_anytype_key() -> None:
    """D6: a file per secret, beside the Anytype key. Path arithmetic only — nothing is made."""
    root = default_secrets_root()

    assert root.parent == DEFAULT_KEY_FILE.parent
    assert root.name == "secrets"
    assert root.is_absolute()


def test_a_secret_is_written_to_its_own_file_and_never_to_the_settings_file(
    tmp_path: Path,
) -> None:
    """Acceptance 1: the settings file's full content has no trace of the value."""
    settings, store = wired(tmp_path)

    settings.write({"folder": "/srv/notes"}, by=USER)
    outcome = store_secret(
        declaration(), addon_id=ADDON_ID, field_id="token", value=SECRET, store=store
    )

    assert outcome.accepted

    # The whole file, as bytes and as text: a secret hiding in an encoding this read did not
    # try would be a secret this assertion missed.
    written = settings.path.read_text(encoding="utf-8")
    assert SECRET not in written
    assert SECRET.encode("utf-8") not in settings.path.read_bytes()
    assert "/srv/notes" in written

    # ... and it really was stored, in a file of its own.
    secret_file = store.path_for(ADDON_ID, "token")
    assert secret_file.read_text(encoding="utf-8") == SECRET
    assert [entry.name for entry in secret_file.parent.iterdir()] == ["token"]


def test_the_settings_store_itself_refuses_to_record_a_secret(tmp_path: Path) -> None:
    """The other half of the same rule: there is no way to put one there by asking nicely."""
    settings, _store = wired(tmp_path)

    outcome = settings.write({"token": SECRET}, by=USER)

    assert not outcome.accepted
    assert [problem.field for problem in outcome.refused] == ["token"]
    assert SECRET not in outcome.refused[0].reason
    assert not settings.path.exists()


def test_the_settings_file_check_can_fail(tmp_path: Path) -> None:
    """The canary for the test above: a settings file that *did* hold it is caught."""
    settings_file = tmp_path / "leaky.toml"
    settings_file.write_text(f'[values]\ntoken = "{SECRET}"\n', encoding="utf-8")

    assert SECRET in settings_file.read_text(encoding="utf-8")


def test_each_secret_field_gets_a_file_of_its_own(tmp_path: Path) -> None:
    store = store_at(tmp_path / "secrets")

    store.write(ADDON_ID, "token", SECRET)
    store.write(ADDON_ID, "refresh-token", OTHER_SECRET)

    assert store.read(ADDON_ID, "token") == SECRET
    assert store.read(ADDON_ID, "refresh-token") == OTHER_SECRET
    assert sorted(entry.name for entry in (tmp_path / "secrets" / ADDON_ID).iterdir()) == [
        "refresh-token",
        "token",
    ]


def test_two_plugins_do_not_share_a_secret(tmp_path: Path) -> None:
    store = store_at(tmp_path / "secrets")

    store.write(ADDON_ID, "token", SECRET)

    assert store.read("whodunnit", "token") is None
    assert not store.is_set("whodunnit", "token")


# --- the mode, and the canary that proves the mode check can fail -------------------------------


def test_the_secret_file_is_owner_only_the_moment_it_exists(tmp_path: Path) -> None:
    """Acceptance 2: 0600 on the file, 0700 on the directory, asserted right after the write."""
    store = store_at(tmp_path / "secrets")

    path = store.write(ADDON_ID, "token", SECRET)

    assert mode_of(path) == SECRET_FILE_MODE == 0o600
    assert mode_of(path.parent) == SECRET_DIRECTORY_MODE == 0o700
    assert mode_of(path.parent.parent) == SECRET_DIRECTORY_MODE


def test_the_mode_check_can_fail(tmp_path: Path) -> None:
    """The canary: a file written the ordinary way is not 0600, so the check above bites."""
    ordinary = tmp_path / "ordinary"
    ordinary.write_text(SECRET, encoding="utf-8")

    assert mode_of(ordinary) != SECRET_FILE_MODE


def test_a_wider_mode_on_an_existing_file_is_tightened_by_the_next_write(tmp_path: Path) -> None:
    """A forced overwrite must not inherit a mode somebody widened."""
    store = store_at(tmp_path / "secrets")
    path = store.write(ADDON_ID, "token", SECRET)
    os.chmod(path, 0o644)

    store.write(ADDON_ID, "token", OTHER_SECRET)

    assert mode_of(path) == SECRET_FILE_MODE


def test_a_directory_somebody_widened_is_tightened_by_the_next_write(tmp_path: Path) -> None:
    store = store_at(tmp_path / "secrets")
    path = store.write(ADDON_ID, "token", SECRET)
    os.chmod(path.parent, 0o755)

    store.write(ADDON_ID, "token", OTHER_SECRET)

    assert mode_of(path.parent) == SECRET_DIRECTORY_MODE


# --- reading: set or not set, never the value ---------------------------------------------------


def test_reading_a_plugins_settings_reports_a_secret_as_set_and_never_its_value(
    tmp_path: Path,
) -> None:
    """Acceptance 3: the round trip reports the field as set, with no value in the result."""
    settings, store = wired(tmp_path)

    settings.write({"folder": "/srv/notes"}, by=USER)
    store_secret(declaration(), addon_id=ADDON_ID, field_id="token", value=SECRET, store=store)

    recorded = settings.read()
    states = secret_states(declaration(), addon_id=ADDON_ID, store=store)

    assert states == {"token": True}
    # Everything the read side hands anybody: the values a plugin gets, the values the form
    # draws, and the set-ness beside the password field.
    assert SECRET not in json.dumps(
        {"values": dict(recorded.values), "recorded": dict(recorded.recorded), "secrets": states}
    )
    assert "token" not in recorded.values
    assert "token" not in recorded.recorded


def test_an_unset_secret_is_reported_as_not_set(tmp_path: Path) -> None:
    _settings, store = wired(tmp_path)

    assert secret_states(declaration(), addon_id=ADDON_ID, store=store) == {"token": False}


def test_clearing_a_secret_makes_the_form_say_it_is_no_longer_set(tmp_path: Path) -> None:
    store = store_at(tmp_path / "secrets")
    fields = declaration()
    store.write(ADDON_ID, "token", SECRET)

    assert secret_states(fields, addon_id=ADDON_ID, store=store) == {"token": True}
    assert store.clear(ADDON_ID, "token") is True
    assert secret_states(fields, addon_id=ADDON_ID, store=store) == {"token": False}
    assert store.clear(ADDON_ID, "token") is False


def test_a_secret_somebody_pasted_into_the_settings_file_is_never_handed_back(
    tmp_path: Path,
) -> None:
    """Fail closed: nothing this host writes can put a secret in that file, so one that is
    there was typed in by hand — and it is still not what a reader is given."""
    settings, store = wired(tmp_path)
    settings.path.parent.mkdir(parents=True, exist_ok=True)
    settings.path.write_text(
        f'[values]\nfolder = "/srv/notes"\ntoken = "{SECRET}"\n', encoding="utf-8"
    )

    recorded = settings.read()
    states = secret_states(declaration(), addon_id=ADDON_ID, store=store)

    assert states == {"token": False}
    assert SECRET not in json.dumps(
        {"values": dict(recorded.values), "recorded": dict(recorded.recorded), "secrets": states}
    )


def test_the_host_can_still_read_a_secret_for_the_addon_that_owns_it(tmp_path: Path) -> None:
    """The one way back to a value: `store.read`, which slice 05 hands to the owning addon."""
    store = store_at(tmp_path / "secrets")
    store.write(ADDON_ID, "token", SECRET)

    assert store.read(ADDON_ID, "token") == SECRET


# --- nothing renders it: logs, exceptions, reprs -------------------------------------------------


def leaked_records(caplog: pytest.LogCaptureFixture) -> list[str]:
    """Every captured record that carries the secret, rendered the way a handler would."""
    found = [record.getMessage() for record in caplog.records if SECRET in record.getMessage()]
    if SECRET in caplog.text:
        found.append(caplog.text)
    return found


def test_a_full_write_read_clear_cycle_logs_no_secret(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """Acceptance 4, the log half: the whole life of a secret, with every record inspected."""
    caplog.set_level(logging.DEBUG)
    store = store_at(tmp_path / "secrets")

    store.write(ADDON_ID, "token", SECRET)
    store.read(ADDON_ID, "token")
    store.is_set(ADDON_ID, "token")
    store.clear(ADDON_ID, "token")
    store.clear_addon(ADDON_ID)

    assert caplog.records, "the cycle logged nothing at all, so this proved nothing"
    assert leaked_records(caplog) == []


def test_the_log_leak_check_can_fail(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    """The canary: the same check, against a logger that has no redactor on it."""
    caplog.set_level(logging.DEBUG)
    store = store_at(tmp_path / "secrets")
    store.write(ADDON_ID, "token", SECRET)

    logging.getLogger("tests.unprotected").warning("the token is %s", SECRET)

    assert leaked_records(caplog) != []


def test_a_secret_logged_through_this_packages_logger_is_redacted(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """The mechanism behind the test above: writing registers the value with the redactor."""
    caplog.set_level(logging.DEBUG)
    store = store_at(tmp_path / "secrets")
    store.write(ADDON_ID, "token", REDACTOR_ONLY_SECRET)

    secrets_module.log.warning("the token is %s", REDACTOR_ONLY_SECRET)

    assert REDACTOR_ONLY_SECRET not in caplog.text
    assert REDACTED in caplog.text


def test_a_secret_is_unrenderable_even_when_the_write_it_was_meant_for_never_happens(
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The gap between reading a form and storing it is still a gap. A secret is registered
    with the redactor as soon as it is recognised as one, so a refusal, a traceback or a debug
    line between there and the file cannot render it.

    The refusal used here is a field id the *manifest* allows — its rule is "a non-empty
    string" — and the store will not turn into a file name, so nothing is written at all.
    """
    caplog.set_level(logging.DEBUG)
    store = store_at(tmp_path / "secrets")
    fields = parse_settings([{"id": "My Token", "type": "secret", "label": "API token"}])

    outcome = store_secret(
        fields,
        addon_id=ADDON_ID,
        field_id="My Token",
        value=REFUSAL_ONLY_SECRET,
        store=store,
    )
    secrets_module.log.warning("about to store %s", REFUSAL_ONLY_SECRET)

    assert not outcome.accepted
    assert REFUSAL_ONLY_SECRET not in outcome.refused[0].reason
    assert not (tmp_path / "secrets").exists()
    assert REFUSAL_ONLY_SECRET not in caplog.text
    assert REDACTED in caplog.text


@pytest.mark.parametrize(
    ("addon_id", "field_id"),
    [
        (ADDON_ID, "../../../../tmp/escaped"),
        (ADDON_ID, "/etc/cron.d/evil"),
        ("../../monty", "token"),
    ],
)
def test_no_exception_message_repeats_a_secret(
    tmp_path: Path, addon_id: str, field_id: str
) -> None:
    """Acceptance 4, the exception half: a refused write names the id, never the value."""
    store = store_at(tmp_path / "secrets")

    with pytest.raises(PluginSecretError) as raised:
        store.write(addon_id, field_id, SECRET)

    assert SECRET not in str(raised.value)
    assert SECRET not in repr(raised.value)


def test_an_operating_system_failure_is_reported_without_the_secret(tmp_path: Path) -> None:
    """The other error path: the directory cannot be made, because a file is in its way."""
    blocked = tmp_path / "secrets"
    blocked.write_text("not a directory", encoding="utf-8")
    store = store_at(blocked)

    with pytest.raises(PluginSecretError) as raised:
        store.write(ADDON_ID, "token", SECRET)

    assert SECRET not in str(raised.value)
    assert str(blocked) in str(raised.value)


@pytest.mark.parametrize(
    ("field_id", "value"),
    [
        ("not-declared", SECRET),
        ("folder", SECRET),
        ("token", 17),
        ("token", "   "),
    ],
)
def test_a_refused_secret_is_reported_by_field_without_its_value(
    tmp_path: Path, field_id: str, value: object
) -> None:
    """Every refusal answers in the settings store's own shape, and none repeats the value."""
    _settings, store = wired(tmp_path)

    outcome = store_secret(
        declaration(), addon_id=ADDON_ID, field_id=field_id, value=value, store=store
    )

    assert not outcome.accepted
    assert [problem.field for problem in outcome.refused] == [field_id]
    assert str(value) not in outcome.refused[0].reason or not isinstance(value, str)
    assert SECRET not in outcome.refused[0].reason
    assert not store.is_set(ADDON_ID, field_id)


def test_the_exception_leak_check_can_fail() -> None:
    """The canary: an exception that does repeat a value is caught by the same check."""
    careless = ValueError(f"could not store {SECRET}")

    assert SECRET in str(careless)


def test_no_repr_of_a_settings_object_carries_a_secret(tmp_path: Path) -> None:
    """Acceptance 4, the repr half: every object either store hands anybody after a save."""
    settings, store = wired(tmp_path)
    settings.write({"folder": "/srv/notes"}, by=USER)
    outcome = store_secret(
        declaration(), addon_id=ADDON_ID, field_id="token", value=SECRET, store=store
    )
    recorded = settings.read()

    rendered = " ".join(
        [
            repr(store),
            str(store),
            repr(settings),
            repr(outcome),
            repr(recorded),
            str(recorded.hold),
            repr(secret_states(declaration(), addon_id=ADDON_ID, store=store)),
        ]
    )

    assert SECRET not in rendered
    # The field is still named, or a reader cannot tell "hidden" from "absent".
    assert "token" in rendered


def test_the_repr_leak_check_can_fail() -> None:
    """The canary: an ordinary container does render what it holds."""
    assert SECRET in repr({"token": SECRET})


# --- telemetry: plugin settings are on the never-sent list ---------------------------------------

# The spellings a caller would reach for when reporting anything about a plugin's settings.
SETTINGS_KEYS = (
    "settings",
    "plugin_settings",
    "setting_values",
    "settings_value",
    "config",
    "configuration",
    "field_values",
    "value",
)


@pytest.mark.parametrize("key", SETTINGS_KEYS)
def test_a_plugin_settings_value_is_stripped_from_a_telemetry_payload(key: str) -> None:
    """Acceptance 5: the never-sent list covers plugin settings, secret or ordinary."""
    sentinel = "SENTINEL-SETTING-THAT-NO-OTHER-RULE-WOULD-CATCH"

    redacted = redact_payload({key: sentinel, "nested": {key: sentinel}})

    assert redacted[key] == REDACTED
    assert sentinel not in json.dumps(redacted)


def test_the_telemetry_key_check_can_fail() -> None:
    """The canary for the table above: a key that is not on the list keeps its value."""
    sentinel = "SENTINEL-SETTING-THAT-NO-OTHER-RULE-WOULD-CATCH"

    assert redact_payload({"starts": sentinel})["starts"] == sentinel


def test_a_stored_secret_is_stripped_from_a_telemetry_payload_wherever_it_hides(
    tmp_path: Path,
) -> None:
    """Planted in a report under a key the name rule would *not* catch, and still removed —
    because storing it registered it with the one credential registry telemetry consults."""
    store = store_at(tmp_path / "secrets")
    store.write(ADDON_ID, "token", TELEMETRY_ONLY_SECRET)

    redacted = redact_payload(
        {
            "intervention": f"restarted after {TELEMETRY_ONLY_SECRET} was rejected",
            "starts": 3,
            "stack": [f"tried {TELEMETRY_ONLY_SECRET}"],
        }
    )

    assert TELEMETRY_ONLY_SECRET not in json.dumps(redacted)
    assert REDACTED in str(redacted["intervention"])
    # The report is still a report: a redactor that emptied everything would prove nothing.
    assert redacted["starts"] == 3


def test_the_planted_secret_check_can_fail(tmp_path: Path) -> None:
    """The canary: the same payload, with a value nothing has registered, keeps it."""
    unregistered = "fake-plugin-secret-never-registered-1234"

    redacted = redact_payload({"intervention": f"restarted after {unregistered} was rejected"})

    assert unregistered in json.dumps(redacted)


# --- overwriting, atomically -----------------------------------------------------------------


def test_overwriting_replaces_the_file_whole(tmp_path: Path) -> None:
    """Acceptance 6: the old content is gone, not appended to and not partly overwritten."""
    store = store_at(tmp_path / "secrets")
    long_first = SECRET + "-and-then-a-great-deal-more-text-besides"
    store.write(ADDON_ID, "token", long_first)

    path = store.write(ADDON_ID, "token", "x")

    assert path.read_text(encoding="utf-8") == "x"
    assert mode_of(path) == SECRET_FILE_MODE


def test_overwriting_leaves_no_scratch_file_behind(tmp_path: Path) -> None:
    store = store_at(tmp_path / "secrets")
    store.write(ADDON_ID, "token", SECRET)

    store.write(ADDON_ID, "token", OTHER_SECRET)

    assert [entry.name for entry in (tmp_path / "secrets" / ADDON_ID).iterdir()] == ["token"]


def test_an_interrupted_write_leaves_the_old_secret_intact(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The rename is what makes the write atomic, so a failure at the rename must be a
    write that did not happen — not half of one."""
    store = store_at(tmp_path / "secrets")
    store.write(ADDON_ID, "token", SECRET)

    def refuse(source: object, destination: object) -> None:
        raise OSError(5, "input/output error")

    monkeypatch.setattr(secrets_module.os, "replace", refuse)

    with pytest.raises(PluginSecretError) as raised:
        store.write(ADDON_ID, "token", OTHER_SECRET)

    assert store.read(ADDON_ID, "token") == SECRET
    assert OTHER_SECRET not in str(raised.value)
    # Nothing half-written was left lying about, at any mode.
    assert [entry.name for entry in (tmp_path / "secrets" / ADDON_ID).iterdir()] == ["token"]


def test_a_scratch_file_never_holds_the_secret_at_a_wider_mode(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The scratch file is the window an overwrite opens; it is 0600 for its whole life."""
    store = store_at(tmp_path / "secrets")
    seen: list[int] = []

    real_replace = secrets_module.os.replace

    def watch(source: object, destination: object) -> None:
        seen.append(mode_of(Path(str(source))))
        real_replace(source, destination)  # type: ignore[arg-type]

    monkeypatch.setattr(secrets_module.os, "replace", watch)
    store.write(ADDON_ID, "token", SECRET)

    assert seen == [SECRET_FILE_MODE]


# --- what the store refuses --------------------------------------------------------------------


@pytest.mark.parametrize(
    "field_id",
    [
        "",
        ".",
        "..",
        "../token",
        "../../../../etc/passwd",
        "/etc/passwd",
        "a/b",
        "a\\b",
        "Token",
        "to ken",
        "token\x00",
        "-token",
        "token-",
        "tok--en",
    ],
)
def test_a_field_id_that_could_name_another_file_is_refused(tmp_path: Path, field_id: str) -> None:
    """A field id becomes a file name, so it is checked as one — the manifest's own rule for
    a field id is only "a non-empty string"."""
    root = tmp_path / "secrets"
    store = store_at(root)

    with pytest.raises(PluginSecretError, match="field id"):
        store.write(ADDON_ID, field_id, SECRET)

    assert not root.exists() or list(root.rglob("*")) == []
    assert SECRET not in _everything_under(tmp_path)


@pytest.mark.parametrize("addon_id", ["", "..", "../monty", "Monty", "monty/x", "monty_x"])
def test_an_addon_id_that_is_not_an_addon_id_is_refused(tmp_path: Path, addon_id: str) -> None:
    root = tmp_path / "secrets"
    store = store_at(root)

    with pytest.raises(PluginSecretError, match="addon id"):
        store.write(addon_id, "token", SECRET)

    assert SECRET not in _everything_under(tmp_path)


def test_the_traversal_check_can_fail(tmp_path: Path) -> None:
    """The canary: the same sweep does find a value written outside the store's root."""
    (tmp_path / "escaped").write_text(SECRET, encoding="utf-8")

    assert SECRET in _everything_under(tmp_path)


def _everything_under(root: Path) -> str:
    """Every readable byte under ``root``, as text, for the traversal assertions above."""
    chunks: list[str] = []
    for path in sorted(root.rglob("*")):
        if path.is_file() and not path.is_symlink():
            chunks.append(path.read_text(encoding="utf-8", errors="replace"))
    return "\n".join(chunks)


def test_an_empty_secret_is_refused(tmp_path: Path) -> None:
    """An empty file reads as "configured" and fails at the far end; clearing is the gesture."""
    store = store_at(tmp_path / "secrets")

    with pytest.raises(PluginSecretError, match="empty"):
        store.write(ADDON_ID, "token", "   ")

    assert not store.is_set(ADDON_ID, "token")


def test_a_secret_is_stored_without_the_whitespace_around_it(tmp_path: Path) -> None:
    store = store_at(tmp_path / "secrets")

    store.write(ADDON_ID, "token", f"  {SECRET}\n")

    assert store.read(ADDON_ID, "token") == SECRET


def test_a_repeatable_secret_has_no_single_file_to_live_in(tmp_path: Path) -> None:
    """`list of secret` parses — the vocabulary allows it — but one file per secret cannot
    hold a list, so it is refused rather than given a format invented for credentials."""
    fields = parse_settings([{"id": "tokens", "type": "list of secret", "label": "API tokens"}])
    store = store_at(tmp_path / "secrets")

    outcome = store_secret(
        fields, addon_id=ADDON_ID, field_id="tokens", value=[SECRET], store=store
    )

    assert not outcome.accepted
    assert "one file per value" in outcome.refused[0].reason
    assert SECRET not in outcome.refused[0].reason


def test_a_symlink_where_a_secret_file_belongs_is_not_followed(tmp_path: Path) -> None:
    """Reading through a planted link would hand the addon some other file's contents."""
    store = store_at(tmp_path / "secrets")
    store.write(ADDON_ID, "token", SECRET)
    elsewhere = tmp_path / "elsewhere"
    elsewhere.write_text("somebody else's file", encoding="utf-8")

    path = store.path_for(ADDON_ID, "token")
    path.unlink()
    path.symlink_to(elsewhere)

    assert store.is_set(ADDON_ID, "token") is False
    with pytest.raises(PluginSecretError, match="not a regular file"):
        store.read(ADDON_ID, "token")


def test_a_write_over_a_symlink_replaces_the_link_not_its_target(tmp_path: Path) -> None:
    store = store_at(tmp_path / "secrets")
    store.write(ADDON_ID, "token", SECRET)
    elsewhere = tmp_path / "elsewhere"
    elsewhere.write_text("somebody else's file", encoding="utf-8")

    path = store.path_for(ADDON_ID, "token")
    path.unlink()
    path.symlink_to(elsewhere)
    store.write(ADDON_ID, "token", OTHER_SECRET)

    assert not path.is_symlink()
    assert elsewhere.read_text(encoding="utf-8") == "somebody else's file"
    assert store.read(ADDON_ID, "token") == OTHER_SECRET


# --- clearing everything a plugin had (D8) -------------------------------------------------------


def test_removing_a_plugin_removes_every_secret_it_had(tmp_path: Path) -> None:
    store = store_at(tmp_path / "secrets")
    store.write(ADDON_ID, "token", SECRET)
    store.write(ADDON_ID, "refresh-token", OTHER_SECRET)
    store.write("whodunnit", "token", OTHER_SECRET)

    removed = store.clear_addon(ADDON_ID)

    assert removed == 2
    assert not (tmp_path / "secrets" / ADDON_ID).exists()
    assert SECRET not in _everything_under(tmp_path)
    # The other plugin is untouched.
    assert store.read("whodunnit", "token") == OTHER_SECRET


def test_removing_a_plugin_that_had_no_secrets_is_not_an_error(tmp_path: Path) -> None:
    store = store_at(tmp_path / "secrets")

    assert store.clear_addon(ADDON_ID) == 0


# --- the two halves of one save ----------------------------------------------------------------


def test_a_secret_field_is_never_recorded_by_the_settings_store(tmp_path: Path) -> None:
    """The division of labour, stated once: that store refuses this type, this one takes it."""
    settings, store = wired(tmp_path)

    refused = settings.write({"token": SECRET}, by=USER)
    accepted = store_secret(
        declaration(), addon_id=ADDON_ID, field_id="token", value=SECRET, store=store
    )

    assert not refused.accepted
    assert accepted.recorded == ("token",)


def test_an_ordinary_field_is_never_recorded_by_the_secret_store(tmp_path: Path) -> None:
    _settings, store = wired(tmp_path)

    outcome = store_secret(
        declaration(), addon_id=ADDON_ID, field_id="folder", value="/srv/notes", store=store
    )

    assert not outcome.accepted
    assert "not a secret" in outcome.refused[0].reason


def test_a_plugin_may_store_its_own_secret(tmp_path: Path) -> None:
    """F2, and the reason D11 exists: an authorisation completed at run time has a value the
    plugin must keep, and this is where it keeps it."""
    fields = parse_settings(
        [{"id": "token", "type": "secret", "label": "T", "written_by": "plugin"}]
    )
    store = store_at(tmp_path / "secrets")

    outcome = store_secret(fields, addon_id=ADDON_ID, field_id="token", value=SECRET, store=store)

    assert outcome.accepted
    assert store.is_set(ADDON_ID, "token")


def test_a_required_secret_holds_the_plugin_disabled_until_it_is_stored(tmp_path: Path) -> None:
    """The one thing the settings store asks this one, wired the way the form will wire it
    (F1): a required secret with nothing recorded is a reason, not a silent default."""
    store = store_at(tmp_path / "secrets")
    fields = parse_settings(
        [{"id": "token", "type": "secret", "label": "API token", "required": True}]
    )
    settings = SettingsStore(
        ADDON_ID,
        fields,
        path=tmp_path / "plugins" / f"{ADDON_ID}.toml",
        secret_is_set=secret_is_set_for(ADDON_ID, store),
    )

    held = settings.read()
    assert held.availability is PluginAvailability.HELD
    assert held.hold is not None
    assert "token" in held.hold.reason
    assert SECRET not in held.hold.reason

    store_secret(fields, addon_id=ADDON_ID, field_id="token", value=SECRET, store=store)

    cleared = settings.read()
    assert cleared.availability is PluginAvailability.ENABLED
    assert cleared.hold is None


def _field_ids(fields: Sequence[SettingsField]) -> list[str]:
    return [field.id for field in fields]


def test_the_declaration_these_tests_use_is_the_one_the_manifest_parses() -> None:
    """A guard on the fixture itself: if the declaration stops parsing, every test above is
    testing something other than what a plugin can actually declare."""
    assert _field_ids(declaration()) == ["folder", "token"]
    assert declaration()[1].type == "secret"


def test_an_empty_secret_file_reads_as_nothing_stored(tmp_path: Path) -> None:
    """A file somebody truncated is "not set", not "set to the empty string"."""
    store = store_at(tmp_path / "secrets")
    path = store.write(ADDON_ID, "token", SECRET)
    path.write_bytes(b"")

    assert store.read(ADDON_ID, "token") is None
    assert store.is_set(ADDON_ID, "token") is False


def test_a_secret_file_that_is_not_text_is_refused_without_repeating_its_bytes(
    tmp_path: Path,
) -> None:
    """Whatever is in there was not written by this store, and it is not decoded into a
    message on the way out."""
    store = store_at(tmp_path / "secrets")
    path = store.write(ADDON_ID, "token", SECRET)
    path.write_bytes(b"\xff\xfe\x00not text at all")

    with pytest.raises(PluginSecretError, match="not UTF-8 text"):
        store.read(ADDON_ID, "token")


def test_a_directory_where_a_secret_file_belongs_is_refused(tmp_path: Path) -> None:
    store = store_at(tmp_path / "secrets")
    path = store.write(ADDON_ID, "token", SECRET)
    path.unlink()
    path.mkdir()

    assert store.is_set(ADDON_ID, "token") is False
    with pytest.raises(PluginSecretError, match="not a regular file"):
        store.read(ADDON_ID, "token")


def test_removing_a_plugin_leaves_behind_anything_this_store_did_not_write(
    tmp_path: Path,
) -> None:
    """Removal deletes the secrets it wrote. A link or a directory somebody else put there is
    neither deleted nor counted, and it keeps the directory alive rather than being followed."""
    store = store_at(tmp_path / "secrets")
    store.write(ADDON_ID, "token", SECRET)
    elsewhere = tmp_path / "elsewhere"
    elsewhere.write_text("somebody else's file", encoding="utf-8")
    directory = tmp_path / "secrets" / ADDON_ID
    (directory / "planted").symlink_to(elsewhere)

    removed = store.clear_addon(ADDON_ID)

    assert removed == 1
    assert not (directory / "token").exists()
    assert (directory / "planted").is_symlink()
    assert elsewhere.read_text(encoding="utf-8") == "somebody else's file"
