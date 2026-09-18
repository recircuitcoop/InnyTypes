"""The published settings form: what the application draws, and what saving it answers.

Plan 0004, "The host publishes a form, not a manifest": the application never reads a
manifest, a lock, an environment or the settings store. It asks for **one form** — every
declared field in the manifest's order, each already carrying its current value, its default,
whether a secret is set, whether it is shown, who last wrote it, and any error attached to it
— and it saves through **one call** that validates, records and answers per field.

Every test here builds its store under `tmp_path`. Nothing in this file may read or write the
real per-user config directory, start a process, sleep, or reach a network.

Each refusal owns a test that turns red when its check is deleted, because the cheapest way to
"satisfy" a requirement to refuse something is to not implement it.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from innytypes.addons.manifest import SettingsField, parse_settings
from innytypes.addons.settings import (
    USER,
    PluginAvailability,
    SettingsError,
    SettingsStore,
)
from innytypes.addons.settings_form import PluginState, SettingsForm

# --- the declarations these tests draw from --------------------------------------------------

FOLDER = {"id": "root", "type": "path", "label": "Folder to watch", "kind": "folder"}
INTERVAL = {"id": "interval", "type": "number", "label": "Interval", "min": 1, "max": 60}
QUALITY = {"id": "quality", "type": "choice", "label": "Quality", "options": ["low", "high"]}
TOKEN = {"id": "token", "type": "secret", "label": "API token", "written_by": "both"}
WATCHING = {"id": "watching", "type": "switch", "label": "Watch on start", "default": False}


def declare(*fields: object) -> tuple[SettingsField, ...]:
    """Parse a settings declaration exactly as a recorded manifest carries it."""
    return parse_settings(list(fields))


def form(tmp_path: Path, *fields: object, **kwargs: Any) -> SettingsForm:
    """A form for `monty`, over a store writing under the test's own directory and nowhere else."""
    state = kwargs.pop("state", None)
    store = SettingsStore(
        "monty",
        declare(*fields),
        path=tmp_path / "plugins" / "monty.toml",
        **kwargs,
    )
    return SettingsForm(store, state=state)


# --- every declared field, with its value, its default and its error ---------------------------


def test_the_form_lists_every_declared_field_in_the_manifests_order(tmp_path: Path) -> None:
    published = form(tmp_path, QUALITY, FOLDER, INTERVAL).publish()

    assert [field.id for field in published.fields] == ["quality", "root", "interval"]
    assert published.addon_id == "monty"


def test_each_field_carries_its_value_its_default_and_its_error(tmp_path: Path) -> None:
    # A mix on purpose: one field answered, one falling back to its default, one required and
    # unanswered, and one whose recorded value no longer fits the declaration (D5).
    settings = form(tmp_path, INTERVAL, dict(QUALITY, default="high"), dict(FOLDER, required=True))
    settings.save({"interval": 20})

    # The declaration then changes under the file, exactly as a plugin update changes it.
    tightened = form(
        tmp_path,
        dict(INTERVAL, min=30),
        dict(QUALITY, default="high"),
        dict(FOLDER, required=True),
    ).publish()

    interval = tightened.field("interval")
    assert interval.value == 20
    assert interval.default is None
    assert interval.error is not None and "interval" in interval.error

    quality = tightened.field("quality")
    assert quality.value == "high"
    assert quality.default == "high"
    assert quality.error is None

    root = tightened.field("root")
    assert root.value is None
    assert root.default is None
    assert root.error is not None and "required" in root.error


def test_a_field_carries_the_type_and_constraints_the_application_draws_it_from(
    tmp_path: Path,
) -> None:
    published = form(
        tmp_path,
        dict(INTERVAL, help="How often to look", group="Sources", step=5),
        QUALITY,
        {"id": "sizes", "type": "list of number", "label": "Sizes", "min": 1},
    ).publish()

    interval = published.field("interval")
    assert (interval.type, interval.label, interval.help) == (
        "number",
        "Interval",
        "How often to look",
    )
    assert (interval.min, interval.max, interval.step, interval.group) == (1, 60, 5, "Sources")
    assert published.field("quality").options == ("low", "high")
    assert published.field("sizes").element_type == "number"


def test_the_form_names_its_groups_in_the_order_they_first_appear(tmp_path: Path) -> None:
    published = form(
        tmp_path,
        dict(INTERVAL, group="Timing"),
        FOLDER,
        dict(QUALITY, group="Timing"),
        dict(WATCHING, group="Behaviour"),
    ).publish()

    assert published.groups == ("Timing", None, "Behaviour")


def test_a_value_the_plugin_wrote_is_published_with_who_wrote_it(tmp_path: Path) -> None:
    settings = form(tmp_path, dict(INTERVAL, written_by="plugin"))

    settings.save({"interval": 30}, by="monty")

    interval = settings.publish().field("interval")
    assert interval.value == 30
    assert interval.written is not None
    assert interval.written.by == "monty"
    assert not interval.written.by_user
    # The window draws it read-only: this one is the plugin's to set, not the user's.
    assert not interval.user_editable


def test_a_save_from_the_application_is_the_users_own_entry(tmp_path: Path) -> None:
    # The application's save is a person's, so `by` defaults to the user; a plugin writing its
    # own values back (slice 05) is the call that has to say so.
    settings = form(tmp_path, INTERVAL)

    settings.save({"interval": 30})

    written = settings.publish().field("interval").written
    assert written is not None and written.by == USER and written.by_user


def test_a_field_with_no_recorded_value_has_no_attribution(tmp_path: Path) -> None:
    assert form(tmp_path, dict(INTERVAL, default=15)).publish().field("interval").written is None


# --- a secret says only whether it is set ------------------------------------------------------


def test_a_secret_reports_only_whether_it_is_set_and_never_a_value(tmp_path: Path) -> None:
    answered: set[str] = set()
    settings = form(tmp_path, TOKEN, INTERVAL, secret_is_set=lambda field_id: field_id in answered)

    token = settings.publish().field("token")
    assert token.is_secret
    assert not token.secret_is_set
    assert token.value is None

    # Slice 03 records the secret; the form learns of it through the same seam the store uses.
    answered.add("token")

    token = settings.publish().field("token")
    assert token.secret_is_set
    assert token.value is None

    # And again on a plain read with nothing changed: it is still only ever a yes or a no.
    token = settings.publish().field("token")
    assert token.secret_is_set
    assert token.value is None


def test_a_secret_planted_in_the_settings_file_by_hand_is_never_published(tmp_path: Path) -> None:
    settings = form(tmp_path, TOKEN)
    path = tmp_path / "plugins" / "monty.toml"
    path.parent.mkdir(parents=True)
    path.write_text('[values]\ntoken = "hunter2"\n', encoding="utf-8")

    token = settings.publish().field("token")

    assert token.value is None
    assert "hunter2" not in repr(settings.publish())


def test_a_default_declared_for_a_secret_is_never_published(tmp_path: Path) -> None:
    # A manifest may carry one, and it is still a secret-shaped literal. The form does not put
    # it in a widget — a secret is answered, never pre-filled.
    published = form(tmp_path, dict(TOKEN, default="hunter2")).publish()

    assert published.field("token").default is None
    assert published.field("token").value is None
    assert "hunter2" not in repr(published)


def test_only_a_secret_is_ever_asked_whether_it_is_set(tmp_path: Path) -> None:
    published = form(tmp_path, INTERVAL, TOKEN, secret_is_set=lambda field_id: True).publish()

    assert not published.field("interval").is_secret
    assert not published.field("interval").secret_is_set
    assert published.field("token").secret_is_set


def test_a_required_secret_that_is_not_set_holds_the_plugin_and_names_the_field(
    tmp_path: Path,
) -> None:
    published = form(tmp_path, dict(TOKEN, required=True)).publish()

    assert published.availability is PluginAvailability.HELD
    assert published.field("token").error is not None


# --- saving: validated, recorded, and answered per field ---------------------------------------


def test_a_field_that_fails_does_not_stop_the_fields_that_pass(tmp_path: Path) -> None:
    settings = form(tmp_path, INTERVAL, QUALITY)
    settings.save({"interval": 10, "quality": "low"})

    outcome = settings.save({"interval": 45, "quality": "medium"})

    assert outcome.recorded == ("interval",)
    assert [problem.field for problem in outcome.refused] == ["quality"]
    assert not outcome.accepted

    published = settings.publish()
    assert published.field("interval").value == 45
    assert published.field("quality").value == "low"
    assert published.field("interval").error is None
    assert published.field("quality").error is not None
    assert published.errors == {"quality": published.field("quality").error}


def test_a_value_of_the_wrong_shape_is_refused_rather_than_converted(tmp_path: Path) -> None:
    settings = form(tmp_path, INTERVAL)

    outcome = settings.save({"interval": "20"})

    assert [problem.field for problem in outcome.refused] == ["interval"]
    assert outcome.recorded == ()
    # Not 20, and not "20": nothing was recorded at all.
    assert settings.publish().field("interval").value is None
    assert not (tmp_path / "plugins" / "monty.toml").exists()


def test_a_field_the_plugin_does_not_declare_is_refused_by_name(tmp_path: Path) -> None:
    outcome = form(tmp_path, INTERVAL).save({"nonesuch": 1})

    assert [problem.field for problem in outcome.refused] == ["nonesuch"]


def test_an_error_from_a_failed_save_stays_beside_the_field_until_it_is_corrected(
    tmp_path: Path,
) -> None:
    settings = form(tmp_path, INTERVAL)

    settings.save({"interval": 900})
    assert settings.publish().field("interval").error is not None
    # Drawn again without saving anything: the person is still looking at their own mistake.
    assert settings.publish().field("interval").error is not None

    settings.save({"interval": 30})
    assert settings.publish().field("interval").error is None


def test_a_save_in_the_name_of_another_plugin_is_refused_whole(tmp_path: Path) -> None:
    with pytest.raises(SettingsError, match="only its own settings"):
        form(tmp_path, INTERVAL).save({"interval": 30}, by="whodunnit")


def test_a_save_to_a_secret_is_refused_by_field_and_points_at_the_secret_store(
    tmp_path: Path,
) -> None:
    outcome = form(tmp_path, TOKEN).save({"token": "hunter2"}, by="monty")

    assert [problem.field for problem in outcome.refused] == ["token"]
    assert "file of its own" in outcome.refused[0].reason


# --- shown_when is the host's to evaluate ------------------------------------------------------


def test_a_dependent_fields_visibility_follows_the_field_it_names(tmp_path: Path) -> None:
    settings = form(
        tmp_path,
        WATCHING,
        dict(INTERVAL, shown_when={"field": "watching", "equals": True}),
    )

    assert not settings.publish().field("interval").shown
    assert settings.publish().field("watching").shown

    settings.save({"watching": True})

    assert settings.publish().field("interval").shown

    settings.save({"watching": False})

    assert not settings.publish().field("interval").shown


def test_a_condition_may_name_a_field_declared_after_it(tmp_path: Path) -> None:
    published = form(
        tmp_path,
        dict(INTERVAL, shown_when={"field": "quality", "equals": "high"}),
        dict(QUALITY, default="high"),
    ).publish()

    assert published.field("interval").shown


def test_a_condition_is_not_satisfied_by_a_value_of_another_type(tmp_path: Path) -> None:
    # `1 == True` in Python, and a number field holding 1 is not a switch that is on.
    published = form(
        tmp_path,
        dict(INTERVAL, default=1),
        dict(QUALITY, shown_when={"field": "interval", "equals": True}),
    ).publish()

    assert not published.field("quality").shown


def test_a_condition_on_a_secret_is_never_satisfied(tmp_path: Path) -> None:
    # A secret's value is not knowable here, so no comparison against it can be true. The
    # form says so rather than guessing from whether one is set.
    published = form(
        tmp_path,
        TOKEN,
        dict(INTERVAL, shown_when={"field": "token", "equals": "x"}),
        secret_is_set=lambda field_id: True,
    ).publish()

    assert not published.field("interval").shown


# --- the form answers the same way whatever state the plugin is in -----------------------------


def test_a_stopped_plugin_publishes_the_same_form_as_a_running_one(tmp_path: Path) -> None:
    # Nothing has taken it out of service: not running is not a settings state at all.
    published = form(tmp_path, dict(INTERVAL, default=15), state=lambda: None).publish()

    assert published.availability is PluginAvailability.ENABLED
    assert published.reason is None
    assert [field.id for field in published.fields] == ["interval"]


@pytest.mark.parametrize(
    ("state", "availability"),
    [
        (None, PluginAvailability.HELD),
        (
            PluginState(PluginAvailability.DISABLED, "turned off by you"),
            PluginAvailability.DISABLED,
        ),
        (
            PluginState(PluginAvailability.QUARANTINED, "the helper gave up restarting it"),
            PluginAvailability.QUARANTINED,
        ),
        (PluginState(PluginAvailability.ENABLED), PluginAvailability.HELD),
    ],
)
def test_the_full_form_is_published_whatever_state_the_plugin_is_in(
    tmp_path: Path, state: PluginState | None, availability: PluginAvailability
) -> None:
    settings = form(
        tmp_path,
        dict(INTERVAL, default=15),
        dict(FOLDER, required=True),
        state=lambda: state,
    )

    published = settings.publish()

    assert published.availability is availability
    assert published.reason is not None
    # The same fields, the same values and the same errors in every one of these states.
    assert [field.id for field in published.fields] == ["interval", "root"]
    assert published.field("interval").value == 15
    assert published.field("root").error is not None


def test_a_plugin_the_user_disabled_is_not_reported_as_held(tmp_path: Path) -> None:
    # Two different states needing two different actions: fixing the folder will not start a
    # plugin the user switched off, so the form must not say "held disabled" about it.
    published = form(
        tmp_path,
        dict(FOLDER, required=True),
        state=lambda: PluginState(PluginAvailability.DISABLED, "turned off by you"),
    ).publish()

    assert published.availability is PluginAvailability.DISABLED
    assert published.reason == "turned off by you"


def test_a_plugin_with_nothing_wrong_is_available(tmp_path: Path) -> None:
    published = form(tmp_path, dict(INTERVAL, default=15)).publish()

    assert published.availability is PluginAvailability.ENABLED
    assert published.reason is None


def test_a_plugin_that_declares_no_settings_publishes_an_empty_form(tmp_path: Path) -> None:
    published = form(tmp_path).publish()

    assert published.fields == ()
    assert published.groups == ()
    assert published.availability is PluginAvailability.ENABLED


def test_asking_for_a_field_the_plugin_does_not_declare_is_refused_by_name(
    tmp_path: Path,
) -> None:
    published = form(tmp_path, INTERVAL).publish()

    with pytest.raises(KeyError, match="nonesuch"):
        published.field("nonesuch")


def test_publishing_a_form_creates_no_file(tmp_path: Path) -> None:
    form(tmp_path, dict(FOLDER, required=True)).publish()

    assert not (tmp_path / "plugins").exists()
