"""The per-plugin settings store — where a plugin's values are recorded, and what they mean.

Plan 0004 moves plugin configuration into the host: a plugin *declares* what it needs
(:func:`innytypes.addons.manifest.parse_settings`), and this module *records the answers*. A
plugin never opens a settings file, never validates one, and never invents a place to put one.

**One file per plugin** (D4): `plugins/<addon-id>.toml`, in the per-user **config** directory
beside the helper's `config.toml`. Per plugin rather than one shared file, so a malformed file
cannot stop anything else being read, and removing a plugin is one file to delete. The path is
injectable, so no test touches the real one.

**What the file looks like to a person.** Two tables, and the first is the only one anyone
needs to edit::

    # innytypes — recorded settings for the plugin "monty".
    ...
    [values]
    root = "/Users/someone/Recordings"
    interval = 20

    [written.root]
    by = "user"
    at = "2026-09-19T11:04:07+00:00"

`[values]` is the settings, one line each, in the order the plugin declares them — a person
opening the file reads the form they saw in the window. `[written.<id>]` is F2's bookkeeping:
who last set that value (`user`, or the plugin's own id) and when, which is what lets the form
say "set by monty" beside a value nobody typed. It is kept out of `[values]` on purpose, so
the part a person edits by hand stays one value per line.

**Every write is atomic**, with a per-process scratch name, exactly as the helper's config
does: the window and the CLI can both write, and a reader must never see half a file.

**Every read is a re-read.** There is no cache and therefore nothing to invalidate. A value
changed on disk — by the window, by the CLI, by a person with an editor — is seen by the next
read. :class:`SettingsStore` is built once and held; its answers are always current.

**Held disabled is a value, not an omission.** This is the point of the module. A plugin whose
recorded values no longer fit its declaration (D5, after an update) or whose **required**
fields have no value at all (F1) is *held disabled with the reason*:
:attr:`RecordedSettings.hold` is a :class:`Hold` naming every offending field and why, and
:attr:`RecordedSettings.availability` is :attr:`PluginAvailability.HELD`. Nothing falls back
to a default quietly, nothing is dropped, and a caller cannot mistake the state for "fine" —
"fine" is `hold is None`. Held disabled clears itself: there is no switch to flip, only values
to correct, and the next read says so.

**A `secret` value is not in this file** (D6). It goes in a file of its own, mode 0600, owned
by slice 03. This store therefore refuses a write to a `secret` field — by field, like any
other refusal, so the window shows the reason beside the widget — and holds nothing in its
place. To decide whether a **required** secret has been answered, it asks the injected
``secret_is_set`` predicate; absent one, no secret is set, which is the truthful answer when
there is no secret store wired up at all. A `table` whose row declares a `secret` **column**,
at any depth, is refused the same way and holds the plugin disabled: the file this module
writes is the one place a secret may never be, and a cell is no different from a field.

**A `table` is several records, so it is recorded several at a time** (plan 0005). Its value
is a list of rows — a TOML array of tables, nested as declared — and every cell of every row
is judged by its own column's rules, the same :func:`check_settings_value` a scalar goes
through. Three rules follow from D2, and they are the whole of what makes a table different:

* **A save records the rows that pass and refuses the rows that do not**, each named the way a
  person would name it — `recorder 2`, and `(recorder 1).takes (take 2)` inside a nested
  table, never `row 2`. Losing nine correct recorders to a typo in a tenth is what a person
  would call a bug, so a table is the one field where partial recording is right.
* **A refused row keeps what was on disk at its position.** Rows are matched to the rows
  already recorded **by position**, all the way down, so a person editing recorder 2 of ten
  sees the other nine exactly as they were. This is the difference between a row that was
  **edited** and a row that was **added**: an edited row has a previous value at its position
  and keeps it, while an **added** row has none, so a refused one is simply absent from what
  is recorded — never a half-filled row, and never one padded out with the column defaults.
  The submitted list is the whole table, so a row the user removed is removed.
* **A `unique` column may not repeat** among the rows that pass, and a repeat refuses **both**
  rows, each naming the other (D3). The marking is optional; a table without one is not asked
  the question.

A **required** table with no rows — none ever written, or a write that left it empty — holds
the plugin disabled with the reason, exactly as a required scalar with no value does (plan
0004, F1), and clears itself the moment one valid row is written. Attribution stays **per
field** (D4): one writer and one timestamp for a table, however many rows a write touched.
"""

from __future__ import annotations

import os
import re
import tomllib
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path
from types import MappingProxyType
from typing import TypeIs

from innytypes.addons.manifest import (
    ManifestError,
    SettingsField,
    check_settings_value,
    is_addon_id,
)

__all__ = [
    "SETTINGS_DIRECTORY",
    "SETTINGS_PATH_VARIABLE",
    "USER",
    "Attribution",
    "CellAddress",
    "FieldProblem",
    "Hold",
    "PluginAvailability",
    "RecordedSettings",
    "RowAt",
    "SettingsError",
    "SettingsStore",
    "WriteOutcome",
    "default_settings_path",
    "is_secret_field",
    "row_name",
    "writer_refusal",
]

# `appauthor=False` keeps the Windows vendor folder out of the path, exactly as
# `innytypes.helper.config` does for `config.toml` — these files are siblings (D4).
APPLICATION_NAME = "innytypes"

# One directory holding one file per plugin, beside `config.toml` and never inside it.
SETTINGS_DIRECTORY = "plugins"

# How the host tells an addon process where its own settings file is (plan 0012, slice 01).
# The addon process cannot work that out: :func:`default_settings_path` needs `platformdirs`,
# which an addon environment deliberately does not have, so an addon that asked the question
# for itself could not start at all. The host already knows the answer — it validated those
# values and it spawned the process — and an environment variable is how it says so.
#
# **A process told nothing falls back to asking**, which is today's behaviour exactly, so a
# host of one version and an addon of another still work together.
SETTINGS_PATH_VARIABLE = "INNYTYPES_ADDON_SETTINGS_PATH"

# The writer id for a person's own entry, from the window or the command line. Every other
# writer is a plugin, recorded under its own addon id — and `user` is not a well-formed addon
# id (no addon may be called `user`, because ids are matched against the same rule), so the
# two can never collide.
USER = "user"

_VALUES = "values"
_WRITTEN = "written"
_KNOWN_TABLES = (_VALUES, _WRITTEN)

_ATTRIBUTION_KEYS = ("by", "at")

# A TOML bare key. A field id is a plugin author's own string — `watch folder` is a legal id
# and an illegal bare key — so anything else is written as a quoted key.
_BARE_KEY = re.compile(r"^[A-Za-z0-9_-]+$")


class SettingsError(RuntimeError):
    """Raised when a settings file cannot be read, or a write cannot be attempted at all.

    This is for the file and the call, never for one value: a value that fails its own
    declaration is a :class:`FieldProblem`, reported per field, because the person reading it
    is looking at one widget in a form.
    """


class PluginAvailability(StrEnum):
    """Why a plugin is, or is not, going to be started — in words that need different actions.

    Three of these are not the same thing and must never be shown as one (plan 0004, D5/F1 and
    the enable switch's own rule):

    * :attr:`HELD` — the host is holding it back because its settings are incomplete or no
      longer fit. Fix the values and it clears itself. Produced by this module.
    * :attr:`DISABLED` — the user turned it off. Only the user turns it back on. Recorded by
      slice 06, which owns the switch.
    * :attr:`QUARANTINED` — the helper gave up restarting it (plan 0003). It takes
      `helper release`, and it is the same word as
      :attr:`innytypes.helper.breaker.RunState.QUARANTINED`.
    """

    ENABLED = "enabled"
    HELD = "held-disabled"
    DISABLED = "disabled"
    QUARANTINED = "quarantined"


@dataclass(frozen=True)
class RowAt:
    """One step down a table: whose rows, and which of them — counted from one.

    ``column`` is the table's own field id at the top level and the column id one level down,
    which is exactly what :func:`row_name` spells out for a person. Counted from one here too,
    so an address and the sentence beside it never disagree about which row is meant.
    """

    column: str
    position: int


@dataclass(frozen=True)
class CellAddress:
    """Where in a table something is wrong: the rows to descend, then the cell in the last one.

    One vocabulary for two halves of the same slice (plan 0005). A refusal from a save carries
    this, and the published form places that refusal at exactly this address — so an
    application never translates a reason into a place on the page.

    ``column`` is ``None`` when the problem is about the row as a whole rather than one of its
    cells (a row that is not a mapping, a row carrying a key the declaration does not name),
    and ``path`` is empty when it is about the whole table rather than any row of it.
    """

    path: tuple[RowAt, ...]
    column: str | None = None

    @property
    def row(self) -> CellAddress:
        """The same row, without the cell — what a drawing holding a row compares against."""
        return CellAddress(path=self.path)


@dataclass(frozen=True)
class FieldProblem:
    """One setting that is wrong, and the sentence shown beside it.

    ``reason`` always begins with the field's id, because it comes from the same validator
    that judges a manifest's defaults and is asked to name the field it is judging.

    ``cell`` is set only for a `table`, where "the field" is not a fine enough address: a
    reason about `recorder 2`'s `destination` belongs beside that cell and nowhere else.
    """

    field: str
    reason: str
    cell: CellAddress | None = None


@dataclass(frozen=True)
class Attribution:
    """Who last set one value, and when (plan 0004, F2)."""

    by: str
    at: datetime

    @property
    def by_user(self) -> bool:
        """Whether a person set this, as opposed to the plugin writing its own value back."""
        return self.by == USER


@dataclass(frozen=True)
class Hold:
    """Why a plugin is held disabled: every offending field, and one sentence to show.

    The existence of this object *is* the hold. There is no separate flag to keep in step with
    it, and no way to be held disabled without a reason naming a field.
    """

    addon_id: str
    problems: tuple[FieldProblem, ...]

    @property
    def why(self) -> str:
        """What has to be corrected, naming every offending field — and nothing else.

        Deliberately without the words "held disabled": the caller that shows this already
        shows the state, and a reason that repeats it reads "held disabled: held disabled:
        destination is required" on screen, which is what it did until somebody opened the
        window and looked.
        """
        return "; ".join(problem.reason for problem in self.problems)

    @property
    def reason(self) -> str:
        """The whole sentence, for a caller that shows no state of its own — a log, a CLI."""
        return f"held disabled: {self.why}"

    def __str__(self) -> str:
        return f"{self.addon_id} is {self.reason}"


@dataclass(frozen=True)
class RecordedSettings:
    """One plugin's settings as of one read: what is usable, what is on disk, and what is wrong.

    ``values`` is the mapping a plugin will be handed (slice 05): every declared field that has
    a **valid** value, with declared defaults filled in, and never a `secret` — a secret's
    value lives elsewhere. A field that is wrong is **absent** from it rather than defaulted,
    which is why a held plugin's values are incomplete by construction.

    ``recorded`` is the `[values]` table as it was read, unjudged and including values for
    fields the current declaration no longer mentions. The form (slice 04) draws from this
    one, because a user has to see the value that is being refused in order to correct it. Its
    one omission is a value recorded against a `secret` field, which this store will not write
    and will not hand back.
    """

    addon_id: str
    values: Mapping[str, object]
    recorded: Mapping[str, object]
    attribution: Mapping[str, Attribution]
    hold: Hold | None = None

    @property
    def availability(self) -> PluginAvailability:
        """:attr:`PluginAvailability.HELD` while anything is wrong, otherwise `ENABLED`."""
        return PluginAvailability.ENABLED if self.hold is None else PluginAvailability.HELD


@dataclass(frozen=True)
class WriteOutcome:
    """What one write did, field by field: what was recorded, and what was refused and why.

    A write is never all-or-nothing and never silently partial. The valid fields in a call are
    recorded; the invalid ones are refused by name, each with its own reason, and their prior
    values are left exactly as they were.
    """

    recorded: tuple[str, ...]
    refused: tuple[FieldProblem, ...]

    @property
    def accepted(self) -> bool:
        """Whether every field in the call was recorded."""
        return not self.refused


def default_settings_path(addon_id: str) -> Path:
    """Where one plugin's settings live for this user, creating nothing.

    ``platformdirs`` is imported **here**, for the reason
    :func:`innytypes.addons.discovery.default_addons_root` gives: this module is imported by
    :mod:`innytypes.addons.run` inside an addon's own environment, which holds `innytypes`
    and no third-party library, and an import at the top of the file would make that
    impossible.
    """
    from platformdirs import user_config_path

    directory = user_config_path(APPLICATION_NAME, appauthor=False) / SETTINGS_DIRECTORY
    return directory / f"{addon_id}.toml"


class SettingsStore:
    """One plugin's recorded settings: read them, write them, and say whether they are complete.

    Built with the declaration the plugin's **recorded manifest** carries, so a plugin update
    is a new store built from the new declaration — which is exactly what makes D5 work: the
    values on disk are unchanged, and it is the declaration they are judged against that moved.
    """

    def __init__(
        self,
        addon_id: str,
        fields: Sequence[SettingsField],
        *,
        path: Path | None = None,
        secret_is_set: Callable[[str], bool] | None = None,
    ) -> None:
        if not is_addon_id(addon_id):
            raise SettingsError(
                f"{addon_id!r} is not a well-formed addon id, so it cannot name a settings "
                "file: expected lowercase letters and digits joined by single hyphens (for "
                "example 'whodunnit')"
            )

        self.addon_id = addon_id
        self.fields = tuple(fields)
        self.path = default_settings_path(addon_id) if path is None else path
        # Slice 03 owns secrets; this store only ever asks whether one has been answered, so
        # that a required `secret` can hold a plugin disabled like any other required field.
        # No predicate means no secret store, which truthfully means no secret is set.
        self._secret_is_set = secret_is_set if secret_is_set is not None else _no_secret

    def secret_is_set(self, field_id: str) -> bool:
        """Whether a secret has been recorded for this field — never what it is (D6).

        The seam itself, exposed. The form (slice 04) has to tell a person that a token is
        already set, and a second predicate wired up beside this one is a second answer to the
        same question: they would disagree the first time one of them was wired to the real
        secret store and the other was not.
        """
        return self._secret_is_set(field_id)

    def read(self) -> RecordedSettings:
        """Read the file now — every time — and judge it against the declaration."""
        document = self._document()
        recorded = _values_table(document, path=self.path)
        attribution = _attribution_table(document, path=self.path)

        values: dict[str, object] = {}
        problems: list[FieldProblem] = []

        for field in self.fields:
            problems.extend(self._judge(field, recorded, into=values))

        return RecordedSettings(
            addon_id=self.addon_id,
            values=values,
            recorded=self._without_secrets(recorded),
            attribution=attribution,
            hold=None if not problems else Hold(self.addon_id, tuple(problems)),
        )

    def write(self, values: Mapping[str, object], *, by: str) -> WriteOutcome:
        """Record the fields in ``values`` that ``by`` may set and that pass their declaration.

        ``by`` is :data:`USER` or this plugin's own id, and nothing else: a plugin writes only
        its own settings (D11), so there is no argument anywhere that names another plugin.
        Passing one is a mistake in the caller rather than a bad value, and is refused whole.

        The file is only touched when at least one field was accepted, so a call whose every
        field is refused changes nothing at all.
        """
        if by != USER and by != self.addon_id:
            raise SettingsError(
                f"a write to {self.addon_id!r}'s settings was made in the name of {by!r}: a "
                f"plugin writes only its own settings, so `by` is {USER!r} or {self.addon_id!r}"
            )

        declared = {field.id: field for field in self.fields}
        accepted: dict[str, object] = {}
        refused: list[FieldProblem] = []

        for field_id, value in values.items():
            field = declared.get(field_id)
            if field is None:
                refused.append(
                    FieldProblem(
                        field_id,
                        f"{field_id} is not a setting {self.addon_id} declares, so there is "
                        "nothing to record it against",
                    )
                )
                continue

            problem = _may_write(field, by=by, addon_id=self.addon_id)
            if problem is not None:
                refused.append(problem)
                continue

            if field.row is not None:
                self._write_rows(field, value, accepted=accepted, refused=refused)
                continue

            try:
                accepted[field_id] = check_settings_value(field, value, where=field_id)
            except ManifestError as error:
                refused.append(FieldProblem(field_id, str(error)))

        if accepted:
            self._record(accepted, by=by)

        return WriteOutcome(recorded=tuple(accepted), refused=tuple(refused))

    def _write_rows(
        self,
        field: SettingsField,
        value: object,
        *,
        accepted: dict[str, object],
        refused: list[FieldProblem],
    ) -> None:
        """One table in one write: the rows that pass, over the rows already on disk (D2).

        The rows on disk are read here rather than carried from an earlier read, for the same
        reason :meth:`_record` re-reads: a row another writer recorded in between is what a
        refused row at that position falls back to.
        """
        judged = _judge_rows(
            field.row or (),
            field.row_label or field.id,
            value,
            field_id=field.id,
            previous=self._recorded_rows(field.id),
        )
        refused.extend(judged.problems)

        if judged.rows is None:
            return

        # Nothing passed and nothing was submitted: the caller emptied the table, which is a
        # change to record. Nothing passed out of rows that *were* submitted is a write that
        # changes nothing at all, so the file is left exactly as it is.
        if judged.passed or judged.submitted == 0:
            accepted[field.id] = judged.rows

    def _recorded_rows(self, field_id: str) -> tuple[object, ...] | None:
        """The rows recorded for one field right now, unjudged — or ``None`` if it holds none."""
        value = _values_table(self._document(), path=self.path).get(field_id)
        if isinstance(value, Sequence) and not isinstance(value, str):
            return tuple(value)
        return None

    # --- the two halves of a read ----------------------------------------------------------

    def _without_secrets(self, recorded: Mapping[str, object]) -> Mapping[str, object]:
        """Everything on disk except a value recorded against a `secret` field.

        Nothing this store writes can put one there, so such a value is a file somebody
        mangled by hand. It is left on disk untouched and it is not handed back: a secret's
        value is never readable through this store, by anyone, whatever the file says (D6).
        That is why the form (slice 04) can draw from ``recorded`` without a rule of its own.
        """
        secrets = {
            field.id
            for field in self.fields
            if is_secret_field(field) or _secret_column(field) is not None
        }
        return {key: value for key, value in recorded.items() if key not in secrets}

    def _judge(
        self, field: SettingsField, recorded: Mapping[str, object], *, into: dict[str, object]
    ) -> list[FieldProblem]:
        """One declared field: fill in its value, or say why it cannot be.

        A list rather than one problem, because a table is several records and a read that
        found three bad rows has three things to say about one field (plan 0005, D2).
        """
        if field.row is not None:
            return self._judge_table(field, recorded, into=into)

        if is_secret_field(field):
            # The value is not here and never was. All this store can say is whether one has
            # been answered, which only matters when the author made it required.
            if field.required and not self._secret_is_set(field.id):
                return [
                    FieldProblem(
                        field.id,
                        f"{field.id} is a required secret and none has been recorded yet",
                    )
                ]
            return []

        if field.id in recorded:
            try:
                into[field.id] = check_settings_value(field, recorded[field.id], where=field.id)
            except ManifestError as error:
                # D5: not defaulted, not dropped — reported, with the value left on disk.
                return [FieldProblem(field.id, str(error))]
            return []

        if field.default is not None:
            into[field.id] = field.default
            return []

        if field.required:
            # F1: installed enabled, held disabled until it is answered.
            return [FieldProblem(field.id, f"{field.id} is required and has no value")]

        return []

    def _judge_table(
        self, field: SettingsField, recorded: Mapping[str, object], *, into: dict[str, object]
    ) -> list[FieldProblem]:
        """One declared `table`: the rows that pass, and a reason for each row that does not.

        The rows that pass are handed over even while others are refused, because a table of
        ten recorders is ten things the user entered rather than one (D2). What holds the
        plugin is the hold, not the absence of the field.
        """
        columns = field.row or ()
        row_label = field.row_label or field.id

        secret = _secret_column(field)
        if secret is not None:
            return [FieldProblem(field.id, _secret_column_refusal(field.id, secret))]

        if field.id not in recorded:
            if field.default is not None:
                # The declared rows, judged by the same rules a recorded one is, so a column's
                # own default fills its cell here exactly as it does in a row the user typed.
                declared = _judge_rows(columns, row_label, field.default, field_id=field.id)
                into[field.id] = declared.rows or ()
                return []
            if field.required:
                return [FieldProblem(field.id, _no_rows(field.id, row_label))]
            return []

        judged = _judge_rows(columns, row_label, recorded[field.id], field_id=field.id)
        problems = list(judged.problems)
        if judged.rows is None:
            # Not a list at all, so there are no rows to salvage: the whole field is refused.
            return problems

        if not judged.rows and field.required:
            # F1 again, and the same shape: a required table with nothing usable in it has no
            # value, so it is absent from `values` exactly as a required scalar would be.
            problems.append(FieldProblem(field.id, _no_rows(field.id, row_label)))
            return problems

        into[field.id] = judged.rows
        return problems

    # --- the file ----------------------------------------------------------------------------

    def _document(self) -> Mapping[str, object]:
        """Parse the file, or refuse it by name. A file that is not there is an empty one."""
        try:
            raw = self.path.read_bytes()
        except FileNotFoundError:
            return {}
        except OSError as error:
            raise SettingsError(f"{self.path} could not be read: {error}") from error

        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError as error:
            raise SettingsError(f"{self.path} is not UTF-8 text: {error}") from error

        try:
            document = dict(tomllib.loads(text))
        except tomllib.TOMLDecodeError as error:
            raise SettingsError(f"{self.path} is not valid TOML: {error}") from error

        unknown = sorted(set(document) - set(_KNOWN_TABLES))
        if unknown:
            raise SettingsError(
                f"{self.path} has table(s) this store does not write: {', '.join(unknown)}. "
                f"A settings file holds {' and '.join(_KNOWN_TABLES)}, and nothing else."
            )
        return document

    def _record(self, accepted: Mapping[str, object], *, by: str) -> None:
        """Merge the accepted fields into the file and write the whole of it back, atomically.

        The file is re-read here rather than carried from an earlier read, so a value another
        writer recorded in between survives this one — the same re-read discipline the reads
        follow, applied to the write.

        Values for fields the current declaration no longer mentions are kept untouched: a
        plugin that dropped a field, or was downgraded, must not cost the user what they typed.
        """
        document = self._document()
        values = dict(_values_table(document, path=self.path))
        written = {
            field_id: {"by": attribution.by, "at": attribution.at.isoformat()}
            for field_id, attribution in _attribution_table(document, path=self.path).items()
        }

        stamp = _now().isoformat(timespec="seconds")
        for field_id, value in accepted.items():
            values[field_id] = value
            written[field_id] = {"by": by, "at": stamp}

        _write_atomically(
            self.path,
            _dump(self.addon_id, values, written, order=[field.id for field in self.fields]),
        )


def _no_secret(field_id: str) -> bool:
    """The answer when no secret store is wired up: nothing has been recorded."""
    return False


def _now() -> datetime:
    """The moment a write happened, in UTC, so two machines' files can be compared."""
    return datetime.now(tz=UTC)


def is_secret_field(field: SettingsField) -> bool:
    """Whether this field's value belongs in the secret store rather than here (D6).

    Public because the secret store (slice 03) asks the same question about the same
    declaration, and two answers to "is this a secret?" is one answer too many.
    """
    return field.type == "secret" or field.element_type == "secret"


def _may_write(field: SettingsField, *, by: str, addon_id: str) -> FieldProblem | None:
    """Whether this writer may set this field at all, before its value is even judged (F2)."""
    if is_secret_field(field):
        return FieldProblem(
            field.id,
            f"{field.id} is a secret, and a secret is never recorded in a settings file: it "
            "is kept in a file of its own that nothing reads back",
        )

    column = _secret_column(field)
    if column is not None:
        return FieldProblem(field.id, _secret_column_refusal(field.id, column))

    return writer_refusal(field, by=by, addon_id=addon_id)


def _secret_column(field: SettingsField) -> str | None:
    """The path to the first `secret` column in a table's row, at any depth, or ``None``.

    A table is the one field whose value holds other people's values, so D6 has to be asked of
    every cell as well as of every field: a row a plugin could put a token in would put that
    token in this file, which is the one place a secret may never be.
    """
    for column in field.row or ():
        if is_secret_field(column):
            return column.id
        deeper = _secret_column(column)
        if deeper is not None:
            return f"{column.id}.{deeper}"
    return None


def _secret_column_refusal(field_id: str, column: str) -> str:
    return (
        f"{field_id} declares {column!r} as a secret column, and a secret is never recorded in "
        "a settings file: it is kept in a file of its own that nothing reads back"
    )


def _no_rows(field_id: str, row_label: str) -> str:
    """F1, for a table: required and empty is required and unanswered."""
    return f"{field_id} is required and holds no {row_label}"


def writer_refusal(field: SettingsField, *, by: str, addon_id: str) -> FieldProblem | None:
    """Whether ``written_by`` lets this writer set this field at all (F2), or why it does not.

    Public because a `secret` is subject to exactly this rule and is not stored here: the
    runner routes a plugin's write to a `secret` field to
    :func:`innytypes.addons.secrets.store_secret`, and asks this question first so that
    "only its own, and only `plugin` or `both`" has one implementation rather than two that
    can disagree the day one of them is amended.
    """
    if by == USER and field.written_by == "plugin":
        return FieldProblem(
            field.id,
            f"{field.id} is declared written_by 'plugin', so only {addon_id} sets it",
        )

    if by != USER and field.written_by == USER:
        return FieldProblem(
            field.id,
            f"{field.id} is declared written_by 'user', so {addon_id} may not set it",
        )

    return None


# --- judging a table's rows (plan 0005, D2 and D3) ---------------------------------------------


@dataclass(frozen=True)
class _JudgedRows:
    """What one list of rows came to.

    ``rows`` is what would be recorded: the rows that passed, and — where a submitted row was
    refused and one was already on disk at that position — the row that was there before. It
    is ``None`` only when the value was not a list of rows at all, which is the one refusal
    that takes the whole field down rather than one row of it.
    """

    rows: tuple[Mapping[str, object], ...] | None
    problems: tuple[FieldProblem, ...]
    submitted: int
    passed: int


def _judge_rows(
    columns: tuple[SettingsField, ...],
    row_label: str,
    value: object,
    *,
    field_id: str,
    previous: Sequence[object] | None = None,
    parent: str | None = None,
    column_id: str | None = None,
    at: tuple[RowAt, ...] = (),
) -> _JudgedRows:
    """A table's whole value: every row judged on its own, and named as a person would name it.

    ``previous`` is what was recorded at this same address before, matched **by position**, so
    a refused row keeps what it had. A read passes none — there is nothing to fall back to
    when the question is simply what is on disk.

    ``parent`` and ``column_id`` are how a nested table names its rows: ``recorder 2`` at the
    top, ``(recorder 1).takes (take 2)`` one level down, to whatever depth the declaration
    nests to. ``at`` is the same descent as an address rather than as a sentence — the rows
    already stepped through to reach this table — and it is what every problem below is
    addressed by, so the form can put each reason on the cell it is about.
    """
    if not isinstance(value, Sequence) or isinstance(value, str):
        where = field_id if parent is None else f"{field_id}: {parent}'s {column_id}"
        return _JudgedRows(
            None,
            (
                FieldProblem(
                    field_id,
                    f"{where} must be a list of {row_label}s, got {type(value).__name__}",
                    # The cell that holds this table, so a nested one is refused where it is
                    # drawn; at the top there is no row above it and the field itself is it.
                    cell=CellAddress(path=at, column=column_id),
                ),
            ),
            submitted=0,
            passed=0,
        )

    holder = column_id if column_id is not None else field_id
    names = [
        row_name(row_label, position, parent=parent, column_id=column_id)
        for position in range(1, len(value) + 1)
    ]
    addresses = [at + (RowAt(holder, position),) for position in range(1, len(value) + 1)]

    problems: list[FieldProblem] = []
    judged: list[Mapping[str, object] | None] = []
    for index, submitted in enumerate(value):
        row, row_problems = _judge_row(
            columns,
            row_label,
            submitted,
            field_id=field_id,
            name=names[index],
            at=addresses[index],
            previous=_previous_row(previous, index),
        )
        judged.append(row)
        problems.extend(row_problems)

    # D3, and only over the rows that would otherwise pass: a row already refused for a cell
    # of its own is not also accused of repeating an identity it never had.
    repeated, repeat_problems = _repeated_identities(
        columns, row_label, judged, names, addresses, field_id=field_id
    )
    problems.extend(repeat_problems)

    recorded: list[Mapping[str, object]] = []
    passed = 0
    for index, row in enumerate(judged):
        if row is not None and index not in repeated:
            recorded.append(row)
            passed += 1
            continue
        # D2: an EDITED row keeps what was on disk at its position; an ADDED one has nothing
        # there to keep, so it is absent rather than half-recorded.
        kept = _previous_row(previous, index)
        if kept is not None:
            recorded.append(kept)

    return _JudgedRows(tuple(recorded), tuple(problems), submitted=len(value), passed=passed)


def _judge_row(
    columns: tuple[SettingsField, ...],
    row_label: str,
    value: object,
    *,
    field_id: str,
    name: str,
    at: tuple[RowAt, ...],
    previous: Mapping[str, object] | None,
) -> tuple[Mapping[str, object] | None, list[FieldProblem]]:
    """One row: every declared column judged by its own rules, and nothing else allowed in.

    Every refusal names the row the way the window will — the row_label and the position
    counted from one — and carries the wording ``check_settings_value`` produces for that
    column's type after it, so a number's `min` refusal reads the same whether the number is a
    top-level field or a cell.

    ``at`` is this row's own address, and every problem here is addressed to a cell of it, or
    to the row itself where there is no one cell to blame.
    """
    if not isinstance(value, Mapping):
        return None, [
            FieldProblem(
                field_id,
                f"{field_id}: {name} must be a mapping of cells, got {type(value).__name__}",
                cell=CellAddress(path=at),
            )
        ]

    declared = {column.id: column for column in columns}
    problems: list[FieldProblem] = []
    refused = False

    undeclared = sorted(set(value) - set(declared))
    if undeclared:
        # Not a free-form mapping: a settings type a plugin can put anything into is a
        # settings file by another name.
        problems.append(
            FieldProblem(
                field_id,
                f"{field_id}: {name} carries "
                f"{', '.join(repr(key) for key in undeclared)}, which the {row_label} "
                f"declaration does not name; its columns are {', '.join(declared)}",
                # The row itself: there is no cell by that name to hang this beside.
                cell=CellAddress(path=at),
            )
        )
        refused = True

    held: dict[str, object] = {}
    for column in columns:
        if column.id not in value:
            if column.default is not None:
                held[column.id] = _default_cell(column, field_id=field_id, name=name, at=at)
            elif column.required:
                problems.append(
                    FieldProblem(
                        field_id,
                        f"{field_id}: {name} is missing {column.id!r}, which every "
                        f"{row_label} must have and which declares no default of its own",
                        cell=CellAddress(path=at, column=column.id),
                    )
                )
                refused = True
            continue

        if column.row is not None:
            nested = _judge_rows(
                column.row,
                column.row_label or column.id,
                value[column.id],
                field_id=field_id,
                previous=_previous_cell(previous, column.id),
                parent=name,
                column_id=column.id,
                at=at,
            )
            problems.extend(nested.problems)
            if nested.rows is None:
                refused = True
                continue
            if column.required and not nested.rows:
                problems.append(
                    FieldProblem(
                        field_id,
                        f"{field_id}: {name} holds no {column.row_label or column.id}, and "
                        f"every {row_label} must have at least one",
                        cell=CellAddress(path=at, column=column.id),
                    )
                )
                refused = True
                continue
            held[column.id] = nested.rows
            continue

        try:
            held[column.id] = check_settings_value(column, value[column.id], where=column.id)
        except ManifestError as error:
            problems.append(
                FieldProblem(
                    field_id,
                    f"{field_id}: {name}'s {error}",
                    cell=CellAddress(path=at, column=column.id),
                )
            )
            refused = True

    if refused:
        return None, problems
    # Immutable, like every value handed out of a declaration: the form, the runtime and the
    # store all read these rows, and none of them owns them.
    return MappingProxyType(held), problems


def _repeated_identities(
    columns: tuple[SettingsField, ...],
    row_label: str,
    judged: Sequence[Mapping[str, object] | None],
    names: Sequence[str],
    addresses: Sequence[tuple[RowAt, ...]],
    *,
    field_id: str,
) -> tuple[set[int], list[FieldProblem]]:
    """The rows whose `unique` column repeats, refused in pairs, each naming the other (D3).

    Both rows, never only the second: the user typed two of them and neither is more wrong
    than the other, and a message that names one leaves the other looking correct.
    """
    identity = next((column for column in columns if column.unique), None)
    if identity is None:
        # The marking is optional, and a table that declares none is asked nothing.
        return set(), []

    positions: dict[object, list[int]] = {}
    for index, row in enumerate(judged):
        if row is None or identity.id not in row:
            continue
        positions.setdefault(row[identity.id], []).append(index)

    repeated: set[int] = set()
    problems: list[FieldProblem] = []
    for value, indexes in positions.items():
        if len(indexes) < 2:
            continue
        repeated.update(indexes)
        for index in indexes:
            others = ", ".join(names[other] for other in indexes if other != index)
            problems.append(
                FieldProblem(
                    field_id,
                    f"{field_id}: {names[index]}'s {identity.id} is {value!r}, which {others} "
                    f"also has; {identity.id} identifies a {row_label}, so two cannot share one",
                    cell=CellAddress(path=addresses[index], column=identity.id),
                )
            )
    return repeated, problems


def _default_cell(
    column: SettingsField, *, field_id: str, name: str, at: tuple[RowAt, ...]
) -> object:
    """What a column's own default puts in a cell the row left out.

    A nested table's default is a set of rows, so it goes through the same judgement a
    recorded set does — which is what fills ITS columns' defaults in turn.
    """
    if column.row is None:
        return column.default

    declared = _judge_rows(
        column.row,
        column.row_label or column.id,
        column.default,
        field_id=field_id,
        parent=name,
        column_id=column.id,
        at=at,
    )
    return declared.rows or ()


def row_name(row_label: str, position: int, *, parent: str | None, column_id: str | None) -> str:
    """What a row is called on screen: `recorder 2`, or `(recorder 1).takes (take 2)` inside one.

    Counted from one, because this names a thing a person sees rather than a place in a file
    the author wrote — those are the declaration's own `row[1]`, counted from zero.

    Public because the published form (slice 03) names the rows it draws, and a second
    spelling of this is a row called one thing in a refusal and another on the page.
    """
    if parent is None:
        return f"{row_label} {position}"
    return f"({parent}).{column_id} ({row_label} {position})"


def _previous_row(previous: Sequence[object] | None, index: int) -> Mapping[str, object] | None:
    """The row recorded at this position before, if there is one this store could hand back."""
    if previous is None or index >= len(previous):
        return None
    recorded = previous[index]
    return recorded if isinstance(recorded, Mapping) else None


def _previous_cell(
    previous: Mapping[str, object] | None, column_id: str
) -> Sequence[object] | None:
    """The nested rows recorded in this cell before, so a refused one deep down keeps its own."""
    if previous is None:
        return None
    recorded = previous.get(column_id)
    if isinstance(recorded, Sequence) and not isinstance(recorded, str):
        return recorded
    return None


# --- reading the two tables ------------------------------------------------------------------


def _values_table(document: Mapping[str, object], *, path: Path) -> Mapping[str, object]:
    """The `[values]` table exactly as recorded, judged by nothing."""
    table = document.get(_VALUES, {})
    if not isinstance(table, Mapping):
        raise SettingsError(f"{path}: [{_VALUES}] must be a table of settings, got {table!r}")
    return dict(table)


def _attribution_table(document: Mapping[str, object], *, path: Path) -> Mapping[str, Attribution]:
    """The `[written.<id>]` tables: who set each value, and when."""
    table = document.get(_WRITTEN, {})
    if not isinstance(table, Mapping):
        raise SettingsError(f"{path}: [{_WRITTEN}] must be a table of attributions, got {table!r}")

    attribution: dict[str, Attribution] = {}
    for field_id, entry in table.items():
        where = f"{path}: [{_WRITTEN}.{field_id}]"
        if not isinstance(entry, Mapping):
            raise SettingsError(f"{where} must be a table with 'by' and 'at', got {entry!r}")

        missing = [key for key in _ATTRIBUTION_KEYS if key not in entry]
        if missing:
            raise SettingsError(f"{where} is missing {', '.join(missing)}")

        by = entry["by"]
        if not isinstance(by, str):
            raise SettingsError(f"{where} has a 'by' that is not a writer's name: {by!r}")

        attribution[field_id] = Attribution(by=by, at=_timestamp(entry["at"], where=where))
    return attribution


def _timestamp(value: object, *, where: str) -> datetime:
    """One recorded `at`, refused rather than guessed at."""
    if isinstance(value, datetime):
        return value
    if not isinstance(value, str):
        raise SettingsError(f"{where} has an 'at' that is not a timestamp: {value!r}")
    try:
        return datetime.fromisoformat(value)
    except ValueError as error:
        raise SettingsError(f"{where} has an 'at' that is not a timestamp: {value!r}") from error


# --- writing the file --------------------------------------------------------------------------


def _write_atomically(path: Path, text: str) -> None:
    """Write the whole file through a scratch name and one rename, or leave it as it was.

    Per process, as the helper's config already is: the window and the CLI both write these
    files, and two writers sharing one scratch name would corrupt each other. The scratch file
    is removed when the rename does not happen, so a failed write leaves nothing behind.
    """
    path.parent.mkdir(parents=True, exist_ok=True)

    temporary = path.with_name(f".{path.name}.{os.getpid()}.new")
    temporary.write_text(text, encoding="utf-8")
    try:
        os.replace(temporary, path)
    except OSError:
        temporary.unlink(missing_ok=True)
        raise


def _dump(
    addon_id: str,
    values: Mapping[str, object],
    written: Mapping[str, Mapping[str, str]],
    *,
    order: Sequence[str],
) -> str:
    """The whole file, written so a person can read and edit it.

    Declared fields come first, in the order the plugin declares them, so the file reads like
    the form. Anything else — a value left over from a declaration that has since changed —
    follows, sorted, rather than being lost.

    A table's rows are written as TOML's array of tables, ``[[values.volumes]]``, nested as
    declared — the one shape that keeps a settings file something a person can read and edit
    (plan 0005). Every one-line value therefore has to be written before the first such block,
    since a block header is where ``[values]`` stops.
    """
    lines = [
        f'# innytypes — recorded settings for the plugin "{addon_id}".',
        "#",
        "# The values below are yours to edit; innytypes re-reads this file on every read, so a",
        "# change takes effect without a restart. A value that does not fit what the plugin",
        "# declares holds the plugin disabled, with the reason shown in the application, and is",
        "# never quietly replaced with a default.",
        "#",
        "# [written.<setting>] records who last set each value and when. A secret is never",
        "# recorded here.",
        "",
        f"[{_VALUES}]",
    ]

    ordered = _ordered(values, order=order)
    for field_id in ordered:
        value = values[field_id]
        if not _is_rows(value):
            lines.append(f"{_key(field_id)} = {_value(value)}")

    for field_id in ordered:
        value = values[field_id]
        if _is_rows(value):
            _append_rows(lines, f"{_VALUES}.{_key(field_id)}", value)

    for field_id in _ordered(written, order=order):
        entry = written[field_id]
        lines.append("")
        lines.append(f"[{_WRITTEN}.{_key(field_id)}]")
        for key in _ATTRIBUTION_KEYS:
            lines.append(f"{key} = {_value(entry[key])}")

    return "\n".join(lines) + "\n"


def _is_rows(value: object) -> TypeIs[Sequence[Mapping[str, object]]]:
    """Whether this value is a table's rows, and so is written as an array of tables.

    Asked of the value rather than of the declaration, so rows left over from a declaration
    that has since dropped the table are written back out rather than refused (the same rule
    every other left-over value already gets). An empty list is not rows — there is no header
    to write — so it goes back as ``volumes = []``, which is what emptying a table records.
    """
    if not isinstance(value, Sequence) or isinstance(value, str) or not value:
        return False
    return all(isinstance(row, Mapping) for row in value)


def _append_rows(lines: list[str], header: str, rows: Sequence[Mapping[str, object]]) -> None:
    """One table's rows, and its nested tables' rows under them, as TOML array-of-tables blocks.

    A nested block belongs to the row it follows, so every one-line cell of a row is written
    before the first nested header — the same rule the file as a whole obeys.
    """
    for row in rows:
        lines.append("")
        lines.append(f"[[{header}]]")
        nested = [(key, value) for key, value in row.items() if _is_rows(value)]
        for key, value in row.items():
            if not _is_rows(value):
                lines.append(f"{_key(key)} = {_value(value)}")
        for key, value in nested:
            _append_rows(lines, f"{header}.{_key(key)}", value)


def _ordered(table: Mapping[str, object], *, order: Sequence[str]) -> list[str]:
    """Declared ids in the declaration's order, then whatever else the file still holds."""
    declared = [field_id for field_id in order if field_id in table]
    return declared + sorted(set(table) - set(declared))


def _key(field_id: str) -> str:
    """A field id as a TOML key: bare where it can be, quoted where it cannot."""
    return field_id if _BARE_KEY.match(field_id) else _string(field_id)


def _value(value: object) -> str:
    """One TOML value, in the only types a settings file can hold.

    Nothing else can reach here: every value was judged against its declaration, and the
    declaration's vocabulary is closed at D1's types. The refusal is here so that stops being
    true loudly rather than by writing something no loader would accept.
    """
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int | float):
        return repr(value)
    if isinstance(value, str):
        return _string(value)
    if isinstance(value, Sequence):
        return "[" + ", ".join(_value(item) for item in value) + "]"
    raise SettingsError(f"{value!r} is not a value a settings file can hold")


def _string(text: str) -> str:
    escaped = (
        text.replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\b", "\\b")
        .replace("\t", "\\t")
        .replace("\n", "\\n")
        .replace("\f", "\\f")
        .replace("\r", "\\r")
    )
    return f'"{escaped}"'
