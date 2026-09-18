"""Linux's facts, proved on a machine that is not Linux.

The gate runs on macOS (plan 0003, D7: macOS is the MVP and Linux is slice 15), so every one of
these tests has to hold without a Linux kernel under it. That is not a limitation worked around
here — it is the same rule the whole helper is built to, and this file is where it is cashed in:

  * the **machine identifier** is read through an injected reader, so ``/etc/machine-id`` is
    never opened, on Linux or anywhere else;
  * the **notification backend** is a list, so nothing is ever put on a screen;
  * the **`.desktop` entry** is rendered into a string and written under ``tmp_path``, so no
    autostart directory of the person running the gate is touched;
  * the **process table** is driven by a stand-in ``psutil`` carrying Linux-shaped values, so no
    real process is looked up and no ``/proc`` entry is read.

**Why there is no `/proc` reader to test.** The WorkItem asked for one. There is nothing for it
to do: ``SystemProcessTable`` already answers every field the identity check (slice 03) and the
resource check (slice 04) consume, and ``psutil`` reads all of them out of ``/proc`` on Linux.
So what this file proves instead is that the reader we have produces the right shape from the
values Linux gives it — which is the thing a second implementation would have been written to
make true. See *What slice 15 sharpened* in plan 0003.
"""

from __future__ import annotations

import hashlib
import hmac
import sys
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from innytypes.children import ChildKind, ChildRecord, RunStateFile
from innytypes.helper.config import HelperSettings
from innytypes.helper.launcher import (
    HELPER_ID,
    InstanceLock,
    LaunchAtLogin,
    LaunchAtLoginError,
)
from innytypes.helper.linux import (
    APPLICATION_TITLE,
    AUTOSTART_DIRNAME,
    DESKTOP_ENTRY_ID,
    DESKTOP_FILENAME,
    NOTIFY_SEND,
    DesktopEntry,
    DesktopEntryError,
    LinuxLoginItem,
    LinuxNotifier,
    default_autostart_directory,
)
from innytypes.helper.notification import HOST_ID, Notice, NoticeKind, compose
from innytypes.helper.processes import (
    ManagedProcesses,
    ProcessFacts,
    ResourceSample,
    SystemProcessTable,
)
from innytypes.helper.telemetry import (
    LINUX_MACHINE_ID_PATHS,
    MACHINE_ID_KEY,
    TelemetryError,
    machine_id,
    os_machine_identifier,
)

# What an installed Linux package looks like from the outside. Paths only — nothing here is
# created, and nothing looks for them on the machine running the gate.
LINUX_LAUNCHER = "/opt/innytypes/bin/innytypes-helper"
LINUX_ICON = "/opt/innytypes/share/icons/innytypes.png"

# A machine identifier that exists only in this file. The word "fake" is on the line for
# tests/test_no_secrets.py, and it is 32 characters like a real one so nothing is exercised at
# a length a real read would never produce.
FAKE_MACHINE_ID = "fake0a1b2c3d4e5f60718293a4b5c6d7"


def entry(**changes: object) -> DesktopEntry:
    """The entry the Linux package installs, with anything a test wants changed."""
    fields: dict[str, Any] = {"executable": LINUX_LAUNCHER, "icon": LINUX_ICON}
    fields.update(changes)
    return DesktopEntry(**fields)


def keys(rendered: str) -> dict[str, str]:
    """The rendered entry as the key/value pairs a desktop shell would read out of it."""
    lines = rendered.splitlines()
    assert lines[0] == "[Desktop Entry]", "a desktop entry starts with its group header"
    return dict(line.split("=", 1) for line in lines[1:] if line)


# --- the `.desktop` entry -------------------------------------------------------------------


def test_the_desktop_entry_names_the_installed_launcher_and_icon() -> None:
    fields = keys(entry().render())

    assert fields["Exec"] == LINUX_LAUNCHER
    assert fields["Icon"] == LINUX_ICON
    assert fields["Type"] == "Application"
    assert fields["Name"] == APPLICATION_TITLE
    assert fields["Terminal"] == "false"
    assert fields["Categories"] == "Utility;Office;"
    assert entry().filename == DESKTOP_FILENAME


def test_the_desktop_entry_asks_the_shell_for_one_window_and_offers_it_no_files() -> None:
    """The entry's half of the single-instance rule: nothing invites a second copy.

    A field code — `%f`, `%F`, `%u`, `%U` — is how a desktop shell is told it may launch one
    copy of an application per file dropped on its icon. InnyTypes has no such spelling, and
    ``SingleMainWindow`` asks a shell that understands it to raise the running window instead.
    """
    fields = keys(entry().render())

    assert fields["SingleMainWindow"] == "true"
    assert not any(code in fields["Exec"] for code in ("%f", "%F", "%u", "%U", "%i", "%c"))
    # The window class is the application id, which is what lets the shell match the window a
    # click on a notification should raise to this entry.
    assert fields["StartupWMClass"] == DESKTOP_ENTRY_ID


@dataclass
class FakeTable:
    """The OS process table as plain data: the only thing the lock's identity check reads."""

    facts_by_pid: dict[int, ProcessFacts] = field(default_factory=dict)

    def facts(self, pid: int) -> ProcessFacts | None:
        return self.facts_by_pid.get(pid)


def helper_at(pid: int, executable: str, started_at: float = 1_000.0) -> ChildRecord:
    """A helper's own run-state record, as a launch of the `.desktop` entry would write one."""
    return ChildRecord(
        id=HELPER_ID,
        kind=ChildKind.HELPER,
        pid=pid,
        started_at=started_at,
        executable=executable,
        parent_pid=1,
    )


def test_a_second_launch_of_the_desktop_entry_starts_nothing(tmp_path: Path) -> None:
    """The entry's single-instance behaviour **is** slice 07's lock, not a shell's promise.

    The launcher the entry's `Exec` names is what takes the lock, so this runs the real lock
    against the real path out of the rendered file: the second launch is refused and is told
    which helper is already running, which is what makes it bring that window forward instead.
    """
    launcher = keys(entry().render())["Exec"]
    assert launcher.endswith("innytypes-helper")

    first = helper_at(pid=4242, executable=launcher)
    table = FakeTable({first.pid: ProcessFacts(first.pid, first.started_at, launcher)})
    lock = InstanceLock(
        path=tmp_path / "helper.lock",
        processes=ManagedProcesses(
            run_state=RunStateFile(tmp_path / "run-state.json"),
            table=table,
        ),
    )

    assert lock.acquire(first).held is True

    second = lock.acquire(helper_at(pid=4343, executable=launcher, started_at=2_000.0))

    assert second.held is False
    assert second.holder is not None
    assert second.holder.pid == first.pid


def test_an_entry_with_no_absolute_launcher_is_refused() -> None:
    """A bare command name is a path this application cannot predict, so it is not written.

    The run-state record for a launched process holds the executable the OS will report, and a
    record whose path does not match is one nothing will ever signal (plan 0003, *Phantom
    detection*). An entry naming `innytypes-helper` and hoping `PATH` agrees is that record.
    """
    with pytest.raises(DesktopEntryError, match="absolute path"):
        entry(executable="innytypes-helper")

    with pytest.raises(DesktopEntryError, match="absolute path"):
        entry(executable="")


def test_an_entry_with_no_icon_is_refused() -> None:
    with pytest.raises(DesktopEntryError, match="icon"):
        entry(icon="")


def test_a_launcher_path_with_a_space_in_it_is_quoted() -> None:
    fields = keys(entry(executable="/opt/inny types/bin/innytypes-helper").render())

    assert fields["Exec"] == '"/opt/inny types/bin/innytypes-helper"'


def test_a_percent_in_the_launcher_path_is_not_read_as_a_field_code() -> None:
    """In `Exec`, a percent starts a field code — the very thing this entry has none of."""
    fields = keys(entry(executable="/opt/inny100%/bin/innytypes-helper").render())

    assert fields["Exec"] == "/opt/inny100%%/bin/innytypes-helper"


def test_a_newline_cannot_smuggle_a_second_key_into_the_entry() -> None:
    """Escaping is not cosmetic: an unescaped newline in a value invents a key."""
    fields = keys(entry(icon="/icons/one\nExec=/bin/sh").render())

    assert fields["Exec"] == LINUX_LAUNCHER
    assert fields["Icon"] == "/icons/one\\nExec=/bin/sh"


def test_the_entry_is_written_where_it_is_asked_for(tmp_path: Path) -> None:
    written = entry().write(tmp_path / "applications")

    assert written == tmp_path / "applications" / DESKTOP_FILENAME
    assert keys(written.read_text(encoding="utf-8"))["Exec"] == LINUX_LAUNCHER


# --- launch at login (F7) -------------------------------------------------------------------


def test_launch_at_login_on_linux_writes_the_autostart_entry(tmp_path: Path) -> None:
    autostart = tmp_path / AUTOSTART_DIRNAME
    switch = LaunchAtLogin(
        settings=HelperSettings(path=tmp_path / "config.toml"),
        login_item=LinuxLoginItem(entry=entry(), directory=autostart),
    )

    switch.set(True)

    written = autostart / DESKTOP_FILENAME
    assert switch.enabled is True
    fields = keys(written.read_text(encoding="utf-8"))
    assert fields["Exec"] == LINUX_LAUNCHER
    # The key a desktop environment writes when a user turns an autostart entry off. Ours says
    # `true`, because an entry this application installed is one that is meant to run.
    assert fields["X-GNOME-Autostart-enabled"] == "true"


def test_turning_launch_at_login_off_removes_the_autostart_entry(tmp_path: Path) -> None:
    autostart = tmp_path / AUTOSTART_DIRNAME
    switch = LaunchAtLogin(
        settings=HelperSettings(path=tmp_path / "config.toml"),
        login_item=LinuxLoginItem(entry=entry(), directory=autostart),
    )
    switch.set(True)

    switch.set(False)

    assert not (autostart / DESKTOP_FILENAME).exists()
    assert switch.enabled is False


def test_removing_an_autostart_entry_that_is_not_there_is_not_an_error(tmp_path: Path) -> None:
    LinuxLoginItem(entry=entry(), directory=tmp_path / AUTOSTART_DIRNAME).unregister()


def test_an_autostart_entry_that_cannot_be_written_refuses_out_loud(tmp_path: Path) -> None:
    """A login item that failed quietly would leave the switch on and nothing starting."""
    blocked = tmp_path / "not-a-directory"
    blocked.write_text("", encoding="utf-8")

    with pytest.raises(LaunchAtLoginError, match="could not be written"):
        LinuxLoginItem(entry=entry(), directory=blocked / AUTOSTART_DIRNAME).register()


def test_an_autostart_entry_that_cannot_be_removed_refuses_out_loud(tmp_path: Path) -> None:
    """The other half: a switch that said "off" while the entry stayed would be as bad."""
    autostart = tmp_path / AUTOSTART_DIRNAME
    (autostart / DESKTOP_FILENAME).mkdir(parents=True)

    with pytest.raises(LaunchAtLoginError, match="could not be removed"):
        LinuxLoginItem(entry=entry(), directory=autostart).unregister()


def test_the_default_autostart_directory_follows_the_session(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))
    assert default_autostart_directory() == tmp_path / "config" / AUTOSTART_DIRNAME

    monkeypatch.delenv("XDG_CONFIG_HOME")
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path / "home"))
    assert default_autostart_directory() == tmp_path / "home" / ".config" / AUTOSTART_DIRNAME


# --- the machine id -------------------------------------------------------------------------


@dataclass
class FakeFiles:
    """The files a test says this machine has, and every path that was asked for."""

    contents: dict[str, str] = field(default_factory=dict)
    asked: list[str] = field(default_factory=list)

    def __call__(self, path: str) -> str:
        self.asked.append(path)
        try:
            return self.contents[path]
        except KeyError as error:
            raise FileNotFoundError(f"no such file: {path}") from error


def test_the_linux_machine_identifier_is_etc_machine_id() -> None:
    files = FakeFiles({"/etc/machine-id": f"{FAKE_MACHINE_ID}\n"})

    found = os_machine_identifier(system="Linux", read=files)

    assert found == FAKE_MACHINE_ID
    # The injected source is what was read, and the real file was never opened.
    assert files.asked == ["/etc/machine-id"]


def test_an_empty_etc_machine_id_falls_through_to_the_dbus_one() -> None:
    """A machine whose identifier is generated at first boot has the file and no contents."""
    files = FakeFiles(
        {"/etc/machine-id": "\n", "/var/lib/dbus/machine-id": f"{FAKE_MACHINE_ID}\n"},
    )

    assert os_machine_identifier(system="Linux", read=files) == FAKE_MACHINE_ID
    assert files.asked == list(LINUX_MACHINE_ID_PATHS)


def test_a_linux_machine_with_no_identifier_at_all_is_refused_by_name() -> None:
    files = FakeFiles()

    with pytest.raises(TelemetryError) as raised:
        os_machine_identifier(system="Linux", read=files)

    # Both paths are named, with why each one missed: that is all a user on such a machine has.
    assert all(path in str(raised.value) for path in LINUX_MACHINE_ID_PATHS)
    assert files.asked == list(LINUX_MACHINE_ID_PATHS)


def test_the_linux_identifier_is_hashed_before_anything_else_sees_it() -> None:
    """D20 again, on this platform: what is reported is the HMAC, never the file's contents."""
    identifier = os_machine_identifier(
        system="Linux",
        read=FakeFiles({"/etc/machine-id": FAKE_MACHINE_ID}),
    )
    hashed = machine_id(lambda: identifier)

    assert hashed == hmac.new(MACHINE_ID_KEY, FAKE_MACHINE_ID.encode(), hashlib.sha256).hexdigest()
    assert FAKE_MACHINE_ID not in hashed


# --- desktop notifications ------------------------------------------------------------------

# The wording of the five conditions is slice 14's (`innytypes.helper.notification`), and it is
# tested there. What belongs here is the one thing that is Linux's: that a composed message
# reaches a Linux desktop, tied to the entry that makes a click come back to us.


@dataclass
class FakeRunner:
    """The commands a test would have run, and whether running one is made to fail."""

    commands: list[tuple[str, ...]] = field(default_factory=list)
    fail: bool = False

    def __call__(self, argv: Sequence[str]) -> str:
        self.commands.append(tuple(argv))
        if self.fail:
            raise OSError("no notification daemon on this session bus")
        return ""


def test_the_real_backend_asks_notify_send_and_ties_it_to_the_desktop_entry() -> None:
    """The `desktop-entry` hint is how a click on a Linux notification reaches our window.

    There is no callback in `notify-send`. What there is, is the hint naming the installed
    application, which the shell activates on a click — and that activation runs the entry's
    `Exec`, which finds the single-instance lock held and raises the running window.
    """
    runner = FakeRunner()

    LinuxNotifier(run=runner).post(
        compose(
            Notice(
                kind=NoticeKind.UPDATE_STAGED,
                subject=HOST_ID,
                version="1.5.0",
                detail="1.5.0 installs when you quit",
            )
        )
    )

    (command,) = runner.commands
    assert command[0] == NOTIFY_SEND
    assert f"--hint=string:desktop-entry:{DESKTOP_ENTRY_ID}" in command
    title, body = command[-2:]
    assert "1.5.0" in title
    assert "quit" in body
    # The id in the hint is the name of the installed entry, or the click reaches nothing.
    assert f"{DESKTOP_ENTRY_ID}.desktop" == DESKTOP_FILENAME


def test_a_desktop_that_will_not_show_a_notification_stops_nothing() -> None:
    """A missing notification daemon must never be why a quarantine or a quit does not happen."""
    runner = FakeRunner(fail=True)

    LinuxNotifier(run=runner).post(
        compose(
            Notice(
                kind=NoticeKind.UPDATE_ROLLED_BACK,
                subject=HOST_ID,
                detail="1.4.0 would not start",
            )
        )
    )

    assert len(runner.commands) == 1


# --- the process table, on Linux-shaped values ----------------------------------------------


class FakePsutilError(Exception):
    """Stands in for ``psutil.Error`` — the base of everything that library raises."""


@dataclass
class FakeLinuxProcess:
    """One process as ``psutil`` reads it out of ``/proc`` on Linux.

    The values are the ones the kernel's own files carry: ``/proc/<pid>/stat`` for the start
    time and the CPU jiffies, ``/proc/<pid>/status`` for the resident set, ``/proc/<pid>/exe``
    for the executable, ``/proc/<pid>/fd`` for the open descriptors. What is asserted below is
    that the helper's reader turns exactly these into the shape every slice already consumes.
    """

    pid: int
    started_at: float
    executable: str
    rss_bytes: int
    user_seconds: float
    system_seconds: float
    fds: int
    descendants: int

    def oneshot(self) -> FakeLinuxProcess:
        return self

    def __enter__(self) -> FakeLinuxProcess:
        return self

    def __exit__(self, *unused: object) -> None:
        return None

    def create_time(self) -> float:
        return self.started_at

    def exe(self) -> str:
        return self.executable

    def memory_info(self) -> Any:
        return SimpleNamespace(rss=self.rss_bytes)

    def cpu_times(self) -> Any:
        return SimpleNamespace(user=self.user_seconds, system=self.system_seconds)

    def num_fds(self) -> int:
        return self.fds

    def children(self, recursive: bool = False) -> list[object]:
        assert recursive, "a child count that is not recursive misses a plugin's grandchildren"
        return [object()] * self.descendants


@dataclass
class FakePsutil:
    """Enough of ``psutil`` to answer about a machine that is not this one."""

    processes: dict[int, FakeLinuxProcess] = field(default_factory=dict)
    Error = FakePsutilError

    def Process(self, pid: int) -> FakeLinuxProcess:  # noqa: N802 - the library spells it so
        try:
            return self.processes[pid]
        except KeyError as error:
            raise FakePsutilError(f"no process {pid}") from error


# A plugin as it would look on a Linux machine: an interpreter inside the installed package,
# a start time counted from the boot the kernel records, and four processes below it.
LINUX_PROCESS = FakeLinuxProcess(
    pid=4242,
    started_at=1_700_000_123.45,
    executable="/opt/innytypes/environments/monty/bin/python3.13",
    rss_bytes=201_326_592,
    user_seconds=12.5,
    system_seconds=3.25,
    fds=37,
    descendants=4,
)


@pytest.fixture
def linux_psutil(monkeypatch: pytest.MonkeyPatch) -> FakePsutil:
    """Make the helper's process table read this fake Linux machine instead of a real one.

    ``SystemProcessTable`` imports ``psutil`` inside each method, so substituting the module is
    substituting the whole of what it can see. Nothing real is looked up, and the gate stays
    hermetic on a machine with no ``/proc`` at all.
    """
    fake = FakePsutil({LINUX_PROCESS.pid: LINUX_PROCESS})
    monkeypatch.setitem(sys.modules, "psutil", fake)
    return fake


def test_the_existing_process_table_reads_linux_identity_without_a_second_implementation(
    linux_psutil: FakePsutil,
) -> None:
    """Slice 03's three facts, out of Linux's values, through the reader that already exists."""
    facts = SystemProcessTable().facts(LINUX_PROCESS.pid)

    assert facts == ProcessFacts(
        pid=4242,
        started_at=1_700_000_123.45,
        executable="/opt/innytypes/environments/monty/bin/python3.13",
    )


def test_the_existing_process_table_reads_linux_resources_without_a_second_implementation(
    linux_psutil: FakePsutil,
) -> None:
    """Slice 04's four numbers, in the units the detector compares against.

    Memory in mebibytes rather than bytes, CPU as **cumulative seconds** rather than a
    percentage — the window belongs to the code that owns the window — open file descriptors as
    Linux counts them in ``/proc/<pid>/fd``, and children counted recursively.
    """
    sample = SystemProcessTable().resources(LINUX_PROCESS.pid)

    assert sample == ResourceSample(
        rss_mb=192.0,
        cpu_seconds=15.75,
        open_files=37,
        children=4,
    )


def test_a_linux_process_that_is_gone_is_not_vouched_for(linux_psutil: FakePsutil) -> None:
    """Both halves answer ``None`` rather than raising, which is what "cannot vouch" means."""
    assert SystemProcessTable().facts(9_999) is None
    assert SystemProcessTable().resources(9_999) is None


def test_process_group_numbers_are_never_asked_about_on_linux(linux_psutil: FakePsutil) -> None:
    """On Linux as on macOS, 0 and negatives address process *groups*, not one process."""
    for pid in (0, -1):
        assert SystemProcessTable().facts(pid) is None
        assert SystemProcessTable().resources(pid) is None
