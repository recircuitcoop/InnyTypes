"""The helper's `config.toml` — every switch the helper reads, and the rules for reading it.

This is the first slice of plan 0003, and every later one reads it: the telemetry pipeline
asks whether it may send, the updater asks whether it may check, the stabilizer asks for its
tick and its limits, and the plugin updater asks for each plugin's mode and pin. The file
lives in the per-user **config** directory resolved by `platformdirs` — the addons live in
the **data** directory (`innytypes.addons.discovery`), and the two are deliberately not the
same place. The path is injectable everywhere, so no test touches the real one.

**The three-state telemetry switch.** `telemetry` is a boolean in the file, and its
*absence* is a third state: the first-launch question has not been answered, and until it is,
nothing is sent **and nothing is queued** (plan 0003 F2). That is why this module hands out a
:class:`Telemetry` member rather than a `bool | None`: `if not config.telemetry` reads
"unanswered" and "answered no" the same way, and the difference between them is the whole
point. Callers ask :attr:`Telemetry.may_send` (true only for `ON`) or
:attr:`Telemetry.answered` (false only for `UNSET`), and neither question can be answered by
accident.

**Live re-read is a property of the API, not a habit of the caller.** The plan says the
helper re-reads the switches before every check and every send, so :class:`HelperSettings`
re-reads the file on **every** access. There is no cache and therefore no invalidation to
forget: a switch the user flips takes effect on the next read, with no restart. The cost is
parsing a small file a few times a minute, which is nothing next to a helper that keeps
sending reports for an hour after the user said stop. Code that wants one consistent picture
of several keys reads :attr:`HelperSettings.current` once and uses that snapshot.

**What this module refuses, and why each choice was made deliberately.**

*A missing file is not an error.* It is the first launch, and the answer is every documented
default with `telemetry` unset. Reading never creates the file or its directory.

*An unreadable file is an error.* Defaulting there would answer "did the user turn telemetry
off?" with a guess, and the guess would be "no". A read that failed is not an answer.

*Invalid TOML, an unknown key, a wrong type or an impossible value are errors*, naming the
file, the section and the key. The house style refuses rather than warns
(`innytypes.addons.manifest`), and the reason is sharper here than anywhere else: this file
decides which processes get killed and what leaves the machine. A helper that guessed at a
key it did not understand would be doing one of those things for a reason nobody wrote down.

The cost of that choice is real — one bad key stops the helper starting — so it is paid for
in the refusals themselves rather than by softening them: every message names the file, the
section, the key and what was expected, so the fix is one line, and the CLI prints that
message instead of a traceback. Writing follows the same rule: `innytypes telemetry on` on a
file it cannot parse refuses rather than rewriting it, because a rewrite would silently
discard whatever the user had written there.

**Writing back.** `innytypes telemetry on|off` and `innytypes addons pin|unpin` change the
file. They re-serialize the document they read, so every value survives — including sections
this slice does not interpret further, such as another plugin's table. Comments and blank
lines do not survive: the standard library parses TOML (`tomllib`) and writes none, and a
pinned-dependency rule (plan 0001) makes a formatting-preserving library a poor trade for a
file the application itself edits.
"""

from __future__ import annotations

import os
import tomllib
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import cast

from platformdirs import user_config_path

from innytypes.addons.manifest import StabilityProfile, is_addon_id

__all__ = [
    "APPLICATION_NAME",
    "CONFIG_FILENAME",
    "DEFAULT_MAX_CHILDREN",
    "BreakerSettings",
    "HelperConfig",
    "HelperConfigError",
    "HelperNumbers",
    "HelperSettings",
    "PluginOverride",
    "PluginSettings",
    "RestartSettings",
    "Telemetry",
    "UpdateMode",
    "UpdateSettings",
    "default_config_path",
    "load_helper_config",
    "parse_helper_config",
]

# `appauthor=False` keeps the Windows vendor folder out of the path, exactly as
# `innytypes.addons.discovery` does for the data directory.
APPLICATION_NAME = "innytypes"
CONFIG_FILENAME = "config.toml"

# The one stability limit a manifest deliberately leaves open: `max_children` has no default
# there because the plan calls it the "helper-wide default", and this is that default.
DEFAULT_MAX_CHILDREN = 32


class HelperConfigError(RuntimeError):
    """Raised when `config.toml` cannot be read, or says something the helper will not act on.

    There is no softer outcome. A caller either gets a configuration every later slice can
    rely on, or an error naming the file, the key and what was expected instead.
    """


class Telemetry(StrEnum):
    """The three states of the telemetry switch: unanswered, on, off.

    `UNSET` is not a missing value to be filled in with a default. It is the state the
    application is in before the first-launch question has been answered, and plan 0003 F2
    makes it behave like `OFF` for sending **and** for queueing, while staying distinguishable
    from it so the application knows it still has to ask.
    """

    UNSET = "unset"
    ON = "on"
    OFF = "off"

    @property
    def answered(self) -> bool:
        """Whether the user has answered the first-launch question."""
        return self is not Telemetry.UNSET

    @property
    def may_send(self) -> bool:
        """Whether anything at all may be sent **or queued**. True for `ON` only."""
        return self is Telemetry.ON


class UpdateMode(StrEnum):
    """What the helper does about a plugin's new versions (plan 0003, D18)."""

    AUTO = "auto"
    MANUAL = "manual"
    OFF = "off"


@dataclass(frozen=True)
class UpdateSettings:
    """When and where the helper looks for a new core release.

    ``check_interval`` and ``check_jitter`` are two keys because they are two numbers: the
    plan's "every 24 h, with up to 1 h of random delay" is a schedule plus the spread that
    keeps every install from checking at the same moment.
    """

    channel: str = "stable"
    check_interval: float = 24 * 60 * 60
    check_jitter: float = 60 * 60


@dataclass(frozen=True)
class PluginOverride:
    """One `[plugins.<id>]` table: what this plugin does differently from the global default.

    ``update_mode`` is ``None`` when the table does not set one, which is how inheritance is
    represented rather than computed: the global default may change under this object's feet,
    and a plugin that never chose a mode must follow it.
    """

    id: str
    update_mode: UpdateMode | None = None
    pinned: bool = False


@dataclass(frozen=True)
class PluginSettings:
    """The plugin update policy: one global default, plus per-plugin overrides."""

    update_mode: UpdateMode = UpdateMode.MANUAL
    overrides: tuple[PluginOverride, ...] = ()

    def override_for(self, plugin_id: str) -> PluginOverride | None:
        """The plugin's own table, or ``None`` when it has none."""
        for override in self.overrides:
            if override.id == plugin_id:
                return override
        return None

    def mode_for(self, plugin_id: str) -> UpdateMode:
        """The mode in force for ``plugin_id``: its own, or the inherited default."""
        override = self.override_for(plugin_id)
        if override is None or override.update_mode is None:
            return self.update_mode
        return override.update_mode

    def is_pinned(self, plugin_id: str) -> bool:
        """Whether the plugin is held at its installed version whatever its mode says."""
        override = self.override_for(plugin_id)
        return False if override is None else override.pinned


@dataclass(frozen=True)
class RestartSettings:
    """How many times the helper relaunches a process, and how long it waits between tries.

    ``backoff`` is the delay before each attempt, in order. When the attempts outlast the
    list, the last delay repeats — so a short list is a rate, not a silent end to the policy.
    Slice 05 is where that rule is applied; this slice only carries the numbers.
    """

    max_attempts: int = 5
    backoff: tuple[float, ...] = (1.0, 2.0, 4.0, 8.0, 16.0)


@dataclass(frozen=True)
class BreakerSettings:
    """When the helper stops relaunching a process and quarantines it instead (plan 0003)."""

    max_interventions: int = 5
    window: float = 10 * 60


@dataclass(frozen=True)
class HelperNumbers:
    """The helper's own numbers: its tick, its timeouts, and the limits it watches against.

    ``defaults`` is a :class:`~innytypes.addons.manifest.StabilityProfile` on purpose. The
    helper-wide defaults and the values a manifest falls back to are the same numbers, and
    two copies of them could disagree about what 1 GB means.
    """

    tick: float = 5.0
    stop_timeout: float = 10.0
    update_health_window: float = 2 * 60
    restart: RestartSettings = field(default_factory=RestartSettings)
    breaker: BreakerSettings = field(default_factory=BreakerSettings)
    defaults: StabilityProfile = field(
        default_factory=lambda: StabilityProfile(max_children=DEFAULT_MAX_CHILDREN)
    )


@dataclass(frozen=True)
class HelperConfig:
    """One snapshot of `config.toml`: every switch, with every documented default applied."""

    telemetry: Telemetry = Telemetry.UNSET
    launch_at_login: bool = False
    auto_check_versions: bool = True
    update: UpdateSettings = field(default_factory=UpdateSettings)
    plugins: PluginSettings = field(default_factory=PluginSettings)
    helper: HelperNumbers = field(default_factory=HelperNumbers)


def default_config_path() -> Path:
    """Where `config.toml` lives for this user, creating nothing."""
    return user_config_path(APPLICATION_NAME, appauthor=False) / CONFIG_FILENAME


def load_helper_config(path: Path | None = None) -> HelperConfig:
    """Read and validate `config.toml`, or return the documented defaults when it is absent."""
    file = default_config_path() if path is None else path
    document = _read_document(file)

    try:
        return parse_helper_config(document)
    except HelperConfigError as error:
        # The message names the key; this names the file it is in, which is the other half
        # of what the person fixing it needs.
        raise HelperConfigError(f"{file}: {error}") from error


class HelperSettings:
    """The live view of `config.toml`: every read re-reads the file.

    Hold one of these for the life of the process. A switch the user flips — in the
    application's window or from the CLI — takes effect on the next read, with no restart and
    nothing to invalidate. Use :attr:`current` when several keys must come from one moment.
    """

    def __init__(self, path: Path | None = None) -> None:
        self.path = default_config_path() if path is None else path

    @property
    def current(self) -> HelperConfig:
        """One fresh snapshot, read from disk now."""
        return load_helper_config(self.path)

    @property
    def telemetry(self) -> Telemetry:
        """The telemetry switch as of this instant."""
        return self.current.telemetry

    @property
    def auto_check_versions(self) -> bool:
        """Whether the helper may make any version-check request at all (D12, D14)."""
        return self.current.auto_check_versions

    @property
    def launch_at_login(self) -> bool:
        """Whether the application starts at login (F7)."""
        return self.current.launch_at_login

    def update_mode(self, plugin_id: str) -> UpdateMode:
        """The update mode in force for one plugin, inherited unless it overrides it."""
        return self.current.plugins.mode_for(plugin_id)

    def is_pinned(self, plugin_id: str) -> bool:
        """Whether one plugin is held at its installed version."""
        return self.current.plugins.is_pinned(plugin_id)

    def set_telemetry(self, enabled: bool) -> None:
        """Answer the telemetry question and persist it.

        There is no way to write `UNSET` back: unanswering a question the user has answered
        is not a state the application can get into, so it is not one this API can express.
        """

        def edit(document: dict[str, object]) -> None:
            document["telemetry"] = enabled

        self._edit(edit)

    def set_pinned(self, plugin_id: str, pinned: bool) -> None:
        """Set or clear ``plugins.<id>.pinned``, leaving every other setting untouched."""
        if not is_addon_id(plugin_id):
            raise HelperConfigError(
                f"{plugin_id!r} is not a well-formed addon id: expected lowercase letters and "
                "digits joined by single hyphens (for example 'whodunnit')"
            )

        def edit(document: dict[str, object]) -> None:
            plugins = _table_at(document, "plugins")
            _table_at(plugins, plugin_id)["pinned"] = pinned

        self._edit(edit)

    def _edit(self, change: Callable[[dict[str, object]], None]) -> None:
        """Read, refuse anything unreadable, apply one change, and write the whole file back."""
        document = _read_document(self.path)

        # Validated BEFORE the change: rewriting a document we could not read would discard
        # whatever the user wrote in the part we did not understand.
        try:
            parse_helper_config(document)
        except HelperConfigError as error:
            raise HelperConfigError(f"{self.path}: {error}") from error

        change(document)
        _write_document(self.path, document)


def parse_helper_config(document: Mapping[str, object]) -> HelperConfig:
    """Validate a parsed TOML document and return it as a typed configuration.

    Raises :class:`HelperConfigError`, naming the offending key, on the first rule broken.
    """
    _check_keys(
        document,
        known=(
            "telemetry",
            "launch_at_login",
            "auto_check_versions",
            "update",
            "plugins",
            "helper",
        ),
        where="config",
    )

    return HelperConfig(
        telemetry=_telemetry(document),
        launch_at_login=_flag(document, "launch_at_login", default=False, where="config"),
        auto_check_versions=_flag(document, "auto_check_versions", default=True, where="config"),
        update=_parse_update(_section(document, "update")),
        plugins=_parse_plugins(_section(document, "plugins")),
        helper=_parse_helper(_section(document, "helper")),
    )


# --- sections ------------------------------------------------------------------------------


def _telemetry(document: Mapping[str, object]) -> Telemetry:
    """The three-state switch: absent is unanswered, and a non-boolean is refused."""
    if "telemetry" not in document:
        return Telemetry.UNSET

    value = document["telemetry"]
    if not isinstance(value, bool):
        raise HelperConfigError(
            f"telemetry must be true or false, got {value!r}. Leave the key out entirely to "
            "mean the first-launch question has not been answered yet"
        )
    return Telemetry.ON if value else Telemetry.OFF


def _parse_update(section: Mapping[str, object]) -> UpdateSettings:
    _check_keys(section, known=("channel", "check_interval", "check_jitter"), where="update")
    defaults = UpdateSettings()

    channel = _text(section, "channel", default=defaults.channel, where="update")
    if not channel:
        raise HelperConfigError("update.channel is empty: name a channel or leave the key out")

    return UpdateSettings(
        channel=channel,
        check_interval=_number(
            section, "check_interval", default=defaults.check_interval, where="update"
        ),
        check_jitter=_number(
            section,
            "check_jitter",
            default=defaults.check_jitter,
            where="update",
            allow_zero=True,
        ),
    )


def _parse_plugins(section: Mapping[str, object]) -> PluginSettings:
    """`[plugins]`: one global `update_mode`, plus a table per plugin.

    Plugin ids are not checked against what is installed — this file is read when nothing is
    running, and a setting for a plugin installed tomorrow is legitimate. The id grammar is
    checked, because `[plugins."Who Dunnit"]` can never match any addon.
    """
    default_mode = UpdateMode.MANUAL
    overrides: list[PluginOverride] = []

    for key, value in section.items():
        if key == "update_mode":
            default_mode = _mode(value, where="plugins", key=key)
            continue

        if not isinstance(value, Mapping):
            raise HelperConfigError(
                f"unknown key {key!r} in [plugins]: expected 'update_mode', or a "
                "[plugins.<addon-id>] table"
            )

        if not is_addon_id(key):
            raise HelperConfigError(
                f"[plugins.{key}] is not a well-formed addon id: expected lowercase letters "
                "and digits joined by single hyphens (for example [plugins.whodunnit])"
            )

        overrides.append(_parse_plugin(value, plugin_id=key))

    return PluginSettings(update_mode=default_mode, overrides=tuple(overrides))


def _parse_plugin(section: Mapping[str, object], *, plugin_id: str) -> PluginOverride:
    where = f"plugins.{plugin_id}"
    _check_keys(section, known=("update_mode", "pinned"), where=where)

    mode = None
    if "update_mode" in section:
        mode = _mode(section["update_mode"], where=where, key="update_mode")

    return PluginOverride(
        id=plugin_id,
        update_mode=mode,
        pinned=_flag(section, "pinned", default=False, where=where),
    )


def _parse_helper(section: Mapping[str, object]) -> HelperNumbers:
    _check_keys(
        section,
        known=(
            "tick",
            "stop_timeout",
            "update_health_window",
            "restart",
            "breaker",
            "defaults",
        ),
        where="helper",
    )
    defaults = HelperNumbers()

    return HelperNumbers(
        tick=_number(section, "tick", default=defaults.tick, where="helper"),
        stop_timeout=_number(
            section, "stop_timeout", default=defaults.stop_timeout, where="helper"
        ),
        update_health_window=_number(
            section,
            "update_health_window",
            default=defaults.update_health_window,
            where="helper",
        ),
        restart=_parse_restart(_section(section, "restart", where="helper")),
        breaker=_parse_breaker(_section(section, "breaker", where="helper")),
        defaults=_parse_stability_defaults(_section(section, "defaults", where="helper")),
    )


def _parse_restart(section: Mapping[str, object]) -> RestartSettings:
    where = "helper.restart"
    _check_keys(section, known=("max_attempts", "backoff"), where=where)
    defaults = RestartSettings()

    max_attempts = _count(section, "max_attempts", default=defaults.max_attempts, where=where)

    if "backoff" not in section:
        return RestartSettings(max_attempts=max_attempts, backoff=defaults.backoff)

    delays = section["backoff"]
    if not isinstance(delays, Sequence) or isinstance(delays, str | bytes):
        raise HelperConfigError(
            f"{where}.backoff must be a list of delays in seconds, got {delays!r}"
        )
    if not delays:
        raise HelperConfigError(
            f"{where}.backoff is empty: give at least one delay, or leave the key out to use "
            f"the default {list(defaults.backoff)}"
        )

    backoff: list[float] = []
    for index, delay in enumerate(delays):
        if isinstance(delay, bool) or not isinstance(delay, int | float) or delay < 0:
            raise HelperConfigError(
                f"{where}.backoff[{index}] must be a delay in seconds of zero or more, "
                f"got {delay!r}"
            )
        backoff.append(float(delay))

    return RestartSettings(max_attempts=max_attempts, backoff=tuple(backoff))


def _parse_breaker(section: Mapping[str, object]) -> BreakerSettings:
    where = "helper.breaker"
    _check_keys(section, known=("max_interventions", "window"), where=where)
    defaults = BreakerSettings()

    return BreakerSettings(
        max_interventions=_count(
            section, "max_interventions", default=defaults.max_interventions, where=where
        ),
        window=_number(section, "window", default=defaults.window, where=where),
    )


def _parse_stability_defaults(section: Mapping[str, object]) -> StabilityProfile:
    """`[helper.defaults]`: the limits every managed process is watched against.

    `heartbeat_interval` and `stale_after` are deliberately not settable here. They are a
    plugin's own promise about how often it will report progress, and a helper-wide value
    would judge a plugin stale for missing heartbeats it never agreed to send.
    """
    where = "helper.defaults"
    _check_keys(
        section,
        known=(
            "max_rss_mb",
            "max_cpu_percent",
            "cpu_window",
            "max_open_files",
            "max_children",
            "breach_grace",
        ),
        where=where,
    )
    defaults = HelperNumbers().defaults

    return StabilityProfile(
        max_rss_mb=_number(section, "max_rss_mb", default=defaults.max_rss_mb, where=where),
        max_cpu_percent=_number(
            section, "max_cpu_percent", default=defaults.max_cpu_percent, where=where
        ),
        cpu_window=_number(section, "cpu_window", default=defaults.cpu_window, where=where),
        max_open_files=_count(
            section, "max_open_files", default=defaults.max_open_files, where=where
        ),
        max_children=_count(section, "max_children", default=DEFAULT_MAX_CHILDREN, where=where),
        breach_grace=_number(section, "breach_grace", default=defaults.breach_grace, where=where),
    )


# --- typed reads, each of which refuses rather than coerces --------------------------------


def _section(
    document: Mapping[str, object], key: str, *, where: str = "config"
) -> Mapping[str, object]:
    """One table, or an empty one when the document has none."""
    if key not in document:
        return {}

    value = document[key]
    if not isinstance(value, Mapping):
        name = key if where == "config" else f"{where}.{key}"
        raise HelperConfigError(f"[{name}] must be a section of settings, got {value!r}")
    return value


def _check_keys(document: Mapping[str, object], *, known: Sequence[str], where: str) -> None:
    """Refuse an unknown key by name.

    An ignored key is a setting its author believes is in force, which is the failure this
    whole module exists to prevent.
    """
    unknown = sorted(set(document) - set(known))
    if unknown:
        raise HelperConfigError(
            f"unknown key(s) in [{where}]: {', '.join(unknown)}. Known keys: {', '.join(known)}"
        )


def _flag(document: Mapping[str, object], key: str, *, default: bool, where: str) -> bool:
    if key not in document:
        return default

    value = document[key]
    if not isinstance(value, bool):
        raise HelperConfigError(f"{where}.{key} must be true or false, got {value!r}")
    return value


def _text(document: Mapping[str, object], key: str, *, default: str, where: str) -> str:
    if key not in document:
        return default

    value = document[key]
    if not isinstance(value, str):
        raise HelperConfigError(f"{where}.{key} must be text, got {value!r}")
    return value


def _number(
    document: Mapping[str, object],
    key: str,
    *,
    default: float,
    where: str,
    allow_zero: bool = False,
) -> float:
    """A number of seconds or units. `True` is an `int` in Python, so booleans are refused."""
    if key not in document:
        return default

    value = document[key]
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise HelperConfigError(f"{where}.{key} must be a number, got {value!r}")

    number = float(value)
    if number < 0 or (number == 0 and not allow_zero):
        limit = "zero or more" if allow_zero else "greater than zero"
        raise HelperConfigError(f"{where}.{key} must be {limit}, got {value!r}")
    return number


def _count(document: Mapping[str, object], key: str, *, default: int, where: str) -> int:
    """A whole number of things — attempts, files, children — and at least one of them."""
    if key not in document:
        return default

    value = document[key]
    if isinstance(value, bool) or not isinstance(value, int):
        raise HelperConfigError(f"{where}.{key} must be a whole number, got {value!r}")
    if value < 1:
        raise HelperConfigError(f"{where}.{key} must be at least 1, got {value!r}")
    return value


def _mode(value: object, *, where: str, key: str) -> UpdateMode:
    if not isinstance(value, str):
        raise HelperConfigError(f"{where}.{key} must be text, got {value!r}")

    try:
        return UpdateMode(value)
    except ValueError as error:
        known = ", ".join(mode.value for mode in UpdateMode)
        raise HelperConfigError(
            f"{where}.{key} is {value!r}, which is not an update mode; expected one of: {known}"
        ) from error


# --- reading and writing the file ----------------------------------------------------------


def _read_document(path: Path) -> dict[str, object]:
    """Parse the file into a plain document, or refuse it by name.

    A missing file is the first launch, so it reads as an empty document — every default, and
    telemetry unanswered. Everything else that goes wrong is an error: see the module
    docstring for why an unreadable file must never be defaulted away.
    """
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        return {}
    except OSError as error:
        raise HelperConfigError(f"{path} could not be read: {error}") from error

    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as error:
        raise HelperConfigError(f"{path} is not UTF-8 text: {error}") from error

    try:
        return dict(tomllib.loads(text))
    except tomllib.TOMLDecodeError as error:
        raise HelperConfigError(f"{path} is not valid TOML: {error}") from error


def _write_document(path: Path, document: Mapping[str, object]) -> None:
    """Write the whole document back, atomically, creating the config directory if needed.

    Atomic because the helper may be reading this file at the moment the CLI writes it: the
    replace is what keeps "re-read before every send" from ever seeing half a file.
    """
    path.parent.mkdir(parents=True, exist_ok=True)

    temporary = path.with_name(f"{path.name}.new")
    temporary.write_text(_dump_document(document), encoding="utf-8")
    os.replace(temporary, path)


def _dump_document(document: Mapping[str, object]) -> str:
    lines: list[str] = []
    _dump_table(document, prefix=(), lines=lines)
    return "\n".join(lines) + "\n"


def _dump_table(table: Mapping[str, object], *, prefix: tuple[str, ...], lines: list[str]) -> None:
    """One table: its own keys first, then its sub-tables, as TOML requires."""
    scalars = {key: value for key, value in table.items() if not isinstance(value, Mapping)}
    tables = {key: value for key, value in table.items() if isinstance(value, Mapping)}

    # A table whose whole content is other tables needs no header of its own: `[plugins]` on
    # its own line above `[plugins.whodunnit]` is valid TOML that says nothing.
    if prefix and (scalars or not tables):
        if lines:
            lines.append("")
        lines.append(f"[{'.'.join(prefix)}]")

    for key, value in scalars.items():
        lines.append(f"{key} = {_dump_value(value)}")

    for key, value in tables.items():
        _dump_table(cast(Mapping[str, object], value), prefix=(*prefix, key), lines=lines)


def _dump_value(value: object) -> str:
    """One TOML value, in the only types this file is allowed to hold.

    Nothing else can reach here: the document was validated before it was changed, and the
    change is this module's own. The refusal is here so that stops being true loudly rather
    than by writing something no loader would accept.
    """
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int | float):
        return repr(value)
    if isinstance(value, str):
        escaped = value.replace("\\", "\\\\").replace('"', '\\"')
        return f'"{escaped}"'
    if isinstance(value, Sequence):
        return "[" + ", ".join(_dump_value(item) for item in value) + "]"
    raise HelperConfigError(f"{value!r} is not a value config.toml can hold")


def _table_at(document: dict[str, object], key: str) -> dict[str, object]:
    """The table at ``key``, created empty when there is none there yet."""
    existing = document.get(key)
    if isinstance(existing, dict):
        return cast(dict[str, object], existing)

    fresh: dict[str, object] = {}
    document[key] = fresh
    return fresh
