"""What Windows needs that the other two platforms do not (plan 0003, D7, slice 16).

Most of the helper is already the same on Windows, and that is by design rather than luck:
every seam that touches the machine is injected, and `psutil` answers the process table on all
three platforms. So this module is deliberately small. It holds the four things that are
genuinely different on Windows and nothing else:

* **The shortcuts that make InnyTypes an application.** macOS has a bundle and Linux has a
  `.desktop` file; Windows has a Start-menu shortcut and a desktop shortcut, both carrying an
  **AppUserModelID**. That identifier is not decoration: Windows shows a toast for an
  application it can find a Start-menu shortcut for, so the shortcut and the notifier below
  have to agree on one string or the user sees nothing.
* **The machine identifier.** Windows has no `/etc/machine-id` and no IORegistry; it has the
  `MachineGuid` registry value. That one lives in :mod:`innytypes.helper.telemetry`, beside
  the macOS and Linux sources and behind the same injected seam, because what a platform's
  machine identifier *is* differs but what telemetry does with it does not.
* **Toast notifications**, which are the Windows half of *Telling the user* (D6).
* **The quit-time updater step**, which is the one place Windows changes the *shape* of
  something rather than the implementation of it. A running program's files are locked on
  Windows, so the helper cannot rename the directory it is executing out of. The swap is
  therefore handed to a small process started at quit, which waits until the helper is
  confirmed gone and only then performs exactly the same swap
  (:meth:`~innytypes.helper.swap.ReleaseApplier.apply_at_quit`) that macOS and Linux perform
  in-process.

**Nothing here reads a real registry, raises a real toast or launches a real process in the
gate.** The registry value arrives through an injected reader, the toast through an injected
runner, and the updater through an injected process launcher and an injected process table —
which is how a gate that only ever runs on macOS can assert all of it.

**The no-interpolation discipline, carried over from macOS.** :class:`WindowsNotifier` never
builds a program out of a string containing a quarantine reason, a plugin id or a version.
:data:`TOAST_SCRIPT` is a constant, and the title, the body and the application id reach
PowerShell through the **environment**, where they are values and never source text. See that
class for why the environment rather than the command line.
"""

from __future__ import annotations

import json
import os
import subprocess
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import TYPE_CHECKING

from innytypes.anytype_mcp.logs import get_logger
from innytypes.children import ChildRecord
from innytypes.helper.notification import Message, OpenWindow
from innytypes.helper.processes import START_TIME_TOLERANCE, ProcessTable
from innytypes.helper.swap import AppliedRelease, ReadyRelease

if TYPE_CHECKING:  # pragma: no cover - imported for the type only, and it would be a cycle
    from innytypes.helper.swap import ReleaseApplier

__all__ = [
    "APPLICATION_TITLE",
    "APP_USER_MODEL_ID",
    "POWERSHELL",
    "SHORTCUT_DESCRIPTION",
    "SHORTCUT_NAME",
    "TOAST_APP_ID_VARIABLE",
    "TOAST_BODY_VARIABLE",
    "TOAST_SCRIPT",
    "TOAST_TITLE_VARIABLE",
    "UPDATER_POLL_INTERVAL",
    "UPDATER_TIMEOUT",
    "ProcessLauncher",
    "RecordingToasts",
    "ShortcutLocation",
    "ShortcutSpecification",
    "SwapHandoffError",
    "ToastRunner",
    "UpdaterOutcome",
    "WindowsNotifier",
    "WindowsSwapHandoff",
    "desktop_shortcut",
    "helper_has_exited",
    "run_updater",
    "shortcuts_for",
    "start_menu_shortcut",
    "start_updater_detached",
]

log = get_logger(__name__)

# The identifier the shell knows this application by, on every platform. The same string names
# the macOS bundle and the Linux `.desktop` entry (D27), and on Windows it is the
# **AppUserModelID**: the value on the Start-menu shortcut, and the value a toast is raised
# under. One string, because a toast raised under an id no shortcut carries is a toast Windows
# silently drops.
APP_USER_MODEL_ID = "it.l1nx.innytypes.helper"

# What the user reads under the icon. "InnyTypesHelper" is the process's name (D27); the thing
# with an icon in the Start menu is the application.
APPLICATION_TITLE = "InnyTypes"

# What the shortcut is called on disk, and the sentence Windows shows in its tooltip.
SHORTCUT_NAME = f"{APPLICATION_TITLE}.lnk"
SHORTCUT_DESCRIPTION = "Start InnyTypes, Anytype and everything that runs with them"

# Spelled in full, for the reason :mod:`innytypes.helper.telemetry` spells `/usr/sbin/ioreg` out:
# a bare name is resolved through `PATH`, and `PATH` is attacker territory in a process a user's
# shell profile has touched.
POWERSHELL = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"


class SwapHandoffError(RuntimeError):
    """Raised when the quit-time updater could not be handed the swap, naming what stopped it."""


# ── the shortcuts that make InnyTypes an application on Windows ──────────────────────────────


class ShortcutLocation(StrEnum):
    """The two places a Windows shortcut for this application is installed.

    The Start menu is the one that matters to more than the user's convenience: Windows
    resolves an AppUserModelID by looking for a Start-menu shortcut carrying it, and a toast
    raised under an id it cannot resolve is never shown. The desktop one is the icon D2 asks
    for — "everything will be started with a clickable application icon".
    """

    START_MENU = "start-menu"
    DESKTOP = "desktop"


@dataclass(frozen=True)
class ShortcutSpecification:
    """One Windows shortcut, as the fields whatever creates it has to be given.

    A specification rather than a writer, and that is deliberate. A `.lnk` is a binary object
    created through COM, and the thing that creates the two shortcuts on a user's machine is
    the **Briefcase bundle's installer** (plan 0003, F5) — not the helper, which by the time it
    runs is already installed. What this application owes that installer is an unambiguous
    description of what it should make, and that description is exactly what can be checked by
    a gate that runs on macOS.

    ``target`` is the executable the icon launches: ``innytypes-helper``, the console script
    D27 names, because the helper is what starts Anytype and the host (D2). ``arguments`` is
    empty on purpose — an icon that needed a flag would be an icon whose behaviour depends on
    which shortcut a person clicked.

    ``app_user_model_id`` is on **both** shortcuts, not only the Start-menu one, so that a
    window raised from either is grouped under the same taskbar identity as the toasts.
    """

    location: ShortcutLocation
    name: str
    target: Path
    icon: Path
    working_directory: Path
    app_user_model_id: str = APP_USER_MODEL_ID
    description: str = SHORTCUT_DESCRIPTION
    arguments: tuple[str, ...] = ()

    def path_under(self, directory: Path) -> Path:
        """Where this shortcut is written, given the directory for its location."""
        return directory / self.name


def start_menu_shortcut(*, executable: Path, icon: Path) -> ShortcutSpecification:
    """The Start-menu shortcut: the one that makes toasts possible as well as launching."""
    return ShortcutSpecification(
        location=ShortcutLocation.START_MENU,
        name=SHORTCUT_NAME,
        target=executable,
        icon=icon,
        # The directory the application starts in, which is the one holding its own executable.
        # A shortcut whose working directory is wherever Explorer happened to be would leave
        # every relative path in the application meaning something different per click.
        working_directory=executable.parent,
    )


def desktop_shortcut(*, executable: Path, icon: Path) -> ShortcutSpecification:
    """The desktop icon D2 asks for, pointing at the same executable as the Start-menu one."""
    return ShortcutSpecification(
        location=ShortcutLocation.DESKTOP,
        name=SHORTCUT_NAME,
        target=executable,
        icon=icon,
        working_directory=executable.parent,
    )


def shortcuts_for(*, executable: Path, icon: Path) -> tuple[ShortcutSpecification, ...]:
    """Both shortcuts the bundle installs, Start menu first.

    One function so the two cannot drift apart: they name the same executable, the same icon
    and the same AppUserModelID, and the only thing that differs between them is where they go.
    """
    return (
        start_menu_shortcut(executable=executable, icon=icon),
        desktop_shortcut(executable=executable, icon=icon),
    )


# ── toast notifications (plan 0003, *Telling the user*) ──────────────────────────────────────

# How :class:`WindowsNotifier` reaches PowerShell: the argument vector, the script text fed to
# it on standard input, and the environment the script reads its text out of. A seam, so the
# gate reads all three without running anything.
ToastRunner = Callable[[Sequence[str], str, Mapping[str, str]], None]

# The environment variables the constant script reads. Named here rather than spelled twice,
# because the script and the runner have to agree on them exactly.
TOAST_TITLE_VARIABLE = "INNYTYPES_TOAST_TITLE"
TOAST_BODY_VARIABLE = "INNYTYPES_TOAST_BODY"
TOAST_APP_ID_VARIABLE = "INNYTYPES_TOAST_APP_ID"

# The script PowerShell runs, whole, as a constant. It is never formatted, interpolated,
# concatenated or f-stringed, and that is the entire security argument of this notifier.
#
# Two things carry it. First, the title and the body arrive in the **environment**: `$env:NAME`
# is a variable read, so a quarantine reason containing a quote, a `$(...)`, a backtick or a
# semicolon is a quarantine reason containing those characters, and there is no stage at which
# it is text PowerShell is about to parse. Second, a toast is XML, and the two values are put
# into that XML with `CreateTextNode` — a DOM call that escapes what it is given — rather than
# by building the document out of strings, where a `<` would close an element.
TOAST_SCRIPT = f"""$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(
    [Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$texts = $template.GetElementsByTagName('text')
$texts.Item(0).AppendChild($template.CreateTextNode($env:{TOAST_TITLE_VARIABLE})) > $null
$texts.Item(1).AppendChild($template.CreateTextNode($env:{TOAST_BODY_VARIABLE})) > $null
$toast = [Windows.UI.Notifications.ToastNotification]::new($template)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(
    $env:{TOAST_APP_ID_VARIABLE}).Show($toast)
"""  # noqa: E501 - the WinRT type line is one token and wrapping it would change the script


def _run_powershell(argv: Sequence[str], script: str, environment: Mapping[str, str]) -> None:
    """Run PowerShell with the script on standard input, never through a shell.

    ``shell=False`` (the default) is the other half of keeping the text out of the script:
    there is nothing for a command line to be quoted into, because the only things on the
    command line are constants. A non-zero exit is logged and not raised — a toast that could
    not be shown must not take the helper's tick down with it, and the condition it was about
    is still in the notices file for `innytypes helper status` to report.
    """
    completed = subprocess.run(
        list(argv),
        input=script,
        env=dict(environment),
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        log.warning(
            "powershell exited %s and showed no toast: %s",
            completed.returncode,
            completed.stderr.strip(),
        )


@dataclass
class WindowsNotifier:
    """Windows toast notifications, raised through PowerShell, with the text passed as data.

    **Why PowerShell.** A toast is a WinRT call, and every Python package that wraps WinRT is a
    dependency that would be installed on macOS and Linux too, where it is not merely unused
    but unbuildable. PowerShell is on every supported Windows and needs nothing pinned.

    **Why the environment and not the command line.** The macOS notifier passes its text as
    ``argv`` because AppleScript hands ``argv`` to the script as data. PowerShell has no
    equivalent for a script read from standard input — `-Command -` takes no parameters — so
    the obvious spelling would be to build the command out of the title and the body, which is
    precisely the thing :data:`MACOS_SCRIPT <innytypes.helper.notification.MACOS_SCRIPT>`
    exists to avoid. The environment is the other channel that is data on both ends: the child
    reads a variable, and a variable's value is never parsed as source.

    **Clicks.** A toast raised this way belongs to PowerShell's invocation, and nothing is
    reported back when the user clicks it, so ``on_click`` is never called here. A real click
    needs the bundled application's own activation handler, which comes with packaging (F5);
    the seam is present so that path has somewhere to arrive without changing this class's
    shape. It is the same honest gap :class:`~innytypes.helper.notification.MacNotifier` has.
    """

    powershell: str = POWERSHELL
    app_user_model_id: str = APP_USER_MODEL_ID
    # None means the real one. A plain function as a dataclass default would be bound as a
    # method on attribute access, so the default is spelled as the absence of an override.
    run: ToastRunner | None = None
    on_click: OpenWindow | None = None

    def post(self, message: Message) -> None:
        """Raise one toast. Returns as soon as PowerShell has been handed the work."""
        run = _run_powershell if self.run is None else self.run
        run(
            [
                self.powershell,
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                "-",
            ],
            TOAST_SCRIPT,
            # The inherited environment plus the three values, rather than only the three: a
            # PowerShell started without `SystemRoot` or `PATHEXT` does not start at all.
            {
                **os.environ,
                TOAST_TITLE_VARIABLE: message.title,
                TOAST_BODY_VARIABLE: message.body,
                TOAST_APP_ID_VARIABLE: self.app_user_model_id,
            },
        )


@dataclass
class RecordingToasts:
    """The :data:`ToastRunner` the gate uses: records the three parts, raises nothing.

    It exists so a test can assert what Windows *would* have been asked to show — the argv, the
    constant script, and the environment the text travelled in — on a machine that has neither
    PowerShell nor a notification centre.
    """

    calls: list[tuple[tuple[str, ...], str, Mapping[str, str]]] = field(default_factory=list)

    def __call__(
        self,
        argv: Sequence[str],
        script: str,
        environment: Mapping[str, str],
    ) -> None:
        self.calls.append((tuple(argv), script, dict(environment)))

    @property
    def titles(self) -> tuple[str, ...]:
        """The title of every toast that was raised, in order."""
        return tuple(str(environment[TOAST_TITLE_VARIABLE]) for _, _, environment in self.calls)


# ── the quit-time updater step (plan 0003, *The update flow*, step 4) ────────────────────────

# How long the updater waits for the helper to finish exiting before it gives up. Generous,
# because the alternative to waiting is swapping under a running process, and a swap that never
# happens leaves the release in staging for the next quit to try again — which is a delay,
# while the other outcome is a half-updated installation.
UPDATER_TIMEOUT = 60.0

# How often it looks again while waiting. Short: every tick of it is a user watching an
# application that has not finished quitting.
UPDATER_POLL_INTERVAL = 0.25

# The one way the updater is started: a process that outlives the helper. A callable, so the
# gate asserts on the argv that was asked for rather than on a process it would have to reap.
ProcessLauncher = Callable[[Sequence[str]], None]


def helper_has_exited(
    table: ProcessTable,
    helper: ChildRecord,
    *,
    tolerance: float = START_TIME_TOLERANCE,
) -> bool:
    """Whether the helper this record names is really gone.

    The same three facts :class:`~innytypes.helper.processes.ManagedProcesses` compares before
    it signals anything, and the same tolerance — imported rather than restated, so there is
    one number and not two that could drift. It is asked here for the opposite purpose: not
    "may I act on this process" but "has this process finished".

    Bare liveness would be the wrong question and dangerously so. Between the helper exiting
    and the updater looking, Windows is free to give its process ID to something else, and an
    updater that read that as "still running" would wait out its whole timeout and never swap
    — which is how an update quietly stops arriving on a busy machine. A process ID that now
    describes a *different* program means our helper has gone, which is exactly what this
    returns.
    """
    facts = None if helper.pid < 1 else table.facts(helper.pid)

    if facts is None:
        return True
    if facts.pid != helper.pid:
        return True
    if abs(facts.started_at - helper.started_at) > tolerance:
        return True
    return facts.executable != helper.executable


@dataclass(frozen=True)
class UpdaterOutcome:
    """What the quit-time updater did: swapped, or why it did not.

    ``waited`` is how long it spent watching the helper go, which is the number to look at when
    somebody asks why quitting felt slow.
    """

    swapped: bool
    waited: float
    result: AppliedRelease | None = None
    reason: str | None = None


def run_updater(
    *,
    helper: ChildRecord,
    table: ProcessTable,
    swap: Callable[[], AppliedRelease | None],
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
    timeout: float = UPDATER_TIMEOUT,
    poll_interval: float = UPDATER_POLL_INTERVAL,
) -> UpdaterOutcome:
    """Wait until the helper is confirmed gone, and **only then** perform the swap.

    This is the whole of what Windows changes about applying an update. Everything the swap
    does is unchanged — the marker is re-read, the artifact re-hashed, the signature verified
    again, the two renames performed, the host version moved into every plugin environment —
    and all of it is still
    :meth:`~innytypes.helper.swap.ReleaseApplier.apply_at_quit`, arriving here as ``swap``.
    What differs is *who* runs it and *when*: a separate process, after the helper's exit,
    because on Windows a running program's files are locked and the helper cannot rename the
    directory it is executing out of.

    The ordering is the point, so it is expressed as one loop with one exit rather than as a
    precondition a caller could skip: there is no path through this function on which ``swap``
    is called while the check still reports the helper present. A helper that never goes gets
    no swap at all and says so — the release stays in staging, marked ready, and the next quit
    offers it again.

    The clock is monotonic, because a wait must not be lengthened or skipped by the machine's
    time changing under it, and both it and ``sleep`` are injected so the gate spends none of
    the timeout.
    """
    started = clock()
    deadline = started + timeout

    while not helper_has_exited(table, helper):
        if clock() >= deadline:
            waited = clock() - started
            reason = (
                f"{helper.id} (process {helper.pid}) was still running {waited:.1f} seconds "
                "after the quit, so nothing was swapped; the release is still staged and the "
                "next quit will try again"
            )
            log.error("%s", reason)
            return UpdaterOutcome(swapped=False, waited=waited, reason=reason)
        sleep(poll_interval)

    waited = clock() - started
    log.info("%s has exited after %.1f seconds; applying the staged release", helper.id, waited)
    return UpdaterOutcome(swapped=True, waited=waited, result=swap())


def start_updater_detached(argv: Sequence[str]) -> None:  # pragma: no cover - starts a process
    """Start the updater so that it outlives the helper, and do not wait for it.

    ``DETACHED_PROCESS`` and a new process group are what make it outlive us: a child in the
    helper's own console group would be sent the console's own shutdown, which is the signal
    the updater exists to be running *after*. The flags are looked up rather than written as
    literals, because this module is imported on macOS by the gate and
    ``subprocess.DETACHED_PROCESS`` does not exist there.
    """
    flags = 0
    for name in ("DETACHED_PROCESS", "CREATE_NEW_PROCESS_GROUP", "CREATE_BREAKAWAY_FROM_JOB"):
        flags |= int(getattr(subprocess, name, 0))

    subprocess.Popen(  # noqa: S603 - the argv is built from constants and this module's paths
        list(argv),
        creationflags=flags,
        close_fds=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


@dataclass(frozen=True)
class WindowsSwapHandoff:
    """Hands the swap to a process started at quit, instead of performing it in this one.

    Plugged into :class:`~innytypes.helper.swap.ReleaseApplier` as its ``handoff``, and built
    **only on Windows**: where it is absent — macOS, Linux — the applier swaps in-process
    exactly as it always has, which is the behaviour every other slice was written against.

    What is written and what is launched are separate on purpose. The plan file is a complete
    description of the swap, so the updater is not given arguments to misread and so a machine
    that was interrupted mid-quit leaves behind something a person can read. The launcher is a
    seam, so the gate asserts what would have been started without starting it.

    ``command`` has **no default**, and that is the same refusal
    :class:`~innytypes.helper.telemetry.Telemetry` makes of its machine identifier: there must
    be no way to reach a real one by forgetting an argument. It also has a real constraint that
    a default could not honour. The updater must run from an interpreter **outside** the
    release tree, because a process running out of `release/current` holds open the very files
    the swap renames — the problem this whole step exists to solve — so whoever builds this
    points it at the staged copy the bundle installs beside the application (F5).
    """

    helper: ChildRecord
    plan_path: Path
    public_key_path: Path
    command: Callable[[Path], Sequence[str]]
    launch: ProcessLauncher = start_updater_detached

    def hand_off(
        self,
        applier: ReleaseApplier,
        ready: ReadyRelease,
        *,
        requested: bool,
    ) -> None:
        """Write the plan and start the updater. Renames nothing, here or ever.

        The applier is read rather than re-derived: the updater must swap exactly what this
        quit decided to swap, from the same staging directory into the same roots, and a
        second set of default paths computed in the other process is a second thing that could
        disagree.
        """
        document = {
            "version": str(ready.version),
            "requested": requested,
            "helper": self.helper.to_document(),
            "staging": str(applier.staging),
            "release_root": str(applier.roots.root),
            "addons_root": str(applier.addons_root),
            "helper_environment": str(applier.helper_environment),
            "blocked_versions": str(applier.blocked.versions.path),
            "pending_release": str(applier.pending.path),
            "public_key": str(self.public_key_path),
            "platform": applier.platform,
        }

        try:
            self.plan_path.parent.mkdir(parents=True, exist_ok=True)
            self.plan_path.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
        except OSError as error:
            raise SwapHandoffError(
                f"the quit-time updater could not be told what to do: {self.plan_path} could "
                f"not be written ({error}). Release {ready.version} stays staged"
            ) from error

        try:
            self.launch(self.command(self.plan_path))
        except Exception as error:  # noqa: BLE001 - every failure to launch is one refusal
            raise SwapHandoffError(
                f"the quit-time updater could not be started: {error}. Release {ready.version} "
                "stays staged and the next quit will try again"
            ) from error

        log.info(
            "release %s will be installed by the updater once this helper has exited",
            ready.version,
        )


def main(argv: Sequence[str] | None = None) -> int:  # pragma: no cover - the updater process
    """``python -m innytypes.helper.windows <plan>``: the process the quit starts.

    Everything it needs is in the plan file the quit wrote, so it takes one argument and reads
    nothing else. It builds the same applier the helper would have used, with **no handoff** —
    this is the process that does the work — and calls it once the helper is gone.
    """
    import sys

    from innytypes.helper.minisign import parse_public_key
    from innytypes.helper.processes import SystemProcessTable
    from innytypes.helper.swap import (
        BlockedReleases,
        PendingReleaseFile,
        ReleaseApplier,
        ReleaseRoots,
        UvCoreInstaller,
    )

    arguments = list(sys.argv[1:] if argv is None else argv)
    if len(arguments) != 1:
        log.error("the updater takes one argument: the plan file the quit wrote")
        return 2

    plan = json.loads(Path(arguments[0]).read_text(encoding="utf-8"))
    applier = ReleaseApplier(
        installer=UvCoreInstaller(),
        roots=ReleaseRoots(root=Path(plan["release_root"])),
        staging=Path(plan["staging"]),
        public_key=parse_public_key(Path(plan["public_key"]).read_text(encoding="utf-8")),
        blocked=BlockedReleases.at(Path(plan["blocked_versions"])),
        pending=PendingReleaseFile(path=Path(plan["pending_release"])),
        addons_root=Path(plan["addons_root"]),
        helper_environment=Path(plan["helper_environment"]),
        platform=plan["platform"],
    )

    outcome = run_updater(
        helper=ChildRecord.from_document(plan["helper"]),
        table=SystemProcessTable(),
        swap=lambda: applier.apply_at_quit(requested=bool(plan["requested"])),
    )
    return 0 if outcome.swapped else 1


if __name__ == "__main__":  # pragma: no cover - the updater process
    raise SystemExit(main())
