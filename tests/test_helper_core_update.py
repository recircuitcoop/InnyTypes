"""Applying a verified core release at quit, confirming it at the next launch, or undoing it.

Everything plan 0003 calls steps 4 and 5 of the *update flow* is driven here with nothing real
behind it. Staging, the installed application and the one it replaced are three directories
under ``tmp_path``; the installer is injected and writes the two files a release is made of
instead of unpacking an archive or running ``uv``; the heartbeat feed is a registry a test puts
beats into; the clock is a number a test moves, so a two-minute health window costs no time at
all. No network, no process, no ``uv``, no sleeping.

**The renames are real.** The swap *is* this slice, and injecting it away would leave the one
behaviour the WorkItem is about proved by nothing. So the roots are injected and the renames
under them happen — on directories this test made, in this test's own temporary directory,
exactly as :mod:`innytypes.helper.environments` is covered for a plugin.

**The pairs are deliberate.** A staged release is *not* applied by a startup **and** is applied
by a quit, from the same application object. A release that never beats is rolled back **and**
one that beats is kept, through the same call. A blocked version is not applied again **and**
is not proposed again by slice 09's check. Each half on its own would pass with the other
behaviour missing.
"""

from __future__ import annotations

import base64
import hashlib
import json
import secrets
import shutil
import tarfile
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest
from nacl.signing import SigningKey

from innytypes import HOST_API_VERSION
from innytypes.addons.discovery import addon_environment, addon_root, recorded_manifest_path
from innytypes.children import (
    ChildKind,
    ChildRecord,
    RunStateFile,
)
from innytypes.helper.breaker import HOST_ID
from innytypes.helper.heartbeat import Heartbeat, HeartbeatRegistry, ProcessState
from innytypes.helper.launcher import (
    HELPER_ID,
    QUIT_FILENAME,
    Application,
    InstanceLock,
    QuitFile,
    QuitReason,
)
from innytypes.helper.minisign import parse_public_key
from innytypes.helper.processes import ManagedProcesses, ProcessFacts, Signal
from innytypes.helper.rollout import UpdateApplyError
from innytypes.helper.swap import (
    RELEASE_MARKER,
    AppliedRelease,
    BlockedReleases,
    PendingReleaseFile,
    ReleaseApplier,
    ReleaseApplyError,
    ReleaseConfirmation,
    ReleaseRoots,
    UvCoreInstaller,
    confirm_or_roll_back,
    incompatible_plugins,
    installed_plugin_apis,
    read_ready_release,
    roll_back_release,
)
from innytypes.helper.update import (
    READY_MARKER,
    Release,
    ReleaseArtifact,
    ReleaseIndex,
    UpdateCandidate,
    Version,
    choose_candidate,
    download_and_verify,
    parse_release_index,
)

# The OS this file pretends to run on: the interpreter's name for it, and the name a release
# index uses for it. Both are fixed rather than read from `sys.platform`, so the same
# assertions hold on every machine that runs the gate.
SYS_PLATFORM = "darwin"
PLATFORM = "macos"

# What is installed before an update, and what the update moves it to.
INSTALLED = "1.2.3"
NEW = "1.3.0"

HELPER_EXECUTABLE = "/opt/innytypes/bin/python"
HOST_COMMAND = (HELPER_EXECUTABLE, "-m", "innytypes", "up")

# A frozen moment, so the pending note's timestamp is an assertion rather than a wildcard.
APPLIED_AT = datetime(2026, 9, 18, 11, 0, tzinfo=UTC)


# --------------------------------------------------------------------------------------
# A throwaway minisign signer, generated per test. Never a committed private key.
# --------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Signer:
    """A minisign key pair that exists only for the duration of one test."""

    signing_key: SigningKey
    key_id: bytes

    @property
    def public_key_text(self) -> str:
        blob = b"Ed" + self.key_id + bytes(self.signing_key.verify_key)
        return (
            "untrusted comment: minisign public key (throwaway, generated in the test)\n"
            + base64.b64encode(blob).decode("ascii")
            + "\n"
        )

    def sign(self, content: bytes, *, trusted_comment: str = "timestamp:1758190000") -> str:
        """A detached minisign signature over ``content``, in the prehashed form."""
        message = hashlib.blake2b(content, digest_size=64).digest()
        signature = self.signing_key.sign(message).signature
        global_signature = self.signing_key.sign(
            signature + trusted_comment.encode("utf-8")
        ).signature

        return (
            "untrusted comment: signature from a throwaway key\n"
            + base64.b64encode(b"ED" + self.key_id + signature).decode("ascii")
            + "\n"
            + f"trusted comment: {trusted_comment}\n"
            + base64.b64encode(global_signature).decode("ascii")
            + "\n"
        )


@pytest.fixture
def signer() -> Signer:
    """A fresh key pair per test. The private half never leaves this process."""
    return Signer(signing_key=SigningKey.generate(), key_id=secrets.token_bytes(8))


# --------------------------------------------------------------------------------------
# The injected installer: it records every call and writes what a release is made of
# --------------------------------------------------------------------------------------


@dataclass
class RecordingInstaller:
    """An installer that creates two files instead of unpacking, and remembers everything.

    It can also fail on demand, in each of the two places a real one can: the unpack, and the
    move of the host version inside one named environment. Both are needed, because a swap
    that cannot be undone is only proved by a swap that had to be.
    """

    host_api: int = HOST_API_VERSION
    # A version to write into the unpacked `release.json` instead of the one asked for, so a
    # test can serve an archive that does not hold the release it was signed as.
    unpacks_version: str | None = None
    fails_to_unpack: str | None = None
    # The environment whose host-version move fails, matched by path.
    fails_for: Path | None = None

    unpacked: list[tuple[Path, Path, str]] = field(default_factory=list)
    moved: list[tuple[Path, str, Path]] = field(default_factory=list)

    def unpack(self, artifact: Path, *, destination: Path, version: str) -> None:
        self.unpacked.append((artifact, destination, version))
        if self.fails_to_unpack is not None:
            raise RuntimeError(self.fails_to_unpack)

        destination.mkdir(parents=True, exist_ok=False)
        (destination / RELEASE_MARKER).write_text(
            json.dumps(
                {
                    "version": version if self.unpacks_version is None else self.unpacks_version,
                    "host_api": self.host_api,
                }
            ),
            encoding="utf-8",
        )
        (destination / "innytypes").write_text(f"the application, version {version}\n")

    def set_host_version(self, environment: Path, *, version: str, release: Path) -> None:
        self.moved.append((environment, version, release))
        if self.fails_for is not None and environment == self.fails_for:
            raise RuntimeError(f"{environment} refused the host version")

    @property
    def moved_environments(self) -> list[Path]:
        return [environment for environment, _version, _release in self.moved]


# --------------------------------------------------------------------------------------
# One hermetic installation: staging, the three roots, the plugins and the records
# --------------------------------------------------------------------------------------


@dataclass
class Machine:
    """Everything one InnyTypes installation is made of, under this test's own directory."""

    root: Path
    staging: Path
    roots: ReleaseRoots
    addons: Path
    helper_environment: Path
    blocked: BlockedReleases
    pending: PendingReleaseFile
    installer: RecordingInstaller
    signer: Signer

    # --- building the state a test starts from ---------------------------------------

    def install(self, version: str) -> Path:
        """Put an installed release in place, as if an earlier launch had been running it."""
        self.roots.live.mkdir(parents=True, exist_ok=True)
        (self.roots.live / RELEASE_MARKER).write_text(
            json.dumps({"version": version, "host_api": HOST_API_VERSION}), encoding="utf-8"
        )
        (self.roots.live / "innytypes").write_text(f"the application, version {version}\n")
        return self.roots.live

    def stage(
        self,
        version: str = NEW,
        *,
        host_api: int = HOST_API_VERSION,
        automatic: bool = True,
        platform: str = PLATFORM,
        content: bytes | None = None,
        marker: dict[str, object] | None = None,
        artifact_name: str = "innytypes.tar.gz",
        directory_name: str | None = None,
        sign_with: Signer | None = None,
    ) -> Path:
        """Write a staged release exactly as slice 09 leaves one, marker last."""
        payload = f"release {version}".encode() if content is None else content
        directory = self.staging / (version if directory_name is None else directory_name)
        directory.mkdir(parents=True, exist_ok=True)
        (directory / artifact_name).write_bytes(payload)

        document: dict[str, object] = {
            "version": version,
            "host_api": host_api,
            "platform": platform,
            "artifact": artifact_name,
            "sha256": hashlib.sha256(payload).hexdigest(),
            "signature": (self.signer if sign_with is None else sign_with).sign(payload),
            "automatic": automatic,
            "blocked_reason": "" if automatic else f"release {version} changes the host API",
            "staged_at": "2026-09-18T10:30:00+00:00",
            "ready": True,
        }
        if marker is not None:
            document.update(marker)

        (directory / READY_MARKER).write_text(json.dumps(document, indent=2), encoding="utf-8")
        return directory

    def install_plugin(self, plugin_id: str, *, host_api: int = HOST_API_VERSION) -> Path:
        """An installed plugin: a recorded manifest and an environment, which is all this reads."""
        recorded_manifest_path(self.addons, plugin_id).parent.mkdir(parents=True, exist_ok=True)
        recorded_manifest_path(self.addons, plugin_id).write_text(
            json.dumps(
                {
                    "id": plugin_id,
                    "version": "1.0.0",
                    "host_api": host_api,
                    "requires": [],
                    "emits": [f"{plugin_id}.started.v1"],
                    "subscribes": [],
                }
            ),
            encoding="utf-8",
        )
        environment = addon_environment(self.addons, plugin_id)
        environment.mkdir(parents=True, exist_ok=True)
        return environment

    # --- what a test asserts against ---------------------------------------------------

    def applier(self, *, public_key_text: str | None = None) -> ReleaseApplier:
        text = self.signer.public_key_text if public_key_text is None else public_key_text
        return ReleaseApplier(
            installer=self.installer,
            roots=self.roots,
            staging=self.staging,
            public_key=parse_public_key(text),
            blocked=self.blocked,
            pending=self.pending,
            addons_root=self.addons,
            helper_environment=self.helper_environment,
            platform=SYS_PLATFORM,
            now=lambda: APPLIED_AT,
        )

    def live_version(self) -> str | None:
        return _recorded_version(self.roots.live)

    def previous_version(self) -> str | None:
        return _recorded_version(self.roots.previous)

    def staged(self) -> list[str]:
        if not self.staging.is_dir():
            return []
        return sorted(child.name for child in self.staging.iterdir())


def _recorded_version(release: Path) -> str | None:
    try:
        document = json.loads((release / RELEASE_MARKER).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    version = document.get("version")
    return version if isinstance(version, str) else None


@pytest.fixture
def machine(tmp_path: Path, signer: Signer) -> Machine:
    """One installation, with nothing installed and nothing staged until a test says so."""
    root = tmp_path / "innytypes"
    staging = root / "staging"
    staging.mkdir(parents=True)
    addons = root / "addons"
    addons.mkdir()
    helper_environment = root / "helper-env"
    helper_environment.mkdir()

    return Machine(
        root=root,
        staging=staging,
        roots=ReleaseRoots(root=root / "release"),
        addons=addons,
        helper_environment=helper_environment,
        blocked=BlockedReleases.at(root / "blocked-core-versions.json"),
        pending=PendingReleaseFile(path=root / "pending-release.json"),
        installer=RecordingInstaller(),
        signer=signer,
    )


# --------------------------------------------------------------------------------------
# The clock and the heartbeats the confirmation runs against
# --------------------------------------------------------------------------------------


class FakeClock:
    """A clock a test moves by hand, and a `sleep` that moves it instead of waiting."""

    def __init__(self, now: float = 1_000.0) -> None:
        self.now = now
        self.slept: list[float] = []

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)
        self.now += seconds

    @property
    def total_slept(self) -> float:
        return sum(self.slept)


def host_record(pid: int = 700, started_at: float = 1_000.0) -> ChildRecord:
    return ChildRecord(
        id=HOST_ID,
        kind=ChildKind.HOST,
        pid=pid,
        started_at=started_at,
        executable=HELPER_EXECUTABLE,
        parent_pid=400,
    )


def beat(
    record: ChildRecord,
    *,
    version: str,
    state: ProcessState = ProcessState.READY,
) -> Heartbeat:
    return Heartbeat(
        id=record.id,
        kind=record.kind,
        pid=record.pid,
        started_at=record.started_at,
        version=version,
        state=state,
        progress_at=record.started_at,
    )


def beats_with(*published: Heartbeat) -> HeartbeatRegistry:
    registry = HeartbeatRegistry(clock=lambda: 1_000.0)
    for published_beat in published:
        registry.record(published_beat)
    return registry


# --------------------------------------------------------------------------------------
# Acceptance 1 — the swap happens at quit, and never at startup
# --------------------------------------------------------------------------------------


@dataclass
class FakeTable:
    """The OS process table as plain data, plus the signals a test sends into it."""

    facts_by_pid: dict[int, ProcessFacts] = field(default_factory=dict)
    signals: list[tuple[int, Signal]] = field(default_factory=list)

    def facts(self, pid: int) -> ProcessFacts | None:
        return self.facts_by_pid.get(pid)

    def add(self, record: ChildRecord) -> None:
        self.facts_by_pid[record.pid] = ProcessFacts(
            pid=record.pid,
            started_at=record.started_at,
            executable=record.executable,
        )

    def send(self, pid: int, which: Signal) -> None:
        self.signals.append((pid, which))
        self.facts_by_pid.pop(pid, None)


@dataclass
class FakeProcess:
    """Enough of a spawned process for a record to be written about it."""

    pid: int


@dataclass
class FakeLauncher:
    """Records what would have been launched, and makes the fake table believe it exists."""

    table: FakeTable
    clock: FakeClock
    next_pid: int = 700
    argvs: list[tuple[str, ...]] = field(default_factory=list)

    def __call__(self, argv: Sequence[str]) -> FakeProcess:
        self.argvs.append(tuple(argv))
        self.next_pid += 1
        self.table.facts_by_pid[self.next_pid] = ProcessFacts(
            pid=self.next_pid, started_at=self.clock(), executable=argv[0]
        )
        return FakeProcess(pid=self.next_pid)


@dataclass
class ApplicationHarness:
    """One application wired to the machine under test, and the calls it made."""

    application: Application
    machine: Machine
    confirmations: list[ChildRecord]


def application_for(
    machine: Machine,
    tmp_path: Path,
    *,
    requested: bool = False,
    apply_update: Callable[[], AppliedRelease | None] | None = None,
) -> ApplicationHarness:
    """An application whose every seam is a fake, with this machine's applier wired in."""
    clock = FakeClock()
    table = FakeTable()
    me = ChildRecord(
        id=HELPER_ID,
        kind=ChildKind.HELPER,
        pid=400,
        started_at=clock(),
        executable=HELPER_EXECUTABLE,
        parent_pid=1,
    )
    table.add(me)

    run_state = RunStateFile(tmp_path / "run-state.json")
    processes = ManagedProcesses(
        run_state=run_state,
        table=table,
        send_signal=table.send,
        clock=clock,
        sleep=lambda seconds: clock.sleep(seconds),
        stop_timeout=10.0,
    )
    applier = machine.applier()
    confirmations: list[ChildRecord] = []

    application = Application(
        lock=InstanceLock(path=tmp_path / "helper.lock", processes=processes),
        processes=processes,
        run_state=run_state,
        quits=QuitFile(path=tmp_path / QUIT_FILENAME),
        applications=_NoApplications(),
        start_process=FakeLauncher(table=table, clock=clock),
        host_command=HOST_COMMAND,
        anytype_executable=None,
        identity=lambda: me,
        clock=clock,
        apply_update=(
            (lambda: applier.apply_at_quit(requested=requested))
            if apply_update is None
            else apply_update
        ),
        confirm_release=confirmations.append,
    )

    return ApplicationHarness(application=application, machine=machine, confirmations=confirmations)


class _NoApplications:
    """No application is already running, which is every test in this file."""

    def find(self, executable: str) -> ProcessFacts | None:
        return None


def test_a_startup_with_a_release_staged_swaps_nothing(machine: Machine, tmp_path: Path) -> None:
    machine.install(INSTALLED)
    machine.stage(NEW)
    harness = application_for(machine, tmp_path)

    report = harness.application.start()

    assert report.started
    # The whole of D11 in three assertions: nothing was unpacked, the installed release is the
    # one that was there, and the new one is still waiting where slice 09 left it.
    assert machine.installer.unpacked == []
    assert machine.live_version() == INSTALLED
    assert machine.staged() == [NEW]
    assert not machine.roots.previous.exists()


def test_a_quit_swaps_the_staged_release_in_and_keeps_the_previous_one(
    machine: Machine, tmp_path: Path
) -> None:
    machine.install(INSTALLED)
    machine.stage(NEW)
    harness = application_for(machine, tmp_path)
    harness.application.start()

    report = harness.application.quit(QuitReason.MENU)

    assert report.update is not None
    assert report.update.applied
    assert machine.live_version() == NEW
    assert machine.previous_version() == INSTALLED
    # Nothing is left waiting: the release is installed, and a marker still claiming one is
    # ready would offer it again at the next quit.
    assert machine.staged() == []


def test_a_quit_with_nothing_staged_applies_nothing(machine: Machine, tmp_path: Path) -> None:
    machine.install(INSTALLED)
    harness = application_for(machine, tmp_path)
    harness.application.start()

    report = harness.application.quit(QuitReason.MENU)

    assert report.update is None
    assert machine.live_version() == INSTALLED


def test_an_update_that_fails_never_stops_the_quit(machine: Machine, tmp_path: Path) -> None:
    """Turning the application off is the one thing that must always work (F1)."""
    machine.install(INSTALLED)
    harness = application_for(machine, tmp_path, apply_update=_raise)
    harness.application.start()

    report = harness.application.quit(QuitReason.MENU)

    assert report.reason is QuitReason.MENU
    assert report.update is None
    assert not (tmp_path / "helper.lock").exists()


def _raise() -> AppliedRelease | None:
    raise RuntimeError("the disk is full")


def test_a_launch_confirms_the_release_it_is_running(machine: Machine, tmp_path: Path) -> None:
    """The confirmation is handed the host's own record, because the beat must come from it."""
    machine.install(INSTALLED)
    harness = application_for(machine, tmp_path)

    report = harness.application.start()

    started = {record.id: record for record in report.records}
    assert [record.pid for record in harness.confirmations] == [started[HOST_ID].pid]


# --------------------------------------------------------------------------------------
# What is never swapped in: no marker, a bad marker, a bad artifact
# --------------------------------------------------------------------------------------


def test_a_release_with_no_ready_marker_is_never_swapped_in(machine: Machine) -> None:
    machine.install(INSTALLED)
    directory = machine.staging / NEW
    directory.mkdir()
    (directory / "innytypes.tar.gz").write_bytes(b"a download that never finished")

    assert machine.applier().apply_at_quit() is None
    assert machine.installer.unpacked == []
    assert machine.live_version() == INSTALLED


def test_a_marker_that_does_not_say_ready_is_refused(machine: Machine) -> None:
    machine.install(INSTALLED)
    machine.stage(NEW, marker={"ready": False})

    with pytest.raises(ReleaseApplyError, match="does not say `ready`"):
        machine.applier().apply_at_quit()

    assert machine.live_version() == INSTALLED


@pytest.mark.parametrize(
    ("marker", "message"),
    [
        ({"version": "not-a-version"}, "not a MAJOR.MINOR.PATCH"),
        ({"platform": "windows"}, "was staged for"),
        ({"host_api": 0}, "positive whole number"),
        ({"automatic": "yes"}, "must be true or false"),
        ({"sha256": "nonsense"}, "64 lowercase hexadecimal"),
        ({"artifact": "../../bin/innytypes"}, "not a usable file name"),
        ({"artifact": "gone.tar.gz"}, "no such file"),
        ({"signature": ""}, "must be a non-empty string"),
    ],
)
def test_a_marker_that_cannot_be_believed_is_refused(
    machine: Machine, marker: dict[str, object], message: str
) -> None:
    machine.install(INSTALLED)
    machine.stage(NEW, marker=marker)

    with pytest.raises(ReleaseApplyError, match=message):
        machine.applier().apply_at_quit()

    assert machine.installer.unpacked == []
    assert machine.live_version() == INSTALLED


def test_a_marker_naming_another_version_than_its_directory_is_refused(machine: Machine) -> None:
    machine.stage(NEW, directory_name="9.9.9")

    with pytest.raises(ReleaseApplyError, match="staged in '9.9.9'"):
        machine.applier().apply_at_quit()


def test_two_releases_marked_ready_are_refused_rather_than_guessed_between(
    machine: Machine,
) -> None:
    machine.stage(NEW)
    machine.stage("1.4.0")

    with pytest.raises(ReleaseApplyError, match="holds 2 releases marked ready"):
        machine.applier().apply_at_quit()


def test_an_unreadable_marker_is_refused(machine: Machine) -> None:
    directory = machine.stage(NEW)
    (directory / READY_MARKER).write_text("{not json", encoding="utf-8")

    with pytest.raises(ReleaseApplyError, match="could not be read"):
        machine.applier().apply_at_quit()


def test_an_artifact_changed_since_it_was_staged_is_deleted_rather_than_installed(
    machine: Machine,
) -> None:
    """The checksum is re-read at apply time, not trusted from download time."""
    machine.install(INSTALLED)
    directory = machine.stage(NEW)
    (directory / "innytypes.tar.gz").write_bytes(b"something else entirely")

    applied = machine.applier().apply_at_quit()

    assert applied is not None
    assert not applied.applied
    assert applied.reason is not None
    assert "no longer matches its own checksum" in applied.reason
    assert machine.installer.unpacked == []
    assert machine.live_version() == INSTALLED
    # Never run and never kept: the bytes are gone, so no later quit reads them either.
    assert machine.staged() == []


def test_an_artifact_signed_by_another_key_is_deleted_rather_than_installed(
    machine: Machine,
) -> None:
    """A perfect checksum with the wrong signature is the case a checksum-only check passes."""
    machine.install(INSTALLED)
    stranger = Signer(signing_key=SigningKey.generate(), key_id=secrets.token_bytes(8))
    machine.stage(NEW, sign_with=stranger)

    applied = machine.applier().apply_at_quit()

    assert applied is not None
    assert applied.reason is not None
    assert "does not verify against the signing key" in applied.reason
    assert machine.installer.unpacked == []
    assert machine.live_version() == INSTALLED
    assert machine.staged() == []


def test_an_archive_that_does_not_hold_the_release_it_was_signed_as_is_refused(
    machine: Machine,
) -> None:
    machine.install(INSTALLED)
    machine.stage(NEW)
    machine.installer.unpacks_version = "9.9.9"

    applied = machine.applier().apply_at_quit()

    assert applied is not None
    assert applied.reason is not None
    assert "does not hold the release it was signed as" in applied.reason
    assert machine.live_version() == INSTALLED
    assert not machine.roots.incoming.exists()


def test_an_unpack_that_fails_leaves_the_installation_alone(machine: Machine) -> None:
    machine.install(INSTALLED)
    machine.stage(NEW)
    machine.installer.fails_to_unpack = "the archive is truncated"

    applied = machine.applier().apply_at_quit()

    assert applied is not None
    assert applied.reason is not None
    assert "could not be unpacked" in applied.reason
    assert machine.live_version() == INSTALLED
    assert not machine.roots.previous.exists()
    assert not machine.roots.incoming.exists()


def test_a_first_install_through_this_path_keeps_no_previous(machine: Machine) -> None:
    """There is nothing to keep when nothing was installed, and that is said rather than faked."""
    machine.stage(NEW)

    applied = machine.applier().apply_at_quit()

    assert applied is not None and applied.applied
    assert applied.previous is None
    assert machine.live_version() == NEW


# --------------------------------------------------------------------------------------
# Acceptance 4 — a host update that would stop a plugin waits instead
# --------------------------------------------------------------------------------------


def test_an_incompatible_plugin_stops_the_swap_and_the_update_waits(machine: Machine) -> None:
    machine.install(INSTALLED)
    machine.install_plugin("monty", host_api=HOST_API_VERSION)
    # `automatic` is true, so the only thing that can stop this release is the plugin: a test
    # where D13 also refused would pass with the compatibility check missing.
    machine.stage(NEW, host_api=HOST_API_VERSION + 1, automatic=True)

    applied = machine.applier().apply_at_quit()

    assert applied is not None
    assert applied.waiting
    assert applied.reason is not None
    assert "monty" in applied.reason
    assert machine.installer.unpacked == []
    assert machine.live_version() == INSTALLED
    # It waits: the verified release stays staged for a quit where every plugin supports it.
    assert machine.staged() == [NEW]


def test_a_compatible_plugin_does_not_stop_the_swap(machine: Machine) -> None:
    machine.install(INSTALLED)
    machine.install_plugin("monty", host_api=HOST_API_VERSION + 1)
    machine.stage(NEW, host_api=HOST_API_VERSION + 1, automatic=True)
    machine.installer.host_api = HOST_API_VERSION + 1

    applied = machine.applier().apply_at_quit()

    assert applied is not None and applied.applied
    assert machine.live_version() == NEW


def test_a_plugin_whose_manifest_cannot_be_read_does_not_hold_up_every_update(
    machine: Machine,
) -> None:
    """A plugin that cannot start today is not one the update stops from starting."""
    machine.install(INSTALLED)
    machine.install_plugin("monty")
    recorded_manifest_path(machine.addons, "monty").write_text("{not json", encoding="utf-8")
    machine.stage(NEW, host_api=HOST_API_VERSION + 1, automatic=True)
    machine.installer.host_api = HOST_API_VERSION + 1

    applied = machine.applier().apply_at_quit()

    assert applied is not None and applied.applied
    assert [plugin.host_api for plugin in installed_plugin_apis(machine.addons)] == [None]


def test_the_compatibility_check_names_every_plugin_that_would_stop(machine: Machine) -> None:
    machine.install_plugin("monty", host_api=1)
    machine.install_plugin("whodunnit", host_api=2)

    stopped = incompatible_plugins(installed_plugin_apis(machine.addons), host_api=2)

    assert [plugin.id for plugin in stopped] == ["monty"]


def test_a_directory_under_the_addons_root_with_no_environment_is_not_installed_into(
    machine: Machine,
) -> None:
    machine.install(INSTALLED)
    addon_root(machine.addons, "leftovers").mkdir(parents=True)
    machine.stage(NEW)

    applied = machine.applier().apply_at_quit()

    assert applied is not None and applied.applied
    assert applied.environments == ()
    assert machine.installer.moved_environments == [machine.helper_environment]


# --------------------------------------------------------------------------------------
# D13 — a host API change never applies itself
# --------------------------------------------------------------------------------------


def test_a_release_that_is_not_automatic_waits_however_often_the_user_quits(
    machine: Machine,
) -> None:
    machine.install(INSTALLED)
    machine.stage(NEW, automatic=False)
    applier = machine.applier()

    first = applier.apply_at_quit()
    second = applier.apply_at_quit()

    for applied in (first, second):
        assert applied is not None
        assert applied.waiting
        assert applied.reason is not None
        assert "changes the host API" in applied.reason
    assert machine.installer.unpacked == []
    assert machine.live_version() == INSTALLED
    assert machine.staged() == [NEW]


def test_an_explicit_apply_installs_a_release_that_is_not_automatic(machine: Machine) -> None:
    machine.install(INSTALLED)
    machine.stage(NEW, automatic=False)

    applied = machine.applier().apply_at_quit(requested=True)

    assert applied is not None and applied.applied
    assert machine.live_version() == NEW


def test_an_explicit_apply_does_not_let_a_bad_signature_through(machine: Machine) -> None:
    machine.install(INSTALLED)
    stranger = Signer(signing_key=SigningKey.generate(), key_id=secrets.token_bytes(8))
    machine.stage(NEW, automatic=False, sign_with=stranger)

    applied = machine.applier().apply_at_quit(requested=True)

    assert applied is not None
    assert not applied.applied
    assert machine.live_version() == INSTALLED


# --------------------------------------------------------------------------------------
# Acceptance 5 — every plugin environment, and the helper, move to the new host version
# --------------------------------------------------------------------------------------


def test_applying_moves_every_plugin_environment_and_the_helper_to_the_new_version(
    machine: Machine,
) -> None:
    machine.install(INSTALLED)
    monty = machine.install_plugin("monty")
    whodunnit = machine.install_plugin("whodunnit")
    machine.stage(NEW)

    applied = machine.applier().apply_at_quit()

    assert applied is not None and applied.applied
    assert machine.installer.moved_environments == [monty, whodunnit, machine.helper_environment]
    assert {version for _environment, version, _release in machine.installer.moved} == {NEW}
    # The wheel comes from inside the release that was just swapped in, never from an index.
    assert {release for _environment, _version, release in machine.installer.moved} == {
        machine.roots.live
    }
    assert applied.environments == ("monty", "whodunnit")
    assert applied.helper_environment == machine.helper_environment


def test_a_plugin_environment_that_will_not_move_puts_the_installation_back(
    machine: Machine,
) -> None:
    machine.install(INSTALLED)
    monty = machine.install_plugin("monty")
    machine.stage(NEW)
    machine.installer.fails_for = monty

    applied = machine.applier().apply_at_quit()

    assert applied is not None
    assert applied.reason is not None
    assert "could not be moved to innytypes" in applied.reason
    assert machine.live_version() == INSTALLED
    # Nothing is blocked: what failed is this machine's environment, not the release.
    assert machine.blocked.all() == ()
    assert machine.pending.current() is None


def test_a_helper_environment_that_will_not_move_puts_the_installation_back(
    machine: Machine,
) -> None:
    machine.install(INSTALLED)
    machine.stage(NEW)
    machine.installer.fails_for = machine.helper_environment

    applied = machine.applier().apply_at_quit()

    assert applied is not None
    assert applied.reason is not None
    assert "the helper's own environment" in applied.reason
    assert machine.live_version() == INSTALLED


# --------------------------------------------------------------------------------------
# Acceptance 2 — confirm at the next launch, or roll back
# --------------------------------------------------------------------------------------


def confirm(
    machine: Machine,
    *,
    beats: HeartbeatRegistry,
    host: ChildRecord | None,
    clock: FakeClock,
    window: float = 120.0,
    restarts: list[str] | None = None,
) -> ReleaseConfirmation | None:
    return confirm_or_roll_back(
        roots=machine.roots,
        pending=machine.pending,
        blocked=machine.blocked,
        beats=beats,
        host=host,
        window=window,
        restart=lambda: (restarts if restarts is not None else []).append("restarted"),
        now=clock,
        sleep=clock.sleep,
    )


def applied_machine(machine: Machine) -> ChildRecord:
    """A machine that has just applied an update and is on its next launch."""
    machine.install(INSTALLED)
    machine.stage(NEW)
    applied = machine.applier().apply_at_quit()
    assert applied is not None and applied.applied
    return host_record()


def test_a_release_that_never_beats_is_rolled_back_restarted_and_blocked(
    machine: Machine,
) -> None:
    host = applied_machine(machine)
    clock = FakeClock()
    restarts: list[str] = []

    confirmation = confirm(machine, beats=beats_with(), host=host, clock=clock, restarts=restarts)

    assert confirmation is not None
    assert not confirmation.confirmed
    assert confirmation.blocked == NEW
    assert confirmation.rolled_back_to == INSTALLED
    assert confirmation.restarted
    assert restarts == ["restarted"]
    # The three lasting consequences: the old release is live again, the new one is blocked,
    # and nothing is left pending for the launch after this one to confirm.
    assert machine.live_version() == INSTALLED
    assert machine.blocked.all() == (NEW,)
    assert machine.pending.current() is None
    # The window was waited out on the injected clock, and no real second passed.
    assert clock.total_slept >= 120.0


def test_a_healthy_beat_from_the_new_host_confirms_the_release(machine: Machine) -> None:
    host = applied_machine(machine)
    clock = FakeClock()

    confirmation = confirm(
        machine, beats=beats_with(beat(host, version=NEW)), host=host, clock=clock
    )

    assert confirmation is not None
    assert confirmation.confirmed
    assert machine.live_version() == NEW
    assert machine.blocked.all() == ()
    assert machine.pending.current() is None
    # Confirmed on the first look: nothing waited at all.
    assert clock.slept == []


@pytest.mark.parametrize(
    ("published", "why"),
    [
        (lambda host: beat(host, version=INSTALLED), "the old version"),
        (lambda host: beat(host, version=NEW, state=ProcessState.DEGRADED), "not ready"),
        (lambda host: beat(host_record(pid=999), version=NEW), "another process"),
    ],
)
def test_a_beat_that_is_not_the_new_host_saying_ready_does_not_confirm(
    machine: Machine,
    published: Callable[[ChildRecord], Heartbeat],
    why: str,
) -> None:
    host = applied_machine(machine)
    clock = FakeClock()

    confirmation = confirm(machine, beats=beats_with(published(host)), host=host, clock=clock)

    assert confirmation is not None
    assert not confirmation.confirmed, why
    assert machine.live_version() == INSTALLED
    assert machine.blocked.all() == (NEW,)


def test_a_launch_with_no_host_at_all_rolls_back(machine: Machine) -> None:
    applied_machine(machine)
    clock = FakeClock()

    confirmation = confirm(machine, beats=beats_with(), host=None, clock=clock)

    assert confirmation is not None
    assert machine.live_version() == INSTALLED


def test_a_launch_with_nothing_pending_confirms_nothing_and_moves_nothing(
    machine: Machine,
) -> None:
    """Every ordinary launch. Nothing is read from staging and nothing is renamed."""
    machine.install(INSTALLED)
    machine.stage(NEW)
    clock = FakeClock()

    assert confirm(machine, beats=beats_with(), host=host_record(), clock=clock) is None
    assert machine.live_version() == INSTALLED
    assert machine.staged() == [NEW]
    assert clock.slept == []


def test_a_pending_note_that_cannot_be_read_is_refused_rather_than_read_as_nothing(
    machine: Machine,
) -> None:
    machine.pending.path.write_text("{not json", encoding="utf-8")

    with pytest.raises(ReleaseApplyError, match="not valid JSON"):
        confirm(machine, beats=beats_with(), host=host_record(), clock=FakeClock())


def test_the_failed_version_is_blocked_even_when_it_cannot_be_rolled_back(
    machine: Machine,
) -> None:
    """The block is written first, because it is the consequence that must survive a failure."""
    applied_machine(machine)
    _remove_tree(machine.roots.previous)
    clock = FakeClock()

    confirmation = confirm(machine, beats=beats_with(), host=host_record(), clock=clock)

    assert confirmation is not None
    assert confirmation.blocked == NEW
    assert confirmation.reason is not None
    assert "could not be rolled back" in confirmation.reason
    assert machine.blocked.all() == (NEW,)
    assert machine.pending.current() is None


def test_a_restart_that_fails_is_reported_and_does_not_undo_the_rollback(
    machine: Machine,
) -> None:
    applied_machine(machine)
    clock = FakeClock()

    confirmation = confirm_or_roll_back(
        roots=machine.roots,
        pending=machine.pending,
        blocked=machine.blocked,
        beats=beats_with(),
        host=host_record(),
        window=120.0,
        restart=_raise_restart,
        now=clock,
        sleep=clock.sleep,
    )

    assert confirmation is not None
    assert not confirmation.restarted
    assert machine.live_version() == INSTALLED


def _raise_restart() -> None:
    raise RuntimeError("the application would not start")


def _remove_tree(path: Path) -> None:
    shutil.rmtree(path)


def test_rolling_back_with_nothing_kept_is_refused(machine: Machine) -> None:
    machine.install(INSTALLED)

    with pytest.raises(ReleaseApplyError, match="nothing to roll back to"):
        roll_back_release(machine.roots)

    assert machine.live_version() == INSTALLED


# --------------------------------------------------------------------------------------
# Acceptance 3 — a rolled-back version is never proposed and never applied again
# --------------------------------------------------------------------------------------


def index_with(*versions: str) -> ReleaseIndex:
    """A release index that still lists every one of these versions."""
    return parse_release_index(
        {
            "channel": "stable",
            "releases": [
                {
                    "version": version,
                    "host_api": HOST_API_VERSION,
                    "artifacts": {
                        PLATFORM: {
                            "url": f"https://releases.example.invalid/innytypes-{version}.tar.gz",
                            "sha256": "0" * 64,
                            "signature": "untrusted comment: x\na\ntrusted comment: y\nb\n",
                        }
                    },
                }
                for version in versions
            ],
        },
        channel="stable",
    )


def test_a_rolled_back_version_is_not_proposed_again_by_the_check(machine: Machine) -> None:
    host = applied_machine(machine)
    confirm(machine, beats=beats_with(), host=host, clock=FakeClock())
    assert machine.blocked.all() == (NEW,)

    proposed = choose_candidate(
        index_with(NEW),
        current_version=Version(1, 2, 3),
        platform=SYS_PLATFORM,
        is_blocked=machine.blocked.is_blocked,
    )

    assert proposed is None
    # And without the record the same index proposes it, so the assertion above is about the
    # block rather than about the index.
    assert (
        choose_candidate(index_with(NEW), current_version=Version(1, 2, 3), platform=SYS_PLATFORM)
        is not None
    )


def test_a_blocked_newest_release_does_not_hide_the_good_one_under_it(
    machine: Machine,
) -> None:
    machine.blocked.block("1.4.0")

    proposed = choose_candidate(
        index_with("1.3.0", "1.4.0"),
        current_version=Version(1, 2, 3),
        platform=SYS_PLATFORM,
        is_blocked=machine.blocked.is_blocked,
    )

    assert proposed is not None
    assert str(proposed.release.version) == "1.3.0"


def test_a_blocked_version_is_deleted_rather_than_applied_again(machine: Machine) -> None:
    machine.install(INSTALLED)
    machine.blocked.block(NEW)
    machine.stage(NEW)

    applied = machine.applier().apply_at_quit()

    assert applied is not None
    assert applied.reason is not None
    assert "is blocked" in applied.reason
    assert machine.installer.unpacked == []
    assert machine.live_version() == INSTALLED
    assert machine.staged() == []


def test_an_unreadable_record_of_blocked_versions_stops_the_update(machine: Machine) -> None:
    """Reading no blocks out of a file that holds them would install the version it keeps out."""
    machine.install(INSTALLED)
    machine.stage(NEW)
    machine.blocked.versions.path.write_text("{not json", encoding="utf-8")

    with pytest.raises(UpdateApplyError, match="could not be read"):
        machine.applier().apply_at_quit()

    assert machine.live_version() == INSTALLED


# --------------------------------------------------------------------------------------
# The contract between slice 09 and slice 10: what staging writes is what applying reads
# --------------------------------------------------------------------------------------


def test_a_release_staged_by_the_download_applies_without_being_touched(
    machine: Machine, signer: Signer
) -> None:
    """Slice 09 stages it, slice 10 installs it, and no test wrote the marker in between."""
    content = b"the release bundle, as published"
    url = "https://downloads.example.invalid/innytypes-1.3.0-macos.tar.gz"
    artifact = ReleaseArtifact(
        url=url,
        filename="innytypes-1.3.0-macos.tar.gz",
        sha256=hashlib.sha256(content).hexdigest(),
        signature=signer.sign(content),
        size=len(content),
    )
    candidate = UpdateCandidate(
        release=Release(version=Version(1, 3, 0), host_api=HOST_API_VERSION, artifacts={}),
        artifact=artifact,
        platform=PLATFORM,
        automatic=True,
        blocked_reason="",
    )

    machine.install(INSTALLED)
    with httpx.Client(
        transport=httpx.MockTransport(lambda request: httpx.Response(200, content=content))
    ) as client:
        download_and_verify(
            candidate,
            client=client,
            staging=machine.staging,
            public_key=parse_public_key(signer.public_key_text),
            now=lambda: APPLIED_AT,
        )

    applied = machine.applier().apply_at_quit()

    assert applied is not None and applied.applied
    assert machine.live_version() == NEW
    pending = machine.pending.current()
    assert pending is not None
    assert str(pending.version) == NEW
    assert pending.previous_version == INSTALLED
    assert pending.applied_at == APPLIED_AT.isoformat()


def test_reading_an_empty_staging_directory_finds_nothing(machine: Machine) -> None:
    assert read_ready_release(machine.staging, platform=SYS_PLATFORM) is None
    assert read_ready_release(machine.root / "never-created", platform=SYS_PLATFORM) is None


# --------------------------------------------------------------------------------------
# The production installer: the argv it builds, and the archive it refuses
# --------------------------------------------------------------------------------------


def _unused_runner(argv: Sequence[str]) -> str:
    """A runner the test never expects to be reached: no `uv` runs in this gate."""
    raise AssertionError(f"nothing should have been run, but {' '.join(argv)} was")


def test_the_installer_installs_the_host_wheel_from_inside_the_release(tmp_path: Path) -> None:
    release = tmp_path / "current"
    (release / "wheels").mkdir(parents=True)
    wheel = release / "wheels" / f"innytypes-{NEW}-py3-none-any.whl"
    wheel.write_bytes(b"a wheel")
    environment = tmp_path / "env"
    argvs: list[list[str]] = []

    def record(argv: Sequence[str]) -> str:
        argvs.append(list(argv))
        return ""

    UvCoreInstaller(run=record).set_host_version(environment, version=NEW, release=release)

    assert argvs == [
        [
            "uv",
            "pip",
            "install",
            "--python",
            str(environment / "bin" / "python"),
            "--no-deps",
            str(wheel),
        ]
    ]


def test_the_installer_refuses_a_release_that_carries_no_host_wheel(tmp_path: Path) -> None:
    release = tmp_path / "current"
    release.mkdir()

    with pytest.raises(ReleaseApplyError, match="carries no innytypes wheel"):
        UvCoreInstaller(run=_unused_runner).set_host_version(
            tmp_path / "env", version=NEW, release=release
        )


def test_the_installer_unpacks_an_archive_into_a_directory_of_its_own(tmp_path: Path) -> None:
    payload = tmp_path / "release.json"
    payload.write_text(json.dumps({"version": NEW, "host_api": HOST_API_VERSION}))
    artifact = tmp_path / "innytypes.tar.gz"
    with tarfile.open(artifact, "w:gz") as archive:
        archive.add(payload, arcname=RELEASE_MARKER)

    destination = tmp_path / "incoming"
    UvCoreInstaller(run=_unused_runner).unpack(artifact, destination=destination, version=NEW)

    assert json.loads((destination / RELEASE_MARKER).read_text())["version"] == NEW


def test_the_installer_refuses_an_archive_it_cannot_read(tmp_path: Path) -> None:
    artifact = tmp_path / "innytypes.tar.gz"
    artifact.write_bytes(b"not an archive at all")

    with pytest.raises(ReleaseApplyError, match="could not be unpacked"):
        UvCoreInstaller(run=_unused_runner).unpack(
            artifact, destination=tmp_path / "incoming", version=NEW
        )
