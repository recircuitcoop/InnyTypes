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

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from types import MappingProxyType
from typing import Final

from innytypes.addons.manifest import SettingsField
from innytypes.addons.settings import (
    USER,
    Attribution,
    CellAddress,
    FieldProblem,
    Hold,
    PluginAvailability,
    RecordedSettings,
    RowAt,
    SettingsStore,
    WriteOutcome,
    row_name,
)

__all__ = [
    "FormField",
    "FormRow",
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
class FormRow:
    """One row of a published `table`: its cells, its nested tables, and what is wrong with it.

    ``values`` holds one entry per declared **cell** column, with the column's own default
    filling a cell the row left out — exactly as the store fills it — and ``None`` where there
    is neither a value nor a default. A column that is itself a table is **not** in there: its
    rows are in :attr:`rows`, under the same column id, because a table column is drawn as a
    table rather than as a cell and offering it as both invites two drawings of one thing.

    ``errors`` is the reason for one cell, by column id, and ``error`` is what is wrong with
    the row as a whole — a row that is not a mapping at all, or one carrying a key the
    declaration does not name, where there is no one cell to blame.

    ``address`` is this row's place in the table, in the same vocabulary a refusal from
    :meth:`SettingsForm.save` carries, so a caller holding a refusal and a caller holding a
    row are talking about the same thing.
    """

    position: int
    name: str
    address: CellAddress
    values: Mapping[str, object | None]
    rows: Mapping[str, tuple[FormRow, ...]]
    errors: Mapping[str, str]
    error: str | None = None


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

    A `table` is the one field whose drawing is not one widget (plan 0005). It carries three
    more things, and ``None``/empty on every other type: ``row``, the declaration of one row,
    which is what each cell's widget is chosen from; ``row_label``, what the **Add** button
    says and what a row is called; and :attr:`rows`, the rows themselves, nested as declared
    and each carrying its own cell errors. ``value`` stays what the store holds — the rows
    that passed — and the drawing reads :attr:`rows`, which is the same thing plus the rows
    that did not and the reasons they did not.
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
    row: tuple[SettingsField, ...] | None = None
    row_label: str | None = None
    rows: tuple[FormRow, ...] = ()

    @property
    def user_editable(self) -> bool:
        """Whether a person may set this field, or only the plugin itself may (F2)."""
        return self.written_by in _USER_WRITABLE

    def row_at(self, position: int) -> FormRow:
        """One row by its position counted from one, or :class:`KeyError` naming it.

        Counted from one because that is what the person sees and what every refusal says:
        `recorder 2` is the second row on screen and `rows[1]` is nobody's vocabulary.
        """
        for row in self.rows:
            if row.position == position:
                return row
        raise KeyError(f"{self.id} holds no {self.row_label or self.id} {position}")

    def error_for(self, cell: CellAddress) -> str | None:
        """The reason attached where a refusal says it is, or ``None`` if nothing is there.

        The bridge between the two halves of this slice: a :class:`FieldProblem` from
        :meth:`SettingsForm.save` carries an address, and this is that address read back off
        the published page — so the application places a refusal without ever deriving a row
        name or a position of its own.
        """
        if not cell.path:
            return self.error

        row = _row_at(self.rows, cell.path[0])
        for step in cell.path[1:]:
            if row is None:
                return None
            row = _row_at(row.rows.get(step.column, ()), step)

        if row is None:
            return None
        return row.error if cell.column is None else row.errors.get(cell.column)


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
        """Every field with something wrong with the **field**, by id.

        A `table`'s per-cell reasons are not in here: they belong to one row's one column and
        are carried by that row (:class:`FormRow`), which is where they are drawn.
        """
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
        # The last save's refusals, whole rather than reduced to a sentence: a table's are
        # several, each addressed to the cell it is about.
        self._refused: dict[str, tuple[FieldProblem, ...]] = {}
        # And, for a table, what was submitted for it — so a refused row is redrawn with what
        # the person typed in it rather than with the row the store kept on disk (D2).
        self._submitted: dict[str, object] = {}

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

        A `table` is both at once: a write can record eight rows and refuse two (D2), so the
        field is in ``recorded`` *and* carries refusals. The refusals win — the two rows are
        still wrong — and what was submitted for the table is kept beside them, because the
        store put the rows it had back at those positions and the person has to see what they
        typed in order to correct it.
        """
        outcome = self._store.write(values, by=by)
        tables = {field.id for field in self._store.fields if field.row is not None}

        for field_id in outcome.recorded:
            self._refused.pop(field_id, None)
            self._submitted.pop(field_id, None)

        refusals: dict[str, list[FieldProblem]] = {}
        for problem in outcome.refused:
            refusals.setdefault(problem.field, []).append(problem)

        for field_id, problems in refusals.items():
            self._refused[field_id] = tuple(problems)
            if field_id in tables and field_id in values:
                self._submitted[field_id] = values[field_id]

        return outcome

    # --- one field ------------------------------------------------------------------------------

    def _entry(
        self,
        field: SettingsField,
        settings: RecordedSettings,
        *,
        values: Mapping[str, object | None],
        problems: Mapping[str, tuple[FieldProblem, ...]],
    ) -> FormField:
        """One declared field, with everything the application draws it from."""
        secret = _is_secret(field)
        # The last save's refusal is the more recent news about this field than whatever
        # judging the file said, so it wins where both have something to say.
        found = self._refused.get(field.id) or problems.get(field.id, ())
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
            # What is wrong with the field itself. A reason about one cell of one row is not
            # that, and hangs on the cell instead (plan 0005, "Drawing it").
            error=_field_error(found),
            written=settings.attribution.get(field.id),
            row=field.row,
            row_label=field.row_label,
            rows=() if field.row is None else self._rows(field, settings, found),
        )

    def _rows(
        self,
        field: SettingsField,
        settings: RecordedSettings,
        problems: Sequence[FieldProblem],
    ) -> tuple[FormRow, ...]:
        """One published `table`: every row on the page, nested as declared, with its errors.

        The whole tree in one pass, so slice 04 draws a table of tables without reading a
        manifest, a store or a lock — and without a second read to reach the depth it is at.
        """
        by_row: dict[tuple[RowAt, ...], list[FieldProblem]] = {}
        for problem in problems:
            if problem.cell is not None and problem.cell.path:
                by_row.setdefault(problem.cell.path, []).append(problem)

        return _rows_of(
            field.row or (),
            field.row_label or field.id,
            self._table_source(field, settings),
            field_id=field.id,
            at=(),
            column_id=None,
            parent=None,
            by_row=by_row,
        )

    def _table_source(self, field: SettingsField, settings: RecordedSettings) -> object:
        """Which rows the page shows, in the same order of preference a scalar's value has.

        What was **submitted** and refused comes first, because a person correcting a row has
        to see the row they typed — the store kept the row that was there before it, which is
        the right thing on disk and the wrong thing on the screen (D2). Then what is recorded,
        judged by nothing, so a row that no longer fits its declaration is still visible and
        correctable (D5). Then the declared default, which is what a table nobody has written
        holds. Then nothing at all.
        """
        if field.id in self._submitted:
            return self._submitted[field.id]
        if field.id in settings.recorded:
            return settings.recorded[field.id]
        return settings.values.get(field.id, ())

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
            # `why`, not `reason`: the page draws the word "held disabled" itself, and a
            # sentence that repeats it is what the window showed before anyone looked at it.
            return PluginAvailability.HELD, hold.why

        return PluginAvailability.ENABLED, None


def _no_state() -> None:
    """The answer when no switch and no breaker are wired up: nobody has decided anything."""
    return None


def _is_secret(field: SettingsField) -> bool:
    """Whether this field's value lives in the secret store rather than the settings file."""
    return field.type == "secret" or field.element_type == "secret"


def _by_field(hold: Hold | None) -> Mapping[str, tuple[FieldProblem, ...]]:
    """A hold's problems grouped by the field they are about.

    Grouped rather than reduced to one reason per field, because a table is several records
    and a read that found three bad rows has three things to say about one field.
    """
    if hold is None:
        return {}

    found: dict[str, list[FieldProblem]] = {}
    for problem in hold.problems:
        found.setdefault(problem.field, []).append(problem)
    return {field_id: tuple(problems) for field_id, problems in found.items()}


def _field_error(problems: Sequence[FieldProblem]) -> str | None:
    """What is wrong with the field itself — never what is wrong with one cell of one row.

    A table's cell reasons are drawn beside their cells, and one repeated above the table as
    well is the same sentence in two places (plan 0005, "Drawing it").
    """
    reasons = [
        problem.reason for problem in problems if problem.cell is None or not problem.cell.path
    ]
    return "; ".join(reasons) or None


def _rows_of(
    columns: tuple[SettingsField, ...],
    row_label: str,
    source: object,
    *,
    field_id: str,
    at: tuple[RowAt, ...],
    column_id: str | None,
    parent: str | None,
    by_row: Mapping[tuple[RowAt, ...], Sequence[FieldProblem]],
) -> tuple[FormRow, ...]:
    """The rows of one table, at one depth, built the way the store addressed and named them.

    A source that is not a list of rows publishes none: there is nothing to draw, and the
    reason why is already on the field or on the cell that holds it.
    """
    if not isinstance(source, Sequence) or isinstance(source, str):
        return ()

    holder = column_id if column_id is not None else field_id
    published: list[FormRow] = []

    for index, row in enumerate(source):
        position = index + 1
        address = at + (RowAt(holder, position),)
        name = row_name(row_label, position, parent=parent, column_id=column_id)

        cells: dict[str, object | None] = {}
        nested: dict[str, tuple[FormRow, ...]] = {}
        # A row that is not a mapping has no cells to show. It is still published, with the
        # reason on it, because a row silently missing from the page is a row nobody can fix.
        if isinstance(row, Mapping):
            for column in columns:
                # The column's own default fills a cell the row left out, exactly as the
                # store fills it — so the page shows what the plugin would be handed.
                value = row.get(column.id, column.default)
                if column.row is None:
                    cells[column.id] = value
                    continue
                nested[column.id] = _rows_of(
                    column.row,
                    column.row_label or column.id,
                    value,
                    field_id=field_id,
                    at=address,
                    column_id=column.id,
                    parent=name,
                    by_row=by_row,
                )

        problems = by_row.get(address, ())
        published.append(
            FormRow(
                position=position,
                name=name,
                address=CellAddress(path=address),
                values=MappingProxyType(cells),
                rows=MappingProxyType(nested),
                errors=MappingProxyType(_cell_errors(problems)),
                error=_row_error(problems),
            )
        )

    return tuple(published)


def _cell_errors(problems: Sequence[FieldProblem]) -> dict[str, str]:
    """One row's reasons, by the column each is about."""
    found: dict[str, list[str]] = {}
    for problem in problems:
        column = problem.cell.column if problem.cell is not None else None
        if column is not None:
            found.setdefault(column, []).append(problem.reason)
    return {column: "; ".join(reasons) for column, reasons in found.items()}


def _row_error(problems: Sequence[FieldProblem]) -> str | None:
    """What is wrong with a row rather than with any one of its cells."""
    reasons = [
        problem.reason
        for problem in problems
        if problem.cell is not None and problem.cell.column is None
    ]
    return "; ".join(reasons) or None


def _row_at(rows: tuple[FormRow, ...], step: RowAt) -> FormRow | None:
    """The row one step of an address names, or ``None`` where the page has no such row."""
    if 1 <= step.position <= len(rows):
        return rows[step.position - 1]
    return None


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
