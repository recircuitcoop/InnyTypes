"""The published settings form — the one thing the application draws a plugin's page from.

Plan 0004, "The host publishes a form, not a manifest". The application does not read a
manifest, a lock, an environment or the settings store. It asks for a **form**:

* every field the plugin declares, in the manifest's order, with the type, the label, the help,
  the group and the constraints the widget is drawn from;
* each field's **current value** — the recorded one, the default when nothing is recorded, or
  nothing at all when there is neither — and its declared default beside it;
* whether a `secret` has been **set**, never what it is;
* whether the field is **shown**, which the host computes from `shown_when` so the application
  never re-implements that logic;
* who last wrote the value and when (F2), and whether the user may write it at all;
* the **error** attached to the field: the one from the last save that refused it, or the one
  from judging what is on disk against the declaration in force (D5, F1);
* and the plugin's **availability** with the sentence to show for it.

Saving is the mirror: :meth:`SettingsForm.save` takes values by field id and answers with the
store's own per-field outcome. A field that fails validation is refused **by field** — never
coerced, never half-recorded — and the fields that passed in the same call are recorded
normally. The refusal is then attached to that field until a later save corrects it, because a
failed write records nothing on disk and there would otherwise be nowhere for the reason to
live between the save and the redraw.

**This module decides nothing on its own.** Values, defaults, validation and the hold come from
:class:`innytypes.addons.settings.SettingsStore`; the vocabulary and the constraints come from
the declaration the store was built with; whether a secret is set comes from the store's
``secret_is_set`` seam, which slice 03 fills. What is added here is the *publishing*: putting
those answers in one object in the order the form is drawn, evaluating `shown_when`, and
choosing the single word for the plugin's availability.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Final

from innytypes.addons.manifest import SettingsField
from innytypes.addons.settings import (
    USER,
    Attribution,
    Hold,
    PluginAvailability,
    RecordedSettings,
    SettingsStore,
    WriteOutcome,
)

__all__ = [
    "FormField",
    "PluginState",
    "PublishedForm",
    "SettingsForm",
]

# `written_by` values a person may type into. A field only the plugin writes is drawn read-only
# rather than hidden: the user is meant to see what the plugin recorded (F2).
_USER_WRITABLE: Final = ("user", "both")


@dataclass(frozen=True)
class PluginState:
    """What somebody other than the settings already decided about this plugin.

    The settings can only ever hold a plugin back. The user's own disable (slice 06) and the
    helper's quarantine (plan 0003) are recorded elsewhere, and this is how they reach the
    form: injected, so this slice neither owns them nor guesses at them.
    """

    availability: PluginAvailability
    reason: str | None = None


@dataclass(frozen=True)
class FormField:
    """One field of the published form: everything needed to draw it, and nothing more.

    ``value`` is the current value the person is looking at — the recorded one, or the declared
    default when nothing is recorded — and is ``None`` only when there is no value at all: no
    type in the vocabulary stores "nothing" (D1), so ``None`` is never a setting's value and
    always means "unanswered". A value that is *refused* is still published here, because a
    person has to see what is being refused in order to correct it.

    ``value`` is always ``None`` for a `secret`. A secret's value never leaves its own file, so
    all the form can say is :attr:`secret_is_set` (D6).
    """

    id: str
    type: str
    label: str
    help: str | None
    group: str | None
    required: bool
    written_by: str
    element_type: str | None
    min: float | None
    max: float | None
    step: float | None
    options: tuple[str, ...] | None
    kind: str | None
    default: object | None
    value: object | None
    is_secret: bool
    secret_is_set: bool
    shown: bool
    error: str | None
    written: Attribution | None

    @property
    def user_editable(self) -> bool:
        """Whether a person may set this field, or only the plugin itself may (F2)."""
        return self.written_by in _USER_WRITABLE


@dataclass(frozen=True)
class PublishedForm:
    """One plugin's settings page, as of one read.

    ``fields`` is in the manifest's order, always — grouping tells the application which
    section to draw a field under and never reorders anything.

    ``availability`` is the one word at the top of the page and ``reason`` the sentence beside
    it; ``reason`` is ``None`` only when the plugin is :attr:`PluginAvailability.ENABLED`, which
    is the one state that needs no explanation.
    """

    addon_id: str
    fields: tuple[FormField, ...]
    availability: PluginAvailability
    reason: str | None = None

    @property
    def groups(self) -> tuple[str | None, ...]:
        """The sections to draw, in the order their first field appears.

        ``None`` is in this tuple when some field declares no group: ungrouped fields are a
        section of the page like any other, and the application has to know it is there.
        """
        seen: list[str | None] = []
        for field in self.fields:
            if field.group not in seen:
                seen.append(field.group)
        return tuple(seen)

    @property
    def errors(self) -> Mapping[str, str]:
        """Every field that currently has something wrong with it, by id."""
        return {field.id: field.error for field in self.fields if field.error is not None}

    def field(self, field_id: str) -> FormField:
        """One field by id, or :class:`KeyError` naming it — the form is the whole truth."""
        for field in self.fields:
            if field.id == field_id:
                return field
        raise KeyError(f"{self.addon_id} declares no setting {field_id!r}")


class SettingsForm:
    """Publishes one plugin's form, and saves what comes back from it.

    Built over the store, so there is one declaration, one validator and one file behind both
    calls. Held for as long as the page is open: the only state it keeps of its own is the
    per-field refusals from the last save, which is what lets the redraw after a failed save
    show the reason beside the field.
    """

    def __init__(
        self,
        store: SettingsStore,
        *,
        state: Callable[[], PluginState | None] | None = None,
    ) -> None:
        self._store = store
        # No seam means nobody has taken this plugin out of service, so only its settings can.
        self._state = state if state is not None else _no_state
        self._refused: dict[str, str] = {}

    @property
    def addon_id(self) -> str:
        """The plugin whose form this is."""
        return self._store.addon_id

    @property
    def fields(self) -> tuple[SettingsField, ...]:
        """The declaration this form publishes, in the manifest's order.

        Exposed so a caller holding a form across draws can tell that the declaration moved
        under it — which is what a plugin update does (D5) — and build a new one rather than
        keep judging by a rule that is no longer in force.
        """
        return self._store.fields

    def publish(self) -> PublishedForm:
        """Read everything now and answer with the whole page, creating nothing on disk."""
        settings = self._store.read()
        problems = _by_field(settings.hold)
        values = {field.id: self._value(field, settings) for field in self._store.fields}

        fields = tuple(
            self._entry(field, settings, values=values, problems=problems)
            for field in self._store.fields
        )
        availability, reason = self._availability(settings.hold)
        return PublishedForm(
            addon_id=self.addon_id,
            fields=fields,
            availability=availability,
            reason=reason,
        )

    def save(self, values: Mapping[str, object], *, by: str = USER) -> WriteOutcome:
        """Validate and record ``values`` by field id, answering with the per-field outcome.

        ``by`` defaults to :data:`innytypes.addons.settings.USER`, because the application's
        save is a person's entry; a plugin writing its own values back says so (D11, F2).

        Nothing is coerced and nothing is partially applied: the store records the fields that
        pass and refuses the rest by name, each with its own reason. Those reasons are kept
        here so the next :meth:`publish` shows them beside their fields, and a field is cleared
        of its reason by the save that records it.
        """
        outcome = self._store.write(values, by=by)

        for field_id in outcome.recorded:
            self._refused.pop(field_id, None)
        for problem in outcome.refused:
            self._refused[problem.field] = problem.reason

        return outcome

    # --- one field ------------------------------------------------------------------------------

    def _entry(
        self,
        field: SettingsField,
        settings: RecordedSettings,
        *,
        values: Mapping[str, object | None],
        problems: Mapping[str, str],
    ) -> FormField:
        """One declared field, with everything the application draws it from."""
        secret = _is_secret(field)
        # A secret has no value here and no default worth showing. Its value lives in a file of
        # its own (D6), and a default written into a manifest is a secret-shaped literal the
        # form must not put into a widget either. All the form ever says about one is whether
        # it is set.
        default = None if secret else field.default
        return FormField(
            id=field.id,
            type=field.type,
            label=field.label,
            help=field.help,
            group=field.group,
            required=field.required,
            written_by=field.written_by,
            element_type=field.element_type,
            min=field.min,
            max=field.max,
            step=field.step,
            options=field.options,
            kind=field.kind,
            default=default,
            value=values[field.id],
            is_secret=secret,
            # Asked of the store rather than answered here, so "is this secret set?" has one
            # implementation for the whole host (D6, slice 03's seam).
            secret_is_set=secret and self._store.secret_is_set(field.id),
            shown=_shown(field, values),
            # The last save's refusal is the more recent news about this field than whatever
            # judging the file said, so it wins where both have something to say.
            error=self._refused.get(field.id) or problems.get(field.id),
            written=settings.attribution.get(field.id),
        )

    def _value(self, field: SettingsField, settings: RecordedSettings) -> object | None:
        """What this field currently holds, from the store and never from a second reading.

        Three cases, in this order: a value that passed (with declared defaults already filled
        in), a value that was refused (published as recorded, because a person cannot correct
        what they cannot see), and nothing at all.

        A `secret` falls through to the last of those with no rule of its own: the store keeps
        one out of both mappings, whatever is in the file (D6).
        """
        if field.id in settings.values:
            return settings.values[field.id]
        if field.id in settings.recorded:
            return settings.recorded[field.id]
        return None

    def _availability(self, hold: Hold | None) -> tuple[PluginAvailability, str | None]:
        """The one word for the top of the page, and the sentence beside it.

        A state somebody else recorded wins over a hold, because the two need different
        actions: correcting a folder will not start a plugin the user switched off, and a
        quarantined plugin needs `helper release`. The settings decide only when nothing else
        has taken the plugin out of service.
        """
        state = self._state()
        if state is not None and state.availability is not PluginAvailability.ENABLED:
            return state.availability, state.reason

        if hold is not None:
            return PluginAvailability.HELD, hold.reason

        return PluginAvailability.ENABLED, None


def _no_state() -> None:
    """The answer when no switch and no breaker are wired up: nobody has decided anything."""
    return None


def _is_secret(field: SettingsField) -> bool:
    """Whether this field's value lives in the secret store rather than the settings file."""
    return field.type == "secret" or field.element_type == "secret"


def _by_field(hold: Hold | None) -> Mapping[str, str]:
    """A hold's problems as one reason per field, ready to hang beside a widget."""
    if hold is None:
        return {}
    return {problem.field: problem.reason for problem in hold.problems}


def _shown(field: SettingsField, values: Mapping[str, object | None]) -> bool:
    """Whether the application draws this field, given what the rest of the form holds (D2).

    Evaluated here, once, so the application never re-implements it — and against the same
    values the form publishes, so what the user sees is what the condition was judged on.

    A condition naming a field with no value is not satisfied, and neither is one naming a
    `secret`: the form does not know a secret's value, and `equals` compares values.
    """
    condition = field.shown_when
    if condition is None:
        return True
    return _equal(values.get(condition.field), condition.equals)


def _equal(value: object | None, expected: object) -> bool:
    """Whether a recorded value *is* the value a condition names, type included.

    `True == 1` in Python, and a `number` field holding 1 is not a `switch` that is on. A
    condition that means one thing in the manifest and another in the form is exactly the class
    of surprise the host exists to prevent, so booleans only ever match booleans.
    """
    if isinstance(value, bool) != isinstance(expected, bool):
        return False
    return bool(value == expected)
