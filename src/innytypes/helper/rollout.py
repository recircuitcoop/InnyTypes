"""Applying a plugin update: build elsewhere, stop only what is affected, swap, or put it all back.

:mod:`innytypes.helper.versions` decides *what* may move and judges the target plugin set
against the five consistency rules. This module takes a set that already passed and carries
out plan 0003's five numbered steps (*Applying a plugin update*), in that order and no other:

1. **Build** every changed plugin's new environment under the staging root, locked with
   hashes, while everything that is running keeps running. A build that fails here fails an
   update that has touched nothing.
2. **Stop only what is affected** — the plugins that change and everything that starts after
   them — in reverse start order, through the host's control channel. The host, the MCP
   server, Anytype and every unaffected plugin are never named in a command.
3. **Swap** each changed environment, one rename in and one rename out, keeping `previous`.
4. **Start** the affected plugins again in start order and wait for each to become healthy.
5. **Confirm or roll back.** One plugin that does not become healthy rolls back the **whole
   group**, blocks the versions it rolled back from, and reports it.

**"Healthy" is whatever the plugin promised.** A plugin whose manifest carries a `stability`
section with a `heartbeat_interval` promised to beat, so it is healthy when a beat arrives
from the **new process** saying `ready`. A plugin that promised nothing is healthy when it is
alive — the host still lists it, at the process ID the start returned. That is the same rule
:mod:`innytypes.helper.detection` watches under: a process is only ever held to what it said
it would do. The new process ID is load-bearing in both halves; a beat left over from the
process that was just stopped would otherwise confirm the update that replaced it.

**"Affected" is whatever starts after a changed plugin**, read from the one definition of it
this project has: :func:`~innytypes.addons.resolution.dependency_edges`, the same edges the
start order is built from. That is what a plugin *requires*, and what subscribes to the kinds
it publishes — a subscriber is started after its publisher for a reason, and the reason does
not stop applying when the publisher is replaced mid-session. Everything else keeps running,
which is the whole of D19: a plugin update is not a restart of the application.

**The group rolls back whole, not the plugin that failed.** Because `requires` are exact
versions, the set moved together; putting one member back would leave the others running
against a version they were never judged with. So the rollback stops the group again, rolls
each swapped environment back to its `previous`, **blocks** every version the group was
moving to, and starts the group again. The blocked versions are read before anything is built
on the next attempt, so a bad release costs one rollback rather than one per check.

**This module spawns nothing and signals nothing.** Every stop and every start is a
:class:`~innytypes.children.Command` on the injected
:class:`~innytypes.helper.restart.ControlChannel`, because the host is the only thing that
owns a child process (plan 0001, invariant 9). The installer, the channel, the heartbeats,
the clock and the three roots are all injected, which is how the gate proves the whole of it
with no `uv`, no process, no socket and no sleeping.

**The stop and the start are two commands, not `restart-group`.** The swap goes between them,
and a command that stops and starts in one step leaves nowhere to put it. `restart-group`
stays the right command for restarting a group whose environments do **not** change.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol, cast

from platformdirs import user_data_path

from innytypes.addons.discovery import APPLICATION_NAME
from innytypes.addons.install import AddonInstaller
from innytypes.addons.lock import recorded_lock_path
from innytypes.addons.manifest import AddonManifest, Requirement
from innytypes.addons.resolution import ResolutionError, dependency_edges, resolve_start_order
from innytypes.children import ChildRecord, Command, CommandName
from innytypes.helper.config import HelperConfig
from innytypes.helper.environments import (
    SwapError,
    SwappedEnvironment,
    roll_back,
    stage_environment,
    swap_in,
)
from innytypes.helper.heartbeat import ProcessState, ReceivedHeartbeat
from innytypes.helper.restart import ControlChannel
from innytypes.helper.versions import (
    Candidate,
    LockResolver,
    TargetPlugin,
    TargetSet,
    evaluate_target_set,
)

__all__ = [
    "BLOCKED_VERSIONS_FILENAME",
    "AppliedUpdate",
    "BlockedVersion",
    "BlockedVersions",
    "LatestBeats",
    "UpdateApplier",
    "UpdateApplyError",
    "default_blocked_versions_path",
]

# Beside the addons, the staging root and the previous root, under the per-user data
# directory: it is a fact about what is installed on this machine, and it outlives every
# process that reads it.
BLOCKED_VERSIONS_FILENAME = "blocked-plugin-versions.json"

# How often the wait for health looks again. Small enough that a plugin that comes up fast is
# not made to wait, large enough that the loop is not the busiest thing on the machine — and
# injected on the applier anyway, so a test never spends a second of it.
DEFAULT_POLL_INTERVAL = 0.5


class UpdateApplyError(RuntimeError):
    """Raised when an update cannot even be attempted, naming what stopped it.

    Deliberately narrow. Anything that goes wrong *while* the group is stopped comes back as
    an :class:`AppliedUpdate` describing the rollback, because there is always something to
    tell the user at that point. This exception is for the refusals that happen before the
    first plugin is stopped — an unreadable record of blocked versions, a set with no start
    order — where nothing has been touched and there is nothing to undo.
    """


def default_blocked_versions_path() -> Path:
    """Where the versions a rollback took away are recorded, for this user."""
    return user_data_path(APPLICATION_NAME, appauthor=False) / BLOCKED_VERSIONS_FILENAME


@dataclass(frozen=True)
class BlockedVersion:
    """One plugin version a rollback took away, and which will not be installed again."""

    plugin_id: str
    version: str

    def __str__(self) -> str:
        return f"{self.plugin_id} {self.version}"


@dataclass(frozen=True)
class BlockedVersions:
    """The versions a rollback took away, written down so nothing offers them again.

    A JSON object of ``{plugin id: [version, …]}``, read before anything is built and written
    when a group rolls back. Kept as a file rather than in memory because the helper restarts
    and the bad release does not go away when it does: a version that failed to come up
    healthy would otherwise be installed again on the next check, fail again, and cost the
    user another rollback every time.

    An unreadable file is **refused**, not treated as empty. Silently reading no blocks out of
    a file that is supposed to hold them would install the exact version this file exists to
    keep out, so the update stops and says which file to fix.
    """

    path: Path

    def blocked_for(self, plugin_id: str) -> tuple[str, ...]:
        """Every version of one plugin that is blocked, in the order they were blocked."""
        return tuple(self._read().get(plugin_id, ()))

    def is_blocked(self, plugin_id: str, version: str) -> bool:
        """Whether this exact version of this plugin was taken away by a rollback."""
        return version in self.blocked_for(plugin_id)

    def block(self, plugin_id: str, version: str) -> None:
        """Record one version as blocked, leaving every other record alone."""
        record = self._read()
        versions = list(record.get(plugin_id, []))
        if version not in versions:
            versions.append(version)
        record[plugin_id] = versions

        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    def _read(self) -> dict[str, list[str]]:
        """The record as it stands, or an empty one when the file has never been written."""
        if not self.path.is_file():
            return {}

        try:
            document = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise UpdateApplyError(
                f"{self.path} could not be read: {error}. It records the plugin versions a "
                "rollback took away, and an update that cannot read it would install one of "
                "them again; fix or delete the file."
            ) from error

        if not isinstance(document, Mapping):
            raise UpdateApplyError(
                f"{self.path} is not a JSON object of plugin ids to blocked versions; fix or "
                "delete the file."
            )

        return {
            str(plugin_id): [str(version) for version in versions]
            for plugin_id, versions in document.items()
            if isinstance(versions, list)
        }


class LatestBeats(Protocol):
    """The one question this module asks of the heartbeats the helper has collected.

    :class:`~innytypes.helper.heartbeat.HeartbeatRegistry` already answers it, and a test can
    answer it with a dictionary, so waiting for a plugin to become healthy needs no socket.
    """

    def latest(self, process_id: str) -> ReceivedHeartbeat | None:
        """The last beat from ``process_id``, or ``None`` when it has never sent one."""
        ...


@dataclass(frozen=True)
class AppliedUpdate:
    """What one apply did: what moved, what was stopped and started, and what came undone.

    Always returned, never raised past the point where something was stopped: by then there
    is something the user has to be told, and an exception is not a report.

    ``reason`` is filled whenever the update did not hold — the set was refused before
    anything was built, or the group rolled back — and is the sentence a person reads.
    """

    changed: tuple[str, ...] = ()
    versions: Mapping[str, str] = field(default_factory=dict)
    group: tuple[str, ...] = ()
    stopped: tuple[str, ...] = ()
    started: tuple[str, ...] = ()
    rolled_back: tuple[str, ...] = ()
    blocked: tuple[BlockedVersion, ...] = ()
    still_down: tuple[str, ...] = ()
    reason: str | None = None

    @property
    def applied(self) -> bool:
        """Whether the plugins are now running the versions this update was asked to install."""
        return bool(self.changed) and not self.rolled_back and self.reason is None


@dataclass(frozen=True)
class UpdateApplier:
    """Carries out one update group, or puts the whole group back the way it was.

    Everything that reaches outside the process is a field. ``channel`` is the only way a
    process is stopped or started, ``installer`` the only way an environment is built,
    ``beats`` the only way health is learned, and ``now``/``sleep`` the only clock — so the
    gate drives the whole sequence in process, in no time at all.
    """

    installer: AddonInstaller
    channel: ControlChannel
    resolve_lock: LockResolver
    blocked: BlockedVersions
    beats: LatestBeats
    live_root: Path
    staging_root: Path
    previous_root: Path
    poll_interval: float = DEFAULT_POLL_INTERVAL
    now: Callable[[], float] = time.monotonic
    sleep: Callable[[float], None] = time.sleep

    def apply(
        self,
        target: TargetSet,
        *,
        installed: Mapping[str, AddonManifest],
        config: HelperConfig,
        requested: Iterable[str] = (),
    ) -> AppliedUpdate:
        """Apply one judged target set, following plan 0003's five steps.

        ``requested`` names the plugins the user asked for by hand; it is passed to the
        re-judgement below for the same reason `outdated` takes it — a `manual` plugin the
        user named is being updated by the user, which is what `manual` means.
        """
        changed = target.changed
        if not changed:
            return AppliedUpdate(
                reason="no plugin in this set would change, so there is nothing to apply"
            )

        refusal = self._refuse_blocked(changed) or self._refuse_violations(
            target, installed=installed, config=config, requested=requested
        )
        if refusal is not None:
            return AppliedUpdate(reason=refusal)

        # Step 1. Nothing running has been touched yet, and nothing will be until every new
        # environment exists and records both the manifest and the lock it was built from.
        try:
            self._build(changed)
            group = self._affected(changed, target=target)
        except UpdateApplyError as error:
            return AppliedUpdate(reason=str(error))

        return self._swap_and_start(changed, group=group, target=target, config=config)

    # --- before anything is built --------------------------------------------------------

    def _refuse_blocked(self, changed: Sequence[TargetPlugin]) -> str | None:
        """Refuse a set containing a version a rollback already took away.

        Asked first, before the environments are built, so a blocked version costs nothing
        at all rather than a staged environment nobody will swap in.
        """
        stopped_by = [
            f"{plugin.id} {plugin.version}"
            for plugin in changed
            if self.blocked.is_blocked(plugin.id, plugin.version)
        ]
        if not stopped_by:
            return None

        return (
            f"{', '.join(stopped_by)} was rolled back before and is blocked; nothing in this "
            "set is applied, because the set moves as a whole"
        )

    def _refuse_violations(
        self,
        target: TargetSet,
        *,
        installed: Mapping[str, AddonManifest],
        config: HelperConfig,
        requested: Iterable[str],
    ) -> str | None:
        """Judge the set against all five rules again, here, where it is about to be installed.

        A set is judged wherever it arrives from (plan 0003, *Consistency*). Re-asking is
        what makes rule 4 true of this module as well: a group in which one plugin is
        `manual`, `off` or pinned is not applied automatically, however it was assembled.
        """
        violations = evaluate_target_set(
            target,
            installed=installed,
            config=config,
            resolve_lock=self.resolve_lock,
            requested=requested,
        )
        if not violations:
            return None

        first = violations[0]
        return (
            f"the set was judged again before anything was built and breaks rule "
            f"{first.rule.number}: {first.reason}"
        )

    def _build(self, changed: Sequence[TargetPlugin]) -> None:
        """Build every changed plugin's environment in staging, and insist each one is ready.

        Ready means what a swap means by it: the manifest discovery reads and the lock the
        environment was installed from, recorded side by side. Checked here rather than only
        at the swap, because here the plugins are still running and a refusal costs nothing.
        """
        for plugin in changed:
            candidate = cast(Candidate, plugin.candidate)

            try:
                stage_environment(
                    Requirement(addon_id=plugin.id, version=plugin.version),
                    installer=self.installer,
                    staging_root=self.staging_root,
                    requirement_text=candidate.requirement_text(),
                )
            except Exception as error:  # noqa: BLE001 - every failure is one refusal
                raise UpdateApplyError(
                    f"{plugin.id} {plugin.version} could not be built in staging: {error}. "
                    "Nothing was stopped and nothing was swapped."
                ) from error

            lock = recorded_lock_path(self.staging_root, plugin.id)
            if not lock.is_file():
                raise UpdateApplyError(
                    f"the environment staged for {plugin.id} {plugin.version} records no lock "
                    f"at {lock}, so it is not ready to be swapped in. Nothing was stopped."
                )

    def _affected(self, changed: Sequence[TargetPlugin], *, target: TargetSet) -> tuple[str, ...]:
        """The plugins this update stops, in **start** order: the changed ones and their users.

        Only what the host is currently running. A plugin that is installed but not started —
        held back by the resolver, or never started at all — has nothing to stop and nothing
        to confirm; its environment is still swapped, and the next start uses it.
        """
        manifests = {plugin.id: plugin.manifest for plugin in target.plugins}
        edges = dependency_edges(manifests)
        affected = {plugin.id for plugin in changed}

        # To a fixed point, because whatever starts after an affected plugin is itself
        # affected, and so is whatever starts after *it*.
        while True:
            grown = {
                plugin_id for plugin_id, before in edges.items() if affected.intersection(before)
            }
            if grown <= affected:
                break
            affected |= grown

        try:
            order = resolve_start_order(tuple(manifests.values())).order
        except ResolutionError as error:
            raise UpdateApplyError(
                f"the plugins in this set have no start order: {error}. Nothing was stopped."
            ) from error

        running = self._running()
        return tuple(
            plugin_id for plugin_id in order if plugin_id in affected and plugin_id in running
        )

    # --- the part where something is actually stopped -------------------------------------

    def _swap_and_start(
        self,
        changed: Sequence[TargetPlugin],
        *,
        group: tuple[str, ...],
        target: TargetSet,
        config: HelperConfig,
    ) -> AppliedUpdate:
        """Steps 2 to 5: stop the group, swap, start it again, and confirm or roll back."""
        try:
            stopped = self._stop(group)
        except Exception as error:  # noqa: BLE001 - the host refused, and nothing has moved
            # Before the swap, so no version has been installed and none is blocked: what
            # went wrong is the channel, not the release. Whatever did stop is started again.
            return self._restart_only(
                group,
                reason=f"the host would not stop the group, so nothing was swapped: {error}",
            )

        swapped: list[SwappedEnvironment] = []
        try:
            for plugin in changed:
                swapped.append(
                    swap_in(
                        plugin.id,
                        live_root=self.live_root,
                        staging_root=self.staging_root,
                        previous_root=self.previous_root,
                    )
                )
        except SwapError as error:
            return self._undo(
                changed,
                group=group,
                swapped=swapped,
                stopped=stopped,
                reason=f"the swap failed and the whole group was put back: {error}",
            )

        try:
            records = self._start(group)
        except Exception as error:  # noqa: BLE001 - the new environment is already live
            return self._undo(
                changed,
                group=group,
                swapped=swapped,
                stopped=stopped,
                reason=(
                    f"the group could not be started on its new versions and was rolled "
                    f"back: {error}"
                ),
            )

        unhealthy = self._await_health(
            group,
            records=records,
            target=target,
            window=config.helper.update_health_window,
        )

        if unhealthy:
            return self._undo(
                changed,
                group=group,
                swapped=swapped,
                stopped=stopped,
                reason=(
                    f"{', '.join(unhealthy)} did not become healthy within "
                    f"{config.helper.update_health_window:g}s, so the whole group was rolled "
                    "back — an update is applied together or not at all"
                ),
            )

        return AppliedUpdate(
            changed=tuple(plugin.id for plugin in changed),
            versions={plugin.id: plugin.version for plugin in changed},
            group=group,
            stopped=stopped,
            started=tuple(records),
        )

    def _stop(self, group: Sequence[str]) -> tuple[str, ...]:
        """Stop every member of the group, in reverse start order.

        Reverse, because a plugin is started after what it requires and must therefore be
        stopped before it: a dependent left running against a plugin that has gone is the
        half-stopped state the order exists to avoid.
        """
        stopped: list[str] = []
        for plugin_id in reversed(tuple(group)):
            self.channel.send(Command(name=CommandName.STOP, child_id=plugin_id))
            stopped.append(plugin_id)
        return tuple(stopped)

    def _start(self, group: Sequence[str]) -> dict[str, ChildRecord]:
        """Start every member of the group in start order, keeping each new process record.

        The record is what the wait for health is measured against: its process ID is the one
        a beat has to carry and the one the host has to still be listing.
        """
        records: dict[str, ChildRecord] = {}
        for plugin_id in group:
            result = self.channel.send(Command(name=CommandName.START, child_id=plugin_id))
            for record in result.children:
                records[record.id] = record
        return records

    def _await_health(
        self,
        group: Sequence[str],
        *,
        records: Mapping[str, ChildRecord],
        target: TargetSet,
        window: float,
    ) -> tuple[str, ...]:
        """Wait until every member of the group is healthy, and name the ones that never are.

        One deadline for the whole group rather than one each: the group came up together and
        it is confirmed together, and giving each member its own window would let a group of
        five take five times as long to be given up on.
        """
        manifests = {plugin.id: plugin.manifest for plugin in target.plugins}
        deadline = self.now() + window
        waiting = tuple(group)

        while True:
            running = self._running()
            waiting = tuple(
                plugin_id
                for plugin_id in waiting
                if not self._is_healthy(
                    plugin_id,
                    record=records.get(plugin_id),
                    manifest=manifests.get(plugin_id),
                    running=running,
                )
            )
            if not waiting or self.now() >= deadline:
                return waiting

            self.sleep(self.poll_interval)

    def _is_healthy(
        self,
        plugin_id: str,
        *,
        record: ChildRecord | None,
        manifest: AddonManifest | None,
        running: Mapping[str, ChildRecord],
    ) -> bool:
        """Whether one plugin has come up, judged against what its manifest promised.

        Liveness first, for every plugin: the host started it and still lists it at that same
        process ID. For a plugin that promised heartbeats, a beat from that same process
        saying `ready` on top — a plugin that starts and then sits there failing to serve is
        exactly what a heartbeat exists to tell the helper about.
        """
        if record is None:
            # The host answered the start with no record at all, so there is no process to
            # ask anything about.
            return False

        live = running.get(plugin_id)
        if live is None or live.pid != record.pid:
            return False

        profile = None if manifest is None else manifest.stability
        if profile is None or profile.heartbeat_interval is None:
            return True

        received = self.beats.latest(plugin_id)
        if received is None or received.beat.pid != record.pid:
            return False
        return received.beat.state is ProcessState.READY

    def _undo(
        self,
        changed: Sequence[TargetPlugin],
        *,
        group: tuple[str, ...],
        swapped: Sequence[SwappedEnvironment],
        stopped: tuple[str, ...],
        reason: str,
    ) -> AppliedUpdate:
        """Put the **whole group** back: stop it, restore every environment, block, start again.

        Every changed plugin's target version is blocked, not only the one that failed health.
        The group was judged and moved as one set, so the set is what did not work; blocking
        one member would leave the helper proposing the same group again tomorrow with one
        version missing from it, which no rule would accept anyway.

        The restored group is started and reported. Whether it then stays up is the ordinary
        health watch's business (:mod:`innytypes.helper.detection` and the restart policy);
        confirming it here would be a second place that decides a process should run again.
        """
        self._stop_quietly(group)

        rolled: list[str] = []
        for swap in swapped:
            if swap.previous is None:
                # Nothing was replaced — a plugin staged into a place where none was live.
                # There is no earlier environment to go back to, and removing this one would
                # leave the plugin with none at all.
                continue
            roll_back(swap.id, live_root=self.live_root, previous_root=self.previous_root)
            rolled.append(swap.id)

        blocked = tuple(
            BlockedVersion(plugin_id=plugin.id, version=plugin.version) for plugin in changed
        )
        for entry in blocked:
            self.blocked.block(entry.plugin_id, entry.version)

        still_down: list[str] = []
        for plugin_id in group:
            try:
                self.channel.send(Command(name=CommandName.START, child_id=plugin_id))
            except Exception:  # noqa: BLE001 - one plugin that will not start is a report
                # Reported rather than raised: the rest of the group still has to be started,
                # and a rollback that stops halfway is worse than the update that caused it.
                still_down.append(plugin_id)

        return AppliedUpdate(
            group=group,
            stopped=stopped,
            rolled_back=tuple(rolled),
            blocked=blocked,
            still_down=tuple(still_down),
            reason=reason,
        )

    def _restart_only(self, group: tuple[str, ...], *, reason: str) -> AppliedUpdate:
        """Start the group again after an attempt that never reached the swap.

        No version is blocked here, because none was ever installed: what failed was the
        channel to the host, and blocking a release for that would take a good version away
        over a bad moment.
        """
        still_down: list[str] = []
        for plugin_id in group:
            try:
                self.channel.send(Command(name=CommandName.START, child_id=plugin_id))
            except Exception:  # noqa: BLE001 - one that will not start is a report
                still_down.append(plugin_id)

        return AppliedUpdate(group=group, still_down=tuple(still_down), reason=reason)

    def _stop_quietly(self, group: Sequence[str]) -> None:
        """Stop the group again on the way back, tolerating one that is already gone.

        A refusal here is the ordinary case rather than the exception: the plugin that failed
        its health check most likely failed by exiting, and the host refuses a command naming
        a child it no longer has.
        """
        for plugin_id in reversed(tuple(group)):
            try:
                self.channel.send(Command(name=CommandName.STOP, child_id=plugin_id))
            except Exception:  # noqa: BLE001 - already stopped is the thing we wanted
                continue

    def _running(self) -> dict[str, ChildRecord]:
        """What the host says it is running right now, by child id."""
        result = self.channel.send(Command(name=CommandName.LIST))
        return {record.id: record for record in result.children}
