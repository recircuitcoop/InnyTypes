"""What the user is told about, in what words, and the once-only rule that keeps it bearable.

The helper accumulates state a person needs to know about while they are not looking at the
application: a process it has stopped restarting (slice 06), an update that did not hold and was
put back (slice 10), a release waiting in staging for the next quit (slices 09/10), a `manual`
plugin update waiting to be asked for, and a plugin set the rules will not let through (slices
12/13). This module turns those five conditions into **system notifications**, and into the lines
`innytypes helper status` prints (plan 0003, *Telling the user*, D6).

**Three things are deliberately separate here**, because each is where a different kind of
mistake would otherwise land:

* A :class:`Notice` is a **condition that is true right now**. It carries no words and no
  formatting: the process, the version, and the sentence saying why.
* :func:`compose` is the **one place** that decides what a notice says to a person. Every
  notification and every `status` line goes through it, so the words a user sees in Notification
  Center and the words they see in a terminal cannot drift apart.
* A :class:`Notifier` is the **seam to the operating system**. macOS is built here and Windows
  in :mod:`innytypes.helper.windows`, which is where that platform's toast belongs;
  :func:`notifier_for` names the remaining Linux seam (slice 15) and refuses, rather than
  pretending to post something. :class:`RecordingNotifier` is the headless one every test uses,
  so the gate never raises a real notification.

**The deduplication rule: a notification per change of state, never per tick.** The helper ticks
for as long as the machine is on, and a quarantined plugin is quarantined on every one of those
ticks. So :class:`Announcer` is handed the **whole** set of conditions that are true now, and
posts only the ones that were not true the last time it was asked. A condition that goes away and
comes back is told again — it is news the second time too. A condition whose wording changes (a
quarantine re-entered for a different reason, a blocked set with a new reason) is also told again,
because the notice is what the person would read, and a different sentence is a different thing to
say.

**`status` never depends on a notification having been shown.** :class:`Announcer` writes the
whole current set to :class:`NoticeFile` on every call, whether or not anything was posted, and
`innytypes helper status` reads that file. A notification that was missed, dismissed, or never
posted because the platform has no notifier yet changes nothing about what `status` says.

**Clicking a notification opens the application's window.** Which window that is belongs to the
application (slice 07b), so it arrives here as one injected callable, ``on_click``, held by the
notifier — the notifier being the thing the operating system tells about a click.
"""

from __future__ import annotations

import json
import os
import subprocess
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Protocol

from platformdirs import user_runtime_path

from innytypes.children import Degradation
from innytypes.helper.breaker import HOST_ID
from innytypes.helper.config import APPLICATION_NAME, HelperConfig, UpdateMode
from innytypes.helper.swap import ReadyRelease, ReleaseConfirmation
from innytypes.helper.versions import ConsistencyRule, VersionCheck
from innytypes.logs import get_logger

__all__ = [
    "MACOS_SCRIPT",
    "NOTICES_FILENAME",
    "Announcer",
    "CommandRunner",
    "MacNotifier",
    "Message",
    "Notice",
    "NoticeFile",
    "NoticeKind",
    "Notifier",
    "OpenWindow",
    "RecordingNotifier",
    "UnsupportedPlatform",
    "compose",
    "current_notices",
    "default_notices_path",
    "notifier_for",
]

log = get_logger(__name__)

# Beside the run-state and quarantine files, in the per-user **runtime** directory, and for the
# same reason: it describes what is true of this machine right now. A reboot clearing it is
# correct — the helper that comes up next re-derives every condition from scratch.
NOTICES_FILENAME = "notices.json"


class NoticeKind(StrEnum):
    """The seven things the helper tells a person about (plan 0003, *Telling the user*)."""

    PROCESS_QUARANTINED = "process-quarantined"
    UPDATE_ROLLED_BACK = "update-rolled-back"
    UPDATE_STAGED = "update-staged"
    PLUGIN_UPDATE_PENDING = "plugin-update-pending"
    PLUGIN_SET_BLOCKED = "plugin-set-blocked"
    # The helper is running without a control channel to its host, so nothing it started is
    # being supervised. The only one of the six that is about the helper's own machinery
    # rather than a process or a release, and it is here for the same reason as the rest: a
    # degradation nobody is told about is one nobody fixes.
    NOT_SUPERVISING = "not-supervising"
    # One part of the host that did not come up, in the host's own words. The second of the
    # seven that is about this application's own machinery rather than a plugin or a release,
    # and the reason plan 0009 slice 04 exists: the host knew, said so on a stdout a packaged
    # application throws away, and nothing carried it to a window or a terminal.
    HOST_DEGRADED = "host-degraded"


@dataclass(frozen=True)
class Notice:
    """One condition that is true right now, in the terms the helper holds it in.

    Frozen and hashable on purpose: two notices being equal is exactly the question
    :class:`Announcer` asks to decide whether a person has already been told this.

    ``subject`` is the process or plugin the condition is about, and :data:`HOST_ID` for the two
    that are about InnyTypes itself. ``version`` is the version at stake where the kind has one.
    ``detail`` is the sentence naming why, taken from whichever module made the decision — the
    breaker's reason, the rollback's reason, the rule the version check broke — never written
    here, because the module that refused something is the one that knows why.
    """

    kind: NoticeKind
    subject: str
    version: str = ""
    detail: str = ""


@dataclass(frozen=True)
class Message:
    """One notice as an operating system will show it: a title, a body, and what it is about."""

    title: str
    body: str
    notice: Notice


def compose(notice: Notice) -> Message:
    """The words for one notice. The only place any of them are written.

    Plain language, and what to do about it where there is something to do. A notification a
    person cannot act on is one they learn to dismiss without reading.
    """
    match notice.kind:
        case NoticeKind.PROCESS_QUARANTINED:
            return Message(
                title=f"InnyTypes stopped restarting {notice.subject}",
                body=_sentences(
                    notice.detail,
                    f"Run `innytypes helper release {notice.subject}` to let it try again.",
                ),
                notice=notice,
            )

        case NoticeKind.UPDATE_ROLLED_BACK:
            return Message(
                title=f"InnyTypes {notice.version} did not start, and was undone",
                body=_sentences(notice.detail, "The version you had before is back."),
                notice=notice,
            )

        case NoticeKind.UPDATE_STAGED:
            # A staged release with a detail is one that will *not* go in on its own — a host
            # API change (D13), which waits for the user to ask. Telling that person it will be
            # installed when they quit would be telling them something untrue.
            return Message(
                title=f"InnyTypes {notice.version} is ready to install",
                body=_sentences(
                    notice.detail,
                    "Run `innytypes update apply` to install it."
                    if notice.detail
                    else "It will be installed the next time you quit InnyTypes.",
                ),
                notice=notice,
            )

        case NoticeKind.PLUGIN_UPDATE_PENDING:
            return Message(
                title=f"{notice.subject} {notice.version} is available",
                body=_sentences(
                    notice.detail,
                    f"Run `innytypes addons update {notice.subject}` to install it.",
                ),
                notice=notice,
            )

        case NoticeKind.PLUGIN_SET_BLOCKED:
            return Message(
                title=f"{notice.subject} {notice.version} is being held back",
                body=_sentences(notice.detail, "Nothing on your machine has changed."),
                notice=notice,
            )

        case NoticeKind.HOST_DEGRADED:
            # The body is the host's sentence and nothing else. Whatever refused to start
            # already said why — an unreachable Anytype, a missing key, a live MCP tool
            # surface that no longer matches the committed one, each naming what differs —
            # and a remedy invented here would be a second, worse account of a fact the code
            # already states.
            return Message(
                title=f"InnyTypes is running without {notice.subject}",
                body=_sentences(notice.detail),
                notice=notice,
            )

        case NoticeKind.NOT_SUPERVISING:
            return Message(
                title="InnyTypes is not watching what it started",
                body=_sentences(
                    notice.detail,
                    "Plugins that stop will not be restarted until InnyTypes is quit and "
                    "started again",
                ),
                notice=notice,
            )


def _sentences(*parts: str) -> str:
    """One body from the pieces that are there, each ended so they read as sentences."""
    return " ".join(_ended(part) for part in parts if part)


def _ended(part: str) -> str:
    """One piece, with the full stop it may or may not already have."""
    return part if part.endswith((".", "!", "?")) else f"{part}."


# ── what is true right now ───────────────────────────────────────────────────────────────────


def current_notices(
    *,
    quarantines: Mapping[str, str] | None = None,
    staged: ReadyRelease | None = None,
    rollback: ReleaseConfirmation | None = None,
    check: VersionCheck | None = None,
    config: HelperConfig | None = None,
    unsupervised: str = "",
    degradations: Sequence[Degradation] = (),
) -> tuple[Notice, ...]:
    """Every condition the user should be told about, from what the helper currently holds.

    Everything is optional because the helper learns these things at different times and from
    different places: quarantines from :class:`~innytypes.helper.breaker.QuarantineFile`, a
    rollback from the launch that confirmed or undid an update, a staged release from
    :func:`~innytypes.helper.swap.read_ready_release`, and the plugin lines from the version
    check. A caller that has not looked yet passes nothing and gets nothing, which is different
    from passing an empty answer.

    ``config`` decides what a plugin held at its installed version *means*. Rule 4 refuses
    `manual`, `off` and pinned plugins alike, and only one of those three is news: `manual` is
    "waiting for you to ask", while `off` and a pin are decisions the user already made and does
    not need repeating back at them.

    ``unsupervised`` is the sentence naming why the helper has no control channel to its host,
    and is empty whenever it has one. It comes first because it is the condition that makes the
    others unreliable: a helper that cannot hear its host cannot quarantine anything, so an
    empty list of quarantines below it means "nothing was heard" rather than "nothing is wrong".

    ``degradations`` is what the **host** last said it came up without, carried here over the
    control channel (:class:`~innytypes.helper.supervision.HostDegradations`). It defaults to
    nothing, which is a host that came up whole — and, for a caller that was never told, a
    caller with nothing to say rather than a claim that all is well.
    """
    settings = HelperConfig() if config is None else config
    notices: list[Notice] = []

    if unsupervised:
        notices.append(
            Notice(kind=NoticeKind.NOT_SUPERVISING, subject=HOST_ID, detail=unsupervised)
        )

    # Straight after the helper's own missing channel, and before anything about plugins or
    # releases, because this is the answer to "why is the thing I came here for not there".
    for degradation in degradations:
        notices.append(
            Notice(
                kind=NoticeKind.HOST_DEGRADED,
                subject=degradation.component,
                detail=degradation.reason,
            )
        )

    for child_id, reason in sorted((quarantines or {}).items()):
        notices.append(Notice(kind=NoticeKind.PROCESS_QUARANTINED, subject=child_id, detail=reason))

    if rollback is not None and not rollback.confirmed:
        notices.append(
            Notice(
                kind=NoticeKind.UPDATE_ROLLED_BACK,
                subject=HOST_ID,
                version=rollback.version,
                detail=rollback.reason or "",
            )
        )

    if staged is not None:
        notices.append(
            Notice(
                kind=NoticeKind.UPDATE_STAGED,
                subject=HOST_ID,
                version=str(staged.version),
                # Empty for the ordinary staged release, which goes in at the next quit. A
                # release whose `automatic` flag is false is waiting for the user to ask
                # (D13), and the marker's own sentence says why.
                detail=""
                if staged.automatic
                else (staged.blocked_reason or "It is not installed automatically"),
            )
        )

    for report in check.blocked if check is not None else ():
        newest = report.newest_version or report.installed_version

        if report.rule is ConsistencyRule.MODE_OR_PIN:
            if settings.plugins.is_pinned(report.id):
                continue
            if settings.update_mode_for(report.id) is not UpdateMode.MANUAL:
                continue
            notices.append(
                Notice(
                    kind=NoticeKind.PLUGIN_UPDATE_PENDING,
                    subject=report.id,
                    version=newest,
                    detail=report.reason or "",
                )
            )
            continue

        notices.append(
            Notice(
                kind=NoticeKind.PLUGIN_SET_BLOCKED,
                subject=report.id,
                version=newest,
                detail=report.reason or "",
            )
        )

    return tuple(notices)


# ── the seam to the operating system ─────────────────────────────────────────────────────────

# What a click does. Injected, because the window belongs to the application (slice 07b) and
# this module has no business knowing how one is raised.
OpenWindow = Callable[[Message], None]


class Notifier(Protocol):
    """Posting one message to whatever this operating system shows notifications with."""

    def post(self, message: Message) -> None:
        """Show it. Returns as soon as it has been handed over, never waiting on the user."""
        ...


@dataclass
class RecordingNotifier:
    """The headless notifier: records what would have been shown, and shows nothing.

    Every test in the gate uses this one, which is how "no test raises a real system
    notification" is a property of the code rather than a rule people remember. It is also the
    honest answer for a platform whose notifier is not built yet, where the alternative is a
    helper that cannot run at all.
    """

    on_click: OpenWindow | None = None
    posted: list[Message] = field(default_factory=list)

    def post(self, message: Message) -> None:
        self.posted.append(message)

    def click(self, index: int = -1) -> None:
        """What the operating system would call when the user clicks one of these.

        Raises :class:`IndexError` when nothing was posted, so a test cannot assert a click on a
        notification that was never shown.
        """
        message = self.posted[index]
        log.debug("notification %r was clicked", message.title)
        if self.on_click is not None:
            self.on_click(message)


# How :class:`MacNotifier` reaches `osascript`: the argument vector, and the script text fed to
# it on standard input. A seam so the gate can read both without running anything.
CommandRunner = Callable[[Sequence[str], str], None]

# The script `osascript` runs, whole, as a constant. It is never formatted, interpolated,
# concatenated or f-stringed, and that is the entire security argument of this notifier: the
# title and the body arrive as **`argv`**, which AppleScript hands to `display notification` as
# data. A quarantine reason containing a quote, a `$(...)`, a backtick or a semicolon is a
# quarantine reason containing those characters, and there is no stage at which it is text that
# something is about to compile.
MACOS_SCRIPT = (
    "on run argv\n\tdisplay notification (item 2 of argv) with title (item 1 of argv)\nend run\n"
)


def _run_osascript(argv: Sequence[str], script: str) -> None:
    """Run `osascript` with the script on stdin, never through a shell.

    ``shell=False`` (the default) is the other half of passing the text as ``argv``: there is no
    command line for anything to be quoted into. A non-zero exit is logged and not raised — a
    notification that could not be shown must not take the helper's tick down with it, and the
    condition it was about is still in the notices file for `status` to report.
    """
    completed = subprocess.run(
        list(argv),
        input=script,
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        log.warning(
            "osascript exited %s and showed no notification: %s",
            completed.returncode,
            completed.stderr.strip(),
        )


@dataclass
class MacNotifier:
    """Notification Center, posted through `osascript`, with the text passed as data.

    **Why the text is never in the script.** The obvious spelling of this —
    ``osascript -e f'display notification "{body}"'`` — builds a program out of a string that
    contains a quarantine reason, a plugin id and a version. Any of those can carry a quote, and
    a quote closes the string and starts AppleScript. `osascript` reads a program file named on
    the command line (``-`` meaning standard input) and passes everything after it to the
    script's ``on run argv`` as arguments, so :data:`MACOS_SCRIPT` stays a constant and the text
    stays an argument.

    **Clicks.** A notification posted this way belongs to `osascript`, and macOS reports nothing
    back when it is clicked, so ``on_click`` is never called by this notifier. Delivering a real
    click needs the bundled application's own ``UNUserNotificationCenter`` delegate, which comes
    with packaging (plan 0003, F5); the seam is here so that path has somewhere to arrive
    without changing this module's shape.
    """

    osascript: str = "/usr/bin/osascript"
    # None means the real one. A plain function as a dataclass default would be bound as a
    # method on attribute access, which is exactly the kind of surprise this seam exists to
    # avoid, so the default is spelled as the absence of an override.
    run: CommandRunner | None = None
    on_click: OpenWindow | None = None

    def post(self, message: Message) -> None:
        run = _run_osascript if self.run is None else self.run
        run([self.osascript, "-", message.title, message.body], MACOS_SCRIPT)


class UnsupportedPlatform(RuntimeError):
    """Raised when this operating system's notifier has not been built yet, naming the slice."""


def notifier_for(system: str, *, on_click: OpenWindow | None = None) -> Notifier:
    """The notifier for one operating system, named as :func:`platform.system` names it.

    A platform with no notifier is refused rather than quietly substituted. A notifier that
    accepts a message and drops it would let every acceptance criterion pass on a machine that
    shows the user nothing, which is the failure this refusal exists to prevent. A caller that
    wants to keep running without notifications says so by choosing :class:`RecordingNotifier`
    itself.

    The platform imports are inside their branches rather than at the top of the module, and
    that is not a style choice: :mod:`innytypes.helper.windows` and
    :mod:`innytypes.helper.linux` both import :class:`Message` from here, so importing them
    back at module scope would be a cycle. This is the only direction that is not one.
    """
    if system == "Darwin":
        return MacNotifier(on_click=on_click)
    if system == "Windows":
        from innytypes.helper.windows import WindowsNotifier

        return WindowsNotifier(on_click=on_click)
    if system == "Linux":
        from innytypes.helper.linux import LinuxNotifier

        return LinuxNotifier()
    raise UnsupportedPlatform(
        f"{system} has no notifier; InnyTypes runs on macOS, Windows and Linux"
    )


# ── what `status` reads ──────────────────────────────────────────────────────────────────────


def default_notices_path() -> Path:
    """Where the current conditions are recorded for this user, creating nothing."""
    return user_runtime_path(APPLICATION_NAME, appauthor=False) / NOTICES_FILENAME


@dataclass(frozen=True)
class NoticeFile:
    """Every condition that is true right now, on disk, so `status` can be asked at any time.

    On disk because the two halves are two processes: the helper writes it, and `innytypes
    helper status` — a command a person types while the helper may be wedged — reads it. Written
    on every tick whether or not anything was posted, which is what makes `status` independent
    of whether a notification was ever shown or dismissed.

    An unreadable file is read as "nothing", unlike the records a rollback keeps. The difference
    is what a wrong answer costs: misreading the blocked-versions file reinstalls a release that
    already failed, while misreading this one prints a shorter report. A `status` that refuses to
    print anything because one file is corrupt would fail a person at the moment they most need
    the other lines.
    """

    path: Path = field(default_factory=default_notices_path)

    def write(self, notices: Sequence[Notice]) -> None:
        """Replace the file atomically, with a scratch name of this process's own."""
        document = [
            {
                "kind": notice.kind.value,
                "subject": notice.subject,
                "version": notice.version,
                "detail": notice.detail,
            }
            for notice in notices
        ]

        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(f".{self.path.name}.{os.getpid()}.new")
        temporary.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, self.path)

    def read(self) -> tuple[Notice, ...]:
        """The conditions as last written, in the order they were written; empty when none."""
        try:
            text = self.path.read_text(encoding="utf-8")
        except OSError:
            return ()

        try:
            document = json.loads(text)
        except json.JSONDecodeError:
            return ()

        if not isinstance(document, list):
            return ()

        notices: list[Notice] = []
        for entry in document:
            if not isinstance(entry, Mapping):
                continue
            try:
                kind = NoticeKind(str(entry.get("kind")))
            except ValueError:
                # A kind this build does not know about: written by a newer helper, or by
                # something that is not one. Either way there are no words for it here.
                continue
            notices.append(
                Notice(
                    kind=kind,
                    subject=str(entry.get("subject", "")),
                    version=str(entry.get("version", "")),
                    detail=str(entry.get("detail", "")),
                )
            )
        return tuple(notices)


# ── telling the user, once ───────────────────────────────────────────────────────────────────


@dataclass
class Announcer:
    """Decides what the user is told, and tells them once.

    Handed the **whole** set of conditions that are true now, on every tick, and not a stream of
    events. That shape is what makes the deduplication rule a property of the code rather than a
    discipline every caller has to keep: a condition that is still true is still in the set, and
    is therefore not new, so nothing is posted for it.
    """

    notifier: Notifier
    # Where `status` reads the current conditions from. None keeps them in memory only, which is
    # what most tests want.
    store: NoticeFile | None = None

    _told: tuple[Notice, ...] = field(default=(), init=False)

    def announce(self, notices: Sequence[Notice]) -> tuple[Notice, ...]:
        """Record every condition, post the ones that are new. Returns what was posted.

        The record is written **before** anything is posted, so a notifier that cannot reach the
        operating system leaves `status` telling the truth anyway.
        """
        # `dict.fromkeys` rather than a set: two identical conditions in one tick are one thing
        # to say, and the order the caller built them in is the order a person reads them in.
        current = tuple(dict.fromkeys(notices))
        already = set(self._told)
        new = tuple(notice for notice in current if notice not in already)

        if self.store is not None:
            self.store.write(current)

        for notice in new:
            self.notifier.post(compose(notice))

        self._told = current
        return new
