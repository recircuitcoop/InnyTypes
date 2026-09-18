"""What Windows needs that macOS and Linux do not — proved on a machine that is neither.

The gate runs on macOS, so every one of these tests describes Windows as **data**: a fake
process snapshot instead of a Windows API call, a fake registry reader instead of a registry, a
recording runner instead of PowerShell, and a recording launcher instead of a process. Nothing
here reads a real registry, raises a real toast, launches a real process or renames a real
installation.

**What is asserted is the Windows-shaped answer, not the Windows-shaped code.** The process
table is the clearest case: `psutil` already answers on Windows, so the only genuine difference
is that Windows counts **handles** where POSIX counts file descriptors. So the test that
matters is that a process offering ``num_handles`` and no ``num_fds`` is read into exactly the
same :class:`ResourceSample` every other slice consumes — which would fail on the code as it
stood before this slice, and does not need a Windows machine to say so.

The quit-time updater step is tested where the swap lives, in ``test_helper_core_update.py``,
because proving it needs a real staged release and a real installation to not rename.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from innytypes.children import ChildKind, ChildRecord
from innytypes.helper import windows
from innytypes.helper.breaker import HOST_ID
from innytypes.helper.notification import (
    Notice,
    NoticeKind,
    UnsupportedPlatform,
    compose,
    notifier_for,
)
from innytypes.helper.processes import (
    ProcessFacts,
    ResourceSample,
    facts_from,
    open_file_count,
    sample_from,
)
from innytypes.helper.telemetry import (
    MACHINE_GUID_KEY,
    MACHINE_GUID_VALUE,
    TelemetryError,
    machine_id,
    os_machine_identifier,
)
from innytypes.helper.windows import (
    APP_USER_MODEL_ID,
    POWERSHELL,
    TOAST_APP_ID_VARIABLE,
    TOAST_BODY_VARIABLE,
    TOAST_SCRIPT,
    TOAST_TITLE_VARIABLE,
    UPDATER_POLL_INTERVAL,
    RecordingToasts,
    ShortcutLocation,
    SwapHandoffError,
    WindowsNotifier,
    WindowsSwapHandoff,
    desktop_shortcut,
    helper_has_exited,
    run_updater,
    shortcuts_for,
    start_menu_shortcut,
)

# ── the shortcuts the bundle installs ────────────────────────────────────────────────────────

EXECUTABLE = Path(r"C:\Program Files\InnyTypes\innytypes-helper.exe")
ICON = Path(r"C:\Program Files\InnyTypes\resources\innytypes.ico")


def test_the_start_menu_shortcut_names_the_helper_its_icon_and_the_application_id() -> None:
    """The four fields whatever creates the `.lnk` has to be given, and the fifth that makes
    toasts possible at all."""
    shortcut = start_menu_shortcut(executable=EXECUTABLE, icon=ICON)

    assert shortcut.location is ShortcutLocation.START_MENU
    assert shortcut.name == "InnyTypes.lnk"
    assert shortcut.target == EXECUTABLE
    assert shortcut.icon == ICON
    assert shortcut.working_directory == EXECUTABLE.parent
    assert shortcut.app_user_model_id == APP_USER_MODEL_ID
    # An icon whose behaviour depended on which shortcut was clicked would be two applications.
    assert shortcut.arguments == ()


def test_the_desktop_shortcut_is_the_same_application_in_another_place() -> None:
    start_menu = start_menu_shortcut(executable=EXECUTABLE, icon=ICON)
    desktop = desktop_shortcut(executable=EXECUTABLE, icon=ICON)

    assert desktop.location is ShortcutLocation.DESKTOP
    assert (desktop.target, desktop.icon) == (start_menu.target, start_menu.icon)
    assert desktop.app_user_model_id == start_menu.app_user_model_id


def test_both_shortcuts_are_generated_together_and_land_where_they_are_told() -> None:
    start_menu, desktop = shortcuts_for(executable=EXECUTABLE, icon=ICON)

    # Paths are compared as `Path` objects joined the same way, because the gate runs on macOS,
    # where a backslash is an ordinary character and not a separator. What is asserted is that
    # each shortcut lands in the directory it is given, under its own name.
    programs = Path(r"C:\ProgramData\Microsoft\Windows\Start Menu\Programs")
    desktop_directory = Path(r"C:\Users\someone\Desktop")

    assert start_menu.path_under(programs) == programs / "InnyTypes.lnk"
    assert desktop.path_under(desktop_directory) == desktop_directory / "InnyTypes.lnk"


def test_the_shortcut_carries_the_same_identifier_the_toast_is_raised_under() -> None:
    """Windows resolves an AppUserModelID by looking for a Start-menu shortcut that carries it.
    A toast raised under an id no shortcut carries is silently dropped, so these two agreeing
    is the difference between the user being told and not."""
    assert start_menu_shortcut(executable=EXECUTABLE, icon=ICON).app_user_model_id == (
        WindowsNotifier().app_user_model_id
    )


# ── the process table, which is `psutil` everywhere and handles only here ────────────────────


@dataclass
class FakeMemory:
    rss: int


@dataclass
class FakeTimes:
    user: float
    system: float


@dataclass
class CountlessProcess:
    """One process as `psutil` describes it, minus the thing the platforms disagree about.

    Deliberately offers **neither** `num_fds` nor `num_handles`, so that the two platforms
    below differ by exactly the one method they really differ by, and so the refusal for a
    process table that counts neither is a real object rather than a broken subclass.
    """

    started_at: float = 1_758_190_000.5
    executable: str = r"C:\Program Files\InnyTypes\innytypes-helper.exe"
    rss: int = 512 * 1024 * 1024
    user: float = 12.5
    system: float = 3.5
    handles: int = 420
    child_processes: int = 3

    def create_time(self) -> float:
        return self.started_at

    def exe(self) -> str:
        return self.executable

    def memory_info(self) -> FakeMemory:
        return FakeMemory(rss=self.rss)

    def cpu_times(self) -> FakeTimes:
        return FakeTimes(user=self.user, system=self.system)

    def children(self, recursive: bool = False) -> list[object]:
        assert recursive, "the open-child count is recursive or it is not the runaway it catches"
        return [object()] * self.child_processes


@dataclass
class WindowsProcess(CountlessProcess):
    """A Windows process: handles, and no file descriptors at all."""

    def num_handles(self) -> int:
        return self.handles


@dataclass
class PosixProcess(CountlessProcess):
    """The same process on macOS or Linux, where the count is of file descriptors."""

    def num_fds(self) -> int:
        return self.handles


def a_windows_process() -> WindowsProcess:
    return WindowsProcess()


def test_a_windows_process_reads_into_the_same_identity_every_slice_consumes() -> None:
    assert facts_from(a_windows_process(), pid=4321) == ProcessFacts(
        pid=4321,
        started_at=1_758_190_000.5,
        executable=r"C:\Program Files\InnyTypes\innytypes-helper.exe",
    )


def test_a_windows_process_reads_into_the_same_resource_sample_every_slice_consumes() -> None:
    """Memory in megabytes, CPU as user plus system, open files, children — the shape slices 03
    and 04 already check against, produced from a process that has handles and no descriptors."""
    assert sample_from(a_windows_process()) == ResourceSample(
        rss_mb=512.0,
        cpu_seconds=16.0,
        open_files=420,
        children=3,
    )


def test_open_files_are_handles_on_windows_and_descriptors_everywhere_else() -> None:
    """The one genuine difference between the platforms' process tables. Before this slice the
    reader asked for `num_fds` unconditionally, which raises on every Windows machine."""
    windows = a_windows_process()
    posix = PosixProcess()

    assert open_file_count(windows) == 420
    assert open_file_count(posix) == 420
    assert sample_from(posix) == sample_from(windows)


def test_a_process_that_counts_neither_is_refused_rather_than_measured_as_zero() -> None:
    """Zero open files would read as a perfectly healthy process, which is the wrong direction
    to be wrong in: the limit exists to catch a runaway."""
    with pytest.raises(AttributeError, match="neither open file descriptors nor open handles"):
        open_file_count(CountlessProcess())


# ── the machine identifier: `MachineGuid`, through an injected reader ────────────────────────

MACHINE_GUID = "8f4c1a6e-0b3d-4a7f-9c21-5d6e7f8a9b0c"


@dataclass
class FakeRegistry:
    """A registry that answers one value and records what was asked of it."""

    values: dict[tuple[str, str], str] = field(default_factory=dict)
    reads: list[tuple[str, str]] = field(default_factory=list)

    def __call__(self, key: str, value: str) -> str:
        self.reads.append((key, value))
        try:
            return self.values[(key, value)]
        except KeyError:
            raise FileNotFoundError(rf"{key}\{value} does not exist") from None


def test_the_windows_machine_identifier_is_the_machine_guid_from_the_injected_reader() -> None:
    registry = FakeRegistry(values={(MACHINE_GUID_KEY, MACHINE_GUID_VALUE): MACHINE_GUID})

    found = os_machine_identifier(system="Windows", read_registry=registry)

    assert found == MACHINE_GUID
    # The injected source is what was read, and it was read for the machine-wide value under
    # the cryptography key — not a user name, a host name or a hardware address (D20).
    assert registry.reads == [(MACHINE_GUID_KEY, MACHINE_GUID_VALUE)]
    assert MACHINE_GUID_KEY == r"SOFTWARE\Microsoft\Cryptography"


def test_the_machine_guid_is_hashed_and_never_reported_as_itself() -> None:
    registry = FakeRegistry(values={(MACHINE_GUID_KEY, MACHINE_GUID_VALUE): MACHINE_GUID})

    identity = machine_id(lambda: os_machine_identifier(system="Windows", read_registry=registry))

    assert MACHINE_GUID not in identity
    assert len(identity) == 64


def test_a_machine_guid_that_cannot_be_read_is_refused_by_name() -> None:
    with pytest.raises(TelemetryError, match="could not be read"):
        os_machine_identifier(system="Windows", read_registry=FakeRegistry())


def test_an_empty_machine_guid_is_a_miss_rather_than_an_answer() -> None:
    """A machine imaged before its cryptography key was regenerated has the value and no
    contents. Returning "" would surface three calls later as a complaint about a length."""
    registry = FakeRegistry(values={(MACHINE_GUID_KEY, MACHINE_GUID_VALUE): "   "})

    with pytest.raises(TelemetryError, match="is empty"):
        os_machine_identifier(system="Windows", read_registry=registry)


# ── toast notifications, for each of the five conditions ─────────────────────────────────────

# One notice per kind in `NoticeKind`, each in the shape the helper really builds it in.
FIVE_CONDITIONS = (
    Notice(
        kind=NoticeKind.PROCESS_QUARANTINED,
        subject="monty",
        detail='It stopped 5 times in 10 minutes; the last said "bad `config`"',
    ),
    Notice(
        kind=NoticeKind.UPDATE_ROLLED_BACK,
        subject=HOST_ID,
        version="1.5.0",
        detail="It did not report itself healthy within 2 minutes",
    ),
    Notice(kind=NoticeKind.UPDATE_STAGED, subject=HOST_ID, version="1.6.0"),
    Notice(
        kind=NoticeKind.PLUGIN_UPDATE_PENDING,
        subject="whodunnit",
        version="2.1.0",
        detail="whodunnit is set to manual",
    ),
    Notice(
        kind=NoticeKind.PLUGIN_SET_BLOCKED,
        subject="summarize",
        version="3.0.0",
        detail="summarize 3.0.0 needs host API 4",
    ),
)


def test_windows_has_a_notifier_now_and_it_is_the_toast_one() -> None:
    assert isinstance(notifier_for("Windows"), WindowsNotifier)


def test_linux_is_still_a_named_seam_that_refuses() -> None:
    """Slice 15's, untouched by this one: a notifier that accepted a message and dropped it
    would let every Linux criterion pass on a machine that shows the user nothing."""
    with pytest.raises(UnsupportedPlatform, match="slice 15"):
        notifier_for("Linux")


def test_every_one_of_the_five_conditions_raises_a_toast() -> None:
    toasts = RecordingToasts()
    notifier = WindowsNotifier(run=toasts)

    for notice in FIVE_CONDITIONS:
        notifier.post(compose(notice))

    assert len(toasts.calls) == len(NoticeKind) == 5
    # Each one carries the words `compose` wrote for it, and they are all different: a notifier
    # that posted the same toast five times would otherwise pass this.
    assert toasts.titles == tuple(compose(notice).title for notice in FIVE_CONDITIONS)
    assert len(set(toasts.titles)) == 5


def test_a_toast_is_raised_under_this_applications_identifier() -> None:
    toasts = RecordingToasts()

    WindowsNotifier(run=toasts).post(compose(FIVE_CONDITIONS[0]))

    (argv, script, environment) = toasts.calls[0]
    assert environment[TOAST_APP_ID_VARIABLE] == APP_USER_MODEL_ID
    assert argv[0] == POWERSHELL
    assert POWERSHELL.startswith("C:\\Windows\\"), "a bare name would be resolved through PATH"
    assert script == TOAST_SCRIPT


def test_the_text_travels_as_data_and_never_becomes_part_of_the_script() -> None:
    """The same discipline the macOS notifier keeps, by the same argument. A quarantine reason
    carrying a quote, a `$(...)`, a backtick or a semicolon is a quarantine reason carrying
    those characters — there is no stage at which it is text something is about to compile."""
    hostile = Notice(
        kind=NoticeKind.PROCESS_QUARANTINED,
        subject="monty",
        detail="it died: \"; $(Remove-Item -Recurse C:\\) `whoami` '--'",
    )
    toasts = RecordingToasts()

    WindowsNotifier(run=toasts).post(compose(hostile))

    (argv, script, environment) = toasts.calls[0]
    # The script is the constant, byte for byte, whatever the notice said.
    assert script == TOAST_SCRIPT
    assert "Remove-Item" not in script
    # Nothing of the notice is on the command line either: every argument is a constant.
    assert not any("Remove-Item" in argument for argument in argv)
    # It is in the environment, unchanged and unescaped, which is where it is only ever a value.
    assert environment[TOAST_BODY_VARIABLE].startswith('it died: "; $(Remove-Item')
    # And the script reads it as a variable rather than interpolating it.
    assert f"$env:{TOAST_BODY_VARIABLE}" in TOAST_SCRIPT
    assert f"$env:{TOAST_TITLE_VARIABLE}" in TOAST_SCRIPT


def test_the_toast_text_is_put_into_the_xml_through_the_dom_and_not_by_concatenation() -> None:
    """A toast is XML. Building it out of strings would let a `<` in a plugin id close an
    element; `CreateTextNode` escapes what it is given."""
    assert "CreateTextNode" in TOAST_SCRIPT
    assert "-join" not in TOAST_SCRIPT
    assert "Invoke-Expression" not in TOAST_SCRIPT


def test_the_notifier_hands_powershell_the_script_on_standard_input() -> None:
    """`-Command -` and no `-EncodedCommand`, so there is no command line for the notice's
    words to be quoted into, and `-NoProfile` so a user's profile cannot redefine anything the
    script names."""
    toasts = RecordingToasts()

    WindowsNotifier(run=toasts).post(compose(FIVE_CONDITIONS[2]))

    (argv, _script, _environment) = toasts.calls[0]
    assert argv[-2:] == ("-Command", "-")
    assert "-NoProfile" in argv
    assert "-NonInteractive" in argv


def test_the_inherited_environment_is_kept_so_powershell_can_start_at_all() -> None:
    toasts = RecordingToasts()

    WindowsNotifier(run=toasts).post(compose(FIVE_CONDITIONS[2]))

    (_argv, _script, environment) = toasts.calls[0]
    # More than the three it adds: a PowerShell started without `SystemRoot` does not start.
    assert len(environment) > 3


# ── the updater's wait: never swap while the helper is still there ───────────────────────────

HELPER = ChildRecord(
    id="innytypes.helper",
    kind=ChildKind.HELPER,
    pid=4321,
    started_at=1_758_190_000.0,
    executable=r"C:\Program Files\InnyTypes\innytypes-helper.exe",
    # Its own parent: whatever the user clicked to start it, which is nothing this
    # application recorded (F6). Not read by the updater, which only asks about the helper.
    parent_pid=1,
)


@dataclass
class RecordingSwap:
    """The swap, as the updater calls it: records that it happened, into the shared sequence."""

    events: list[str]
    calls: int = 0

    def __call__(self) -> None:
        self.calls += 1
        self.events.append("swapped")
        return None


@dataclass
class ScriptedTable:
    """A process table that answers a prepared list of facts, one per question.

    It also writes into a shared list of events, which is how the ordering is asserted: the
    question is worthless unless "the swap happened after the last time this said *present*"
    can be read off one sequence.
    """

    answers: list[ProcessFacts | None]
    events: list[str]

    def facts(self, pid: int) -> ProcessFacts | None:
        answer = self.answers.pop(0) if self.answers else None
        self.events.append("present" if answer is not None else "gone")
        return answer


def facts_of(record: ChildRecord) -> ProcessFacts:
    return ProcessFacts(pid=record.pid, started_at=record.started_at, executable=record.executable)


def test_the_swap_happens_only_after_the_helper_is_confirmed_gone() -> None:
    events: list[str] = []
    table = ScriptedTable(answers=[facts_of(HELPER), facts_of(HELPER), None], events=events)
    naps: list[float] = []

    outcome = run_updater(
        helper=HELPER,
        table=table,
        swap=RecordingSwap(events),
        clock=iter([0.0, 0.0, 1.0, 2.0, 2.0]).__next__,
        sleep=naps.append,
        timeout=30.0,
    )

    assert outcome.swapped
    # The whole of the acceptance line, read off one sequence: the helper was found present
    # twice, the swap did not happen either time, and it happened once the table said gone.
    assert events == ["present", "present", "gone", "swapped"]
    assert naps == [UPDATER_POLL_INTERVAL] * 2


def test_nothing_is_swapped_while_the_helper_is_still_running() -> None:
    """A helper that never goes gets no swap at all. The release stays staged and the next quit
    offers it again — which is a delay, where swapping under a running process is a
    half-updated installation."""
    events: list[str] = []
    table = ScriptedTable(answers=[facts_of(HELPER)] * 100, events=events)

    outcome = run_updater(
        helper=HELPER,
        table=table,
        swap=RecordingSwap(events),
        clock=iter([0.0, 0.0, 5.0, 5.0, 5.0]).__next__,
        sleep=lambda _seconds: None,
        timeout=1.0,
    )

    assert not outcome.swapped
    assert "swapped" not in events
    assert outcome.reason is not None
    assert "still running" in outcome.reason
    assert "next quit will try again" in outcome.reason


def test_a_process_id_that_now_belongs_to_something_else_means_the_helper_has_gone() -> None:
    """Bare liveness would be the wrong question. Windows is free to hand the helper's process
    id to another program the moment it exits, and reading that as "still running" is how an
    update quietly stops arriving on a busy machine."""
    someone_else = ProcessFacts(
        pid=HELPER.pid,
        started_at=HELPER.started_at + 600,
        executable=r"C:\Windows\System32\notepad.exe",
    )

    assert helper_has_exited(_TableOf(someone_else), HELPER)
    assert not helper_has_exited(_TableOf(facts_of(HELPER)), HELPER)
    assert helper_has_exited(_TableOf(None), HELPER)


def test_a_helper_whose_executable_changed_is_not_the_helper_any_more() -> None:
    reused = ProcessFacts(
        pid=HELPER.pid,
        started_at=HELPER.started_at,
        executable=r"C:\Windows\System32\cmd.exe",
    )

    assert helper_has_exited(_TableOf(reused), HELPER)


def test_a_start_time_read_a_moment_late_is_still_the_same_helper() -> None:
    """The same tolerance the identity check uses, imported rather than restated: the record's
    start time is read after the spawn returned, so exact equality would never match."""
    just_after = ProcessFacts(
        pid=HELPER.pid,
        started_at=HELPER.started_at + 0.4,
        executable=HELPER.executable,
    )

    assert not helper_has_exited(_TableOf(just_after), HELPER)


@dataclass(frozen=True)
class _TableOf:
    """A process table with one answer, for the questions that need no sequence."""

    answer: ProcessFacts | None

    def facts(self, pid: int) -> ProcessFacts | None:
        return self.answer


def test_the_recording_toast_runner_matches_the_shape_the_notifier_calls() -> None:
    """Guards the seam itself: a recorder whose signature drifted from the runner's would make
    every test above pass against something the real notifier never calls."""
    toasts = RecordingToasts()
    argv: Sequence[str] = ["powershell"]
    environment: Mapping[str, str] = {TOAST_TITLE_VARIABLE: "a title"}

    toasts(argv, TOAST_SCRIPT, environment)

    assert toasts.titles == ("a title",)


def test_a_powershell_that_fails_is_logged_and_never_raised(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A toast that could not be shown must not take the helper's tick down with it, and the
    condition it was about is still in the notices file for `status` to report."""

    class Failed:
        returncode = 1
        stderr = "the notification platform is unavailable"

    calls: list[dict[str, object]] = []

    def fake_run(argv: object, **kwargs: object) -> Failed:
        calls.append(kwargs)
        return Failed()

    monkeypatch.setattr(windows.subprocess, "run", fake_run)

    WindowsNotifier().post(compose(FIVE_CONDITIONS[1]))

    # It really went through the production path, and it went through it without a shell.
    assert calls and calls[0]["input"] == TOAST_SCRIPT
    assert "shell" not in calls[0]


def test_a_process_id_that_answers_for_a_different_id_is_not_our_helper() -> None:
    """A process table that answered about some other process would otherwise be believed. All
    three facts are compared, and the first of them is which process was asked about."""
    somebody_else = ProcessFacts(
        pid=HELPER.pid + 1,
        started_at=HELPER.started_at,
        executable=HELPER.executable,
    )

    assert helper_has_exited(_TableOf(somebody_else), HELPER)


def test_a_plan_that_cannot_be_written_starts_no_updater_and_says_why(tmp_path: Path) -> None:
    """The plan is how the updater knows what to do. Starting one that could not be told would
    be starting a process to do nothing."""
    blocked = tmp_path / "updater"
    blocked.write_text("a file where the updater's directory should be", encoding="utf-8")
    launcher: list[tuple[str, ...]] = []

    handoff = WindowsSwapHandoff(
        helper=HELPER,
        plan_path=blocked / "swap.json",
        public_key_path=tmp_path / "innytypes.pub",
        command=lambda plan: ("python", str(plan)),
        launch=lambda argv: launcher.append(tuple(argv)),
    )

    with pytest.raises(SwapHandoffError, match="could not be told what to do"):
        handoff.hand_off(_an_applier(tmp_path), _a_ready_release(), requested=False)

    assert launcher == []


def _an_applier(root: Path) -> Any:
    """Just enough of a :class:`ReleaseApplier` for the plan to be built out of it.

    The whole applier, with a real staged release and real renames to not perform, is exercised
    in ``test_helper_core_update.py`` where that machinery lives. What is under test here is the
    refusal, which happens before any of it is used.
    """
    return SimpleNamespace(
        staging=root / "staging",
        roots=SimpleNamespace(root=root / "release"),
        addons_root=root / "addons",
        helper_environment=root / "env",
        blocked=SimpleNamespace(versions=SimpleNamespace(path=root / "blocked.json")),
        pending=SimpleNamespace(path=root / "pending.json"),
        platform="win32",
    )


def _a_ready_release() -> Any:
    return SimpleNamespace(version="1.3.0")
