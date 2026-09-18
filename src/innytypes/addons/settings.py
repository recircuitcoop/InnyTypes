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
there is no secret store wired up at all.
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

from platformdirs import user_config_path

from innytypes.addons.manifest import (
    ManifestError,
    SettingsField,
    check_settings_value,
    is_addon_id,
)

__all__ = [
    "SETTINGS_DIRECTORY",
    "USER",
    "Attribution",
    "FieldProblem",
    "Hold",
    "PluginAvailability",
    "RecordedSettings",
    "SettingsError",
    "SettingsStore",
    "WriteOutcome",
    "default_settings_path",
]

# `appauthor=False` keeps the Windows vendor folder out of the path, exactly as
# `innytypes.helper.config` does for `config.toml` — these files are siblings (D4).
APPLICATION_NAME = "innytypes"

# One directory holding one file per plugin, beside `config.toml` and never inside it.
SETTINGS_DIRECTORY = "plugins"

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
class FieldProblem:
    """One setting that is wrong, and the sentence shown beside it.

    ``reason`` always begins with the field's id, because it comes from the same validator
    that judges a manifest's defaults and is asked to name the field it is judging.
    """

    field: str
    reason: str


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
    def reason(self) -> str:
        """One sentence, naming every field that has to be corrected."""
        return f"held disabled: {'; '.join(problem.reason for problem in self.problems)}"

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
    """Where one plugin's settings live for this user, creating nothing."""
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

    def read(self) -> RecordedSettings:
        """Read the file now — every time — and judge it against the declaration."""
        document = self._document()
        recorded = _values_table(document, path=self.path)
        attribution = _attribution_table(document, path=self.path)

        values: dict[str, object] = {}
        problems: list[FieldProblem] = []

        for field in self.fields:
            problem = self._judge(field, recorded, into=values)
            if problem is not None:
                problems.append(problem)

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

            try:
                accepted[field_id] = check_settings_value(field, value, where=field_id)
            except ManifestError as error:
                refused.append(FieldProblem(field_id, str(error)))

        if accepted:
            self._record(accepted, by=by)

        return WriteOutcome(recorded=tuple(accepted), refused=tuple(refused))

    # --- the two halves of a read ----------------------------------------------------------

    def _without_secrets(self, recorded: Mapping[str, object]) -> Mapping[str, object]:
        """Everything on disk except a value recorded against a `secret` field.

        Nothing this store writes can put one there, so such a value is a file somebody
        mangled by hand. It is left on disk untouched and it is not handed back: a secret's
        value is never readable through this store, by anyone, whatever the file says (D6).
        That is why the form (slice 04) can draw from ``recorded`` without a rule of its own.
        """
        secrets = {field.id for field in self.fields if _is_secret(field)}
        return {key: value for key, value in recorded.items() if key not in secrets}

    def _judge(
        self, field: SettingsField, recorded: Mapping[str, object], *, into: dict[str, object]
    ) -> FieldProblem | None:
        """One declared field: fill in its value, or say why it cannot be."""
        if _is_secret(field):
            # The value is not here and never was. All this store can say is whether one has
            # been answered, which only matters when the author made it required.
            if field.required and not self._secret_is_set(field.id):
                return FieldProblem(
                    field.id,
                    f"{field.id} is a required secret and none has been recorded yet",
                )
            return None

        if field.id in recorded:
            try:
                into[field.id] = check_settings_value(field, recorded[field.id], where=field.id)
            except ManifestError as error:
                # D5: not defaulted, not dropped — reported, with the value left on disk.
                return FieldProblem(field.id, str(error))
            return None

        if field.default is not None:
            into[field.id] = field.default
            return None

        if field.required:
            # F1: installed enabled, held disabled until it is answered.
            return FieldProblem(field.id, f"{field.id} is required and has no value")

        return None

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


def _is_secret(field: SettingsField) -> bool:
    """Whether this field's value belongs in the secret store rather than here (D6)."""
    return field.type == "secret" or field.element_type == "secret"


def _may_write(field: SettingsField, *, by: str, addon_id: str) -> FieldProblem | None:
    """Whether this writer may set this field at all, before its value is even judged (F2)."""
    if _is_secret(field):
        return FieldProblem(
            field.id,
            f"{field.id} is a secret, and a secret is never recorded in a settings file: it "
            "is kept in a file of its own that nothing reads back",
        )

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

    for field_id in _ordered(values, order=order):
        lines.append(f"{_key(field_id)} = {_value(values[field_id])}")

    for field_id in _ordered(written, order=order):
        entry = written[field_id]
        lines.append("")
        lines.append(f"[{_WRITTEN}.{_key(field_id)}]")
        for key in _ATTRIBUTION_KEYS:
            lines.append(f"{key} = {_value(entry[key])}")

    return "\n".join(lines) + "\n"


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
    escaped = text.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'
