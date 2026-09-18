"""The macOS login item, and the refusal it replaces for exactly one kind of installation.

Slice 07 shipped :class:`~innytypes.helper.launcher.UnpackagedLoginItem`, which refuses out
loud because a login item needs the identity of an installed application and there was no
bundle to have one. This file is the pair of assertions that keeps both halves of that honest
now that the bundle exists:

* a run **out of a bundle** registers a real LaunchAgent, naming the bundle's own launcher, and
  the `launch_at_login` switch in the window moves and stays moved;
* a run **not out of a bundle** still gets the refusal, word for word, because the honest
  failure is the thing that is easiest to lose when a feature finally works.

Nothing here touches this machine. The "bundle" is a directory under ``tmp_path`` shaped the
way macOS shapes one, `launchctl` is an injected runner that records its arguments, and the
LaunchAgents directory is wherever the test says it is. No login item is registered by the
gate, on any machine, ever.
"""

from __future__ import annotations

import os
import plistlib
import subprocess
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path

import pytest

from innytypes.helper.config import BUNDLE_IDENTIFIER, HelperSettings
from innytypes.helper.launcher import LaunchAtLogin, LaunchAtLoginError, UnpackagedLoginItem
from innytypes.helper.macos import (
    MacLoginItem,
    bundle_launcher,
    default_login_item,
    installed_bundle,
    launch_agent_filename,
)

UID = 501


@dataclass
class FakeLaunchctl:
    """`launchctl`, recorded rather than run. Raises what the real one raises when told to."""

    calls: list[tuple[str, ...]] = field(default_factory=list)
    fails: bool = False

    def __call__(self, argv: Sequence[str]) -> str:
        self.calls.append(tuple(argv))
        if self.fails:
            raise subprocess.CalledProcessError(1, list(argv), stderr="Bootstrap failed: 5: I/O")
        return ""

    @property
    def verbs(self) -> list[str]:
        """The subcommand of each call: `bootstrap`, `bootout`."""
        return [call[1] for call in self.calls]


def make_bundle(root: Path, *, name: str = "InnyTypes", launcher: str = "InnyTypes") -> Path:
    """A directory shaped exactly like the bundle Briefcase builds, with one launcher in it."""
    bundle = root / f"{name}.app"
    executables = bundle / "Contents" / "MacOS"
    executables.mkdir(parents=True)
    (executables / launcher).write_text("#!/bin/sh\n", encoding="utf-8")
    (executables / launcher).chmod(0o755)
    return bundle


@pytest.fixture
def bundle(tmp_path: Path) -> Path:
    return make_bundle(tmp_path)


@pytest.fixture
def agents(tmp_path: Path) -> Path:
    return tmp_path / "LaunchAgents"


# --- is this process running out of a bundle? -----------------------------------------------


def test_a_bundled_launcher_is_recognised_as_one(bundle: Path) -> None:
    executable = bundle / "Contents" / "MacOS" / "InnyTypes"

    assert installed_bundle(str(executable)) == bundle


def test_an_unpackaged_interpreter_is_not_a_bundle(tmp_path: Path) -> None:
    # What a `pip install` or a checkout looks like: a Python in a virtual environment.
    assert installed_bundle(str(tmp_path / ".venv" / "bin" / "python")) is None


def test_a_directory_that_merely_ends_in_app_is_not_a_bundle(tmp_path: Path) -> None:
    # The shape is checked, not the suffix: `Contents/MacOS` has to be there too, or any
    # project directory called `something.app` would be registered as an application.
    stray = tmp_path / "mine.app" / "bin" / "python"
    stray.parent.mkdir(parents=True)

    assert installed_bundle(str(stray)) is None


def test_the_launcher_inside_a_bundle_is_found_rather_than_assumed(bundle: Path) -> None:
    # Briefcase names the launcher after the formal name, so it is discovered. A bundle with
    # two executables is ambiguous and answers nothing rather than picking one.
    assert bundle_launcher(bundle) == bundle / "Contents" / "MacOS" / "InnyTypes"

    second = bundle / "Contents" / "MacOS" / "Updater"
    second.write_text("#!/bin/sh\n", encoding="utf-8")
    second.chmod(0o755)

    assert bundle_launcher(bundle) is None


# --- the refusal still stands for an unpackaged run -----------------------------------------


def test_an_unpackaged_run_still_gets_the_refusal(tmp_path: Path) -> None:
    item = default_login_item(str(tmp_path / ".venv" / "bin" / "python"))

    assert isinstance(item, UnpackagedLoginItem)
    with pytest.raises(LaunchAtLoginError, match="application bundle"):
        item.register()
    with pytest.raises(LaunchAtLoginError, match="no login item to remove"):
        item.unregister()


def test_a_bundle_with_no_usable_launcher_refuses_rather_than_guessing(tmp_path: Path) -> None:
    bundle = tmp_path / "InnyTypes.app"
    (bundle / "Contents" / "MacOS").mkdir(parents=True)
    executable = bundle / "Contents" / "MacOS" / "InnyTypes"

    assert isinstance(default_login_item(str(executable)), UnpackagedLoginItem)


def test_a_bundled_run_gets_a_real_login_item(bundle: Path) -> None:
    item = default_login_item(str(bundle / "Contents" / "MacOS" / "InnyTypes"))

    assert isinstance(item, MacLoginItem)
    assert item.launcher == bundle / "Contents" / "MacOS" / "InnyTypes"
    assert item.identifier == BUNDLE_IDENTIFIER


# --- registering one --------------------------------------------------------------------


def make_item(bundle: Path, agents: Path, launchctl: FakeLaunchctl) -> MacLoginItem:
    return MacLoginItem(
        launcher=bundle / "Contents" / "MacOS" / "InnyTypes",
        directory=agents,
        run=launchctl,
        uid=UID,
    )


def test_registering_writes_the_agent_and_loads_it(bundle: Path, agents: Path) -> None:
    launchctl = FakeLaunchctl()
    item = make_item(bundle, agents, launchctl)

    item.register()

    written = agents / launch_agent_filename()
    document = plistlib.loads(written.read_bytes())
    assert document["Label"] == BUNDLE_IDENTIFIER
    assert document["ProgramArguments"] == [str(bundle / "Contents" / "MacOS" / "InnyTypes")]
    assert document["RunAtLoad"] is True
    # Without this, launchd offers the agent to contexts that have no screen to draw on.
    assert document["LimitLoadToSessionType"] == "Aqua"

    # Loaded into this user's own GUI session, so the switch means something before the next
    # login rather than only after it.
    assert launchctl.calls == ([("/bin/launchctl", "bootstrap", f"gui/{UID}", str(written))])


def test_registering_against_a_launcher_that_is_not_there_refuses(
    tmp_path: Path, agents: Path
) -> None:
    launchctl = FakeLaunchctl()
    item = MacLoginItem(
        launcher=tmp_path / "Gone.app" / "Contents" / "MacOS" / "Gone",
        directory=agents,
        run=launchctl,
        uid=UID,
    )

    with pytest.raises(LaunchAtLoginError, match="is not there"):
        item.register()

    assert not (agents / launch_agent_filename()).exists()
    assert launchctl.calls == []


def test_a_load_that_fails_leaves_no_half_registered_login_item(bundle: Path, agents: Path) -> None:
    # A plist launchd was never told about is a login item that works after the next reboot
    # and not before, with the switch reading "on" the whole time. The file goes back.
    launchctl = FakeLaunchctl(fails=True)
    item = make_item(bundle, agents, launchctl)

    with pytest.raises(LaunchAtLoginError, match="launchctl bootstrap"):
        item.register()

    assert not (agents / launch_agent_filename()).exists()


def test_unregistering_unloads_and_removes(bundle: Path, agents: Path) -> None:
    launchctl = FakeLaunchctl()
    item = make_item(bundle, agents, launchctl)
    item.register()

    item.unregister()

    assert not (agents / launch_agent_filename()).exists()
    assert launchctl.verbs == ["bootstrap", "bootout"]
    assert launchctl.calls[-1] == (
        "/bin/launchctl",
        "bootout",
        f"gui/{UID}/{BUNDLE_IDENTIFIER}",
    )


def test_unregistering_something_that_was_never_registered_is_not_an_error(
    bundle: Path, agents: Path
) -> None:
    launchctl = FakeLaunchctl()

    make_item(bundle, agents, launchctl).unregister()

    # Nothing to unload, nothing to remove, and no complaint: the state asked for is the
    # state the machine is already in.
    assert launchctl.calls == []


def test_a_launchd_that_has_no_such_agent_does_not_block_the_removal(
    bundle: Path, agents: Path
) -> None:
    # `bootout` on a domain that never loaded the agent fails, and it must not stop the file
    # being removed: the user asked for the login item to go away.
    launchctl = FakeLaunchctl()
    item = make_item(bundle, agents, launchctl)
    item.register()
    launchctl.fails = True

    item.unregister()

    assert not (agents / launch_agent_filename()).exists()


# --- the switch the window actually moves ---------------------------------------------------


def test_the_switch_turns_on_against_a_bundle_and_stays_on(
    bundle: Path, agents: Path, tmp_path: Path
) -> None:
    # The whole point of the slice, end to end: the control in the window, the OS, and
    # `config.toml` agreeing. The switch asks the OS first and writes the setting only once
    # that worked, which is `LaunchAtLogin`'s rule and is not re-implemented for macOS.
    settings = HelperSettings(path=tmp_path / "config.toml")
    launchctl = FakeLaunchctl()
    switch = LaunchAtLogin(settings=settings, login_item=make_item(bundle, agents, launchctl))

    assert switch.enabled is False
    switch.set(True)

    assert switch.enabled is True
    assert settings.launch_at_login is True
    assert (agents / launch_agent_filename()).is_file()

    switch.set(False)

    assert switch.enabled is False
    assert not (agents / launch_agent_filename()).exists()


def test_the_switch_does_not_move_for_an_unpackaged_installation(tmp_path: Path) -> None:
    # The refusal, as the user would meet it: the setting is not written, so the window can
    # never show "on" for a machine where nothing will start at login.
    settings = HelperSettings(path=tmp_path / "config.toml")
    switch = LaunchAtLogin(settings=settings, login_item=UnpackagedLoginItem())

    with pytest.raises(LaunchAtLoginError):
        switch.set(True)

    assert settings.launch_at_login is False


def test_the_default_uid_is_this_session(bundle: Path, agents: Path) -> None:
    # The domain is read from the running user rather than hard-coded, because a login item
    # loaded into somebody else's session is one this user cannot turn off.
    item = MacLoginItem(launcher=bundle / "Contents" / "MacOS" / "InnyTypes", directory=agents)

    assert item.uid == os.getuid()
