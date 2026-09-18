"""Applying a plugin update: build in staging, stop the affected group, swap, start, or undo.

The whole of plan 0003's *Applying a plugin update* is driven here with nothing real behind
it. The installer is injected and writes the two records an environment is made of instead of
running `uv`; the host is a fake that answers commands and hands out process IDs instead of
spawning anything; the clock is a counter a test moves, so a two-minute health window costs
no time at all. No `uv`, no `git`, no network, no process, no socket, no sleeping.

**The fakes can fail the tests.** The fake host refuses a command naming a child it is not
running, exactly as :class:`~innytypes.children.ChildSupervisor` does, so a stop issued for an
unaffected plugin is an error rather than a line nobody notices. And it writes down what was
under the live root at the moment of every stop and every start, which is what lets "built
before anything stopped" and "swapped before anything started" be assertions about order
rather than about intent.
"""

from __future__ import annotations

import hashlib
import json
import shutil
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest
from click.testing import CliRunner, Result

from innytypes import HOST_API_VERSION, __version__
from innytypes.addons.discovery import (
    InstalledAddon,
    addon_environment,
    addon_root,
    recorded_manifest_path,
)
from innytypes.addons.lock import LockError, parse_lock, recorded_lock_path
from innytypes.addons.manifest import AddonManifest, Requirement, parse_manifest
from innytypes.children import (
    ChildError,
    ChildKind,
    ChildRecord,
    Command,
    CommandName,
    CommandResult,
)
from innytypes.cli import CliContext, cli
from innytypes.helper.config import (
    HelperConfig,
    HelperSettings,
    PluginOverride,
    PluginSettings,
    UpdateMode,
)
from innytypes.helper.environments import stage_environment
from innytypes.helper.heartbeat import Heartbeat, HeartbeatRegistry, ProcessState
from innytypes.helper.rollout import (
    AppliedUpdate,
    BlockedVersions,
    UpdateApplier,
    UpdateApplyError,
    default_blocked_versions_path,
)
from innytypes.helper.versions import (
    Candidate,
    ConsistencyRule,
    PluginIndexSource,
    PluginReport,
    PluginState,
    TargetPlugin,
    TargetSet,
    VersionCheck,
    VersionChecker,
)

# A repository URL that exists only in this file: no `git` runs here, and none is reachable.
REPOSITORY = "https://forge.example/monty.git"


# --- manifests, candidates and target sets -------------------------------------------------


def manifest_document(
    addon_id: str,
    version: str,
    *,
    requires: Sequence[str] = (),
    emits: Sequence[str] | None = None,
    subscribes: Sequence[str] = (),
    stability: Mapping[str, object] | None = None,
) -> dict[str, Any]:
    """One manifest as a source publishes it, or as an install records it."""
    document: dict[str, Any] = {
        "id": addon_id,
        "version": version,
        "host_api": HOST_API_VERSION,
        "requires": list(requires),
        "emits": [f"{addon_id}.started.v1"] if emits is None else list(emits),
        "subscribes": list(subscribes),
        "update": {"source": "index"},
    }
    if stability is not None:
        document["stability"] = dict(stability)
    return document


def manifest(document: Mapping[str, Any]) -> AddonManifest:
    """The parsed manifest, through the parser the host itself uses."""
    return parse_manifest(document)


def candidate_for(document: Mapping[str, Any]) -> Candidate:
    """One version a plugin could move to, published by the owner's index."""
    parsed = manifest(document)
    return Candidate(
        plugin_id=parsed.id,
        manifest=parsed,
        source=PluginIndexSource(name=parsed.id),
        reference=parsed.version,
    )


def target_set(*plugins: TargetPlugin) -> TargetSet:
    """A target set in the order the checker produces it, by id."""
    return TargetSet(plugins=tuple(sorted(plugins, key=lambda plugin: plugin.id)))


def moving(document: Mapping[str, Any]) -> TargetPlugin:
    """One plugin the set would move to the version this document names."""
    return TargetPlugin(
        id=str(document["id"]), manifest=manifest(document), candidate=candidate_for(document)
    )


def staying(document: Mapping[str, Any]) -> TargetPlugin:
    """One plugin the set leaves exactly where it is."""
    return TargetPlugin(id=str(document["id"]), manifest=manifest(document), candidate=None)


def config_with(**modes: str) -> HelperConfig:
    """A config saying what each plugin's update mode is, and which plugins are pinned.

    The global default is `auto` here, because these tests are about applying rather than
    about who is allowed to ask: the plugins whose mode is the point of a test name it.
    """
    return HelperConfig(
        plugins=PluginSettings(
            update_mode=UpdateMode.AUTO,
            overrides=tuple(
                PluginOverride(
                    id=plugin_id,
                    update_mode=None if mode == "pinned" else UpdateMode(mode),
                    pinned=mode == "pinned",
                )
                for plugin_id, mode in modes.items()
            ),
        )
    )


# --- locks -----------------------------------------------------------------------------------


def digest(seed: str) -> str:
    """A syntactically valid sha256 hash, derived from a seed so it is stable per entry."""
    return f"sha256:{hashlib.sha256(seed.encode('utf-8')).hexdigest()}"


def pin(name: str, version: str) -> str:
    """One hashed pin, the shape `uv pip compile --generate-hashes` writes."""
    return f"{name}=={version} --hash={digest(name + version)}"


def good_lock(candidate: Candidate) -> str:
    """A lock rule 5 accepts: this host's `innytypes`, the plugin, and one dependency."""
    entries = [
        pin("innytypes", __version__),
        pin(candidate.plugin_id, candidate.version),
        pin("httpx", "0.28.1"),
    ]
    return "\n".join(entries) + "\n"


@dataclass
class FakeLocks:
    """The lock resolver: answers from a dictionary, and records what it was asked for."""

    texts: dict[str, str] = field(default_factory=dict)
    asked: list[str] = field(default_factory=list)

    def __call__(self, candidate: Candidate) -> str:
        requirement = candidate.requirement_text()
        self.asked.append(requirement)
        return self.texts.get(requirement, good_lock(candidate))


# --- the injected installer --------------------------------------------------------------------


@dataclass
class RecordingInstaller:
    """An installer that writes the two records an environment is made of, and runs no `uv`.

    It creates the environment directory and the lock beside it because that on-disk layout
    is what a swap refuses to move when it is incomplete — a fake that only counted calls
    could not fail the test asserting an environment is ready before anything stops.
    """

    journal: list[tuple[str, str]]
    # The manifest each addon's entry point would export, by addon id.
    documents: dict[str, Mapping[str, Any]] = field(default_factory=dict)
    # What every install was asked to install, in order.
    requirements: list[tuple[str, ...]] = field(default_factory=list)
    # Addon ids the build blows up for, the way a resolver that cannot resolve blows up.
    fails_for: set[str] = field(default_factory=set)
    # Addon ids whose install writes no lock, leaving a half-built environment behind.
    writes_no_lock: set[str] = field(default_factory=set)

    def create_environment(self, environment: Path, *, python: str) -> None:
        environment.mkdir(parents=True)

    def install(
        self,
        environment: Path,
        requirements: Sequence[str],
        *,
        editable: object | None = None,
    ) -> None:
        self.requirements.append(tuple(requirements))
        addon_id = environment.parent.name
        if addon_id in self.fails_for:
            raise RuntimeError(f"the installer was told to fail for {addon_id}")
        if addon_id in self.writes_no_lock:
            return
        lines = [
            pin(*requirement.split("==")) if "==" in requirement else requirement
            for requirement in requirements
        ]
        (environment.parent / "lock.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")

    def read_manifest(self, environment: Path, *, addon_id: str) -> Mapping[str, Any]:
        self.journal.append(("staged", addon_id))
        return self.documents[addon_id]


# --- the injected host -------------------------------------------------------------------------


@dataclass
class FakeHost:
    """A host that answers the helper's commands, spawns nothing, and writes down what it saw.

    ``running`` is what a `list` answers with. A command naming a child it does not have is
    **refused**, the way :class:`~innytypes.children.ChildSupervisor` refuses one, so a stop
    issued for a plugin this update had no business touching fails the test.
    """

    live_root: Path
    beats: HeartbeatRegistry
    journal: list[tuple[str, str]]
    running: dict[str, ChildRecord] = field(default_factory=dict)
    known: set[str] = field(default_factory=set)
    # Plugins whose process exits the instant it is started: the host lists them no more.
    dies: set[str] = field(default_factory=set)
    # Plugins that start and stay up but never publish a `ready` beat.
    silent: set[str] = field(default_factory=set)
    # (command, child, the live versions on disk) for every command, in order.
    saw: list[tuple[str, str, dict[str, str]]] = field(default_factory=list)
    # Run before each command is carried out, for the tests about a disk that changes.
    before_each: Callable[[Command], None] | None = None
    next_pid: int = 90_000

    def add(self, addon_id: str, *, running: bool = True) -> None:
        """Make the host aware of one child, and start it if it should already be up."""
        self.known.add(addon_id)
        if running:
            self.running[addon_id] = self._record(addon_id)

    def send(self, command: Command) -> CommandResult:
        if command.name is CommandName.LIST:
            return CommandResult(name=command.name, children=tuple(self.running.values()))

        child_id = command.child_id
        assert child_id is not None
        if child_id not in self.known:
            raise ChildError(f"this host has no child called {child_id!r}")

        if self.before_each is not None:
            self.before_each(command)

        self.journal.append((str(command.name), child_id))
        self.saw.append((str(command.name), child_id, self._live_versions()))

        if command.name is CommandName.STOP:
            self.running.pop(child_id, None)
            return CommandResult(name=command.name)

        if command.name is CommandName.START:
            record = self._record(child_id)
            if child_id not in self.dies:
                self.running[child_id] = record
                if child_id not in self.silent:
                    self._beat(record)
            return CommandResult(name=command.name, children=(record,))

        raise AssertionError(f"this fake host was not asked for {command.name}")

    def commands(self, name: str) -> list[str]:
        """The children one kind of command named, in the order the host received them."""
        return [child_id for kind, child_id in self.journal if kind == name]

    def versions_seen(self, kind: str, child_id: str) -> list[dict[str, str]]:
        """What was installed under the live root each time one command arrived."""
        return [
            versions
            for seen_kind, seen_id, versions in self.saw
            if seen_kind == kind and seen_id == child_id
        ]

    def _record(self, child_id: str) -> ChildRecord:
        self.next_pid += 1
        return ChildRecord(
            id=child_id,
            kind=ChildKind.ADDON,
            pid=self.next_pid,
            started_at=float(self.next_pid),
            executable=f"/nonexistent/{child_id}",
            parent_pid=1,
        )

    def _beat(self, record: ChildRecord) -> None:
        self.beats.record(
            Heartbeat(
                id=record.id,
                kind=record.kind,
                pid=record.pid,
                started_at=record.started_at,
                version=self._live_versions().get(record.id, "0"),
                state=ProcessState.READY,
                progress_at=record.started_at,
            )
        )

    def _live_versions(self) -> dict[str, str]:
        """The version each plugin's live recorded manifest reports, right now."""
        versions: dict[str, str] = {}
        if not self.live_root.is_dir():
            return versions
        for directory in sorted(self.live_root.iterdir()):
            record = recorded_manifest_path(self.live_root, directory.name)
            if record.is_file():
                versions[directory.name] = str(json.loads(record.read_text())["version"])
        return versions


# --- the injected clock ------------------------------------------------------------------------


@dataclass
class Clock:
    """A clock a test moves. ``sleep`` advances it instead of spending anything."""

    t: float = 0.0
    slept: list[float] = field(default_factory=list)

    def now(self) -> float:
        return self.t

    def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)
        self.t += seconds


# --- the world one test runs in ------------------------------------------------------------------


@dataclass
class World:
    """Everything one apply needs, with every seam pointing at something in this file."""

    applier: UpdateApplier
    host: FakeHost
    installer: RecordingInstaller
    locks: FakeLocks
    blocked: BlockedVersions
    clock: Clock
    beats: HeartbeatRegistry
    live_root: Path
    staging_root: Path
    previous_root: Path
    journal: list[tuple[str, str]]
    installed: dict[str, AddonManifest] = field(default_factory=dict)

    def install(self, document: Mapping[str, Any], *, running: bool = True) -> None:
        """Put one addon under the live root exactly as an install leaves it, and start it."""
        addon_id = str(document["id"])
        addon_environment(self.live_root, addon_id).mkdir(parents=True, exist_ok=True)
        recorded_manifest_path(self.live_root, addon_id).write_text(
            json.dumps(document), encoding="utf-8"
        )
        recorded_lock_path(self.live_root, addon_id).write_text(
            pin(addon_id, str(document["version"])) + "\n", encoding="utf-8"
        )
        self.installed[addon_id] = manifest(document)
        self.host.add(addon_id, running=running)

    def offers(self, document: Mapping[str, Any]) -> None:
        """Make the injected installer answer with this manifest when it builds that addon."""
        self.installer.documents[str(document["id"])] = document

    def apply(
        self,
        target: TargetSet,
        *,
        config: HelperConfig | None = None,
        requested: Sequence[str] = (),
    ) -> AppliedUpdate:
        return self.applier.apply(
            target,
            installed=self.installed,
            config=config_with() if config is None else config,
            requested=requested,
        )

    def live_version(self, addon_id: str) -> str:
        """The version the live recorded manifest reports for one addon."""
        return str(
            json.loads(recorded_manifest_path(self.live_root, addon_id).read_text())["version"]
        )

    def previous_version(self, addon_id: str) -> str:
        """The version kept as `previous` for one addon."""
        record = recorded_manifest_path(self.previous_root, addon_id)
        return str(json.loads(record.read_text())["version"])


@pytest.fixture
def world(tmp_path: Path) -> World:
    """One applier wired to fakes, writing only under ``tmp_path``."""
    live_root = tmp_path / "addons"
    staging_root = tmp_path / "staging"
    previous_root = tmp_path / "previous"
    live_root.mkdir()

    journal: list[tuple[str, str]] = []
    beats = HeartbeatRegistry(clock=lambda: 1.0)
    installer = RecordingInstaller(journal=journal)
    host = FakeHost(live_root=live_root, beats=beats, journal=journal)
    locks = FakeLocks()
    blocked = BlockedVersions(path=tmp_path / "blocked.json")
    clock = Clock()

    applier = UpdateApplier(
        installer=installer,
        channel=host,
        resolve_lock=locks,
        blocked=blocked,
        beats=beats,
        live_root=live_root,
        staging_root=staging_root,
        previous_root=previous_root,
        poll_interval=1.0,
        now=clock.now,
        sleep=clock.sleep,
    )

    return World(
        applier=applier,
        host=host,
        installer=installer,
        locks=locks,
        blocked=blocked,
        clock=clock,
        beats=beats,
        live_root=live_root,
        staging_root=staging_root,
        previous_root=previous_root,
        journal=journal,
    )


# --- step 1: built and ready before anything running is touched -----------------------------------


def test_the_new_environments_are_built_before_any_stop_command(world: World) -> None:
    world.install(manifest_document("monty", "1.0.0"))
    new = manifest_document("monty", "2.0.0")
    world.offers(new)

    applied = world.apply(target_set(moving(new)))

    assert applied.applied
    kinds = [kind for kind, _ in world.journal]
    assert kinds.index("staged") < kinds.index("stop")
    assert world.installer.requirements == [("monty==2.0.0", f"innytypes=={__version__}")]


def test_the_plugin_is_still_on_its_old_version_when_the_stop_arrives(world: World) -> None:
    world.install(manifest_document("monty", "1.0.0"))
    new = manifest_document("monty", "2.0.0")
    world.offers(new)

    world.apply(target_set(moving(new)))

    # The build went somewhere else entirely: what discovery could read at the moment of the
    # stop is the environment that was already live.
    assert world.host.versions_seen("stop", "monty") == [{"monty": "1.0.0"}]


def test_a_build_that_fails_stops_nothing_and_leaves_the_old_version_running(
    world: World,
) -> None:
    world.install(manifest_document("monty", "1.0.0"))
    new = manifest_document("monty", "2.0.0")
    world.offers(new)
    world.installer.fails_for.add("monty")

    applied = world.apply(target_set(moving(new)))

    assert not applied.applied
    assert "could not be built in staging" in str(applied.reason)
    assert world.host.commands("stop") == []
    assert world.live_version("monty") == "1.0.0"


def test_an_environment_that_records_no_lock_is_never_swapped_in(world: World) -> None:
    world.install(manifest_document("monty", "1.0.0"))
    new = manifest_document("monty", "2.0.0")
    world.offers(new)
    world.installer.writes_no_lock.add("monty")

    applied = world.apply(target_set(moving(new)))

    assert not applied.applied
    assert "records no lock" in str(applied.reason)
    assert world.host.commands("stop") == []
    assert world.live_version("monty") == "1.0.0"


def test_one_plugin_that_cannot_be_built_stops_the_whole_group(world: World) -> None:
    new_base, new_rider = _pair(world)
    world.installer.fails_for.add("rider")

    applied = world.apply(target_set(moving(new_base), moving(new_rider)))

    assert not applied.applied
    assert world.host.commands("stop") == []
    assert world.live_version("base") == "1.0.0"


# --- step 2: only the affected plugins stop, in reverse start order -------------------------------


def _chain(world: World) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    """base <- middle (requires base) <- reader (subscribes to middle), and an unrelated loner.

    ``reader`` is the plugin the phrase "and everything that depends on them" is about: it
    does not change, and it is restarted anyway, because it is started after `middle` and the
    reason for that does not stop applying when `middle` is replaced mid-session.
    """
    base = manifest_document("base", "1.0.0")
    middle = manifest_document("middle", "1.0.0", requires=["base==1.0.0"])
    reader = manifest_document("reader", "1.0.0", subscribes=["middle.started.v1"])
    loner = manifest_document("loner", "1.0.0")

    for document in (base, middle, reader, loner):
        world.install(document)
    world.host.add("innytypes.anytype_mcp")
    world.host.add("anytype-app")

    new_base = manifest_document("base", "2.0.0")
    new_middle = manifest_document("middle", "2.0.0", requires=["base==2.0.0"])
    world.offers(new_base)
    world.offers(new_middle)
    return new_base, new_middle, reader


def _chain_set(new_base: Mapping[str, Any], new_middle: Mapping[str, Any]) -> TargetSet:
    return target_set(
        moving(new_base),
        moving(new_middle),
        staying(manifest_document("reader", "1.0.0", subscribes=["middle.started.v1"])),
        staying(manifest_document("loner", "1.0.0")),
    )


def test_the_affected_group_is_stopped_in_reverse_start_order(world: World) -> None:
    new_base, new_middle, _reader = _chain(world)

    applied = world.apply(_chain_set(new_base, new_middle))

    assert applied.applied
    assert applied.group == ("base", "middle", "reader")
    assert world.host.commands("stop") == ["reader", "middle", "base"]
    assert world.host.commands("start") == ["base", "middle", "reader"]


def test_the_host_the_mcp_server_anytype_and_unaffected_plugins_are_never_stopped(
    world: World,
) -> None:
    new_base, new_middle, _reader = _chain(world)

    world.apply(_chain_set(new_base, new_middle))

    touched = set(world.host.commands("stop")) | set(world.host.commands("start"))
    assert touched == {"base", "middle", "reader"}
    # Still running, and on the very process they were started on.
    assert {"loner", "innytypes.anytype_mcp", "anytype-app"} <= set(world.host.running)


def test_a_plugin_that_is_installed_but_not_running_is_swapped_and_never_commanded(
    world: World,
) -> None:
    world.install(manifest_document("monty", "1.0.0"), running=False)
    new = manifest_document("monty", "2.0.0")
    world.offers(new)

    applied = world.apply(target_set(moving(new)))

    assert applied.applied
    assert applied.group == ()
    assert world.host.commands("stop") == []
    assert world.live_version("monty") == "2.0.0"


# --- steps 3 and 4: swap, then start, then wait for health ----------------------------------------


def test_the_swap_happens_between_the_stop_and_the_start(world: World) -> None:
    world.install(manifest_document("monty", "1.0.0"))
    new = manifest_document("monty", "2.0.0")
    world.offers(new)

    applied = world.apply(target_set(moving(new)))

    assert applied.applied
    assert world.host.versions_seen("stop", "monty") == [{"monty": "1.0.0"}]
    assert world.host.versions_seen("start", "monty") == [{"monty": "2.0.0"}]


def test_the_environment_the_swap_replaced_is_kept_as_previous(world: World) -> None:
    world.install(manifest_document("monty", "1.0.0"))
    new = manifest_document("monty", "2.0.0")
    world.offers(new)

    world.apply(target_set(moving(new)))

    assert world.live_version("monty") == "2.0.0"
    assert world.previous_version("monty") == "1.0.0"


def test_a_plugin_with_no_stability_profile_is_confirmed_by_liveness_alone(world: World) -> None:
    world.install(manifest_document("monty", "1.0.0"))
    new = manifest_document("monty", "2.0.0")
    world.offers(new)
    # It publishes no beat — and it never promised one, so it is never asked for one.
    world.host.silent.add("monty")

    applied = world.apply(target_set(moving(new)))

    assert applied.applied
    assert world.clock.slept == []


def test_a_plugin_with_no_stability_profile_that_dies_at_once_is_not_confirmed(
    world: World,
) -> None:
    world.install(manifest_document("monty", "1.0.0"))
    new = manifest_document("monty", "2.0.0")
    world.offers(new)
    world.host.dies.add("monty")

    applied = world.apply(target_set(moving(new)))

    assert not applied.applied
    assert applied.rolled_back == ("monty",)


def test_a_plugin_that_promised_heartbeats_is_not_confirmed_by_liveness(world: World) -> None:
    promise = {"heartbeat_interval": 5}
    world.install(manifest_document("monty", "1.0.0", stability=promise))
    new = manifest_document("monty", "2.0.0", stability=promise)
    world.offers(new)
    world.host.silent.add("monty")

    applied = world.apply(target_set(moving(new)))

    assert not applied.applied
    assert applied.rolled_back == ("monty",)
    assert "did not become healthy" in str(applied.reason)
    assert world.live_version("monty") == "1.0.0"


def test_a_plugin_that_promised_heartbeats_is_confirmed_when_one_arrives(world: World) -> None:
    promise = {"heartbeat_interval": 5}
    world.install(manifest_document("monty", "1.0.0", stability=promise))
    new = manifest_document("monty", "2.0.0", stability=promise)
    world.offers(new)

    applied = world.apply(target_set(moving(new)))

    assert applied.applied
    assert world.live_version("monty") == "2.0.0"


def test_a_beat_from_the_process_that_was_just_stopped_confirms_nothing(world: World) -> None:
    promise = {"heartbeat_interval": 5}
    world.install(manifest_document("monty", "1.0.0", stability=promise))
    new = manifest_document("monty", "2.0.0", stability=promise)
    world.offers(new)
    world.host.silent.add("monty")

    # The old process beat happily, right up to the moment it was stopped.
    old = world.host.running["monty"]
    world.beats.record(
        Heartbeat(
            id="monty",
            kind=ChildKind.ADDON,
            pid=old.pid,
            started_at=old.started_at,
            version="1.0.0",
            state=ProcessState.READY,
            progress_at=old.started_at,
        )
    )

    applied = world.apply(target_set(moving(new)))

    assert applied.rolled_back == ("monty",)


def test_the_wait_for_health_gives_up_at_the_window_the_config_names(world: World) -> None:
    promise = {"heartbeat_interval": 5}
    world.install(manifest_document("monty", "1.0.0", stability=promise))
    new = manifest_document("monty", "2.0.0", stability=promise)
    world.offers(new)
    world.host.silent.add("monty")

    applied = world.apply(target_set(moving(new)))

    assert not applied.applied
    # One poll per second of the window, and not one second past it.
    assert sum(world.clock.slept) == pytest.approx(HelperConfig().helper.update_health_window)


# --- step 5: the whole group rolls back, and the versions are blocked -----------------------------


def _pair(world: World) -> tuple[dict[str, Any], dict[str, Any]]:
    """Two plugins that move together, because one requires the other at an exact version."""
    world.install(manifest_document("base", "1.0.0"))
    world.install(manifest_document("rider", "1.0.0", requires=["base==1.0.0"]))

    new_base = manifest_document("base", "2.0.0")
    new_rider = manifest_document("rider", "2.0.0", requires=["base==2.0.0"])
    world.offers(new_base)
    world.offers(new_rider)
    return new_base, new_rider


def test_one_plugin_failing_health_rolls_back_the_whole_group(world: World) -> None:
    new_base, new_rider = _pair(world)
    # `base` comes up perfectly; only `rider` fails to stay alive.
    world.host.dies.add("rider")

    applied = world.apply(target_set(moving(new_base), moving(new_rider)))

    assert not applied.applied
    assert sorted(applied.rolled_back) == ["base", "rider"]
    assert world.live_version("base") == "1.0.0"
    assert world.live_version("rider") == "1.0.0"


def test_a_rolled_back_group_is_stopped_and_started_again_on_the_old_versions(
    world: World,
) -> None:
    new_base, new_rider = _pair(world)
    world.host.dies.add("rider")

    world.apply(target_set(moving(new_base), moving(new_rider)))

    assert world.host.commands("stop") == ["rider", "base", "rider", "base"]
    assert world.host.commands("start") == ["base", "rider", "base", "rider"]
    # First stopped on the old version, then on the new one; started on the new one, then on
    # the old one it was put back to.
    assert world.host.versions_seen("stop", "base") == [
        {"base": "1.0.0", "rider": "1.0.0"},
        {"base": "2.0.0", "rider": "2.0.0"},
    ]
    assert world.host.versions_seen("start", "base") == [
        {"base": "2.0.0", "rider": "2.0.0"},
        {"base": "1.0.0", "rider": "1.0.0"},
    ]


def test_every_version_the_group_was_moving_to_is_blocked_not_only_the_one_that_failed(
    world: World,
) -> None:
    new_base, new_rider = _pair(world)
    world.host.dies.add("rider")

    applied = world.apply(target_set(moving(new_base), moving(new_rider)))

    assert [str(entry) for entry in applied.blocked] == ["base 2.0.0", "rider 2.0.0"]
    assert world.blocked.blocked_for("base") == ("2.0.0",)
    assert world.blocked.blocked_for("rider") == ("2.0.0",)


def test_a_blocked_version_is_never_offered_again(world: World) -> None:
    new_base, new_rider = _pair(world)
    world.host.dies.add("rider")
    world.apply(target_set(moving(new_base), moving(new_rider)))

    builds_before = len(world.installer.requirements)
    stops_before = len(world.host.commands("stop"))

    # The very same set, proposed again the next time the helper checks.
    second = world.apply(target_set(moving(new_base), moving(new_rider)))

    assert not second.applied
    assert "blocked" in str(second.reason)
    # Nothing was built and nothing was stopped: a blocked set costs one rollback, not one
    # rollback per check.
    assert len(world.installer.requirements) == builds_before
    assert len(world.host.commands("stop")) == stops_before


def test_blocking_one_version_does_not_block_the_next_one(world: World) -> None:
    new_base, new_rider = _pair(world)
    world.host.dies.add("rider")
    world.apply(target_set(moving(new_base), moving(new_rider)))
    world.host.dies.clear()

    newer_base = manifest_document("base", "3.0.0")
    newer_rider = manifest_document("rider", "3.0.0", requires=["base==3.0.0"])
    world.offers(newer_base)
    world.offers(newer_rider)

    applied = world.apply(target_set(moving(newer_base), moving(newer_rider)))

    assert applied.applied
    assert world.live_version("base") == "3.0.0"
    assert world.live_version("rider") == "3.0.0"


def test_a_swap_that_cannot_be_made_puts_the_whole_group_back(world: World) -> None:
    new_base, new_rider = _pair(world)

    def sabotage(command: Command) -> None:
        """Take the staged manifest away between the last stop and the first swap."""
        if command.name is not CommandName.STOP or command.child_id != "base":
            return
        staged = recorded_manifest_path(world.staging_root, "rider")
        if staged.is_file():
            staged.unlink()

    world.host.before_each = sabotage

    applied = world.apply(target_set(moving(new_base), moving(new_rider)))

    assert not applied.applied
    assert "the swap failed" in str(applied.reason)
    assert world.live_version("base") == "1.0.0"
    assert world.live_version("rider") == "1.0.0"
    assert [str(entry) for entry in applied.blocked] == ["base 2.0.0", "rider 2.0.0"]


def test_a_host_that_will_not_stop_the_group_blocks_no_version(world: World) -> None:
    world.install(manifest_document("monty", "1.0.0"))
    new = manifest_document("monty", "2.0.0")
    world.offers(new)

    def refuse(command: Command) -> None:
        raise ChildError("the host is not answering")

    world.host.before_each = refuse

    applied = world.apply(target_set(moving(new)))

    assert not applied.applied
    assert "would not stop the group" in str(applied.reason)
    assert applied.blocked == ()
    # It could not be started again either, and that is said rather than swallowed.
    assert applied.still_down == ("monty",)
    assert world.live_version("monty") == "1.0.0"


def test_a_group_that_cannot_be_started_on_its_new_versions_is_rolled_back(
    world: World,
) -> None:
    world.install(manifest_document("monty", "1.0.0"))
    new = manifest_document("monty", "2.0.0")
    world.offers(new)

    def refuse_starts(command: Command) -> None:
        if command.name is CommandName.START:
            raise ChildError("the host will not start it")

    world.host.before_each = refuse_starts

    applied = world.apply(target_set(moving(new)))

    assert not applied.applied
    assert "could not be started on its new versions" in str(applied.reason)
    assert applied.rolled_back == ("monty",)
    assert applied.still_down == ("monty",)
    assert world.live_version("monty") == "1.0.0"


def test_a_host_that_stops_answering_during_a_rollback_is_reported_not_raised(
    world: World,
) -> None:
    new_base, new_rider = _pair(world)
    world.host.dies.add("rider")

    def refuse_once_the_group_is_up(command: Command) -> None:
        # Everything up to the failed health check works; then the host goes quiet.
        if len(world.host.journal) >= 4:
            raise ChildError("the host stopped answering")

    world.host.before_each = refuse_once_the_group_is_up

    applied = world.apply(target_set(moving(new_base), moving(new_rider)))

    assert not applied.applied
    assert sorted(applied.rolled_back) == ["base", "rider"]
    assert sorted(applied.still_down) == ["base", "rider"]
    assert world.live_version("base") == "1.0.0"


def test_a_plugin_whose_environment_vanished_is_not_rolled_back_to_nothing(
    world: World,
) -> None:
    new_base, new_rider = _pair(world)
    world.host.dies.add("base")

    deleted = False

    def delete_riders_environment(command: Command) -> None:
        """Something outside the helper removes the live environment, once, mid-update."""
        nonlocal deleted
        if deleted or command.name is not CommandName.STOP or command.child_id != "base":
            return
        deleted = True
        shutil.rmtree(addon_root(world.live_root, "rider"))

    world.host.before_each = delete_riders_environment

    applied = world.apply(target_set(moving(new_base), moving(new_rider)))

    assert not applied.applied
    # `base` had an environment to go back to; `rider` had none, and putting it back to
    # nothing would have left it with no environment at all.
    assert applied.rolled_back == ("base",)
    assert world.live_version("base") == "1.0.0"
    assert world.live_version("rider") == "2.0.0"


def test_a_set_whose_plugins_depend_on_each_other_in_a_loop_stops_nothing(
    world: World,
) -> None:
    world.install(manifest_document("left", "1.0.0", subscribes=["right.started.v1"]))
    world.install(manifest_document("right", "1.0.0", subscribes=["left.started.v1"]))
    new_left = manifest_document("left", "2.0.0", subscribes=["right.started.v1"])
    world.offers(new_left)

    applied = world.apply(
        target_set(
            moving(new_left),
            staying(manifest_document("right", "1.0.0", subscribes=["left.started.v1"])),
        )
    )

    assert not applied.applied
    assert "no start order" in str(applied.reason)
    assert world.host.commands("stop") == []


def test_a_start_the_host_answers_with_no_record_is_not_a_healthy_plugin(
    world: World,
) -> None:
    world.install(manifest_document("monty", "1.0.0"))
    new = manifest_document("monty", "2.0.0")
    world.offers(new)
    host = world.host

    class Quiet:
        """A host that starts the child but answers the command with nothing."""

        def send(self, command: Command) -> CommandResult:
            result = host.send(command)
            if command.name is CommandName.START:
                return CommandResult(name=command.name)
            return result

    object.__setattr__(world.applier, "channel", Quiet())

    applied = world.apply(target_set(moving(new)))

    assert not applied.applied
    assert applied.rolled_back == ("monty",)


# --- the lock and the requirement a git source is installed from ----------------------------------


def test_a_lock_may_be_checked_against_a_git_direct_reference() -> None:
    commit = "a" * 40
    lock = parse_lock(f"{pin('innytypes', __version__)}\nmonty @ git+{REPOSITORY}@{commit}\n")

    lock.must_contain([f"monty @ git+{REPOSITORY}@{commit}"])

    with pytest.raises(LockError, match="but " + "b" * 40):
        lock.must_contain([f"monty @ git+{REPOSITORY}@{'b' * 40}"])


def test_a_staged_environment_is_installed_from_the_text_the_candidate_names(
    world: World,
) -> None:
    commit = "c" * 40
    document = manifest_document("monty", "2.0.0")
    world.offers(document)

    staged = stage_environment(
        Requirement(addon_id="monty", version="2.0.0"),
        installer=world.installer,
        staging_root=world.staging_root,
        requirement_text=f"monty @ git+{REPOSITORY}@{commit}",
    )

    assert staged.manifest.version == "2.0.0"
    # The commit, never the tag and never a version an index would have served instead.
    assert world.installer.requirements == [
        (f"monty @ git+{REPOSITORY}@{commit}", f"innytypes=={__version__}")
    ]


# --- the set is judged again, here, before anything is built --------------------------------------


def test_a_group_in_which_every_plugin_is_auto_is_applied(world: World) -> None:
    new_base, new_rider = _pair(world)

    applied = world.apply(
        target_set(moving(new_base), moving(new_rider)),
        config=config_with(base="auto", rider="auto"),
    )

    assert applied.applied
    assert world.live_version("base") == "2.0.0"
    assert world.live_version("rider") == "2.0.0"


def test_a_group_in_which_one_plugin_is_manual_is_not_applied_at_all(world: World) -> None:
    new_base, new_rider = _pair(world)

    applied = world.apply(
        target_set(moving(new_base), moving(new_rider)),
        config=config_with(base="auto", rider="manual"),
    )

    assert not applied.applied
    assert "rule 4" in str(applied.reason)
    assert world.installer.requirements == []
    assert world.host.commands("stop") == []
    assert world.live_version("base") == "1.0.0"


def test_a_group_in_which_one_plugin_is_pinned_is_not_applied_at_all(world: World) -> None:
    new_base, new_rider = _pair(world)

    applied = world.apply(
        target_set(moving(new_base), moving(new_rider)),
        config=config_with(base="auto", rider="pinned"),
    )

    assert not applied.applied
    assert "rule 4" in str(applied.reason)
    assert world.host.commands("stop") == []


def test_a_manual_group_the_user_named_is_applied(world: World) -> None:
    new_base, new_rider = _pair(world)

    applied = world.apply(
        target_set(moving(new_base), moving(new_rider)),
        config=config_with(base="manual", rider="manual"),
        requested=("base", "rider"),
    )

    assert applied.applied
    assert world.live_version("base") == "2.0.0"


def test_naming_a_pinned_plugin_does_not_get_past_the_pin(world: World) -> None:
    world.install(manifest_document("solo", "1.0.0"))
    newer = manifest_document("solo", "2.0.0")
    world.offers(newer)

    applied = world.apply(
        target_set(moving(newer)),
        config=config_with(solo="pinned"),
        requested=("solo",),
    )

    assert not applied.applied
    assert "pinned" in str(applied.reason)
    assert world.live_version("solo") == "1.0.0"


def test_a_set_that_breaks_a_requirement_is_refused_before_anything_is_built(
    world: World,
) -> None:
    _new_base, _new_rider = _pair(world)
    # `base` moves and `rider` does not, so rider's exact requirement names a version that is
    # no longer in the set: rule 2, caught here rather than at the swap.
    applied = world.apply(
        target_set(
            moving(manifest_document("base", "2.0.0")),
            staying(manifest_document("rider", "1.0.0", requires=["base==1.0.0"])),
        )
    )

    assert not applied.applied
    assert "rule 2" in str(applied.reason)
    assert world.installer.requirements == []


def test_a_set_that_would_change_nothing_is_reported_rather_than_applied(world: World) -> None:
    world.install(manifest_document("monty", "1.0.0"))

    applied = world.apply(target_set(staying(manifest_document("monty", "1.0.0"))))

    assert not applied.applied
    assert "nothing to apply" in str(applied.reason)
    assert world.installer.requirements == []


# --- the record of blocked versions ---------------------------------------------------------------


def test_the_blocked_record_keeps_every_version_it_was_given(tmp_path: Path) -> None:
    blocked = BlockedVersions(path=tmp_path / "blocked.json")

    blocked.block("monty", "2.0.0")
    blocked.block("monty", "2.1.0")
    blocked.block("whodunnit", "3.0.0")

    assert blocked.blocked_for("monty") == ("2.0.0", "2.1.0")
    assert blocked.blocked_for("whodunnit") == ("3.0.0",)
    assert blocked.is_blocked("monty", "2.0.0")
    assert not blocked.is_blocked("monty", "1.0.0")


def test_blocking_the_same_version_twice_records_it_once(tmp_path: Path) -> None:
    blocked = BlockedVersions(path=tmp_path / "blocked.json")

    blocked.block("monty", "2.0.0")
    blocked.block("monty", "2.0.0")

    assert blocked.blocked_for("monty") == ("2.0.0",)


def test_a_record_that_cannot_be_read_refuses_rather_than_reading_as_empty(
    tmp_path: Path,
) -> None:
    path = tmp_path / "blocked.json"
    path.write_text("{ not json", encoding="utf-8")

    with pytest.raises(UpdateApplyError, match="could not be read"):
        BlockedVersions(path=path).blocked_for("monty")


def test_a_record_that_is_not_an_object_of_versions_refuses(tmp_path: Path) -> None:
    path = tmp_path / "blocked.json"
    path.write_text('["monty"]', encoding="utf-8")

    with pytest.raises(UpdateApplyError, match="not a JSON object"):
        BlockedVersions(path=path).blocked_for("monty")


def test_the_blocked_record_lives_under_this_users_data_directory() -> None:
    assert default_blocked_versions_path().name == "blocked-plugin-versions.json"
    assert default_blocked_versions_path().parent.name == "innytypes"


# --- `innytypes addons update`, and the pin that outranks it --------------------------------------


@dataclass
class _CheckerFromOffers:
    """A checker that offers whatever the injected installer was told it could build.

    It asks no index and runs no `git`: what a source publishes is already in this file, and
    what is under test here is the command, not the checking. It honours ``requested`` the
    way the real checker does — an addon nobody asked for does not move — and it reports a
    line per addon, because that is what the command prints when nothing may move.
    """

    world: World
    # Addons a rule holds back: a newer version exists and the set will not take it.
    held_back: set[str] = field(default_factory=set)

    def check(
        self, installed: Sequence[InstalledAddon], *, requested: Sequence[str] = ()
    ) -> VersionCheck:
        asked = set(requested)
        plugins: list[TargetPlugin] = []
        reports: list[PluginReport] = []

        for addon in installed:
            offered = self.world.installer.documents.get(addon.id)
            newest = None if offered is None else str(offered["version"])
            unchanged = (
                offered is None
                or addon.id not in asked
                or addon.id in self.held_back
                or newest == addon.manifest.version
            )

            if unchanged:
                plugins.append(TargetPlugin(id=addon.id, manifest=addon.manifest, candidate=None))
                reports.append(
                    PluginReport(
                        id=addon.id,
                        installed_version=addon.manifest.version,
                        state=(
                            PluginState.BLOCKED
                            if addon.id in self.held_back
                            else PluginState.UP_TO_DATE
                        ),
                        target_version=addon.manifest.version,
                        newest_version=newest,
                        rule=(ConsistencyRule.MODE_OR_PIN if addon.id in self.held_back else None),
                        reason=(
                            f"{addon.id} moves only with something that will not move"
                            if addon.id in self.held_back
                            else None
                        ),
                    )
                )
            else:
                plugins.append(moving(offered))
                reports.append(
                    PluginReport(
                        id=addon.id,
                        installed_version=addon.manifest.version,
                        state=PluginState.AVAILABLE,
                        target_version=str(newest),
                        newest_version=newest,
                    )
                )

        return VersionCheck(checked=True, target=target_set(*plugins), reports=tuple(reports))


@dataclass
class CliWorld:
    """The command line driven against the same fakes, with a config file of its own."""

    world: World
    runner: CliRunner
    context: CliContext
    config_path: Path

    def invoke(self, *args: str) -> Result:
        return self.runner.invoke(
            cli,
            ["addons", "--config", str(self.config_path), *args],
            obj=self.context,
            catch_exceptions=False,
        )


@pytest.fixture
def cli_world(world: World, tmp_path: Path) -> CliWorld:
    """`addons update` wired to this file's applier, and to a checker that reads no source."""
    config_path = tmp_path / "config.toml"
    config_path.write_text('[plugins]\nupdate_mode = "auto"\n', encoding="utf-8")

    def make_checker(settings: HelperSettings) -> VersionChecker:
        # The command needs something that answers `check`; it is not the real one, and
        # `_CheckerFromOffers` is deliberately not a `VersionChecker` subclass.
        return _CheckerFromOffers(world)  # type: ignore[return-value]

    context = CliContext(
        addons_root=world.live_root,
        make_checker=make_checker,
        make_applier=lambda settings, root: world.applier,
    )
    return CliWorld(world=world, runner=CliRunner(), context=context, config_path=config_path)


def test_update_by_name_applies_that_addons_update(cli_world: CliWorld) -> None:
    cli_world.world.install(manifest_document("monty", "1.0.0"))
    cli_world.world.offers(manifest_document("monty", "2.0.0"))

    result = cli_world.invoke("update", "monty")

    assert result.exit_code == 0, result.output
    assert "monty  -> 2.0.0" in result.output
    assert "Restarted: monty." in result.output
    assert cli_world.world.live_version("monty") == "2.0.0"


def test_update_by_name_leaves_every_other_addon_alone(cli_world: CliWorld) -> None:
    cli_world.world.install(manifest_document("monty", "1.0.0"))
    cli_world.world.install(manifest_document("whodunnit", "1.0.0"))
    cli_world.world.offers(manifest_document("monty", "2.0.0"))
    cli_world.world.offers(manifest_document("whodunnit", "2.0.0"))

    assert cli_world.invoke("update", "monty").exit_code == 0

    assert cli_world.world.live_version("whodunnit") == "1.0.0"
    assert cli_world.world.host.commands("stop") == ["monty"]


def test_update_all_applies_every_addon_that_is_not_pinned(cli_world: CliWorld) -> None:
    cli_world.world.install(manifest_document("monty", "1.0.0"))
    cli_world.world.install(manifest_document("whodunnit", "1.0.0"))
    cli_world.world.offers(manifest_document("monty", "2.0.0"))
    cli_world.world.offers(manifest_document("whodunnit", "2.0.0"))

    result = cli_world.invoke("update", "--all")

    assert result.exit_code == 0, result.output
    assert cli_world.world.live_version("monty") == "2.0.0"
    assert cli_world.world.live_version("whodunnit") == "2.0.0"


def test_a_pinned_addon_is_excluded_from_a_subsequent_update_all(cli_world: CliWorld) -> None:
    cli_world.world.install(manifest_document("monty", "1.0.0"))
    cli_world.world.install(manifest_document("whodunnit", "1.0.0"))
    cli_world.world.offers(manifest_document("monty", "2.0.0"))
    cli_world.world.offers(manifest_document("whodunnit", "2.0.0"))

    assert cli_world.invoke("pin", "monty").exit_code == 0
    result = cli_world.invoke("update", "--all")

    assert result.exit_code == 0, result.output
    assert cli_world.world.live_version("monty") == "1.0.0"
    assert cli_world.world.live_version("whodunnit") == "2.0.0"
    assert cli_world.world.host.commands("stop") == ["whodunnit"]


def test_unpin_lets_the_next_update_all_move_it_again(cli_world: CliWorld) -> None:
    cli_world.world.install(manifest_document("monty", "1.0.0"))
    cli_world.world.offers(manifest_document("monty", "2.0.0"))

    cli_world.invoke("pin", "monty")
    assert cli_world.invoke("update", "--all").exit_code == 0
    assert cli_world.world.live_version("monty") == "1.0.0"

    assert cli_world.invoke("unpin", "monty").exit_code == 0
    assert cli_world.invoke("update", "--all").exit_code == 0
    assert cli_world.world.live_version("monty") == "2.0.0"


def test_updating_a_pinned_addon_by_name_is_refused_by_name(cli_world: CliWorld) -> None:
    cli_world.world.install(manifest_document("monty", "1.0.0"))
    cli_world.world.offers(manifest_document("monty", "2.0.0"))
    cli_world.invoke("pin", "monty")

    result = cli_world.invoke("update", "monty")

    assert result.exit_code != 0
    assert "unpin monty" in result.output
    assert cli_world.world.live_version("monty") == "1.0.0"


def test_update_refuses_to_guess_between_one_addon_and_all_of_them(cli_world: CliWorld) -> None:
    cli_world.world.install(manifest_document("monty", "1.0.0"))

    neither = cli_world.invoke("update")
    both = cli_world.invoke("update", "monty", "--all")

    assert neither.exit_code != 0
    assert both.exit_code != 0
    assert "name one addon or pass --all" in neither.output


def test_update_refuses_an_addon_that_is_not_installed(cli_world: CliWorld) -> None:
    cli_world.world.install(manifest_document("monty", "1.0.0"))

    result = cli_world.invoke("update", "whodunnit")

    assert result.exit_code != 0
    assert "not installed" in result.output


def test_update_says_so_when_there_is_nothing_to_update(cli_world: CliWorld) -> None:
    cli_world.world.install(manifest_document("monty", "1.0.0"))

    result = cli_world.invoke("update", "monty")

    assert result.exit_code == 0
    assert "Nothing to update." in result.output


def test_update_says_so_when_nothing_is_installed(cli_world: CliWorld) -> None:
    result = cli_world.invoke("update", "--all")

    assert result.exit_code == 0
    assert "No addons installed." in result.output


def test_update_reports_a_rollback_and_exits_non_zero(cli_world: CliWorld) -> None:
    cli_world.world.install(manifest_document("monty", "1.0.0"))
    cli_world.world.offers(manifest_document("monty", "2.0.0"))
    cli_world.world.host.dies.add("monty")

    result = cli_world.invoke("update", "monty")

    assert result.exit_code == 1
    assert "rolled back" in result.output
    assert "Rolled back: monty." in result.output
    assert "Blocked: monty 2.0.0." in result.output
    assert cli_world.world.live_version("monty") == "1.0.0"


def test_update_says_what_is_missing_when_there_is_no_way_to_reach_the_host(
    cli_world: CliWorld,
) -> None:
    cli_world.world.install(manifest_document("monty", "1.0.0"))
    cli_world.world.offers(manifest_document("monty", "2.0.0"))
    # The production seam, which answers `None` until the control channel exists.
    context = CliContext(
        addons_root=cli_world.context.addons_root,
        make_checker=cli_world.context.make_checker,
    )

    result = CliRunner().invoke(
        cli,
        ["addons", "--config", str(cli_world.config_path), "update", "monty"],
        obj=context,
        catch_exceptions=False,
    )

    assert result.exit_code != 0
    assert "needs the running application" in result.output
    assert cli_world.world.live_version("monty") == "1.0.0"


def test_update_asks_no_source_when_auto_check_versions_is_off(cli_world: CliWorld) -> None:
    cli_world.world.install(manifest_document("monty", "1.0.0"))
    cli_world.world.offers(manifest_document("monty", "2.0.0"))
    cli_world.config_path.write_text("auto_check_versions = false\n", encoding="utf-8")

    def make_checker(settings: HelperSettings) -> VersionChecker:
        # The real checker this time: with the switch off it asks nothing at all, which is
        # the fact under test, and it needs no transport to prove it.
        return VersionChecker(settings=settings, resolve_lock=cli_world.world.locks)

    object.__setattr__(cli_world.context, "make_checker", make_checker)
    result = cli_world.invoke("update", "monty")

    assert result.exit_code == 0
    assert "auto_check_versions is off" in result.output
    assert cli_world.world.live_version("monty") == "1.0.0"


def test_update_prints_the_rule_that_holds_an_addon_back(cli_world: CliWorld) -> None:
    cli_world.world.install(manifest_document("monty", "1.0.0"))
    cli_world.world.offers(manifest_document("monty", "2.0.0"))
    checker = _CheckerFromOffers(cli_world.world, held_back={"monty"})
    object.__setattr__(cli_world.context, "make_checker", lambda settings: checker)

    result = cli_world.invoke("update", "monty")

    assert result.exit_code == 0
    assert "held at this version" in result.output
    assert "blocked by rule 4" in result.output
    assert "Nothing to update." in result.output
    assert cli_world.world.live_version("monty") == "1.0.0"


def test_update_prints_the_refusal_when_the_record_of_blocked_versions_is_unreadable(
    cli_world: CliWorld,
) -> None:
    cli_world.world.install(manifest_document("monty", "1.0.0"))
    cli_world.world.offers(manifest_document("monty", "2.0.0"))
    cli_world.world.blocked.path.write_text("{ not json", encoding="utf-8")

    result = cli_world.invoke("update", "monty")

    assert result.exit_code != 0
    assert "could not be read" in result.output
    assert cli_world.world.live_version("monty") == "1.0.0"


def test_update_of_an_addon_that_was_not_running_restarts_nothing(cli_world: CliWorld) -> None:
    cli_world.world.install(manifest_document("monty", "1.0.0"), running=False)
    cli_world.world.offers(manifest_document("monty", "2.0.0"))

    result = cli_world.invoke("update", "monty")

    assert result.exit_code == 0, result.output
    assert "Restarted: -" in result.output
    assert cli_world.world.live_version("monty") == "2.0.0"


def test_update_says_which_addon_the_rollback_could_not_start_again(
    cli_world: CliWorld,
) -> None:
    cli_world.world.install(manifest_document("monty", "1.0.0"))
    cli_world.world.offers(manifest_document("monty", "2.0.0"))

    def refuse_starts(command: Command) -> None:
        if command.name is CommandName.START:
            raise ChildError("the host will not start it")

    cli_world.world.host.before_each = refuse_starts

    result = cli_world.invoke("update", "monty")

    assert result.exit_code == 1
    assert "Still not running: monty." in result.output
    assert cli_world.world.live_version("monty") == "1.0.0"


def test_update_reports_a_host_that_would_not_stop_the_group_and_blocks_nothing(
    cli_world: CliWorld,
) -> None:
    cli_world.world.install(manifest_document("monty", "1.0.0"))
    cli_world.world.offers(manifest_document("monty", "2.0.0"))

    def refuse(command: Command) -> None:
        raise ChildError("the host is not answering")

    cli_world.world.host.before_each = refuse

    result = cli_world.invoke("update", "monty")

    assert result.exit_code == 1
    assert "would not stop the group" in result.output
    # Nothing was installed, so nothing is taken away from a later attempt.
    assert "Rolled back" not in result.output
    assert "Blocked" not in result.output
    assert "Still not running: monty." in result.output
