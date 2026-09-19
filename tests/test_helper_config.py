"""The helper's `config.toml`: the defaults, the three-state telemetry switch, live re-read.

Every test writes its own configuration file into `tmp_path` and points the loader or the CLI
at it with `--config`. Nothing here reads or writes the real per-user config directory, opens
a socket, spawns a process or sleeps — the one test that touches
:func:`~innytypes.helper.config.default_config_path` only compares paths.

The substance of this slice is what the loader **refuses** and what it **does not confuse**,
so most of what follows breaks exactly one key and asserts the refusal names it, or sets a
switch through the CLI and asserts a loader that was constructed *before* the change sees the
new value.
"""

from __future__ import annotations

from pathlib import Path
from textwrap import dedent

import pytest
from click.testing import CliRunner, Result
from platformdirs import user_config_path

from innytypes.addons.manifest import StabilityProfile
from innytypes.cli import cli
from innytypes.helper.config import (
    APPLICATION_NAME,
    CONFIG_FILENAME,
    DEFAULT_MAX_CHILDREN,
    OFFICIAL_SOURCE_NAME,
    CatalogueSource,
    HelperConfig,
    HelperConfigError,
    HelperSettings,
    Telemetry,
    UpdateMode,
    _dump_value,  # the writer's last refusal, asserted below
    default_config_path,
    load_helper_config,
)

# A configuration that sets every section, so a test can prove one write left the rest alone.
FULL_CONFIG = """
    telemetry = false
    launch_at_login = true
    auto_check_versions = false

    [update]
    channel = "beta"
    check_interval = 3600
    check_jitter = 60

    [plugins]
    update_mode = "auto"

    [plugins.whodunnit]
    update_mode = "manual"
    pinned = true

    [plugins.monty]
    pinned = false

    [helper]
    tick = 2
    stop_timeout = 30
    update_health_window = 45

    [helper.restart]
    max_attempts = 3
    backoff = [0.5, 1, 2]

    [helper.breaker]
    max_interventions = 9
    window = 300

    [helper.defaults]
    max_rss_mb = 512
    max_cpu_percent = 50
    cpu_window = 30
    max_open_files = 256
    max_children = 8
    breach_grace = 15
    """


def write_config(path: Path, text: str) -> Path:
    """Write one configuration file, so no test depends on a fixture outside itself."""
    path.write_text(dedent(text).lstrip(), encoding="utf-8")
    return path


def config_path(tmp_path: Path) -> Path:
    """Where this test's configuration file lives — never the real one."""
    return tmp_path / CONFIG_FILENAME


def run(*args: str) -> Result:
    """Invoke the console entry point in-process."""
    return CliRunner().invoke(cli, list(args))


# --- defaults ------------------------------------------------------------------------------


def test_missing_file_yields_the_documented_defaults(tmp_path: Path) -> None:
    # A first launch has no configuration file, and that is not an error: it is the state the
    # whole first-launch story (plan 0003 F2) is written for.
    path = config_path(tmp_path)
    assert not path.exists()

    config = load_helper_config(path)

    assert config == HelperConfig()
    assert config.telemetry is Telemetry.UNSET
    assert config.auto_check_versions is True
    assert config.launch_at_login is False
    assert config.plugins.update_mode is UpdateMode.MANUAL
    # Reading must never create the file, the directory, or anything else.
    assert not path.exists()


def test_the_default_numbers_are_the_plan_s_numbers(tmp_path: Path) -> None:
    config = load_helper_config(config_path(tmp_path))

    assert config.update.channel == "stable"
    assert config.update.check_interval == 24 * 60 * 60
    assert config.update.check_jitter == 60 * 60
    assert config.helper.tick == 5
    assert config.helper.stop_timeout == 10
    assert config.helper.update_health_window == 2 * 60
    assert config.helper.breaker.max_interventions == 5
    assert config.helper.breaker.window == 10 * 60
    assert config.helper.restart.max_attempts >= 1
    assert config.helper.restart.backoff == tuple(sorted(config.helper.restart.backoff))


def test_helper_wide_stability_defaults_are_the_manifest_s_numbers(tmp_path: Path) -> None:
    # One set of numbers, not two: a plugin that omits `max_rss_mb` and a config that omits
    # `helper.defaults.max_rss_mb` cannot be made to disagree about what the limit is.
    defaults = load_helper_config(config_path(tmp_path)).helper.defaults
    profile = StabilityProfile()

    assert defaults.max_rss_mb == profile.max_rss_mb
    assert defaults.max_cpu_percent == profile.max_cpu_percent
    assert defaults.cpu_window == profile.cpu_window
    assert defaults.max_open_files == profile.max_open_files
    assert defaults.breach_grace == profile.breach_grace
    # The one field a manifest deliberately leaves open: "helper-wide default" (plan 0003).
    assert profile.max_children is None
    assert defaults.max_children == DEFAULT_MAX_CHILDREN


def test_every_documented_key_is_read_from_the_file(tmp_path: Path) -> None:
    config = load_helper_config(write_config(config_path(tmp_path), FULL_CONFIG))

    assert config.telemetry is Telemetry.OFF
    assert config.launch_at_login is True
    assert config.auto_check_versions is False
    assert config.update.channel == "beta"
    assert config.update.check_interval == 3600
    assert config.update.check_jitter == 60
    assert config.plugins.update_mode is UpdateMode.AUTO
    assert config.helper.tick == 2
    assert config.helper.stop_timeout == 30
    assert config.helper.update_health_window == 45
    assert config.helper.restart.max_attempts == 3
    assert config.helper.restart.backoff == (0.5, 1.0, 2.0)
    assert config.helper.breaker.max_interventions == 9
    assert config.helper.breaker.window == 300
    assert config.helper.defaults.max_rss_mb == 512
    assert config.helper.defaults.max_cpu_percent == 50
    assert config.helper.defaults.cpu_window == 30
    assert config.helper.defaults.max_open_files == 256
    assert config.helper.defaults.max_children == 8
    assert config.helper.defaults.breach_grace == 15


def test_the_default_path_is_the_per_user_config_directory() -> None:
    # Compared, never read: the gate may not touch the real config directory.
    assert default_config_path() == user_config_path(APPLICATION_NAME, appauthor=False) / (
        CONFIG_FILENAME
    )


# --- telemetry: unset is not off -----------------------------------------------------------


def test_telemetry_unset_is_neither_on_nor_off(tmp_path: Path) -> None:
    # The whole point of F2: "not yet answered" must be impossible to read as "answered no".
    config = load_helper_config(write_config(config_path(tmp_path), "launch_at_login = true\n"))

    assert config.telemetry is Telemetry.UNSET
    assert config.telemetry is not Telemetry.OFF
    assert config.telemetry.answered is False
    assert config.telemetry.may_send is False


def test_telemetry_off_is_answered_and_silent(tmp_path: Path) -> None:
    config = load_helper_config(write_config(config_path(tmp_path), "telemetry = false\n"))

    assert config.telemetry is Telemetry.OFF
    assert config.telemetry.answered is True
    assert config.telemetry.may_send is False


def test_telemetry_on_is_answered_and_sends(tmp_path: Path) -> None:
    config = load_helper_config(write_config(config_path(tmp_path), "telemetry = true\n"))

    assert config.telemetry is Telemetry.ON
    assert config.telemetry.answered is True
    assert config.telemetry.may_send is True


def test_telemetry_must_be_a_boolean(tmp_path: Path) -> None:
    path = write_config(config_path(tmp_path), 'telemetry = "on"\n')

    with pytest.raises(HelperConfigError) as error:
        load_helper_config(path)

    assert "telemetry" in str(error.value)
    assert str(path) in str(error.value)


# --- live re-read --------------------------------------------------------------------------


def test_settings_reread_the_file_on_every_access(tmp_path: Path) -> None:
    # The discipline every later slice depends on: the helper holds ONE settings object for
    # its whole life and still sees a switch the user flipped a second ago.
    path = config_path(tmp_path)
    settings = HelperSettings(path=path)

    assert settings.telemetry is Telemetry.UNSET
    assert settings.auto_check_versions is True

    write_config(path, "telemetry = true\nauto_check_versions = false\n")

    assert settings.telemetry is Telemetry.ON
    assert settings.auto_check_versions is False

    write_config(path, "telemetry = false\n")

    assert settings.telemetry is Telemetry.OFF
    assert settings.auto_check_versions is True


def test_a_settings_object_predating_the_cli_write_sees_the_new_value(tmp_path: Path) -> None:
    path = config_path(tmp_path)
    settings = HelperSettings(path=path)
    assert settings.telemetry is Telemetry.UNSET

    assert run("telemetry", "--config", str(path), "on").exit_code == 0

    assert settings.telemetry is Telemetry.ON
    # And a loader constructed afterwards agrees — the file, not the object, is the truth.
    assert load_helper_config(path).telemetry is Telemetry.ON


def test_settings_read_launch_at_login_live(tmp_path: Path) -> None:
    path = config_path(tmp_path)
    settings = HelperSettings(path=path)

    assert settings.launch_at_login is False

    write_config(path, "launch_at_login = true\n")

    assert settings.launch_at_login is True


def test_settings_read_plugin_modes_and_pins_live(tmp_path: Path) -> None:
    path = config_path(tmp_path)
    settings = HelperSettings(path=path)

    assert settings.update_mode("whodunnit") is UpdateMode.MANUAL
    assert settings.is_pinned("whodunnit") is False

    write_config(
        path,
        """
        [plugins]
        update_mode = "auto"

        [plugins.whodunnit]
        pinned = true
        """,
    )

    assert settings.update_mode("whodunnit") is UpdateMode.AUTO
    assert settings.is_pinned("whodunnit") is True


# --- the telemetry CLI ---------------------------------------------------------------------


def test_cli_telemetry_on_then_off_round_trips_through_the_file(tmp_path: Path) -> None:
    path = config_path(tmp_path)

    assert run("telemetry", "--config", str(path), "on").exit_code == 0
    assert load_helper_config(path).telemetry is Telemetry.ON

    assert run("telemetry", "--config", str(path), "off").exit_code == 0
    assert load_helper_config(path).telemetry is Telemetry.OFF


def test_cli_telemetry_on_creates_the_file_and_its_directory(tmp_path: Path) -> None:
    path = tmp_path / "nested" / "dir" / CONFIG_FILENAME

    assert run("telemetry", "--config", str(path), "on").exit_code == 0

    assert path.is_file()
    assert load_helper_config(path).telemetry is Telemetry.ON


def test_cli_telemetry_status_distinguishes_unanswered_from_off(tmp_path: Path) -> None:
    path = config_path(tmp_path)

    unanswered = run("telemetry", "--config", str(path), "status")
    assert unanswered.exit_code == 0
    assert "not been answered" in unanswered.output
    # An unanswered switch must not be described with the word the OFF state uses.
    assert "Telemetry: off" not in unanswered.output

    run("telemetry", "--config", str(path), "off")
    answered = run("telemetry", "--config", str(path), "status")
    assert answered.exit_code == 0
    assert "Telemetry: off" in answered.output
    assert "not been answered" not in answered.output

    run("telemetry", "--config", str(path), "on")
    on = run("telemetry", "--config", str(path), "status")
    assert on.exit_code == 0
    assert "Telemetry: on" in on.output


def test_cli_telemetry_show_consults_the_real_queue(tmp_path: Path) -> None:
    # `show` prints the queued reports (D24). Slice 08 built the queue it reads, so an empty
    # answer here is now a queue that was looked at and found empty. `--queue` is passed for
    # the same reason `--config` is: nothing in the gate touches this user's own directories.
    path = config_path(tmp_path)

    result = run("telemetry", "--config", str(path), "--queue", str(tmp_path / "queue"), "show")

    assert result.exit_code == 0
    assert "No reports are queued." in result.output


def test_cli_telemetry_reports_a_broken_file_instead_of_a_traceback(tmp_path: Path) -> None:
    path = write_config(config_path(tmp_path), "telemetry = = true\n")

    result = run("telemetry", "--config", str(path), "status")

    assert result.exit_code != 0
    assert str(path) in result.output
    assert "Traceback" not in result.output


def test_cli_telemetry_on_refuses_to_rewrite_a_file_it_cannot_read(tmp_path: Path) -> None:
    # Rewriting a file we could not parse would silently discard whatever the user wrote.
    original = "telemetry = = true\n"
    path = write_config(config_path(tmp_path), original)

    result = run("telemetry", "--config", str(path), "on")

    assert result.exit_code != 0
    assert path.read_text(encoding="utf-8") == original


def test_cli_telemetry_on_refuses_a_file_holding_a_key_it_does_not_understand(
    tmp_path: Path,
) -> None:
    # Parses as TOML, so only validation catches it. Writing the file back would drop the
    # user's typo'd key and leave them believing a setting is in force.
    original = "telemtry = true\n"
    path = write_config(config_path(tmp_path), original)

    result = run("telemetry", "--config", str(path), "on")

    assert result.exit_code != 0
    assert "telemtry" in result.output
    assert str(path) in result.output
    assert path.read_text(encoding="utf-8") == original


# --- plugin update modes and pins ----------------------------------------------------------


def test_plugin_mode_inherits_the_global_default(tmp_path: Path) -> None:
    config = load_helper_config(
        write_config(
            config_path(tmp_path),
            """
            [plugins]
            update_mode = "auto"

            [plugins.whodunnit]
            pinned = true
            """,
        )
    )

    # No `update_mode` of its own, so it inherits — including for a plugin with no table.
    assert config.update_mode_for("whodunnit") is UpdateMode.AUTO
    assert config.update_mode_for("monty") is UpdateMode.AUTO


def test_plugin_mode_overrides_the_global_default(tmp_path: Path) -> None:
    config = load_helper_config(
        write_config(
            config_path(tmp_path),
            """
            [plugins]
            update_mode = "auto"

            [plugins.whodunnit]
            update_mode = "off"
            """,
        )
    )

    assert config.update_mode_for("whodunnit") is UpdateMode.OFF
    assert config.update_mode_for("monty") is UpdateMode.AUTO


def test_the_global_plugin_mode_defaults_to_manual(tmp_path: Path) -> None:
    # D18: `auto` is a choice made one plugin at a time, never the state you wake up in.
    config = load_helper_config(config_path(tmp_path))

    assert config.update_mode_for("anything-at-all") is UpdateMode.MANUAL


def test_pinned_defaults_to_false(tmp_path: Path) -> None:
    config = load_helper_config(
        write_config(
            config_path(tmp_path),
            """
            [plugins.whodunnit]
            update_mode = "auto"
            """,
        )
    )

    assert config.plugins.is_pinned("whodunnit") is False
    assert config.plugins.is_pinned("monty") is False


def test_cli_addons_pin_and_unpin_round_trip(tmp_path: Path) -> None:
    path = config_path(tmp_path)

    assert run("addons", "--config", str(path), "pin", "whodunnit").exit_code == 0
    assert load_helper_config(path).plugins.is_pinned("whodunnit") is True

    assert run("addons", "--config", str(path), "unpin", "whodunnit").exit_code == 0
    assert load_helper_config(path).plugins.is_pinned("whodunnit") is False


def test_the_written_file_is_one_a_person_can_read(tmp_path: Path) -> None:
    # The user opens this file to edit it by hand, so the writer may not leave a header that
    # says nothing — `[plugins]` above `[plugins.whodunnit]` is valid TOML and pure noise.
    path = config_path(tmp_path)

    assert run("addons", "--config", str(path), "pin", "whodunnit").exit_code == 0

    text = path.read_text(encoding="utf-8")
    assert "[plugins.whodunnit]" in text
    assert "[plugins]" not in text
    # And it still says what it meant.
    assert load_helper_config(path).plugins.is_pinned("whodunnit") is True


def test_cli_addons_pin_leaves_every_other_setting_alone(tmp_path: Path) -> None:
    path = write_config(config_path(tmp_path), FULL_CONFIG)
    before = load_helper_config(path)

    assert run("addons", "--config", str(path), "pin", "monty").exit_code == 0

    after = load_helper_config(path)
    assert after.plugins.is_pinned("monty") is True
    # Everything else survived the rewrite, including the other plugin's own settings.
    assert after.plugins.is_pinned("whodunnit") is True
    assert after.update_mode_for("whodunnit") is UpdateMode.MANUAL
    assert after.telemetry is before.telemetry
    assert after.launch_at_login is before.launch_at_login
    assert after.auto_check_versions is before.auto_check_versions
    assert after.update == before.update
    assert after.helper == before.helper


def test_cli_telemetry_on_leaves_every_other_setting_alone(tmp_path: Path) -> None:
    path = write_config(config_path(tmp_path), FULL_CONFIG)
    before = load_helper_config(path)

    assert run("telemetry", "--config", str(path), "on").exit_code == 0

    after = load_helper_config(path)
    assert after.telemetry is Telemetry.ON
    assert after.plugins == before.plugins
    assert after.helper == before.helper
    assert after.update == before.update
    assert after.launch_at_login == before.launch_at_login


def test_cli_addons_pin_refuses_an_id_that_is_not_an_addon_id(tmp_path: Path) -> None:
    path = config_path(tmp_path)

    result = run("addons", "--config", str(path), "pin", "Who.Dunnit")

    assert result.exit_code != 0
    assert "Who.Dunnit" in result.output
    assert not path.exists()


# --- registered plugin sources, and the switch each one carries (plan 0006, F2) -------------

# A stand-in for the base64 line of a minisign `.pub` file. What `config.toml` checks is the
# shape — one token, no whitespace — never the cryptography, which is
# `innytypes.helper.catalogue`'s to do when the source is actually read.
EXAMPLE_KEY = "an-example-public-key-line"

ACME_URL = "https://acme.example.invalid/catalogue.json"


def test_a_registered_source_round_trips_through_the_config_file(tmp_path: Path) -> None:
    """Written by `add_source`, read back by the same parser a hand-edited file goes through."""
    path = config_path(tmp_path)

    HelperSettings(path=path).add_source("acme", ACME_URL, public_key=EXAMPLE_KEY, auto_update=True)

    assert "[sources.acme]" in path.read_text(encoding="utf-8")
    assert load_helper_config(path).sources == (
        CatalogueSource(name="acme", url=ACME_URL, public_key=EXAMPLE_KEY, auto_update=True),
    )


def test_a_source_registered_with_nothing_optional_round_trips_too(tmp_path: Path) -> None:
    """A keyless source with no opinion about updating: the minimum F1 allows anyone to be."""
    path = config_path(tmp_path)

    HelperSettings(path=path).add_source("acme", ACME_URL)

    source = load_helper_config(path).source_for("acme")
    assert source == CatalogueSource(name="acme", url=ACME_URL)
    assert source is not None and source.update_mode is None


def test_registering_a_name_that_is_already_registered_is_refused(tmp_path: Path) -> None:
    """Never an overwrite: moving a source's URL or key is an edit a person has to see."""
    path = config_path(tmp_path)
    settings = HelperSettings(path=path)
    settings.add_source("acme", ACME_URL)

    with pytest.raises(HelperConfigError) as error:
        settings.add_source("acme", "https://elsewhere.example.invalid/catalogue.json")

    assert "acme" in str(error.value)
    assert load_helper_config(path).sources[0].url == ACME_URL


def test_a_source_url_that_is_not_https_is_refused_when_registered(tmp_path: Path) -> None:
    path = config_path(tmp_path)

    with pytest.raises(HelperConfigError) as error:
        HelperSettings(path=path).add_source("acme", "http://acme.example.invalid/catalogue.json")

    assert "HTTPS" in str(error.value)
    # Nothing was written: the value is validated before the file is opened.
    assert not path.exists()


def test_a_source_url_that_is_not_https_is_refused_when_read(tmp_path: Path) -> None:
    """The same rule for a file somebody edited by hand, in the same words."""
    path = write_config(
        config_path(tmp_path),
        """
        [sources.acme]
        url = "http://acme.example.invalid/catalogue.json"
        """,
    )

    with pytest.raises(HelperConfigError) as error:
        load_helper_config(path)

    assert "sources.acme.url" in str(error.value)
    assert "HTTPS" in str(error.value)


def test_a_source_with_no_url_is_refused(tmp_path: Path) -> None:
    path = write_config(
        config_path(tmp_path),
        """
        [sources.acme]
        auto_update = true
        """,
    )

    with pytest.raises(HelperConfigError) as error:
        load_helper_config(path)

    assert "sources.acme.url" in str(error.value)


def test_a_source_name_that_is_not_a_name_is_refused(tmp_path: Path) -> None:
    """A source name is joined onto a cache directory, so it is a name and never a path."""
    path = write_config(
        config_path(tmp_path),
        """
        [sources."../../etc"]
        url = "https://acme.example.invalid/catalogue.json"
        """,
    )

    with pytest.raises(HelperConfigError) as error:
        load_helper_config(path)

    assert "well-formed source name" in str(error.value)

    with pytest.raises(HelperConfigError):
        HelperSettings(path=config_path(tmp_path)).add_source("../../etc", ACME_URL)


def test_the_official_source_name_is_reserved(tmp_path: Path) -> None:
    """Nothing registered may take the name the window uses for the catalogue that ships."""
    path = write_config(
        config_path(tmp_path),
        f"""
        [sources.{OFFICIAL_SOURCE_NAME}]
        url = "https://impostor.example.invalid/catalogue.json"
        """,
    )

    with pytest.raises(HelperConfigError) as error:
        load_helper_config(path)

    assert OFFICIAL_SOURCE_NAME in str(error.value)

    with pytest.raises(HelperConfigError):
        HelperSettings(path=config_path(tmp_path)).add_source(OFFICIAL_SOURCE_NAME, ACME_URL)


def test_a_public_key_pasted_as_a_whole_file_is_refused(tmp_path: Path) -> None:
    """The bare base64 line, never the two-line `.pub` file the writer could not spell back."""
    path = config_path(tmp_path)

    with pytest.raises(HelperConfigError) as error:
        HelperSettings(path=path).add_source(
            "acme", ACME_URL, public_key=f"untrusted comment: acme\n{EXAMPLE_KEY}\n"
        )

    assert "single base64 line" in str(error.value)


def test_a_source_table_that_is_not_a_table_is_refused(tmp_path: Path) -> None:
    path = write_config(config_path(tmp_path), 'sources = { acme = "https://x.invalid" }\n')

    with pytest.raises(HelperConfigError) as error:
        load_helper_config(path)

    assert "acme" in str(error.value)


def test_an_unknown_key_in_a_source_table_is_refused(tmp_path: Path) -> None:
    path = write_config(
        config_path(tmp_path),
        """
        [sources.acme]
        url = "https://acme.example.invalid/catalogue.json"
        mirror = "https://mirror.example.invalid"
        """,
    )

    with pytest.raises(HelperConfigError) as error:
        load_helper_config(path)

    assert "mirror" in str(error.value)


def test_a_source_can_be_removed_and_the_plugins_from_it_are_left_alone(tmp_path: Path) -> None:
    """Removing a listing is not uninstalling what it listed."""
    path = config_path(tmp_path)
    settings = HelperSettings(path=path)
    settings.add_source("acme", ACME_URL, auto_update=False)
    settings.set_plugin_source("monty", "acme")

    settings.remove_source("acme")

    after = load_helper_config(path)
    assert after.sources == ()
    override = after.plugins.override_for("monty")
    assert override is not None
    assert override.source == "acme"
    # A dangling name is "no opinion", never a refusal.
    assert after.update_mode_for("monty") is UpdateMode.MANUAL


def test_removing_a_source_that_is_not_registered_is_refused(tmp_path: Path) -> None:
    path = config_path(tmp_path)

    with pytest.raises(HelperConfigError) as error:
        HelperSettings(path=path).remove_source("acme")

    assert "acme" in str(error.value)


def test_a_sources_switch_is_written_to_the_file(tmp_path: Path) -> None:
    path = config_path(tmp_path)
    settings = HelperSettings(path=path)
    settings.add_source("acme", ACME_URL, auto_update=True)

    settings.set_source_auto_update("acme", False)

    source = load_helper_config(path).source_for("acme")
    assert source is not None
    assert source.auto_update is False
    assert source.update_mode is UpdateMode.MANUAL


def test_a_switch_cannot_be_set_on_a_source_that_is_not_registered(tmp_path: Path) -> None:
    path = config_path(tmp_path)

    with pytest.raises(HelperConfigError) as error:
        HelperSettings(path=path).set_source_auto_update("acme", False)

    assert "acme" in str(error.value)


def test_recording_a_plugins_source_refuses_a_source_nothing_answers_to(tmp_path: Path) -> None:
    """A recorded name nothing owns would be a switch drawn in the window nothing consults."""
    path = config_path(tmp_path)

    with pytest.raises(HelperConfigError) as error:
        HelperSettings(path=path).set_plugin_source("monty", "acme")

    assert "acme" in str(error.value)
    assert not path.exists()


def test_a_plugin_may_record_the_official_catalogue_as_its_source(tmp_path: Path) -> None:
    path = config_path(tmp_path)

    HelperSettings(path=path).set_plugin_source("monty", OFFICIAL_SOURCE_NAME)

    override = load_helper_config(path).plugins.override_for("monty")
    assert override is not None
    assert override.source == OFFICIAL_SOURCE_NAME


def test_recording_a_plugins_source_refuses_names_that_are_not_names(tmp_path: Path) -> None:
    path = config_path(tmp_path)
    settings = HelperSettings(path=path)

    with pytest.raises(HelperConfigError):
        settings.set_plugin_source("Who.Dunnit", OFFICIAL_SOURCE_NAME)
    with pytest.raises(HelperConfigError):
        settings.set_plugin_source("monty", "../../etc")


def test_a_plugins_recorded_source_must_be_a_well_formed_name_when_read(tmp_path: Path) -> None:
    path = write_config(
        config_path(tmp_path),
        """
        [plugins.monty]
        source = "../../etc"
        """,
    )

    with pytest.raises(HelperConfigError) as error:
        load_helper_config(path)

    assert "plugins.monty.source" in str(error.value)


def test_registering_a_source_leaves_every_other_setting_alone(tmp_path: Path) -> None:
    path = write_config(config_path(tmp_path), FULL_CONFIG)
    before = load_helper_config(path)

    HelperSettings(path=path).add_source("acme", ACME_URL, auto_update=True)

    after = load_helper_config(path)
    assert after.source_for("acme") is not None
    assert after.plugins == before.plugins
    assert after.telemetry is before.telemetry
    assert after.update == before.update
    assert after.helper == before.helper


# --- the update mode actually in force: plugin, then source, then default -------------------


def test_the_update_mode_resolves_plugin_then_source_then_default(tmp_path: Path) -> None:
    """All three levels decide something in one file, so none of them can be skipped."""
    config = load_helper_config(
        write_config(
            config_path(tmp_path),
            """
            [plugins]
            update_mode = "manual"

            [plugins.monty]
            update_mode = "off"
            source = "acme"

            [plugins.whodunnit]
            source = "acme"

            [plugins.summarize]
            source = "gone"

            [sources.acme]
            url = "https://acme.example.invalid/catalogue.json"
            auto_update = true
            """,
        )
    )

    # 1. The plugin's own override, over a source that says otherwise.
    assert config.update_mode_for("monty") is UpdateMode.OFF
    # 2. The switch of the source it came from, over the global default.
    assert config.update_mode_for("whodunnit") is UpdateMode.AUTO
    # 3. The global default — for a plugin whose source is gone, and for one with no source.
    assert config.update_mode_for("summarize") is UpdateMode.MANUAL
    assert config.update_mode_for("anything-at-all") is UpdateMode.MANUAL


def test_a_sources_switch_off_stops_automatic_updates_for_its_plugins(tmp_path: Path) -> None:
    """The one that makes F2 real: a switch that is only drawn is a switch that lies."""
    config = load_helper_config(
        write_config(
            config_path(tmp_path),
            """
            [plugins]
            update_mode = "auto"

            [plugins.whodunnit]
            source = "acme"

            [sources.acme]
            url = "https://acme.example.invalid/catalogue.json"
            auto_update = false
            """,
        )
    )

    # No override of its own, so the source's switch is the only thing that can decide this.
    assert config.update_mode_for("whodunnit") is UpdateMode.MANUAL
    # And it decides for that source alone: everything else still inherits `auto`.
    assert config.update_mode_for("monty") is UpdateMode.AUTO


def test_a_source_with_no_switch_leaves_the_global_default_in_charge(tmp_path: Path) -> None:
    """`None` is the third state: the source has no opinion, so it does not get a vote."""
    config = load_helper_config(
        write_config(
            config_path(tmp_path),
            """
            [plugins]
            update_mode = "auto"

            [plugins.whodunnit]
            source = "acme"

            [sources.acme]
            url = "https://acme.example.invalid/catalogue.json"
            """,
        )
    )

    assert config.update_mode_for("whodunnit") is UpdateMode.AUTO
    assert config.source_for("acme") is not None
    assert config.source_for("nobody") is None


def test_the_settings_object_resolves_the_same_three_levels(tmp_path: Path) -> None:
    """`HelperSettings.update_mode` is what the window asks, and it may not be a shortcut."""
    path = write_config(
        config_path(tmp_path),
        """
        [plugins]
        update_mode = "auto"

        [plugins.whodunnit]
        source = "acme"

        [sources.acme]
        url = "https://acme.example.invalid/catalogue.json"
        auto_update = false
        """,
    )
    settings = HelperSettings(path=path)

    assert settings.update_mode("whodunnit") is UpdateMode.MANUAL
    assert settings.update_mode("monty") is UpdateMode.AUTO
    assert [source.name for source in settings.sources] == ["acme"]


# --- refusals ------------------------------------------------------------------------------


def test_an_unknown_top_level_key_is_refused(tmp_path: Path) -> None:
    # A typo silently ignored is a setting its author believes is in force.
    path = write_config(config_path(tmp_path), "telemtry = true\n")

    with pytest.raises(HelperConfigError) as error:
        load_helper_config(path)

    assert "telemtry" in str(error.value)


def test_an_unknown_key_inside_a_section_is_refused(tmp_path: Path) -> None:
    path = write_config(config_path(tmp_path), "[helper]\ntickk = 5\n")

    with pytest.raises(HelperConfigError) as error:
        load_helper_config(path)

    assert "tickk" in str(error.value)
    assert "helper" in str(error.value)


def test_an_unknown_scalar_under_plugins_is_refused(tmp_path: Path) -> None:
    # `[plugins]` holds one key and a table per plugin, so a stray scalar is a typo.
    path = write_config(config_path(tmp_path), '[plugins]\nupdate_modes = "auto"\n')

    with pytest.raises(HelperConfigError) as error:
        load_helper_config(path)

    assert "update_modes" in str(error.value)


def test_a_plugin_table_named_by_something_that_is_not_an_id_is_refused(tmp_path: Path) -> None:
    path = write_config(config_path(tmp_path), '[plugins."Who Dunnit"]\npinned = true\n')

    with pytest.raises(HelperConfigError) as error:
        load_helper_config(path)

    assert "Who Dunnit" in str(error.value)


def test_an_unknown_plugin_update_mode_is_refused(tmp_path: Path) -> None:
    path = write_config(config_path(tmp_path), '[plugins]\nupdate_mode = "sometimes"\n')

    with pytest.raises(HelperConfigError) as error:
        load_helper_config(path)

    assert "sometimes" in str(error.value)
    assert "manual" in str(error.value)


def test_a_switch_that_is_not_a_boolean_is_refused(tmp_path: Path) -> None:
    path = write_config(config_path(tmp_path), 'auto_check_versions = "yes"\n')

    with pytest.raises(HelperConfigError) as error:
        load_helper_config(path)

    assert "auto_check_versions" in str(error.value)


def test_a_number_that_is_not_a_number_is_refused(tmp_path: Path) -> None:
    path = write_config(config_path(tmp_path), '[helper]\ntick = "fast"\n')

    with pytest.raises(HelperConfigError) as error:
        load_helper_config(path)

    assert "tick" in str(error.value)


def test_a_boolean_is_not_accepted_where_a_number_belongs(tmp_path: Path) -> None:
    # `True` is an `int` in Python, so this is the coercion a naive check lets through.
    path = write_config(config_path(tmp_path), "[helper]\ntick = true\n")

    with pytest.raises(HelperConfigError):
        load_helper_config(path)


def test_a_non_positive_number_is_refused(tmp_path: Path) -> None:
    path = write_config(config_path(tmp_path), "[helper]\ntick = 0\n")

    with pytest.raises(HelperConfigError) as error:
        load_helper_config(path)

    assert "tick" in str(error.value)


def test_a_negative_backoff_delay_is_refused(tmp_path: Path) -> None:
    path = write_config(config_path(tmp_path), "[helper.restart]\nbackoff = [1, -2]\n")

    with pytest.raises(HelperConfigError) as error:
        load_helper_config(path)

    assert "backoff" in str(error.value)


def test_an_empty_backoff_is_refused(tmp_path: Path) -> None:
    # An empty list would mean "restart with no delay", which the max_attempts key already
    # cannot express; silently treating it as the default hides the user's mistake.
    path = write_config(config_path(tmp_path), "[helper.restart]\nbackoff = []\n")

    with pytest.raises(HelperConfigError) as error:
        load_helper_config(path)

    assert "backoff" in str(error.value)


def test_a_fractional_count_is_refused(tmp_path: Path) -> None:
    path = write_config(config_path(tmp_path), "[helper.restart]\nmax_attempts = 2.5\n")

    with pytest.raises(HelperConfigError) as error:
        load_helper_config(path)

    assert "max_attempts" in str(error.value)


def test_a_section_that_is_not_a_table_is_refused(tmp_path: Path) -> None:
    path = write_config(config_path(tmp_path), 'helper = "yes please"\n')

    with pytest.raises(HelperConfigError) as error:
        load_helper_config(path)

    assert "helper" in str(error.value)


def test_an_empty_channel_is_refused(tmp_path: Path) -> None:
    path = write_config(config_path(tmp_path), '[update]\nchannel = ""\n')

    with pytest.raises(HelperConfigError) as error:
        load_helper_config(path)

    assert "channel" in str(error.value)


def test_a_backoff_that_is_not_a_list_is_refused(tmp_path: Path) -> None:
    path = write_config(config_path(tmp_path), "[helper.restart]\nbackoff = 4\n")

    with pytest.raises(HelperConfigError) as error:
        load_helper_config(path)

    assert "backoff" in str(error.value)


def test_a_channel_that_is_not_text_is_refused(tmp_path: Path) -> None:
    path = write_config(config_path(tmp_path), "[update]\nchannel = 2\n")

    with pytest.raises(HelperConfigError) as error:
        load_helper_config(path)

    assert "channel" in str(error.value)


def test_an_update_mode_that_is_not_text_is_refused(tmp_path: Path) -> None:
    path = write_config(config_path(tmp_path), "[plugins]\nupdate_mode = 3\n")

    with pytest.raises(HelperConfigError) as error:
        load_helper_config(path)

    assert "update_mode" in str(error.value)


def test_a_count_that_is_not_a_whole_number_is_refused(tmp_path: Path) -> None:
    path = write_config(config_path(tmp_path), "[helper.breaker]\nmax_interventions = 0\n")

    with pytest.raises(HelperConfigError) as error:
        load_helper_config(path)

    assert "max_interventions" in str(error.value)


def test_the_writer_refuses_a_value_the_file_cannot_hold() -> None:
    # Unreachable through the public API — the document is validated before it is changed —
    # so it is asserted here rather than left as a comment claiming it cannot happen.
    with pytest.raises(HelperConfigError):
        _dump_value(object())


def test_a_file_that_is_not_toml_is_refused(tmp_path: Path) -> None:
    path = write_config(config_path(tmp_path), "telemetry: true\n")

    with pytest.raises(HelperConfigError) as error:
        load_helper_config(path)

    assert str(path) in str(error.value)


def test_a_file_that_cannot_be_read_is_refused_rather_than_defaulted(tmp_path: Path) -> None:
    # Defaulting here would answer "was telemetry turned off?" with a guess, and the guess
    # would be "no". A read that failed is not an answer, so it is an error.
    path = config_path(tmp_path)
    path.mkdir()

    with pytest.raises(HelperConfigError) as error:
        load_helper_config(path)

    assert str(path) in str(error.value)


def test_a_file_that_is_not_utf8_is_refused(tmp_path: Path) -> None:
    path = config_path(tmp_path)
    path.write_bytes(b"telemetry = true\n\xff\xfe")

    with pytest.raises(HelperConfigError) as error:
        load_helper_config(path)

    assert str(path) in str(error.value)


def test_two_writers_do_not_share_one_scratch_file(tmp_path: Path, monkeypatch) -> None:
    """The scratch file carries the writer's process id, so two writers cannot collide.

    The application window (plan 0003 slice 07b) writes these switches alongside the CLI. A
    fixed scratch name meant both processes writing the same file at once, and one of them
    replacing the config with the other's half-written document.
    """
    from innytypes.helper import config as config_module

    path = config_path(tmp_path)
    scratch_names: list[str] = []

    real_replace = config_module.os.replace

    def recording_replace(source, target):  # type: ignore[no-untyped-def]
        scratch_names.append(Path(source).name)
        real_replace(source, target)

    monkeypatch.setattr(config_module.os, "replace", recording_replace)

    monkeypatch.setattr(config_module.os, "getpid", lambda: 4242)
    HelperSettings(path=path).set_telemetry(True)
    monkeypatch.setattr(config_module.os, "getpid", lambda: 5353)
    HelperSettings(path=path).set_telemetry(False)

    assert len(set(scratch_names)) == 2, scratch_names
    assert all(name != path.name for name in scratch_names)
    assert load_helper_config(path).telemetry is Telemetry.OFF
