"""The enable switch: recorded, obeyed by the host, and never undone by the helper.

Two of the things this slice builds are **absences** — a disabled plugin is not started, and
a disabled plugin is not restarted — so the tests are written so that deleting the code that
makes them true turns one of them red:

* the fake process a test is handed is dead the moment it is spawned, so a host or a helper
  that decided to bring it back would spawn it again and again, and every test below asserts
  the exact list of spawns rather than "at least one";
* the restart policy is driven through the real :class:`~innytypes.children.ChildSupervisor`,
  so "the stop was expected" is a fact produced by the host rather than a flag a fake set;
* the switch is read back from the file it was written to, not from the object that wrote it.

Nothing here spawns a process, opens a socket or sleeps. The spawn records its arguments, the
clock counts instead of passing, and every file — the config, the settings, the secrets, the
quarantines, the addons — is under ``tmp_path`` (WI-0003-05's discipline).
"""

from __future__ import annotations

import json
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path

import pytest
from click.testing import CliRunner

from innytypes import HOST_API_VERSION, __version__
from innytypes.addons.discovery import ENVIRONMENT_DIRNAME, MANIFEST_FILENAME, InstalledAddon
from innytypes.addons.install import EditableInstall, host_source, install_addon_from_path
from innytypes.addons.manifest import AddonManifest, parse_manifest
from innytypes.addons.resolution import resolve_start_order
from innytypes.addons.secrets import SecretStore
from innytypes.addons.settings import USER, PluginAvailability, SettingsStore
from innytypes.children import (
    ChildExit,
    ChildSupervisor,
    Command,
    CommandName,
    CommandResult,
    DisabledChildError,
    RunStateFile,
)
from innytypes.cli import cli
from innytypes.helper.breaker import Breaker, QuarantineFile
from innytypes.helper.config import HelperSettings
from innytypes.helper.enablement import EnableSwitch, StartGate, plugin_state, plugin_states
from innytypes.helper.launcher import LaunchAtLogin
from innytypes.helper.restart import RestartPolicy
from innytypes.helper.window import ApplicationWindow, HeadlessDesktop
from innytypes.host import Host

# A required setting with no default: the declaration that makes a plugin held disabled until
# somebody fills the form in (plan 0004, F1).
REQUIRED_FOLDER = {"id": "root", "type": "text", "label": "Folder to watch", "required": True}


# --- fakes ------------------------------------------------------------------------------


class FakeProcess:
    """Enough of a ``Popen`` to be started, polled and stopped.

    ``exit_code`` at construction is a child that was dead before anybody looked at it, which
    is how "it crashed again" is staged without a process.
    """

    def __init__(self, pid: int, *, exit_code: int | None = None) -> None:
        self.pid = pid
        self.returncode = exit_code

    def poll(self) -> int | None:
        return self.returncode

    def terminate(self) -> None:
        self.returncode = 0

    def kill(self) -> None:
        self.returncode = -9

    def wait(self, timeout: float | None = None) -> int:
        if self.returncode is None:
            self.returncode = 0
        return self.returncode


class FakeClock:
    """A clock a test moves by hand, so a backoff is asserted rather than waited out."""

    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


@dataclass
class RecordingChannel:
    """The control channel, with the real host on the other end of it.

    A fake that carried out commands itself would prove nothing about the enable switch: the
    facts this slice turns on — that a stop is *expected*, that a start honours the resolver's
    order — are the host's, so the host is what answers here.
    """

    supervisor: ChildSupervisor
    commands: list[Command] = field(default_factory=list)

    def send(self, command: Command) -> CommandResult:
        self.commands.append(command)
        return self.supervisor.execute(command)

    @property
    def names(self) -> list[CommandName]:
        return [command.name for command in self.commands]


@dataclass
class FakeInstaller:
    """An installer that records what it was asked for and installs nothing.

    It creates the environment *directory*, because that is what makes the layout on disk real
    for discovery to read back; what would have gone inside it is a `uv` invocation this suite
    never makes.
    """

    document: Mapping[str, object]

    def build_wheel(self, source: Path, *, into: Path) -> Path:
        # The host's own source tree builds the host's own wheel, at the host's own version;
        # anything else is the addon whose checkout was named (plan 0001, *Each addon has its
        # own environment*).
        name = (
            f"innytypes-{__version__}-py3-none-any.whl"
            if source == host_source()
            else "monty-1.0.0-py3-none-any.whl"
        )
        wheel = into / name
        wheel.write_bytes(b"a wheel, as far as this suite is concerned")
        return wheel

    def create_environment(self, environment: Path, *, python: str) -> None:
        environment.mkdir(parents=True)

    def install(
        self,
        environment: Path,
        requirements: Sequence[str],
        *,
        editable: EditableInstall | None = None,
    ) -> None:
        return None

    def read_manifest(
        self, environment: Path, *, addon_id: str | None = None
    ) -> Mapping[str, object]:
        return self.document


# --- the addons every test is built out of -------------------------------------------------


def document(
    addon_id: str,
    *,
    version: str = "1.0.0",
    requires: Sequence[str] = (),
    emits: Sequence[str] = (),
    subscribes: Sequence[str] = (),
    settings: Sequence[Mapping[str, object]] = (),
) -> dict[str, object]:
    """One manifest as an addon exports it, before anything has judged it."""
    return {
        "id": addon_id,
        "version": version,
        "host_api": HOST_API_VERSION,
        "requires": list(requires),
        "emits": list(emits),
        "subscribes": list(subscribes),
        "settings": [dict(declared) for declared in settings],
    }


def manifest(addon_id: str, **declared: object) -> AddonManifest:
    """One parsed manifest, so no test invents a shape the grammar would refuse."""
    return parse_manifest(document(addon_id, **declared))  # type: ignore[arg-type]


def installed(root: Path, addon_manifest: AddonManifest) -> InstalledAddon:
    """One addon as discovery would report it, without anything being written to disk."""
    addon_root = root / addon_manifest.id
    return InstalledAddon(
        id=addon_manifest.id,
        manifest=addon_manifest,
        root=addon_root,
        environment=addon_root / ENVIRONMENT_DIRNAME,
        manifest_path=addon_root / MANIFEST_FILENAME,
    )


def three_plugins(root: Path) -> list[InstalledAddon]:
    """Three plugins whose manifests force the order alpha, beta, gamma.

    The edges are *subscriptions*, not requirements, so none of the three is held back when
    another is switched off — which is what makes "beta starts in its own position" a
    statement about the resolver rather than about degradation.
    """
    return [
        installed(root, manifest("alpha", emits=["alpha.started.v1"])),
        installed(root, manifest("beta", emits=["beta.done.v1"], subscribes=["alpha.*"])),
        installed(root, manifest("gamma", subscribes=["beta.*"])),
    ]


# --- the harness ---------------------------------------------------------------------------


@dataclass
class Harness:
    """A host, a helper and a switch, wired to each other and to nothing else."""

    supervisor: ChildSupervisor
    policy: RestartPolicy
    breaker: Breaker
    settings: HelperSettings
    switch: EnableSwitch
    channel: RecordingChannel
    gate: StartGate
    clock: FakeClock
    config: Path
    addons: list[InstalledAddon]
    # The child id of every spawn that was attempted, in order.
    spawns: list[str] = field(default_factory=list)
    # Every child exit the host reported to the helper, in order.
    exits: list[ChildExit] = field(default_factory=list)
    processes: dict[int, FakeProcess] = field(default_factory=dict)

    def running(self) -> list[str]:
        return [record.id for record in self.supervisor.running()]

    def crash(self, child_id: str) -> None:
        """Make a running child look as though it died on its own, and let the host notice."""
        record = next(record for record in self.supervisor.running() if record.id == child_id)
        self.processes[record.pid].returncode = 1
        self.supervisor.poll()

    def enabled_in_the_file(self, plugin_id: str) -> bool:
        """The switch as the *file* records it, read back rather than remembered."""
        return HelperSettings(path=self.config).is_enabled(plugin_id)


@pytest.fixture
def make_harness(tmp_path: Path) -> Iterator[Callable[..., Harness]]:
    """Build a host, a helper and a switch that spawn nothing and write only in ``tmp_path``."""

    def _make(
        *,
        addons: Sequence[InstalledAddon] | None = None,
        disabled: Sequence[str] = (),
        dead_on_arrival: bool = True,
    ) -> Harness:
        root = tmp_path / "addons"
        plugins = list(three_plugins(root) if addons is None else addons)
        config = tmp_path / "config.toml"
        settings = HelperSettings(path=config)

        for plugin_id in disabled:
            settings.set_enabled(plugin_id, False)

        spawns: list[str] = []
        exits: list[ChildExit] = []
        processes: dict[int, FakeProcess] = {}
        clock = FakeClock()

        def spawn(
            argv: Sequence[str],
            env: dict[str, str],
            *,
            channel: int | None = None,
        ) -> FakeProcess:
            spawns.append(argv[-1])
            # Dead the instant it is spawned, so a respawn anywhere would show up as a second
            # entry in `spawns` rather than as silence.
            process = FakeProcess(
                pid=90_000 + len(spawns),
                exit_code=0 if dead_on_arrival else None,
            )
            processes[process.pid] = process
            return process

        def report(exit_report: ChildExit) -> None:
            exits.append(exit_report)
            scheduled = policy.child_exited(exit_report)
            if scheduled is not None:
                # What the helper does with a restart it decided on: counts it, so a plugin
                # that keeps failing is eventually quarantined. A deliberate stop reaches
                # neither of these lines, which is the point of the `expected` flag.
                breaker.record(exit_report.id, reason=scheduled.reason)

        breaker = Breaker(now=clock)
        gate = StartGate(
            settings=settings,
            installed=plugins,
            config_path=config,
            secrets=SecretStore(root=tmp_path / "secrets"),
        )
        supervisor = ChildSupervisor(
            mcp=None,
            addons=plugins,
            run_state=RunStateFile(tmp_path / "run-state.json"),
            report_exit=report,
            spawn=spawn,  # type: ignore[arg-type]
            clock=clock,
            # An environment of its own, so nothing here depends on the shell the gate runs in.
            environment={"PATH": "/nonexistent"},
            holds_back=gate,
        )
        channel = RecordingChannel(supervisor)
        policy = RestartPolicy(channel=channel, now=clock, holds_back=gate)

        return Harness(
            supervisor=supervisor,
            policy=policy,
            breaker=breaker,
            settings=settings,
            switch=EnableSwitch(settings=settings, channel=channel),
            channel=channel,
            gate=gate,
            clock=clock,
            config=config,
            addons=plugins,
            spawns=spawns,
            exits=exits,
            processes=processes,
        )

    yield _make


# --- D7: installing is the act of wanting it -----------------------------------------------


def test_a_newly_installed_plugin_is_enabled_before_any_switch_is_touched(tmp_path: Path) -> None:
    """D7, and the reason the config file records only departures from it.

    The assertion that the file was never written is what makes "enabled" the *default*
    rather than something the installer happens to write: a plugin nobody has switched off is
    enabled with nothing recorded anywhere.
    """
    source = tmp_path / "checkout"
    source.mkdir()

    addon = install_addon_from_path(
        source,
        installer=FakeInstaller(document("monty")),  # type: ignore[arg-type]
        root=tmp_path / "addons",
    )

    config = tmp_path / "config.toml"
    settings = HelperSettings(path=config)

    assert addon.id == "monty"
    assert settings.is_enabled("monty")
    assert not config.exists()

    gate = StartGate(
        settings=settings,
        installed=[addon],
        config_path=config,
        secrets=SecretStore(root=tmp_path / "secrets"),
    )
    assert gate("monty") is None


# --- disabling a running plugin -------------------------------------------------------------


def test_disabling_a_running_plugin_records_it_and_stops_it_as_an_expected_stop(
    make_harness: Callable[..., Harness],
) -> None:
    """The stop goes through the channel, and the helper is told it was asked for.

    Every assertion after the stop is about what did **not** happen: no attempt counted, no
    restart scheduled, no intervention recorded and no second spawn. Remove the `expected`
    flag from the host's stop, or the check for it in the policy, and the last four go red.
    """
    harness = make_harness(dead_on_arrival=False)
    harness.supervisor.start_all()
    assert harness.running() == ["alpha", "beta", "gamma"]

    result = harness.switch.disable("beta")

    assert result.enabled is False
    assert result.stopped == ("beta",)
    assert harness.enabled_in_the_file("beta") is False
    assert CommandName.STOP in harness.channel.names
    assert harness.running() == ["alpha", "gamma"]

    stopped = harness.exits[-1]
    assert stopped.id == "beta"
    assert stopped.expected is True
    assert harness.policy.state("beta").attempts == 0
    assert harness.policy.pending == ()
    assert harness.breaker.interventions_for("beta") == ()
    assert harness.breaker.is_quarantined("beta") is False
    assert harness.spawns == ["alpha", "beta", "gamma"]


def test_a_disabled_plugin_that_exits_again_is_never_spawned_again(
    make_harness: Callable[..., Harness],
) -> None:
    """The absence this slice is about, staged as a plugin that keeps dying.

    The fake process is dead the moment it is spawned, so ticking the helper after a disabled
    plugin's exit would spawn it again — and the spawn list would grow. Take the switch out of
    :meth:`RestartPolicy._schedule` and this test fails on the very first tick.
    """
    harness = make_harness()
    harness.supervisor.start_all()
    harness.switch.disable("beta")
    before = list(harness.spawns)

    # It exits on its own, after being disabled: a process that was already on its way out
    # when the stop arrived, which is the race the rule has to survive.
    harness.policy.child_exited(
        ChildExit(id="beta", kind=harness.exits[0].kind, pid=4242, exit_code=1, expected=False)
    )

    for _ in range(5):
        harness.clock.advance(60.0)
        assert harness.policy.tick() == ()

    assert harness.spawns == before
    assert harness.policy.pending == ()
    assert harness.policy.state("beta").attempts == 0


def test_a_restart_already_scheduled_is_dropped_when_the_plugin_is_disabled(
    make_harness: Callable[..., Harness],
) -> None:
    """Switched off during its own backoff: the decision was taken before the user's.

    The restart is scheduled while beta is still enabled, so the policy really is holding one;
    the switch is then flipped, and the tick that would have issued it issues nothing. Take
    the switch out of :meth:`RestartPolicy.tick` and beta is spawned a second time.
    """
    harness = make_harness(dead_on_arrival=False)
    harness.supervisor.start_all()

    harness.crash("beta")
    assert [pending.child_id for pending in harness.policy.pending] == ["beta"]

    harness.switch.disable("beta")
    harness.clock.advance(60.0)

    assert harness.policy.tick() == ()
    assert harness.spawns == ["alpha", "beta", "gamma"]
    assert harness.policy.pending == ()


def test_the_host_refuses_to_start_a_disabled_plugin_whatever_asks(
    make_harness: Callable[..., Harness],
) -> None:
    """The last line of the rule: the one place a process is created enforces it too."""
    harness = make_harness(disabled=["beta"])

    harness.supervisor.start_all()
    assert harness.spawns == ["alpha", "gamma"]

    with pytest.raises(DisabledChildError, match="beta is disabled"):
        harness.supervisor.start("beta")

    assert harness.spawns == ["alpha", "gamma"]


def test_a_disabled_plugin_does_not_stop_the_host_from_starting(
    make_harness: Callable[..., Harness],
) -> None:
    """The defect this test exists for: `innytypes up` exited because a plugin was held.

    `Host.start` started every child by name, so the refusal that makes "disabled means not
    started" true took the **whole application** down with it — no host, no window, nothing to
    turn off. It was found by installing a real plugin on a real machine and opening the app:
    monty was held-disabled for want of a folder, and InnyTypes died on launch.

    A child that is switched off, or held back until its settings are valid (plan 0004, F1),
    is not a failure. It is skipped, named in `held`, and everything else starts.
    """
    harness = make_harness(disabled=["beta"])
    host = Host(children=harness.supervisor)

    report = host.start()

    assert [record.id for record in report.started] == ["alpha", "gamma"]
    assert [held.component for held in report.held] == ["beta"]
    assert "disabled" in report.held[0].reason
    # Held is not degraded: nothing is broken here, and the two need different sentences.
    assert report.degraded == ()


# --- enabling ---------------------------------------------------------------------------------


def test_enabling_a_plugin_starts_it_in_its_own_place_in_the_resolver_order(
    make_harness: Callable[..., Harness],
) -> None:
    """beta comes back between alpha and gamma — neither first nor last by accident.

    Enabling asks the host to start everything that should be running, so the order is the
    resolver's rather than the switch's. A switch that sent `start beta` instead would start
    beta alone, and the list below would be one id long.
    """
    harness = make_harness(disabled=["beta"], dead_on_arrival=False)
    harness.supervisor.start_all()
    assert harness.spawns == ["alpha", "gamma"]

    # Everything stopped: the pass that follows starts all three, so beta's position in it is
    # the resolver's answer and nothing else.
    harness.supervisor.shutdown()
    harness.spawns.clear()

    result = harness.switch.enable("beta")

    assert harness.enabled_in_the_file("beta") is True
    assert result.started == ("alpha", "beta", "gamma")
    assert harness.spawns == ["alpha", "beta", "gamma"]


def test_enabling_a_plugin_that_is_already_running_starts_nothing(
    make_harness: Callable[..., Harness],
) -> None:
    """Enabling is not a restart: a plugin already running is left exactly as it is."""
    harness = make_harness(dead_on_arrival=False)
    harness.supervisor.start_all()

    result = harness.switch.enable("beta")

    assert result.enabled is True
    assert result.started == ()
    assert harness.spawns == ["alpha", "beta", "gamma"]
    assert CommandName.START_ALL not in harness.channel.names


# --- a plugin that requires a disabled plugin -------------------------------------------------


def test_a_plugin_that_requires_a_disabled_plugin_is_held_back_and_says_why(
    make_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """Reported the way a missing requirement is reported (plan 0001's degradation rule).

    delta is not spawned, it is in ``held_back`` with a sentence naming beta and the word for
    beta's state, and beta itself is **not** held back — there is nothing wrong with it.
    """
    root = tmp_path / "addons"
    plugins = [
        *three_plugins(root),
        installed(root, manifest("delta", requires=["beta==1.0.0"])),
    ]
    harness = make_harness(addons=plugins, disabled=["beta"])

    held_back = {addon.id: addon.reason for addon in harness.supervisor.held_back}
    assert "delta" in held_back
    assert held_back["delta"] == "requires beta, which is disabled"
    assert "beta" not in held_back

    harness.supervisor.start_all()
    assert harness.spawns == ["alpha", "gamma"]

    # A plugin that merely *subscribes* to a disabled one still starts: gamma subscribes to
    # beta and is in the list above. Only `requires` is a hard dependency (plan 0001).
    assert "gamma" not in held_back


def test_a_missing_requirement_and_a_disabled_one_are_reported_in_the_same_shape() -> None:
    """The same sentence with a different ending, so one reader reads both the same way."""
    manifests = [manifest("beta"), manifest("delta", requires=["beta==1.0.0"])]

    switched_off = resolve_start_order(manifests, not_starting={"beta": "disabled"})
    not_installed = resolve_start_order([manifests[1]])

    assert switched_off.held_back[0].reason == "requires beta, which is disabled"
    assert not_installed.held_back[0].reason == "requires beta==1.0.0, which is not installed"
    assert switched_off.order == ("beta",)


# --- three words, three remedies ---------------------------------------------------------------


def test_disabled_held_and_quarantined_are_three_different_values() -> None:
    """They are not the same word, and no two of them are the same state."""
    disabled = plugin_state(enabled=False)
    quarantined = plugin_state(enabled=True, quarantine="exited with code 1 five times")
    held = plugin_state(enabled=True, held="held disabled: root is required and has no value")

    words = {disabled.availability, quarantined.availability, held.availability}
    assert words == {
        PluginAvailability.DISABLED,
        PluginAvailability.QUARANTINED,
        PluginAvailability.HELD,
    }
    assert len(words) == 3
    assert plugin_state(enabled=True).availability is PluginAvailability.ENABLED

    # And when more than one is true, the word names what has to be done first.
    both = plugin_state(enabled=False, quarantine="exited with code 1 five times")
    assert both.availability is PluginAvailability.DISABLED


def test_clearing_a_quarantine_and_flipping_the_switch_do_not_touch_each_other(
    tmp_path: Path,
) -> None:
    """Two states, two files, two remedies — and neither command reaches the other's.

    Driven through the commands a person actually types, because that is where the two would
    be confused for one another.
    """
    config = tmp_path / "config.toml"
    quarantine = tmp_path / "quarantine.json"
    QuarantineFile(path=quarantine).save({"monty": "exited with code 1 five times"})
    runner = CliRunner()

    disabled = runner.invoke(cli, ["addons", "--config", str(config), "disable", "monty"])
    assert disabled.exit_code == 0, disabled.output

    # Disabling by hand left the quarantine exactly as it was.
    assert QuarantineFile(path=quarantine).load() == {"monty": "exited with code 1 five times"}
    assert HelperSettings(path=config).is_enabled("monty") is False

    released = runner.invoke(cli, ["helper", "release", "monty", "--quarantine", str(quarantine)])
    assert released.exit_code == 0, released.output

    # Releasing cleared the quarantine and left the switch exactly as it was.
    assert QuarantineFile(path=quarantine).load() == {}
    assert HelperSettings(path=config).is_enabled("monty") is False


def test_helper_status_says_disabled_held_and_quarantined_in_three_different_words(
    tmp_path: Path,
) -> None:
    """One line each, and never one state printed as another."""
    root = tmp_path / "addons"
    config = tmp_path / "config.toml"
    quarantine = tmp_path / "quarantine.json"

    _install(root, document("switched-off"))
    _install(root, document("incomplete", settings=[REQUIRED_FOLDER]))
    _install(root, document("given-up-on"))

    HelperSettings(path=config).set_enabled("switched-off", False)
    QuarantineFile(path=quarantine).save({"given-up-on": "exited with code 1 five times"})

    result = CliRunner().invoke(
        cli,
        [
            "helper",
            "status",
            "--run-state",
            str(tmp_path / "absent.json"),
            "--quarantine",
            str(quarantine),
            "--notices",
            str(tmp_path / "absent-notices.json"),
            "--config",
            str(config),
            "--addons-root",
            str(root),
        ],
    )

    assert result.exit_code == 0, result.output
    assert "switched-off: disabled" in result.output
    assert "incomplete: held-disabled" in result.output
    assert "root is required and has no value" in result.output
    assert "given-up-on: quarantined" in result.output
    assert "exited with code 1 five times" in result.output


def test_the_window_shows_the_three_states_as_three_different_rows(tmp_path: Path) -> None:
    """The window draws from the same answer the command line prints."""
    config = tmp_path / "config.toml"
    settings = HelperSettings(path=config)

    states = [
        ("switched-off", plugin_state(enabled=False)),
        ("incomplete", plugin_state(enabled=True, held="held disabled: root has no value")),
        ("given-up-on", plugin_state(enabled=True, quarantine="crashed five times")),
        ("fine", plugin_state(enabled=True)),
    ]

    window = ApplicationWindow(
        desktop=HeadlessDesktop(),
        settings=settings,
        launch_at_login=LaunchAtLogin(settings=settings, login_item=_ObligingLoginItem()),
        quit=lambda reason: pytest.fail("nothing here quits anything"),
        plugins=lambda: states,
    )

    contents = window.contents()
    rows = {row.plugin_id: row.availability for row in contents.plugins}

    assert rows == {
        "switched-off": PluginAvailability.DISABLED,
        "incomplete": PluginAvailability.HELD,
        "given-up-on": PluginAvailability.QUARANTINED,
        "fine": PluginAvailability.ENABLED,
    }
    assert contents.plugin("switched-off") is not None
    assert contents.plugin("switched-off").enabled is False  # type: ignore[union-attr]
    assert contents.plugin("incomplete").enabled is True  # type: ignore[union-attr]


# --- held disabled clears itself; a user's disable does not ------------------------------------


def test_a_held_plugin_starts_once_its_required_settings_are_filled_in(
    make_harness: Callable[..., Harness], tmp_path: Path
) -> None:
    """F1: the switch turns itself on when the form is complete, with nothing to flip.

    The plugin is enabled throughout — the file never records a switch — and the only thing
    that changes between the two starts is a value in its settings file.
    """
    root = tmp_path / "addons"
    plugins = [installed(root, manifest("monty", settings=[REQUIRED_FOLDER]))]
    harness = make_harness(addons=plugins, dead_on_arrival=False)

    assert harness.enabled_in_the_file("monty") is True
    assert harness.gate("monty") == PluginAvailability.HELD
    harness.supervisor.start_all()
    assert harness.spawns == []

    store = SettingsStore(
        "monty",
        plugins[0].manifest.settings,
        path=tmp_path / "plugins" / "monty.toml",
    )
    assert store.write({"root": "/recordings"}, by=USER).accepted

    assert harness.gate("monty") is None
    harness.supervisor.start_all()
    assert harness.spawns == ["monty"]
    assert not harness.config.exists()


def test_a_plugin_disabled_by_hand_stays_off_until_it_is_enabled_again(
    make_harness: Callable[..., Harness],
) -> None:
    """The other half of F1: an ordinary disable never turns itself back on.

    Nothing about the plugin changes except the switch, and no amount of starting the host
    brings it back until the switch is flipped by hand.
    """
    harness = make_harness(dead_on_arrival=False)
    harness.supervisor.start_all()
    harness.switch.disable("beta")
    harness.spawns.clear()

    for _ in range(3):
        harness.supervisor.start_all()

    assert harness.spawns == []
    assert harness.enabled_in_the_file("beta") is False

    harness.switch.enable("beta")

    assert harness.spawns == ["beta"]
    assert harness.enabled_in_the_file("beta") is True


def test_a_hold_is_reported_with_the_field_that_causes_it(tmp_path: Path) -> None:
    """The sentence a person acts on names the field, not just the state."""
    root = tmp_path / "addons"
    config = tmp_path / "config.toml"
    plugins = [installed(root, manifest("monty", settings=[REQUIRED_FOLDER]))]

    states = dict(
        plugin_states(
            installed=plugins,
            enabled=HelperSettings(path=config).is_enabled,
            config_path=config,
            secrets=SecretStore(root=tmp_path / "secrets"),
        )
    )

    assert states["monty"].availability is PluginAvailability.HELD
    assert states["monty"].reason is not None
    assert "root is required and has no value" in states["monty"].reason


# --- helpers ------------------------------------------------------------------------------------


class _ObligingLoginItem:
    """A login item the operating system accepts, so the window can be built."""

    def register(self) -> None:
        return None

    def unregister(self) -> None:
        return None


def _install(root: Path, recorded: Mapping[str, object]) -> None:
    """Lay one addon out on disk the way `addons install` leaves it.

    The environment directory and the recorded manifest beside it, which is the whole of what
    discovery reads — no environment is built and no addon code exists.
    """
    addon_root = root / str(recorded["id"])
    (addon_root / ENVIRONMENT_DIRNAME).mkdir(parents=True)
    (addon_root / MANIFEST_FILENAME).write_text(json.dumps(recorded), encoding="utf-8")


def test_a_held_plugins_reason_never_repeats_the_word_beside_it(tmp_path: Path) -> None:
    """The line read "held disabled: held disabled: destination is required" on screen.

    Every caller of `held_reason` pairs it with the availability word it has already drawn or
    printed — the window's plugin line, `helper status`, the page's heading — so the reason is
    what must be corrected and nothing more. `Hold.reason` still carries the whole sentence for
    a caller that shows no word of its own.
    """
    from innytypes.addons.settings import FieldProblem, Hold

    hold = Hold(
        addon_id="monty", problems=(FieldProblem("destination", "destination is required"),)
    )

    assert hold.why == "destination is required"
    assert hold.reason == "held disabled: destination is required"
    assert str(hold) == "monty is held disabled: destination is required"
