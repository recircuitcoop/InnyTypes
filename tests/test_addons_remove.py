"""`addons remove`: the stop, the refusals, and everything a removed plugin leaves behind.

Plan 0004, *Removing a plugin*. Three of the four rules are refusals or absences — stop it
before touching anything, refuse while another plugin requires it, delete nothing that was
not recorded — and an absence is the easiest thing in the world to "pass" by writing no code.
So the tests below are written to turn red when a check is deleted:

* the injected control channel **snapshots the disk every time it is asked to stop
  something**, so a removal that deleted first and stopped afterwards fails on the snapshot
  rather than on an ordering nobody looked at;
* the expected stop is proved through a real
  :class:`~innytypes.children.ChildSupervisor`, so `expected` is what the host actually
  reported rather than a flag this suite made up;
* the interrupted removal is staged by making the environment refuse to go, and asserts what
  the **next** discovery says about what is left.

Nothing real is behind any of it. No process is spawned, no `uv` runs, nothing sleeps, and
every path — the addons root, the plugins directory and the secrets root — is under
``tmp_path``. The real per-user directories are never read and never written.
"""

from __future__ import annotations

import json
import shutil
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path

import pytest
from click.testing import CliRunner, Result

from innytypes import HOST_API_VERSION
from innytypes.addons import removal
from innytypes.addons.discovery import DiscoveryResult, discover_addons
from innytypes.addons.lock import LOCK_FILENAME
from innytypes.addons.removal import RemovalError, remove_addon
from innytypes.addons.resolution import resolve_start_order
from innytypes.addons.secrets import SecretStore, secret_is_set_for
from innytypes.addons.settings import USER, SettingsStore
from innytypes.children import (
    ChildExit,
    ChildSupervisor,
    Command,
    CommandName,
    CommandResult,
    RunStateFile,
    UnknownChildError,
)
from innytypes.cli import CliContext, build_control_channel, cli

# A number the plugin declares and a secret it holds, so a removal has both kinds of trace to
# take and a reinstall has something to fall back to.
INTERVAL = {"id": "interval", "type": "number", "label": "Interval", "min": 1, "max": 60}
TOKEN = {"id": "token", "type": "secret", "label": "Token"}
DECLARATION: list[object] = [dict(INTERVAL, default=15), TOKEN]


# --- the machine every test removes from ----------------------------------------------------


@dataclass(frozen=True)
class PluginPaths:
    """Everything one installed plugin occupies, so "gone" and "untouched" are both facts."""

    root: Path
    environment: Path
    interpreter: Path
    manifest: Path
    lock: Path
    settings: Path
    secrets: Path
    token: Path

    def existing(self) -> dict[str, bool]:
        """Which of them are on disk right now."""
        return {
            "root": self.root.exists(),
            "environment": self.environment.is_dir(),
            "interpreter": self.interpreter.exists(),
            "manifest": self.manifest.exists(),
            "lock": self.lock.exists(),
            "settings": self.settings.exists(),
            "token": self.token.exists(),
        }


@dataclass(frozen=True)
class Machine:
    """One machine's plugin state: an addons root, a plugins directory and a secrets root.

    All three are under ``tmp_path`` and all three are passed explicitly to every call, which
    is how no test here can reach the real ones by forgetting an argument.
    """

    addons_root: Path
    settings_root: Path
    secrets_root: Path

    def install(
        self,
        addon_id: str,
        *,
        version: str = "1.0.0",
        requires: Sequence[Mapping[str, str]] = (),
        settings: Sequence[object] = (),
    ) -> PluginPaths:
        """Put on disk exactly what `addons install` records: a manifest, an environment, a lock.

        Written directly rather than through the installer, because what removal walks is the
        **recorded layout** — the contract between install and discovery — and this suite is
        about what happens to that layout, not about how it got there.
        """
        paths = self.paths(addon_id)
        paths.interpreter.parent.mkdir(parents=True)
        paths.interpreter.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        paths.lock.write_text(f"# the lock {addon_id} was installed from\n", encoding="utf-8")

        document: dict[str, object] = {
            "id": addon_id,
            "version": version,
            "host_api": HOST_API_VERSION,
            "requires": [f"{one['addon_id']}=={one['version']}" for one in requires],
            "emits": [f"{addon_id}.started.v1"],
            "subscribes": [],
        }
        if settings:
            document["settings"] = list(settings)
        paths.manifest.write_text(json.dumps(document), encoding="utf-8")
        return paths

    def paths(self, addon_id: str) -> PluginPaths:
        """Where everything belonging to one plugin lives, whether or not it is there."""
        root = self.addons_root / addon_id
        environment = root / "env"
        secrets = self.secrets_root / addon_id
        return PluginPaths(
            root=root,
            environment=environment,
            interpreter=environment / "bin" / "python",
            manifest=root / "manifest.json",
            lock=root / LOCK_FILENAME,
            settings=self.settings_path(addon_id),
            secrets=secrets,
            token=secrets / "token",
        )

    def settings_path(self, addon_id: str) -> Path:
        """One plugin's settings file, in this test's plugins directory and no other."""
        return self.settings_root / f"{addon_id}.toml"

    def store(self, addon_id: str) -> SettingsStore:
        """A settings store built from the plugin's **recorded** declaration, as the host does."""
        installed = {addon.id: addon for addon in discover_addons(self.addons_root).installed}
        return SettingsStore(
            addon_id,
            installed[addon_id].manifest.settings,
            path=self.settings_path(addon_id),
            secret_is_set=secret_is_set_for(addon_id, SecretStore(root=self.secrets_root)),
        )

    def configure(self, addon_id: str, values: Mapping[str, object], *, token: str) -> None:
        """Record a value and a secret through the real stores, so both files are real ones."""
        outcome = self.store(addon_id).write(values, by=USER)
        assert outcome.accepted, outcome.refused
        SecretStore(root=self.secrets_root).write(addon_id, "token", token)


@pytest.fixture
def machine(tmp_path: Path) -> Machine:
    """A machine whose three roots are all inside this test's own directory."""
    return Machine(
        addons_root=tmp_path / "addons",
        settings_root=tmp_path / "plugins",
        secrets_root=tmp_path / "secrets",
    )


# --- the control channel, injected -----------------------------------------------------------


@dataclass
class RecordingChannel:
    """A control channel that records what it was asked and stops nothing.

    ``witness`` is what makes the ordering assertion possible: it is called the moment a
    command arrives, so a test can photograph the disk at exactly that instant. A removal that
    deleted anything first would hand back a photograph with something missing from it.

    ``unknown`` names the children the host does not have, which is what a plugin that was
    never started looks like from here.
    """

    commands: list[Command] = field(default_factory=list)
    witness: Callable[[], dict[str, bool]] | None = None
    seen: list[dict[str, bool]] = field(default_factory=list)
    unknown: frozenset[str] = frozenset()

    def send(self, command: Command) -> CommandResult:
        self.commands.append(command)
        if self.witness is not None:
            self.seen.append(self.witness())
        if command.child_id in self.unknown:
            raise UnknownChildError(f"this host has no child called {command.child_id!r}")
        return CommandResult(name=command.name)


class FakeProcess:
    """Enough of a ``Popen`` for the host to start one child and stop it again."""

    def __init__(self, pid: int) -> None:
        self.pid = pid
        self.returncode: int | None = None
        self.terminated = False
        self.killed = False

    def poll(self) -> int | None:
        return self.returncode

    def terminate(self) -> None:
        self.terminated = True
        self.returncode = 0

    def kill(self) -> None:
        self.killed = True
        self.returncode = -9

    def wait(self, timeout: float | None = None) -> int:
        if self.returncode is None:
            self.returncode = 0
        return self.returncode


@dataclass
class HostChannel:
    """The real inbound half: a command goes to a real supervisor's :meth:`execute`.

    Used by the one test that has to prove the stop is an **expected** one, because "expected"
    is a fact the host reports about an exit and not something this suite can assert about a
    command it invented.
    """

    supervisor: ChildSupervisor

    def send(self, command: Command) -> CommandResult:
        return self.supervisor.execute(command)


def running_host(
    machine: Machine, tmp_path: Path, *, exits: list[ChildExit], processes: list[FakeProcess]
) -> ChildSupervisor:
    """A host holding the plugins this machine has installed, spawning fake processes."""

    def spawn(
        argv: Sequence[str], env: Mapping[str, str], *, channel: int | None = None
    ) -> FakeProcess:
        process = FakeProcess(pid=90_000 + len(processes) + 1)
        processes.append(process)
        return process

    return ChildSupervisor(
        mcp=None,
        addons=discover_addons(machine.addons_root).installed,
        run_state=RunStateFile(tmp_path / "run-state.json"),
        report_exit=exits.append,
        spawn=spawn,  # type: ignore[arg-type]
        environment={},
        # The OS process table holds nothing for a pid this suite invented, and asking it is
        # the one thing here that would touch the machine.
        image_of=lambda pid: None,
    )


def remove(machine: Machine, addon_id: str, channel: RecordingChannel) -> removal.RemovedAddon:
    """Remove one plugin with every root pointed at this test's own directories."""
    return remove_addon(
        addon_id,
        channel=channel,
        root=machine.addons_root,
        settings_path=machine.settings_path(addon_id),
        secrets_root=machine.secrets_root,
    )


# --- the stop comes first ---------------------------------------------------------------------


def test_the_plugin_is_stopped_before_any_file_is_touched(machine: Machine) -> None:
    """Acceptance 1: the stop is issued, and the disk is whole when it is.

    The channel photographs the disk as the command arrives. Deleting anything before the
    stop — in any order, by any route — puts a `False` in that photograph.
    """
    paths = machine.install("monty", version="1.4.0", settings=DECLARATION)
    machine.configure("monty", {"interval": 42}, token="fake-token-for-this-suite")
    whole = paths.existing()
    assert all(whole.values()), whole

    channel = RecordingChannel(witness=paths.existing)
    removed = remove(machine, "monty", channel)

    assert [(command.name, command.child_id) for command in channel.commands] == [
        (CommandName.STOP, "monty")
    ]
    # The disk as it was when the stop arrived: everything the plugin had, still there.
    assert channel.seen == [whole]
    assert removed.stopped is True
    # And gone once the removal finished, so the photograph above is of a real before.
    assert paths.existing() == dict.fromkeys(whole, False)


def test_the_stop_is_an_expected_one(machine: Machine, tmp_path: Path) -> None:
    """Acceptance 1: the host reports the exit as expected, so the helper will not undo it.

    Driven through a real :class:`~innytypes.children.ChildSupervisor`: `expected` is what the
    host says about an exit it asked for, and a removal that killed the plugin instead — or
    that reached past the channel to a signal — would not produce this report.
    """
    machine.install("monty", version="1.4.0")
    exits: list[ChildExit] = []
    processes: list[FakeProcess] = []
    supervisor = running_host(machine, tmp_path, exits=exits, processes=processes)
    supervisor.start("monty")

    remove_addon(
        "monty",
        channel=HostChannel(supervisor),
        root=machine.addons_root,
        settings_path=machine.settings_path("monty"),
        secrets_root=machine.secrets_root,
    )

    assert [(exit_report.id, exit_report.expected) for exit_report in exits] == [("monty", True)]
    assert processes[0].terminated is True
    assert processes[0].killed is False
    assert supervisor.running() == ()


def test_a_plugin_the_host_never_started_is_still_removed(machine: Machine) -> None:
    """A host with no such child has nothing to stop, and that is an answer, not a failure."""
    paths = machine.install("monty")
    channel = RecordingChannel(unknown=frozenset({"monty"}))

    removed = remove(machine, "monty", channel)

    assert removed.stopped is False
    assert len(channel.commands) == 1
    assert not paths.root.exists()


def test_a_stop_that_fails_leaves_everything_on_disk(machine: Machine) -> None:
    """A plugin that could not be stopped is a plugin still holding its environment open."""
    paths = machine.install("monty")
    before = paths.existing()

    class RefusingChannel:
        def send(self, command: Command) -> CommandResult:
            raise RuntimeError("the host could not be reached")

    with pytest.raises(RuntimeError, match="could not be reached"):
        remove_addon(
            "monty",
            channel=RefusingChannel(),
            root=machine.addons_root,
            settings_path=machine.settings_path("monty"),
            secrets_root=machine.secrets_root,
        )

    assert paths.existing() == before


# --- refused while another plugin requires it --------------------------------------------------


def test_a_plugin_another_one_requires_is_refused_by_name(machine: Machine) -> None:
    """Acceptance 2: the requiring plugin is named, and nothing at all is removed."""
    monty = machine.install("monty", version="1.4.0", settings=DECLARATION)
    machine.configure("monty", {"interval": 42}, token="fake-token-for-this-suite")
    machine.install("whodunnit", requires=[{"addon_id": "monty", "version": "1.4.0"}])
    before = monty.existing()

    channel = RecordingChannel()
    with pytest.raises(RemovalError) as refusal:
        remove(machine, "monty", channel)

    message = str(refusal.value)
    assert "whodunnit" in message
    # Named the way the resolver names a requirement it cannot satisfy.
    assert "monty==1.4.0" in message
    assert "which is not installed" in message

    # Nothing was deleted, and nothing was even stopped: the refusal comes before both.
    assert monty.existing() == before
    assert all(before.values()), before
    assert channel.commands == []


def test_a_requirement_at_another_version_still_refuses(machine: Machine) -> None:
    """The id is what makes the edge; the version only decides whether it is satisfied.

    A plugin requiring `monty==2.0.0` while 1.4.0 is installed is already held back. Removing
    monty would take away its last chance of ever starting, so it is refused the same way.
    """
    machine.install("monty", version="1.4.0")
    machine.install("whodunnit", requires=[{"addon_id": "monty", "version": "2.0.0"}])

    with pytest.raises(RemovalError, match="whodunnit requires monty==2.0.0"):
        remove(machine, "monty", RecordingChannel())


def test_a_plugin_nothing_requires_is_removed_with_others_installed(machine: Machine) -> None:
    """The refusal is about requirements, not about company: a neighbour is not a blocker.

    The neighbour here requires something — just not this plugin — so the check has a
    requirement to look past rather than an empty list to fall through.
    """
    monty = machine.install("monty", version="1.4.0")
    machine.install("summarize", version="0.3.0")
    whodunnit = machine.install(
        "whodunnit", requires=[{"addon_id": "summarize", "version": "0.3.0"}]
    )
    before = whodunnit.existing()

    remove(machine, "monty", RecordingChannel())

    assert not monty.root.exists()
    assert whodunnit.existing() == before


# --- everything it had goes (D8) ---------------------------------------------------------------


def test_a_successful_remove_takes_all_four_things(machine: Machine) -> None:
    """Acceptance 3: environment, recorded manifest, settings file and secret, all gone."""
    paths = machine.install("monty", version="1.4.0", settings=DECLARATION)
    machine.configure("monty", {"interval": 42}, token="fake-token-for-this-suite")
    assert all(paths.existing().values()), paths.existing()

    removed = remove(machine, "monty", RecordingChannel())

    assert paths.existing() == dict.fromkeys(paths.existing(), False)
    assert not paths.secrets.exists()
    assert discover_addons(machine.addons_root) == DiscoveryResult(installed=(), broken=())
    assert removed.settings_removed is True
    assert removed.secrets_removed == 1


def test_reinstalling_starts_from_the_declarations_defaults(machine: Machine) -> None:
    """Acceptance 4: no trace of the old settings or the old secret survives the reinstall."""
    machine.install("monty", version="1.4.0", settings=DECLARATION)
    machine.configure("monty", {"interval": 42}, token="fake-token-for-this-suite")
    assert machine.store("monty").read().values == {"interval": 42}
    assert machine.store("monty").secret_is_set("token") is True

    remove(machine, "monty", RecordingChannel())
    machine.install("monty", version="1.4.0", settings=DECLARATION)

    reinstalled = machine.store("monty").read()
    assert reinstalled.values == {"interval": 15}
    assert reinstalled.recorded == {}
    assert reinstalled.attribution == {}
    assert machine.store("monty").secret_is_set("token") is False


def test_a_plugin_with_nothing_recorded_is_removed_cleanly(machine: Machine) -> None:
    """Acceptance 5: a partial record completes for what is recorded and refuses nothing.

    The settings file was never written and no secret was ever stored — the ordinary state of
    a plugin nobody has configured, and the same state as one whose file a person deleted by
    hand. Neither absence is a failure, and neither makes removal reach for anything else.
    """
    paths = machine.install("monty", version="1.4.0", settings=DECLARATION)
    assert not paths.settings.exists()
    neighbour = machine.settings_root / "whodunnit.toml"
    neighbour.parent.mkdir(parents=True, exist_ok=True)
    neighbour.write_text("[values]\nkept = true\n", encoding="utf-8")

    removed = remove(machine, "monty", RecordingChannel())

    assert removed.settings_removed is False
    assert removed.secrets_removed == 0
    assert not paths.root.exists()
    # Nothing beside the plugin's own file was touched.
    assert neighbour.read_text(encoding="utf-8") == "[values]\nkept = true\n"


def test_a_secrets_directory_holding_a_subdirectory_keeps_it(machine: Machine) -> None:
    """The secret goes; a directory the store never wrote stays, and keeps its parent standing.

    Whose rule this is matters: removal asks
    :meth:`~innytypes.addons.secrets.SecretStore.clear_addon` and counts what it took, so what
    survives is that store's judgement about what it wrote — not a second opinion here.
    """
    paths = machine.install("monty", version="1.4.0", settings=DECLARATION)
    machine.configure("monty", {"interval": 42}, token="fake-token-for-this-suite")
    stranger = paths.secrets / "keys"
    stranger.mkdir()

    removed = remove(machine, "monty", RecordingChannel())

    assert removed.secrets_removed == 1
    assert not paths.token.exists()
    assert stranger.is_dir()


def test_a_settings_file_that_will_not_go_is_named(machine: Machine) -> None:
    """A deletion the filesystem refuses is reported with the path, not swallowed.

    Staged with a directory where the settings file belongs, because `unlink` refuses one —
    the same refusal a permission or a held file produces, and the only one a test can make
    happen without changing the mode of something.
    """
    paths = machine.install("monty", version="1.4.0", settings=DECLARATION)
    paths.settings.mkdir(parents=True)

    with pytest.raises(RemovalError, match="the settings file of monty could not be removed"):
        remove(machine, "monty", RecordingChannel())

    # The plugin itself is already gone: what is left is the one path that refused.
    assert not paths.root.exists()
    assert paths.settings.is_dir()


# --- only what the host recorded ----------------------------------------------------------------


def test_removal_acts_only_on_the_root_it_was_given(machine: Machine, tmp_path: Path) -> None:
    """Acceptance 5: the caller names an id, never a path, so a namesake elsewhere is safe."""
    machine.install("monty", version="1.4.0")
    elsewhere = Machine(
        addons_root=tmp_path / "another-machine" / "addons",
        settings_root=tmp_path / "another-machine" / "plugins",
        secrets_root=tmp_path / "another-machine" / "secrets",
    )
    other = elsewhere.install("monty", version="1.4.0", settings=DECLARATION)
    elsewhere.configure("monty", {"interval": 42}, token="fake-token-for-this-suite")
    before = other.existing()

    remove(machine, "monty", RecordingChannel())

    assert not (machine.addons_root / "monty").exists()
    assert other.existing() == before
    assert all(before.values()), before


def test_a_plugin_that_is_not_installed_is_refused_by_name(machine: Machine) -> None:
    """Acceptance 6: the id is named, nothing is stopped, and nothing else on disk moves."""
    whodunnit = machine.install("whodunnit")
    before = whodunnit.existing()
    channel = RecordingChannel()

    with pytest.raises(RemovalError, match="monty is not installed"):
        remove(machine, "monty", channel)

    assert channel.commands == []
    assert whodunnit.existing() == before


def test_a_record_that_cannot_be_read_is_refused_rather_than_guessed_at(machine: Machine) -> None:
    """A broken record leaves nothing to walk, so removal refuses instead of deleting blind."""
    paths = machine.install("monty")
    paths.manifest.write_bytes(b"{ not json")
    before = paths.existing()
    channel = RecordingChannel()

    with pytest.raises(RemovalError) as refusal:
        remove(machine, "monty", channel)

    message = str(refusal.value)
    assert "monty cannot be removed" in message
    assert "not valid JSON" in message
    assert channel.commands == []
    assert paths.existing() == before


# --- interrupted half way ------------------------------------------------------------------------


def test_an_interrupted_removal_leaves_a_plugin_nobody_will_start(
    machine: Machine, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The order of destruction: the record goes before the environment, never after.

    The environment is made to refuse, which is every way a removal can stop half way —
    power, a kill, a permission. What matters is what the next discovery says: the plugin is
    **broken**, not installed, so no start order can contain it. Swap the two steps and this
    test finds it installed with an environment that is being deleted, which is the state that
    must never exist.
    """
    paths = machine.install("monty", version="1.4.0")

    class RefusingShutil:
        """`shutil`, as far as the module under test is concerned, with a tree that will not go."""

        @staticmethod
        def rmtree(path: object, *args: object, **kwargs: object) -> None:
            raise OSError(13, "Permission denied")

    # The module's own name for it, so nothing outside this test sees a patched `shutil`.
    monkeypatch.setattr(removal, "shutil", RefusingShutil)

    with pytest.raises(RemovalError, match="the environment of monty could not be removed"):
        remove(machine, "monty", RecordingChannel())

    found = discover_addons(machine.addons_root)
    assert [broken.id for broken in found.broken] == ["monty"]
    assert found.installed == ()
    # The environment is still there to be cleaned up by hand, and nothing will launch it.
    assert paths.interpreter.exists()
    assert resolve_start_order([addon.manifest for addon in found.installed]).order == ()


def test_the_real_rmtree_is_what_removes_the_environment(machine: Machine) -> None:
    """The canary for the test above: without the monkeypatch, the tree really does go.

    Without this, a `rmtree` that had been replaced by nothing at all would still let the
    interrupted test pass.
    """
    paths = machine.install("monty")
    assert removal.shutil is shutil

    remove(machine, "monty", RecordingChannel())

    assert not paths.environment.exists()
    assert not paths.lock.exists()


# --- the command line -----------------------------------------------------------------------------


def cli_context(machine: Machine, channel: RecordingChannel) -> CliContext:
    """A CLI wired to this machine's three roots and to an injected control channel."""
    return CliContext(
        addons_root=machine.addons_root,
        make_channel=lambda: channel,
        settings_path=machine.settings_path,
        secrets_root=machine.secrets_root,
    )


def invoke(context: CliContext, *arguments: str) -> Result:
    return CliRunner().invoke(cli, list(arguments), obj=context, catch_exceptions=False)


def test_the_command_stops_the_plugin_and_removes_everything(machine: Machine) -> None:
    """Acceptance 7: the whole thing through the command a person types, injected end to end."""
    paths = machine.install("monty", version="1.4.0", settings=DECLARATION)
    machine.configure("monty", {"interval": 42}, token="fake-token-for-this-suite")
    channel = RecordingChannel(witness=paths.existing)

    result = invoke(cli_context(machine, channel), "addons", "remove", "monty")

    assert result.exit_code == 0, result.output
    assert "Removed monty 1.4.0" in result.output
    assert "It was stopped first." in result.output
    assert "Removed 1 stored secret." in result.output
    assert all(channel.seen[0].values()), channel.seen[0]
    assert paths.existing() == dict.fromkeys(paths.existing(), False)


def test_the_command_refuses_and_names_the_requiring_plugin(machine: Machine) -> None:
    paths = machine.install("monty", version="1.4.0")
    machine.install("whodunnit", requires=[{"addon_id": "monty", "version": "1.4.0"}])
    channel = RecordingChannel()

    result = invoke(cli_context(machine, channel), "addons", "remove", "monty")

    assert result.exit_code == 1
    assert "whodunnit requires monty==1.4.0" in result.output
    assert paths.manifest.exists()
    assert channel.commands == []


def test_the_command_refuses_a_plugin_that_is_not_installed(machine: Machine) -> None:
    result = invoke(cli_context(machine, RecordingChannel()), "addons", "remove", "monty")

    assert result.exit_code == 1
    assert "monty is not installed" in result.output


def test_the_command_says_so_when_it_cannot_reach_the_host(machine: Machine) -> None:
    """There is no channel in production yet, and a removal that cannot stop does not start.

    The seam is the point: the window's plugin page holds the host's own channel and calls the
    same function. Until the command line has one, it says so and deletes nothing.
    """
    paths = machine.install("monty", version="1.4.0")
    assert build_control_channel() is None

    result = invoke(
        CliContext(
            addons_root=machine.addons_root,
            settings_path=machine.settings_path,
            secrets_root=machine.secrets_root,
        ),
        "addons",
        "remove",
        "monty",
    )

    assert result.exit_code == 1
    assert "has no way to reach it yet" in result.output
    assert paths.manifest.exists()
