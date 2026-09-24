"""Logging, as a basic of the InnyTypes API: where records go, and what is removed from them.

Two jobs, and they are one module because they are one promise. :func:`start_logging` is how
each of this application's three processes attaches to a single per-user file — it is the only
place a handler is configured, so "the application writes a log" is a fact with one owner
rather than a convention each caller could forget. :data:`REDACTOR` is what makes that file
safe to have: a credential is removed on the way to it, once, here.

A plugin takes part in both without arranging either. It is handed a logger
(:func:`plugin_logger`) on its context, the same way it is handed an emitter and its settings,
and what it writes lands in the application's log with the same redaction applied.

Every module in this distribution logs through :func:`get_logger`, and every logger it
hands back carries :data:`REDACTOR`. The alternative — each call site remembering not to
format the API key into its own message — is the arrangement that eventually loses a key,
because it only has to be forgotten once, in one branch, on one bad afternoon.

The mechanism is exact-match rather than pattern-matching on purpose. A
:class:`~innytypes.anytype_mcp.config.ServerConfig` registers its key with :func:`protect`
the moment it is built, and the filter removes precisely that string from whatever the
record would render. A pattern that guesses what a credential looks like fails *open* on
the credentials it did not anticipate, and a redactor that fails open is decoration.

The cost of exact matching is that the key is held here for the life of the process. That
is a deliberate trade rather than an oversight: the same string already lives in the
``ServerConfig`` and in the child process's environment, whereas a redactor that can
quietly forget a secret is a redactor that silently stops working.

This module imports nothing but the standard library, which is why it sits at the top of
the distribution rather than inside :mod:`innytypes.anytype_mcp`, where it started. The
redactor is needed by the contract layer an addon environment installs — a plugin's secret
store registers its values here too — and that layer may reach nothing a third-party
library would follow (plan 0001, *What an addon environment contains*). Anything holding a
credential can depend on this module, from either side, without a cycle and without a pin.
"""

from __future__ import annotations

import logging
import logging.handlers
import os
from collections.abc import Mapping
from contextlib import suppress
from io import TextIOWrapper
from pathlib import Path

# What a redacted credential is replaced with. Kept recognisable on purpose: a log that
# says a value was removed is much easier to read than one with a hole in it.
REDACTED = "[redacted]"

# Every credential this package must never render. A set, so registering twice is free.
_SECRETS: set[str] = set()


def protect(secret: str) -> None:
    """Register a credential that must never appear in a log record of this package."""
    # An empty secret would be worse than useless: ``"x".replace("", "…")`` inserts the
    # marker between every single character, so one empty registration would destroy every
    # log line in the process.
    if secret:
        _SECRETS.add(secret)


def redact(text: str) -> str:
    """``text`` with every protected credential replaced by :data:`REDACTED`."""
    # Longest first: where one secret contains another, replacing the longer one first
    # leaves a readable result instead of a half-substituted fragment.
    for secret in sorted(_SECRETS, key=len, reverse=True):
        text = text.replace(secret, REDACTED)
    return text


class SecretRedactingFilter(logging.Filter):
    """Removes protected credentials from a record before any handler can see it."""

    def filter(self, record: logging.LogRecord) -> bool:
        # The *rendered* message is what matters. A log argument can be any object, and a
        # credential hides in its ``str()`` rather than in the template, so rendering once
        # here covers every shape a call site can take.
        message = record.getMessage()
        redacted = redact(message)
        if redacted != message:
            # The message is now rendered, so the arguments have been consumed. Clearing
            # them is what stops a handler applying them a second time to the new string —
            # and it is why a clean record keeps its arguments: structured handlers should
            # still see fields whenever there was nothing to remove.
            record.msg = redacted
            record.args = ()

        # A formatter that has already rendered a traceback caches it here, and a traceback
        # carries exception messages that a caller may have built out of configuration.
        if record.exc_text:
            record.exc_text = redact(record.exc_text)

        # A filter returning False drops the record. This one removes credentials, never
        # evidence: a supervisor whose logs disappear is worse than one that logs too much.
        return True

    def __repr__(self) -> str:
        # The default ``Filter`` repr is harmless, but this is the one object in the process
        # whose state is entirely credentials. It does not get a revealing repr.
        return f"<{type(self).__name__}>"


# One shared instance, so a test can unhook it and prove that it is what does the work.
REDACTOR = SecretRedactingFilter()


def get_logger(name: str) -> logging.Logger:
    """The logger for ``name``, with :data:`REDACTOR` installed on it.

    The filter goes on each logger itself rather than on the package logger above them.
    Python runs a logger's own filters when a record is emitted, but propagation walks up
    to ancestor *handlers* without running those ancestors' filters — so a single filter on
    ``innytypes.anytype_mcp`` would never see a record from
    ``innytypes.anytype_mcp.supervisor``.
    """
    logger = logging.getLogger(name)
    if REDACTOR not in logger.filters:
        logger.addFilter(REDACTOR)
    return logger


# --- where the records actually go ------------------------------------------------------------
#
# Everything above this line was true and useless on its own. Until plan 0012 slice 04 nothing
# in either repository configured a handler, so every record this package produced was written
# to nowhere: an INFO record was discarded by Python's defaults before reaching a stream, and a
# WARNING reached the helper's standard error, which for an application opened from the Finder
# is `launchd` and nobody. The redactor below was guarding a pipe with no water in it.
#
# **This is a basic of the InnyTypes API, not something each plugin arranges.** A plugin is
# handed a logger (:func:`plugin_logger`) on its context, exactly as it is handed an emitter and
# its settings, and it configures no handler of its own. One call — :func:`start_logging` — is
# how each of the three processes attaches to the same file, and it is made in exactly three
# places: :func:`innytypes.cli.cli`, :func:`innytypes.helper.launcher.start_helper_logging` and
# :func:`innytypes.addons.run.main`.
#
# **This does not replace the control channel plan 0009 built.** That channel carries a short,
# fixed vocabulary of *degradations* to a person looking at the window — it answers "why is this
# plugin not running", now, on screen. The log answers "what happened", afterwards, to whoever
# is diagnosing it, and it carries everything. The two do not compete: the helper still reports
# degradations over the channel, and both ends of that channel now also write what they did here.

# The application, as the per-user directories spell it. Written out here rather than imported
# from :mod:`innytypes.helper.config`, exactly as :mod:`innytypes.addons.settings` writes it out:
# that module needs `platformdirs` at import time, and this one is imported inside addon
# environments, which hold no third-party library at all.
APPLICATION_NAME = "innytypes"

# The one file the helper, the host and every addon child append to. One file rather than three,
# because the question a log is read to answer — what happened, in what order — is a question
# about the whole application and not about one of its processes.
LOG_FILENAME = "innytypes.log"

# How a process that cannot work out a per-user directory is told where the log is. Same channel
# and same reason as :data:`~innytypes.addons.settings.SETTINGS_PATH_VARIABLE`: an addon
# environment has no `platformdirs`, so the host answers the question when it spawns the child
# (:func:`innytypes.children.default_addon_locations`). A variable rather than an argument,
# because an addon installed before this existed ignores a variable it does not read.
LOG_PATH_VARIABLE = "INNYTYPES_LOG_FILE"

# How that process is told how much to write. The host sets it from its own level, so a child is
# exactly as verbose as the application that started it, and a person can set it by hand for one
# run without editing `config.toml`.
LOG_LEVEL_VARIABLE = "INNYTYPES_LOG_LEVEL"

# The logger every module of this distribution hangs under, and therefore the one place a
# handler has to be attached for all of them to be heard. Attached *here* rather than on the
# root logger on purpose: a third-party library logs under its own name, and turning this
# application's verbosity up must not turn `httpx`'s up with it.
PACKAGE_LOGGER = "innytypes"

# Where a plugin's own logger hangs. Under the package logger, so a plugin's records reach the
# same file by the same propagation as the host's; in a namespace of its own, so `innytypes.
# plugin.monty` can never collide with a module that happens to be called `monty`.
PLUGIN_LOGGER_PREFIX = f"{PACKAGE_LOGGER}.plugin"

# **A test-mode default, stated as one.** The application is being proved right now by watching
# events fire, and an emit is recorded at DEBUG (see :mod:`innytypes.events.emitter`), so DEBUG
# is the level at which the thing under examination is visible at all. It is not a permanent
# choice: when events stop being the question, this becomes INFO and the emit lines go quiet
# while an accepted event and a refusal both stay.
DEFAULT_LEVEL = logging.DEBUG

# The levels a person may write in `config.toml` or in :data:`LOG_LEVEL_VARIABLE`, for the
# refusal to name when they write something else. Only the five that mean something to a person
# choosing verbosity: `logging` also knows `NOTSET`, which is not a verbosity but the absence
# of one, and offering it would be offering a way to say nothing at all.
LEVEL_NAMES = ("debug", "info", "warning", "error", "critical")

# What bounds the volume. A machine left running for a month must not fill a disk, and a log
# that has to be deleted by hand before it can be read is not a log. Two megabytes is a few
# hundred thousand event lines; three backups is the history that survives a rollover.
MAX_LOG_BYTES = 2 * 1024 * 1024
BACKUP_COUNT = 3

# The process id is in every line because three processes write to one file: without it, an
# addon's record and the host's are indistinguishable, and the whole point of one file is being
# able to read across them.
LOG_FORMAT = "%(asctime)s %(levelname)-8s %(process)6d %(name)s: %(message)s"


def default_log_path() -> Path:
    """Where this user's log lives, creating nothing.

    The per-user **log** directory rather than a data or runtime one: on macOS that is
    ``~/Library/Logs/innytypes``, which is where a person looks and where Console.app already
    points, and a log is neither application data the user owns nor state a reboot may clear.

    ``platformdirs`` is imported **here**, for the reason
    :func:`innytypes.addons.discovery.default_addons_root` gives: this module is imported inside
    addon environments, which carry `innytypes` and no third-party library, so an import at the
    top of the file would make importing it impossible there. An addon process therefore never
    calls this — it is told the path instead.
    """
    from platformdirs import user_log_path

    return user_log_path(APPLICATION_NAME, appauthor=False) / LOG_FILENAME


def resolve_level(value: str | int | None, *, default: int = DEFAULT_LEVEL) -> int:
    """One verbosity setting as a level number, or :class:`ValueError` naming what was wrong.

    Accepts a level name in any case (``"info"``, ``"INFO"``) and a number, because the setting
    is written by a person in `config.toml` and passed between processes as an environment
    variable, and those two should not be two different spellings of one value.
    """
    if value is None:
        return default
    if isinstance(value, int):
        return value

    named = logging.getLevelNamesMapping().get(value.strip().upper())
    if named is None:
        known = ", ".join(LEVEL_NAMES)
        raise ValueError(f"{value!r} is not a logging level; expected one of {known}")
    return named


def _file_identity(path: str) -> tuple[int, int] | None:
    """Which file ``path`` names right now, or ``None`` when it names none.

    Device and inode rather than the name: after a rollover the name points at a *different*
    file, and the whole problem this answers is that a process holding the old one would go on
    writing into something nobody will ever read.
    """
    try:
        status = os.stat(path)
    except OSError:
        return None
    return (status.st_dev, status.st_ino)


class _SharedLogFile(logging.handlers.RotatingFileHandler):
    """A size-bounded log file three processes may append to at once.

    :class:`~logging.handlers.RotatingFileHandler` alone is not safe for this. It rolls over by
    **renaming** the file, and every other process goes on writing into the renamed inode — so
    the helper would rotate and the host's records would vanish into a file called
    ``innytypes.log.1`` that nothing ever appends to again.

    Two changes fix it, and neither needs a lock on the hot path:

    * before every record, the handler checks whether the path still names the file it holds,
      and reopens it when it does not. That is what
      :class:`~logging.handlers.WatchedFileHandler` does for `logrotate`, applied to a rollover
      performed by a sibling process instead of by a cron job;
    * a rollover that fails is not an error. Two processes can decide to roll the same file at
      the same moment; one of them wins, and the loser's rename raises. The loser does not need
      to retry — the file *has* been rolled — it only needs to reopen, which the check above
      does on its very next record.

    The ordinary append needs nothing else: the file is opened in append mode, so every write
    goes to the current end of the file whoever else is writing, and each record is one short
    write. The cost of the design is stated rather than hidden: two processes rolling at the
    same instant can lose one generation of backups. That is a far smaller price than the
    alternative, which is one process's records silently disappearing for the life of the
    machine.
    """

    # Set by :meth:`_open`, which the base class calls from its own constructor — before any
    # ``__init__`` body here could run, which is why it is a class attribute with a default.
    _identity: tuple[int, int] | None = None

    def _open(self) -> TextIOWrapper:
        stream = super()._open()
        self._identity = _file_identity(self.baseFilename)
        return stream

    def emit(self, record: logging.LogRecord) -> None:
        self._reopen_if_replaced()
        super().emit(record)

    def doRollover(self) -> None:  # noqa: N802 - the name is the base class's
        # Another process can roll this same file between our size check and our rename, so
        # the rename finds nothing where it expected something. Suppressed rather than raised,
        # because raising here loses the record being written *and* every record after it: the
        # file has been rolled, which is what this call wanted, and `FileHandler.emit` opens a
        # stream again before it writes.
        with suppress(OSError):
            super().doRollover()

    def _reopen_if_replaced(self) -> None:
        """Point at the file the path names now, if that is no longer the one we hold."""
        stream = self.stream
        if stream is not None and _file_identity(self.baseFilename) == self._identity:
            return

        if stream is not None:
            # Not ``self.close()``: that unregisters the handler from logging's own list of
            # handlers to flush at exit, and this handler goes on being used.
            #
            # A flush that fails is not a problem to report: the stream died with the file it
            # pointed at, there is nothing to salvage, and the line after this opens a working
            # one.
            with suppress(OSError, ValueError):
                stream.flush()
            stream.close()

        self.stream = self._open()


# The handler this process installed, if it installed one. Module state because there is exactly
# one application log per process: a second handler on the same file would write every record
# twice, and a process that called :func:`start_logging` again — which the CLI does, once per
# invocation — must move its log rather than acquire a second one.
_installed: _SharedLogFile | None = None
_destination: Path | None = None

# The loggers outside the package that :func:`route_logger` attached that handler to, so that
# :func:`stop_logging` can take it off every one of them again.
_routed: list[logging.Logger] = []


def log_destination() -> Path | None:
    """The file this process is writing to, or ``None`` when it reached none."""
    return _destination


def current_level() -> int:
    """The verbosity in force for this package, as a level number.

    What the host passes its children, so an addon is exactly as verbose as the application
    that started it rather than as verbose as its own defaults happen to be.
    """
    return logging.getLogger(PACKAGE_LOGGER).getEffectiveLevel()


def stop_logging() -> None:
    """Detach this process's log file, if it has one. Idempotent.

    From every logger it was attached to: the package logger, and each one
    :func:`route_logger` added. A route left behind would keep a closed handler on a plugin's
    logger, and the next record through it would be an error instead of a line.
    """
    global _installed, _destination

    if _installed is not None:
        logging.getLogger(PACKAGE_LOGGER).removeHandler(_installed)
        for routed in _routed:
            routed.removeHandler(_installed)
        _installed.close()
    _routed.clear()
    _installed = None
    _destination = None


def route_logger(name: str) -> None:
    """Send one more logger's records to this process's log file: a plugin's own package.

    A plugin written the ordinary way logs with ``logging.getLogger(__name__)`` — ``monty.addon``
    for monty — and never touches :attr:`~innytypes.addons.run.AddonContext.log`. That record
    propagates to the root logger, which has no handler, and Python drops anything below
    WARNING. The runner names the plugin's top-level package here (plan 0014), so what a plugin
    writes the tutorial way reaches the same file as what it writes through its context.

    **This builds nothing.** It attaches the one handler :func:`start_logging` built, filter and
    all, so the redaction and the format are the ones every other line has, and
    :func:`start_logging` stays the only place a handler is configured. Before that call, or
    when it reached no file, there is nothing to attach and this does nothing.

    **Never the root logger, and never a logger already under** :data:`PACKAGE_LOGGER`. Root
    would pull every third-party library's DEBUG into the file at the test-mode level and bury
    the event lines; a plugin's dependencies stay at WARNING and above, like any unconfigured
    library. A logger under the package already reaches the handler by propagation, so a second
    route to it would write each of its records twice.

    The level is set as well as the handler: an unconfigured logger inherits root's WARNING,
    and a handler at DEBUG never sees the INFO line a logger that level has already dropped.
    """
    if _installed is None:
        return
    if name == PACKAGE_LOGGER or name.startswith(f"{PACKAGE_LOGGER}."):
        return

    logger = logging.getLogger(name)
    # `getLogger("")` and `getLogger("root")` are both the root logger, so the check is on the
    # object rather than on the spelling.
    if logger is logging.getLogger() or _installed in logger.handlers:
        return

    logger.setLevel(_installed.level)
    logger.addHandler(_installed)
    _routed.append(logger)


def start_logging(
    *,
    role: str,
    path: Path | None = None,
    level: str | int | None = None,
    environment: Mapping[str, str] | None = None,
) -> Path | None:
    """Attach this process to the application's log. Returns the file, or ``None``.

    ``role`` is what this process is — ``"helper"``, ``"host"``, ``"addon monty"`` — and it is
    written into the opening record, so that one file read afterwards says which processes were
    involved rather than leaving a reader to infer it from process ids.

    **Where** is answered in three steps, most specific first: the argument, then
    :data:`LOG_PATH_VARIABLE` (what the host tells a child it spawns), then
    :func:`default_log_path`. **How much** is answered the same way, falling back to
    :data:`DEFAULT_LEVEL`.

    ``None`` means this process reached no file and its records go nowhere — today's behaviour,
    unchanged, for the one case that cannot be fixed from here: an addon environment that was
    told no path and has no `platformdirs` to work one out with. It is returned rather than
    raised because a plugin that cannot log is still a plugin that should run.
    """
    global _installed, _destination

    told = os.environ if environment is None else environment

    unreadable_level: str | None = None
    try:
        wanted = resolve_level(told.get(LOG_LEVEL_VARIABLE) if level is None else level)
    except ValueError as error:
        # Reported once the handler exists, below. Refusing to log at all because the verbosity
        # was misspelled would be the worst possible response to a misspelled verbosity.
        unreadable_level = str(error)
        wanted = DEFAULT_LEVEL

    destination = _where_to_log(path, told)
    if destination is None:
        return None

    try:
        destination.parent.mkdir(parents=True, exist_ok=True)
        handler = _SharedLogFile(
            str(destination),
            maxBytes=MAX_LOG_BYTES,
            backupCount=BACKUP_COUNT,
            encoding="utf-8",
        )
    except OSError:
        # A read-only home directory, a path that is a directory, a full disk. None of those is
        # a reason for the application not to start.
        return None

    handler.setLevel(wanted)
    handler.setFormatter(logging.Formatter(LOG_FORMAT))
    # On the handler as well as on each logger. A logger's own filters run only for records it
    # creates, whereas a handler's run for every record that reaches it — including one from a
    # logger nothing in this package made. Redaction has to cover what is *written*, so this is
    # the one place that sees all of it.
    handler.addFilter(REDACTOR)

    stop_logging()
    package = logging.getLogger(PACKAGE_LOGGER)
    package.setLevel(wanted)
    package.addHandler(handler)

    _installed = handler
    _destination = destination

    opening = get_logger(f"{PACKAGE_LOGGER}.logs")
    if unreadable_level is not None:
        opening.warning("%s; logging at %s instead", unreadable_level, logging.getLevelName(wanted))
    opening.info(
        "innytypes %s (process %s) is logging to %s at %s",
        role,
        os.getpid(),
        destination,
        logging.getLevelName(wanted),
    )
    return destination


def _where_to_log(path: Path | None, told: Mapping[str, str]) -> Path | None:
    """The file to write to, or ``None`` when this process cannot name one."""
    if path is not None:
        return path

    named = told.get(LOG_PATH_VARIABLE)
    if named:
        return Path(named)

    try:
        return default_log_path()
    except Exception:
        # `ModuleNotFoundError` in an addon environment, which holds no `platformdirs`. The host
        # normally tells such a process where to write; one started by hand is not told, and
        # gets exactly what it got before this existed.
        return None


def plugin_logger(addon_id: str) -> logging.Logger:
    """The logger one plugin is handed on its context.

    A plugin never builds this for itself and never configures a handler: it writes to what it
    was given, and what it writes reaches the application's log because this logger hangs under
    :data:`PACKAGE_LOGGER`, where the handler is. Bound to one addon id like everything else on
    the context — the name says which plugin wrote the line.
    """
    return get_logger(f"{PLUGIN_LOGGER_PREFIX}.{addon_id}")
