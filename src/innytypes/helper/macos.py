"""macOS's own facts: the installed bundle, and the login item that needs one to exist.

Plan 0003 left `launch_at_login` (F7) half-built on purpose. The switch, its ordering rule and
its storage in `config.toml` are real and landed with slice 07; what was missing was anything
truthful to register with the operating system, because **registering a login item means
handing macOS the identity of an installed application** and until the Briefcase bundle (F5)
existed there was no such identity. :class:`~innytypes.helper.launcher.UnpackagedLoginItem`
refused out loud in the meantime, and that refusal is still what an unpackaged run gets:
:func:`default_login_item` hands it back whenever this process is not running out of a bundle.

**What a login item is here.** A **LaunchAgent**: one property list in the user's own
`~/Library/LaunchAgents`, named for the bundle identifier (D27), whose `ProgramArguments` is
the bundle's launcher and whose `RunAtLoad` is true. It is loaded into the running GUI session
with `launchctl bootstrap` so the switch takes effect now rather than at the next login, and
removed with `launchctl bootout`. That is the whole mechanism: a file and one command, both of
which a test can watch without a login ever happening.

*Why a LaunchAgent and not `SMAppService`.* Apple's modern API is the right long-term answer
and is Objective-C only — reaching it needs a bridge (`rubicon-objc`) and, more importantly, it
registers the **calling bundle**, which means it cannot be exercised at all outside a built
app. The LaunchAgent is the documented, still-supported path, it is a value this module can
render and assert, and it works identically for a bundle in `/Applications` and one a developer
built into `dist/`.

**The refusal is not softened, it is *narrowed*.** An installation with no bundle still gets
:class:`~innytypes.helper.launcher.UnpackagedLoginItem`'s sentence, because a hook that quietly
did nothing would leave the switch reading "on" in the window while nothing starts at login —
the one outcome the user cannot detect. What changed with the bundle is only that there is now
a case where the honest answer is "done" rather than "impossible".

**Nothing here runs on the machine during the gate.** The plist is rendered to a string and
written under a directory a test chooses, and `launchctl` is an injected
:data:`~innytypes.addons.install.Runner`. No test registers a login item, and none could.
"""

from __future__ import annotations

import os
import plistlib
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

from innytypes.addons.install import Runner, run_command
from innytypes.anytype_mcp.logs import get_logger
from innytypes.helper.config import BUNDLE_IDENTIFIER
from innytypes.helper.launcher import LaunchAtLoginError, LoginItem, UnpackagedLoginItem

__all__ = [
    "BUNDLE_SUFFIX",
    "LAUNCHCTL",
    "LAUNCH_AGENTS_DIRNAME",
    "MacLoginItem",
    "bundle_launcher",
    "default_launch_agents_directory",
    "default_login_item",
    "installed_bundle",
    "launch_agent_filename",
]

log = get_logger(__name__)

# What a macOS application bundle's directory is called, and where its launcher sits inside it.
# `installed_bundle` looks for exactly this shape, which is what Briefcase builds.
BUNDLE_SUFFIX = ".app"
BUNDLE_EXECUTABLE_PARTS = ("Contents", "MacOS")

# The per-user directory launchd reads at login. The *user's* one, never `/Library` and never
# `/System/Library`: a login item is this user's choice about their own session, and writing
# outside their home would need an administrator and would apply to people who never asked.
LAUNCH_AGENTS_DIRNAME = "Library/LaunchAgents"

# Absolute, for the reason `innytypes.helper.linux` spells `notify-send` out in full: a bare
# name is resolved through `PATH`, and `PATH` is attacker territory in a process a user's shell
# profile has touched.
LAUNCHCTL = "/bin/launchctl"


def launch_agent_filename(identifier: str = BUNDLE_IDENTIFIER) -> str:
    """What the property list is called: the bundle identifier, and `.plist`.

    launchd matches the file name against the `Label` inside it, so the two are one value here
    for the same reason the identifier is one value across the three platforms.
    """
    return f"{identifier}.plist"


def default_launch_agents_directory() -> Path:
    """This user's `~/Library/LaunchAgents`, creating nothing."""
    return Path.home() / LAUNCH_AGENTS_DIRNAME


def installed_bundle(executable: str | None = None) -> Path | None:
    """The `.app` this process is running out of, or ``None`` when it is not in one.

    Read off the running interpreter's path rather than asked of the operating system, because
    the question is not "is an InnyTypes bundle installed somewhere" — it is "is *this* process
    the bundle's own launcher". A machine may well have a bundle in `/Applications` while a
    developer runs the console script from a checkout, and registering that bundle from this
    process would point login at an application this run knows nothing about.

    The shape looked for is what Briefcase builds and what every macOS application has:
    `<name>.app/Contents/MacOS/<launcher>`.
    """
    path = Path(executable if executable is not None else sys.executable)
    parents = path.parents

    # `.../X.app/Contents/MacOS/launcher` — the bundle is three levels up, and the two levels
    # between are checked so a directory that merely ends in `.app` cannot be mistaken for one.
    if len(parents) < 3:
        return None

    bundle = parents[2]
    if bundle.suffix != BUNDLE_SUFFIX:
        return None
    if tuple(part.name for part in (parents[1], parents[0])) != BUNDLE_EXECUTABLE_PARTS:
        return None

    return bundle


def bundle_launcher(bundle: Path) -> Path | None:
    """The executable inside ``bundle`` that launching the application runs.

    A bundle has exactly one launcher and its name is not fixed — Briefcase names it after the
    application's formal name — so it is found rather than assumed, and a bundle with no
    launcher (or with several) answers ``None`` instead of guessing at one.
    """
    directory = bundle.joinpath(*BUNDLE_EXECUTABLE_PARTS)
    try:
        found = [entry for entry in sorted(directory.iterdir()) if entry.is_file()]
    except OSError:
        return None

    executables = [entry for entry in found if os.access(entry, os.X_OK)]
    return executables[0] if len(executables) == 1 else None


@dataclass
class MacLoginItem:
    """`launch_at_login` on macOS: a LaunchAgent naming the installed bundle's launcher.

    A :class:`~innytypes.helper.launcher.LoginItem`, so the switch in the window and in
    `config.toml` drives this exactly as it drives Linux's autostart entry — the switch's own
    ordering rule (ask the OS first, write the setting only once that worked) is
    :class:`~innytypes.helper.launcher.LaunchAtLogin`'s and is not repeated here.

    ``load`` is what makes the switch mean something before the next login. It is a separate
    step from writing the file because the two can fail independently, and a written plist that
    launchd was never told about is a login item that works tomorrow and not today. A failure to
    load removes the file again rather than leaving that half-state behind.
    """

    launcher: Path
    identifier: str = BUNDLE_IDENTIFIER
    directory: Path = field(default_factory=default_launch_agents_directory)
    launchctl: str = LAUNCHCTL
    run: Runner = run_command
    # The GUI session launchd is asked about. A callable, because the gate has no session and
    # `os.getuid` is the machine's answer rather than a value a test can choose.
    uid: int = field(default_factory=os.getuid)

    @property
    def path(self) -> Path:
        """Where the property list is written."""
        return self.directory / launch_agent_filename(self.identifier)

    def document(self) -> dict[str, object]:
        """The property list, as the dictionary `plistlib` writes.

        ``LimitLoadToSessionType`` is `Aqua` and is not decoration: without it launchd will
        offer the agent to background and pre-login contexts, where an application with a
        window has nothing to draw on and nobody to draw for.
        """
        return {
            "Label": self.identifier,
            "ProgramArguments": [str(self.launcher)],
            "RunAtLoad": True,
            "LimitLoadToSessionType": "Aqua",
        }

    def register(self) -> None:
        """Write the LaunchAgent and load it, so InnyTypes starts at the next login."""
        if not self.launcher.exists():
            raise LaunchAtLoginError(
                f"the application launcher at {self.launcher} is not there, so a login item "
                "naming it would start nothing; reinstall InnyTypes and try again"
            )

        try:
            self.directory.mkdir(parents=True, exist_ok=True)
            self.path.write_bytes(plistlib.dumps(self.document()))
        except OSError as error:
            raise LaunchAtLoginError(
                f"the login item could not be written to {self.path}: {error}"
            ) from error

        try:
            self._launchctl("bootstrap", self._domain(), str(self.path))
        except LaunchAtLoginError:
            # A plist launchd was never told about is a login item that silently works only
            # after the next reboot. Putting the file back is the honest half-state: none.
            self.path.unlink(missing_ok=True)
            raise

        log.info("InnyTypes will start at login: %s", self.path)

    def unregister(self) -> None:
        """Unload the LaunchAgent and remove it. Removing one already gone is not an error."""
        if self.path.exists():
            # Bootout first, while the file launchd was told about is still on disk. A domain
            # that has no such agent is not a failure: it is the state being asked for.
            try:
                self._launchctl("bootout", f"{self._domain()}/{self.identifier}")
            except LaunchAtLoginError as error:
                log.info("launchd had no login item to unload: %s", error)

        try:
            self.path.unlink(missing_ok=True)
        except OSError as error:
            raise LaunchAtLoginError(
                f"the login item at {self.path} could not be removed: {error}"
            ) from error

        log.info("InnyTypes will no longer start at login")

    def _domain(self) -> str:
        """The launchd domain a login item belongs to: this user's GUI session."""
        return f"gui/{self.uid}"

    def _launchctl(self, *arguments: str) -> None:
        """One `launchctl` call, with its failure turned into the switch's own error."""
        try:
            self.run([self.launchctl, *arguments])
        except (OSError, subprocess.CalledProcessError) as error:
            raise LaunchAtLoginError(
                f"`launchctl {' '.join(arguments)}` failed: {error}"
            ) from error


def default_login_item(executable: str | None = None) -> LoginItem:
    """The login item this installation actually has — which for an unpackaged run is a refusal.

    The one place the bundle question is asked. A packaged run gets a :class:`MacLoginItem`
    pointing at its own bundle's launcher; anything else gets
    :class:`~innytypes.helper.launcher.UnpackagedLoginItem`, whose refusal is unchanged and
    still the right answer: there is no installed identity to hand the operating system.
    """
    bundle = installed_bundle(executable)
    if bundle is None:
        return UnpackagedLoginItem()

    launcher = bundle_launcher(bundle)
    if launcher is None:
        log.warning(
            "%s has no single launcher in %s, so there is nothing a login item could name",
            bundle,
            "/".join(BUNDLE_EXECUTABLE_PARTS),
        )
        return UnpackagedLoginItem()

    return MacLoginItem(launcher=launcher)
