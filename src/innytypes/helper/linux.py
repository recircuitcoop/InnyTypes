"""Linux's own facts, handed to policy that was written with no platform in it.

Plan 0003's MVP is macOS (D7), and slices 01–14 were deliberately built against **injected**
process tables, clocks, identifier sources and desktops. This module is the Linux half of what
those seams are filled with, and it is small on purpose: the smaller it is, the more of the
application is platform-independent, which is the property the injection was for.

**What Linux genuinely needed, and what it turned out not to.**

*It needed a `.desktop` entry.* On Linux an application exists, to the desktop shell, because a
`.desktop` file says so. :class:`DesktopEntry` is that file as a value — rendered, asserted and
written — and it is the same object twice over: once as the entry the Briefcase package installs
into the applications directory, and once, through :class:`LinuxLoginItem`, as the copy in the
XDG autostart directory that is what `launch_at_login` (F7) *means* on this platform.

*It needed a machine identifier.* `/etc/machine-id` is Linux's answer to macOS's
`IOPlatformUUID`, and it is read through the same injected source shape in
:mod:`innytypes.helper.telemetry`, not here — the telemetry module owns the one place a machine
is identified, and a second place would be a second thing to audit.

*It needed a way to raise a desktop notification.* :class:`NotifySendBackend` is that, through
`notify-send`, and :class:`DesktopNotifications` is the wording each of plan 0003's five
conditions gets on a Linux desktop.

*It did **not** need a `/proc` reader.* :class:`~innytypes.helper.processes.SystemProcessTable`
already answers every field the identity check (slice 03) and the resource check (slice 04)
consume — process ID, start time, executable path, resident memory, cumulative CPU, open file
descriptors and recursive child count — and `psutil` reads all seven of them out of `/proc` on
Linux already. A second reader here would be a second answer to a question that has one, kept
alive by nothing but a WorkItem's wording, so what this slice adds instead is a test that holds
that reader to the Linux-shaped values it will be given. See *What slice 15 sharpened* in plan
0003.

**Clicking a notification opens the window, and the three pieces above are how.** There is no
callback in `notify-send`; what there is, is the `desktop-entry` hint, which tells the desktop
shell which installed application a notification belongs to. The shell activates that
application on a click, the activation runs the entry's `Exec`, and that is
``innytypes-helper`` — which finds the single-instance lock held and brings the running
window forward rather than starting a second application (:mod:`innytypes.helper.launcher`).
So the hint, the entry and the lock are one mechanism, and :data:`DESKTOP_ENTRY_ID` is the
name all three of them have to agree on.

**Nothing here is reached by a test on the machine it describes.** The entry is rendered into a
string and written under a directory a test chooses, the notification backend runs an injected
command runner, and the machine identifier reads an injected reader. The gate runs on macOS and
never writes an autostart file, never runs `notify-send` and never opens `/etc/machine-id`.
"""

from __future__ import annotations

import os
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field, replace
from enum import StrEnum
from pathlib import Path
from typing import Protocol

from innytypes.addons.install import Runner, run_command
from innytypes.anytype_mcp.logs import get_logger
from innytypes.helper.launcher import LaunchAtLoginError

__all__ = [
    "APPLICATION_TITLE",
    "AUTOSTART_DIRNAME",
    "DESKTOP_ENTRY_ID",
    "DESKTOP_FILENAME",
    "NOTIFY_SEND",
    "TITLES",
    "DesktopEntry",
    "DesktopEntryError",
    "DesktopNotifications",
    "LinuxLoginItem",
    "Notification",
    "NotificationBackend",
    "NotificationCondition",
    "NotifySendBackend",
    "RecordingNotifications",
    "default_autostart_directory",
]

log = get_logger(__name__)

# The identifier the desktop shell knows this application by. D27's bundle identifier, unchanged:
# the same string names the macOS bundle, the `.desktop` file, the window class the shell matches
# a running window against, and the `desktop-entry` hint on every notification. One value, because
# a click on a notification only reaches the window if all four agree.
DESKTOP_ENTRY_ID = "it.l1nx.innytypes.helper"
DESKTOP_FILENAME = f"{DESKTOP_ENTRY_ID}.desktop"

# What the user sees under the icon. "InnyTypesHelper" is the process's name (D27); the thing
# with an icon on the user's desktop is the application.
APPLICATION_TITLE = "InnyTypes"

# The XDG directory whose `.desktop` files are launched at login, relative to the configuration
# home. Registering a login item on Linux is writing one file into it, and unregistering is
# deleting that file: there is no service to ask and no state kept anywhere else.
AUTOSTART_DIRNAME = "autostart"

# Absolute, not `notify-send`, for the same reason :mod:`innytypes.helper.telemetry` spells
# `/usr/sbin/ioreg` out in full: a bare name is resolved through `PATH`, and `PATH` is attacker
# territory in a process a user's shell profile has touched. Injectable, because a distribution
# that puts it somewhere else is a configuration question, not a reason to search `PATH`.
NOTIFY_SEND = "/usr/bin/notify-send"


class DesktopEntryError(RuntimeError):
    """Raised when a `.desktop` entry cannot be built out of what this installation has."""


# ── the `.desktop` entry ─────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class DesktopEntry:
    """The file that makes InnyTypes an application on a Linux desktop.

    **`Exec` is an absolute path and carries no field codes**, and both halves of that are
    load-bearing rather than tidiness.

    An absolute path, because the run-state record written for a process has to hold the
    executable the OS will report, and a record whose path does not match is one nothing will
    ever signal (:mod:`innytypes.helper.processes`). A launcher found on `PATH` at click time is
    a launcher whose path this application cannot predict, so an entry is refused rather than
    written with a bare name.

    No field codes — no `%f`, `%F`, `%u`, `%U` — because those are what a desktop shell uses to
    launch **one copy per file** the user dropped on the icon. InnyTypes is a single-instance
    application (plan 0003, *How the application starts*), and the entry says so twice: no field
    codes, so the shell is never invited to start a second copy, and ``SingleMainWindow=true``,
    so a shell that supports it raises the running window instead. The guarantee itself is not
    here and is not the shell's: it is the single-instance lock, which holds however the second
    launch was asked for.
    """

    # The installed launcher: the packaged `innytypes-helper`, by its absolute path.
    executable: str
    # The installed icon: an absolute path to an image, or an icon-theme name.
    icon: str
    name: str = APPLICATION_TITLE
    comment: str = "Anytype, with InnyTypes watching over it"
    categories: tuple[str, ...] = ("Utility", "Office")
    # Whether this is the autostart copy. The only difference in the file is the key a desktop
    # environment writes when the user turns an autostart entry off from its own settings; it is
    # written as `true` so that an entry this application installed is one that actually runs.
    autostart: bool = False

    def __post_init__(self) -> None:
        if not self.executable or not Path(self.executable).is_absolute():
            raise DesktopEntryError(
                f"a .desktop entry needs the absolute path of the installed launcher, and "
                f"{self.executable!r} is not one; the path is what the process table will "
                "report and what every identity check compares against (plan 0003)"
            )
        if not self.icon:
            raise DesktopEntryError(
                "a .desktop entry needs an icon: either the absolute path of the installed "
                "image or an icon-theme name"
            )

    @property
    def filename(self) -> str:
        """What the file is called, wherever it is installed. The application id, always."""
        return DESKTOP_FILENAME

    def autostarting(self) -> DesktopEntry:
        """The same entry as the copy that belongs in the autostart directory."""
        return replace(self, autostart=True)

    def render(self) -> str:
        """The file, as freedesktop's Desktop Entry specification spells it.

        Written out key by key rather than through a formatter, because every key here is a
        decision this plan made and a reader should be able to see all of them at once.
        """
        lines = [
            "[Desktop Entry]",
            # The version *of the specification* this file is written to, not of InnyTypes.
            "Version=1.0",
            "Type=Application",
            f"Name={_escape(self.name)}",
            f"Comment={_escape(self.comment)}",
            f"Exec={_exec_value(self.executable)}",
            f"Icon={_escape(self.icon)}",
            # It is a windowed application, so no terminal is opened for it.
            "Terminal=false",
            f"Categories={''.join(f'{_escape(item)};' for item in self.categories)}",
            # The shell may show a launch cue, and may match the window this application opens
            # to this entry — which is what makes a click on a notification land on our window.
            "StartupNotify=true",
            f"StartupWMClass={_escape(DESKTOP_ENTRY_ID)}",
            "SingleMainWindow=true",
        ]
        if self.autostart:
            lines.append("X-GNOME-Autostart-enabled=true")

        return "\n".join(lines) + "\n"

    def write(self, directory: Path) -> Path:
        """Write the entry into ``directory``, creating it if it is not there, and say where."""
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / self.filename
        path.write_text(self.render(), encoding="utf-8")
        return path


def _escape(value: str) -> str:
    """Escape one value the way the Desktop Entry specification asks for.

    Backslashes first, or the escapes added afterwards would be escaped again. Newlines and
    tabs become their two-character forms, because a value is one line and a raw newline in one
    would silently truncate the key or invent a new one.
    """
    return (
        value.replace("\\", "\\\\").replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t")
    )


def _exec_value(executable: str) -> str:
    """The `Exec` key's value: the launcher, quoted if it has to be.

    The specification's quoting is its own, stricter than the rest of the file's: a quoted
    argument escapes the backslash and the double quote, and a path with a space in it must be
    quoted or the shell would read it as two arguments.

    A literal percent sign is doubled, because in this one key a percent introduces a **field
    code** — the `%f`, `%U` and friends this entry deliberately has none of. A directory called
    `100%` in the installation path would otherwise be read as one.
    """
    escaped = _escape(executable).replace("%", "%%")
    if " " not in escaped:
        return escaped

    inner = escaped.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{inner}"'


# ── launch at login, which on Linux is one file in one directory (F7) ────────────────────────


def default_autostart_directory() -> Path:
    """Where this user's autostart entries live, creating nothing.

    `XDG_CONFIG_HOME` when the session sets it, and `~/.config` when it does not, which is what
    the XDG base directory specification says the fallback is. Read from the environment rather
    than from `platformdirs`, because the question here is not "where does this application keep
    its files" — it is "which directory does *this session's desktop* read at login".
    """
    configured = os.environ.get("XDG_CONFIG_HOME")
    base = Path(configured) if configured else Path.home() / ".config"
    return base / AUTOSTART_DIRNAME


@dataclass
class LinuxLoginItem:
    """`launch_at_login` on Linux: the entry, copied into the autostart directory.

    A :class:`~innytypes.helper.launcher.LoginItem`, so the switch in the window and in
    `config.toml` drives this exactly as it drives every other platform's — the switch's own
    ordering rule (ask the OS first, write the setting only once that worked) is
    :class:`~innytypes.helper.launcher.LaunchAtLogin`'s and is not repeated here.

    Every failure is raised as a :class:`~innytypes.helper.launcher.LaunchAtLoginError` with the
    path in it. A login item that quietly failed to register would leave the switch reading
    "on" while nothing starts at login, and the user would have no way to tell.
    """

    entry: DesktopEntry
    directory: Path = field(default_factory=default_autostart_directory)

    def register(self) -> None:
        """Write the autostart entry, so the desktop starts InnyTypes at the next login."""
        try:
            path = self.entry.autostarting().write(self.directory)
        except OSError as error:
            raise LaunchAtLoginError(
                f"the autostart entry could not be written to {self.directory}: {error}"
            ) from error

        log.info("InnyTypes will start at login: %s", path)

    def unregister(self) -> None:
        """Remove the autostart entry. Removing one that is already gone is not an error."""
        path = self.directory / self.entry.filename
        try:
            path.unlink(missing_ok=True)
        except OSError as error:
            raise LaunchAtLoginError(
                f"the autostart entry at {path} could not be removed: {error}"
            ) from error

        log.info("InnyTypes will no longer start at login")


# ── desktop notifications (plan 0003, *Telling the user*) ────────────────────────────────────


class NotificationCondition(StrEnum):
    """The five things plan 0003 says the user is told about, whatever platform they are on.

    Slice 14 decides **when** each of these has happened and makes sure `innytypes helper
    status` says so whether or not a notification was ever shown. This module decides only what
    a Linux desktop puts on the screen when it has.
    """

    QUARANTINE = "quarantine"
    ROLLBACK = "rollback"
    STAGED_UPDATE = "staged-update"
    PENDING_MANUAL_UPDATE = "pending-manual-update"
    BLOCKED_SET = "blocked-set"


# The headline each condition gets. A table rather than five methods, so "every condition has a
# wording" is one lookup that fails loudly for a condition nobody wrote one for, rather than a
# method somebody could forget to add. `{subject}` is the process, release or plugin it is about.
TITLES: Mapping[NotificationCondition, str] = {
    NotificationCondition.QUARANTINE: "InnyTypes has stopped restarting {subject}",
    NotificationCondition.ROLLBACK: "InnyTypes put the previous version back",
    NotificationCondition.STAGED_UPDATE: "An InnyTypes update is ready to install",
    NotificationCondition.PENDING_MANUAL_UPDATE: "{subject} has an update waiting for you",
    NotificationCondition.BLOCKED_SET: "An InnyTypes update is being held back",
}


@dataclass(frozen=True)
class Notification:
    """One thing to put on the screen: which condition it is, and what it says."""

    condition: NotificationCondition
    title: str
    body: str


class NotificationBackend(Protocol):
    """How a notification reaches this desktop. One call, and nothing to read back.

    The seam is deliberately this narrow. Slice 14 counts notifications, refuses duplicates and
    keeps `innytypes helper status` truthful; none of that is a platform's business, so none of
    it is in here. What a platform owns is putting one message on one screen.
    """

    def show(self, notification: Notification) -> None:
        """Raise this notification, or log why it could not be raised. Never raises."""
        ...


@dataclass
class NotifySendBackend:
    """The real Linux backend: one `notify-send` per notification.

    **The `desktop-entry` hint is the click.** `notify-send` has no callback to hand back — it
    is one command that exits — so a notification becomes clickable by naming the installed
    application it belongs to. The desktop shell activates that application when the user clicks,
    the activation runs the entry's `Exec`, and that launch finds the single-instance lock held
    and brings the running window forward. That is why the hint carries
    :data:`DESKTOP_ENTRY_ID` and not some string of its own.

    **It never raises.** A desktop with no notification daemon, a session with no bus, a
    distribution without `notify-send` installed: all three are reasons a message did not appear,
    and none of them is a reason for a quarantine to fail to be recorded or a quit to fail to
    happen. The failure is logged and the caller carries on.
    """

    run: Runner = run_command
    notify_send: str = NOTIFY_SEND
    application_id: str = DESKTOP_ENTRY_ID

    def show(self, notification: Notification) -> None:
        """Ask the desktop to show one notification, and say so in the log if it would not."""
        argv: Sequence[str] = (
            self.notify_send,
            "--app-name",
            APPLICATION_TITLE,
            f"--hint=string:desktop-entry:{self.application_id}",
            "--urgency=normal",
            notification.title,
            notification.body,
        )

        try:
            self.run(argv)
        except Exception as error:  # noqa: BLE001 - nothing fails because a message did not show
            log.warning(
                "this desktop would not show the %s notification: %s", notification.condition, error
            )


@dataclass
class RecordingNotifications:
    """A backend that keeps every notification instead of showing one.

    Not a mock: it is what an installation with no desktop session has, and what every test
    uses. The notifications it holds are the same objects a real desktop would have been asked
    for, so asserting on them is asserting on what the user would have seen.
    """

    shown: list[Notification] = field(default_factory=list)

    def show(self, notification: Notification) -> None:
        self.shown.append(notification)

    @property
    def conditions(self) -> list[NotificationCondition]:
        """Which conditions were raised, in order."""
        return [notification.condition for notification in self.shown]


@dataclass
class DesktopNotifications:
    """Plan 0003's five conditions, in the words a Linux desktop shows them in.

    The wording lives here rather than at each of the five call sites because that is what makes
    them consistent — and because the platform is the thing that changes between a Notification
    Center banner, a Windows toast and this. A caller says *which condition, about what, with
    what detail*; this decides what appears.
    """

    backend: NotificationBackend

    def show(
        self,
        condition: NotificationCondition,
        *,
        subject: str = APPLICATION_TITLE,
        detail: str,
    ) -> Notification:
        """Show one condition, and return what was shown so a caller can record it.

        A condition with no wording in :data:`TITLES` raises a :class:`KeyError` rather than
        showing something generic: an unworded condition is one somebody added without deciding
        what the user should be told, and a blank banner is worse than a loud failure.
        """
        notification = Notification(
            condition=condition,
            title=TITLES[condition].format(subject=subject),
            body=detail,
        )
        self.backend.show(notification)
        return notification
