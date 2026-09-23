"""The CLI surface: `addons install`, `addons list` and `up`, driven through the real commands.

Every test below invokes the actual `click` group with `CliRunner`, because the thing this
slice adds is the command line a person types — a test that called the underlying function
would prove the wiring nobody uses.

Nothing real is behind any of it. The installer is injected and records what it was asked to
do, the spawn records argv instead of launching anything, the health client answers in
process, and every path is under `tmp_path`. No `uv` runs, no `pip` runs, no subprocess is
started and no socket is opened — which is the point of the injected installer: `up` is
proved to install nothing by counting its calls, and the same counter is asserted to *move*
when an install really happens, so the zero is a fact rather than an artefact.
"""

from __future__ import annotations

import contextlib
import io
import json
import subprocess
import sys
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field, replace
from pathlib import Path

import httpx
import pytest
from click.testing import CliRunner, Result

from conftest import FAKE_KEY
from innytypes import HOST_API_VERSION, __version__
from innytypes.addons.discovery import (
    DiscoveryResult,
    InstalledSource,
    addon_environment,
    addon_root,
    discover_addons,
    recorded_manifest_path,
    recorded_source_path,
)
from innytypes.addons.install import _MANIFEST_READER as MANIFEST_READER
from innytypes.addons.install import (
    ENTRY_POINT_GROUP,
    HOST_DISTRIBUTION,
    EditableInstall,
    InstallError,
    UvInstaller,
    host_python_version,
    host_requirement,
    host_source,
)
from innytypes.anytype_mcp.config import API_KEY_ENV_VAR, load_config
from innytypes.anytype_mcp.supervisor import Supervisor
from innytypes.children import (
    MCP_CHILD_ID,
    ChildError,
    ChildExit,
    ChildKind,
    ChildSupervisor,
    ExitReporter,
    RunStateFile,
    StartFailureReporter,
    addon_interpreter,
)
from innytypes.cli import CliContext, build_terminal_host, cli, report_exit, supervise_children
from innytypes.helper.breaker import HOST_ID
from innytypes.helper.launcher import ANYTYPE_APP_ID, HELPER_ID
from innytypes.helper.supervision import CORE_PROFILES
from innytypes.host import Host, HostReport, build_host

# --- fakes ---------------------------------------------------------------------------------


class FakeProcess:
    """Enough of a ``Popen`` for a child to be started, polled and stopped."""

    def __init__(self, pid: int) -> None:
        self.pid = pid
        # Alive until a test kills it, or until the host stops it on the way out.
        self.returncode: int | None = None

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


@dataclass
class RecordingInstaller:
    """An installer that writes down what it was asked to do and installs nothing.

    It creates the environment *directory* because that is what makes the on-disk layout
    real for discovery to read back; what would have gone inside it is a `uv` invocation
    this suite never makes.
    """

    documents: dict[str, Mapping[str, object]] = field(default_factory=dict)
    calls: list[tuple[str, ...]] = field(default_factory=list)
    # Which step to blow up at, for the tests about a failed install.
    fails_at: str | None = None
    # The wheel a build produces, for an install from a local path. Its name is the addon's
    # distribution name, which is the one thing the requirement text is built out of.
    wheel_name: str = "monty-1.4.0-py3-none-any.whl"
    # The wheel a build of the *host's* own source tree produces. Every install builds one,
    # because that is where an addon environment's `innytypes` comes from (plan 0001).
    host_wheel_name: str = f"innytypes-{__version__}-py3-none-any.whl"
    # Which document an environment built from a path exports when it is asked for its sole
    # manifest — the read that happens before anything knows what the addon is called.
    exported: str | None = None

    def build_wheel(self, source: Path, *, into: Path) -> Path:
        self.calls.append(("build_wheel", str(source), str(into)))
        self._maybe_fail("build_wheel")
        # The host's own source tree builds the host's own wheel; anything else is the addon
        # the person named a directory for.
        wheel = into / (self.host_wheel_name if source == host_source() else self.wheel_name)
        # Bytes rather than nothing, so a test that goes looking finds an artifact where the
        # requirement text says one is.
        wheel.write_bytes(b"a wheel, as far as this suite is concerned")
        return wheel

    def create_environment(self, environment: Path, *, python: str) -> None:
        self.calls.append(("create_environment", str(environment), python))
        self._maybe_fail("create_environment")
        environment.mkdir(parents=True)

    def install(
        self,
        environment: Path,
        requirements: Sequence[str],
        *,
        editable: EditableInstall | None = None,
    ) -> None:
        self.calls.append(("install", str(environment), *requirements))
        if editable is not None:
            self.calls.append(
                ("install_editable", str(environment), editable.name, str(editable.source))
            )
        self._maybe_fail("install")

    def read_manifest(
        self, environment: Path, *, addon_id: str | None = None
    ) -> Mapping[str, object]:
        # An empty name records the read that asks for the environment's sole manifest,
        # which is the only question an install from a path can ask first.
        self.calls.append(("read_manifest", str(environment), addon_id or ""))
        self._maybe_fail("read_manifest")

        wanted = self.exported if addon_id is None else addon_id
        if wanted not in self.documents:
            # What the real reader's script says when the environment exports nothing under
            # that name, which is the refusal a manifest claiming another id runs into.
            raise InstallError(
                f"this environment exports no {ENTRY_POINT_GROUP} entry point named "
                f"{wanted!r}: an addon exports its manifest from an entry point named after "
                "its own id"
            )
        return self.documents[wanted]

    def _maybe_fail(self, step: str) -> None:
        if self.fails_at == step:
            raise InstallError(f"the installer was told to fail at {step}")

    def call(self, step: str) -> tuple[str, ...]:
        """The one call to ``step``, so a test can assert its arguments."""
        made = self.calls_to(step)
        assert len(made) == 1, f"expected exactly one {step} call, got {len(made)}"
        return made[0]

    def calls_to(self, step: str) -> list[tuple[str, ...]]:
        """Every call to ``step``, in order — an install from a path reads twice."""
        return [call for call in self.calls if call[0] == step]


@dataclass
class CliHarness:
    """The CLI wired to fakes, plus everything a test needs to assert about it."""

    runner: CliRunner
    context: CliContext
    installer: RecordingInstaller
    root: Path
    run_state: RunStateFile
    # The (argv, environment) of every spawn `up` attempted, in order.
    spawns: list[tuple[list[str], dict[str, str]]]
    # Every child exit the host reported.
    exits: list[ChildExit]
    # Every supervisor `up` handed to the injected wait.
    supervised: list[ChildSupervisor]
    # Every host `up` built through the injected seam — one, if there is one start path.
    hosts: list[Host]
    # Every fake process handed out, by the process ID the host recorded for it.
    processes: dict[int, FakeProcess]

    def invoke(self, *args: str) -> Result:
        return self.runner.invoke(cli, list(args), obj=self.context, catch_exceptions=False)

    def spawned_ids(self) -> list[str]:
        """Which children were spawned, by the id in their argv."""
        return [MCP_CHILD_ID if argv[0] == "npx" else argv[-1] for argv, _env in self.spawns]


MakeHarness = Callable[..., CliHarness]


@pytest.fixture
def make_harness(tmp_path: Path) -> Iterator[MakeHarness]:
    """Build CLI harnesses that install nothing, spawn nothing and write only in ``tmp_path``."""
    clients: list[httpx.Client] = []

    def _make(*, key: str | None = FAKE_KEY, reachable: bool = True) -> CliHarness:
        root = tmp_path / "addons"
        installer = RecordingInstaller()
        spawns: list[tuple[list[str], dict[str, str]]] = []
        exits: list[ChildExit] = []
        supervised: list[ChildSupervisor] = []
        hosts: list[Host] = []
        processes: dict[int, FakeProcess] = {}
        run_state = RunStateFile(tmp_path / "run-state.json")

        def handle(request: httpx.Request) -> httpx.Response:
            if not reachable:
                raise httpx.ConnectError("connection refused", request=request)
            return httpx.Response(200)

        client = httpx.Client(transport=httpx.MockTransport(handle))
        clients.append(client)

        def spawn(
            argv: Sequence[str],
            env: dict[str, str],
            *,
            channel: int | None = None,
        ) -> FakeProcess:
            # `channel` is the addon's event channel, which a real child inherits as its
            # standard input; a fake process has nothing to do with it.
            spawns.append((list(argv), dict(env)))
            # Process IDs that could not collide with this test runner's own.
            process = FakeProcess(pid=90_000 + len(spawns))
            processes[process.pid] = process
            return process

        def mcp() -> Supervisor:
            # The real key lookup, against an environment and a key file this test owns, so
            # `key=None` fails the way a machine with no key fails — in `load_config`, rather
            # than by a hand-raised error nothing else would produce.
            environment = {} if key is None else {API_KEY_ENV_VAR: key}
            return Supervisor(
                config=load_config(env=environment, key_file=tmp_path / "absent-key"),
                spawn=spawn,  # type: ignore[arg-type]
                health_client=client,
            )

        def host(
            addons_root: Path | None,
            report_exit: ExitReporter,
            report_start_failure: StartFailureReporter,
        ) -> Host:
            # The real `build_host`, with every seam it already has pointed at this test's
            # fakes: `up` gets the production host assembly and touches nothing real.
            def record(exit_report: ChildExit) -> None:
                """Recorded here *and* passed on, so neither fact is lost.

                `up` decides where a child's exit goes — the helper when this host is
                answering to one, the terminal when it is not (plan 0008, slice 03) — and
                swallowing its reporter here would leave that decision untested while
                keeping these tests' own count.
                """
                exits.append(exit_report)
                report_exit(exit_report)

            built = build_host(
                addons_root=addons_root,
                mcp=mcp,
                spawn=spawn,
                run_state=run_state,
                report_exit=record,
                # Passed straight through: where the news that a child never started goes is
                # `up`'s decision (plan 0009 slice 02), and this harness asserts about starting
                # rather than about that seam.
                report_start_failure=report_start_failure,
                # An environment of its own, so nothing depends on the shell the gate runs in.
                environment={"PATH": "/nonexistent"},
                # Nothing holds a child back here. The enable switch and the settings hold
                # are read from this user's own files by default (plan 0004), and these tests
                # are about installing and starting: `tests/test_enable_switch.py` is where
                # the switch is exercised, against files of its own.
                holds_back=lambda child_id: None,
            )
            hosts.append(built)
            return built

        def supervise(supervisor: ChildSupervisor) -> None:
            supervised.append(supervisor)

        context = CliContext(
            installer=installer,
            addons_root=root,
            host=host,
            supervise=supervise,
        )
        return CliHarness(
            runner=CliRunner(),
            context=context,
            installer=installer,
            root=root,
            run_state=run_state,
            spawns=spawns,
            exits=exits,
            supervised=supervised,
            hosts=hosts,
            processes=processes,
        )

    yield _make

    for client in clients:
        client.close()


@pytest.fixture
def harness(make_harness: MakeHarness) -> CliHarness:
    """One harness with everything reachable, which is what most tests want."""
    return make_harness()


# --- helpers -------------------------------------------------------------------------------


def manifest_document(
    addon_id: str,
    *,
    version: str = "1.0.0",
    **overrides: object,
) -> dict[str, object]:
    """A manifest document that parses, so each test can break exactly one thing."""
    document: dict[str, object] = {
        "id": addon_id,
        "version": version,
        "host_api": HOST_API_VERSION,
        "requires": [],
        "emits": [f"{addon_id}.started.v1"],
        "subscribes": [],
    }
    document.update(overrides)
    return document


def install(
    harness: CliHarness,
    addon_id: str,
    version: str = "1.0.0",
    *,
    document: Mapping[str, object] | None = None,
    force: bool = False,
) -> Result:
    """Install one addon the way a person does: through the command line."""
    harness.installer.documents[addon_id] = (
        manifest_document(addon_id, version=version) if document is None else document
    )
    arguments = ["addons", "install", f"{addon_id}=={version}"]
    if force:
        arguments.append("--force")
    return harness.invoke(*arguments)


def break_addon(root: Path, addon_id: str) -> None:
    """Put an addon on disk that discovery cannot read, without going through install."""
    addon_environment(root, addon_id).mkdir(parents=True)
    recorded_manifest_path(root, addon_id).write_bytes(b"{ not json")


def tree_snapshot(root: Path) -> dict[str, bytes | None]:
    """Every path under ``root`` and the bytes of every file, so "untouched" is a fact."""
    return {
        str(path.relative_to(root)): path.read_bytes() if path.is_file() else None
        for path in sorted(root.rglob("*"))
    }


# --- install: the environment, the pin and the manifest ------------------------------------


def test_install_builds_the_addon_its_own_environment(harness: CliHarness) -> None:
    result = install(harness, "monty", "1.4.0")

    assert result.exit_code == 0, result.output
    environment = addon_environment(harness.root, "monty")
    assert environment.is_dir()
    assert harness.installer.call("create_environment") == (
        "create_environment",
        str(environment),
        host_python_version(),
    )


def test_install_puts_the_running_hosts_own_innytypes_in_the_environment(
    harness: CliHarness,
) -> None:
    """Where an addon environment's `innytypes` comes from: a wheel this host built of itself.

    The pin is unchanged — the environment holds exactly the version the host is running —
    but nothing asks an index for it, because no index has ever served this project.
    """
    install(harness, "monty", "1.4.0")

    _, built_from, into = harness.installer.call("build_wheel")
    assert built_from == str(host_source())

    _, environment, addon, host = harness.installer.call("install")
    assert environment == str(addon_environment(harness.root, "monty"))
    assert addon == "monty==1.4.0"
    assert host == f"{HOST_DISTRIBUTION} @ file://{Path(into) / harness.installer.host_wheel_name}"
    # The version in that wheel's name is the version this process is running, which is the
    # whole of what the pin ever asserted.
    assert host.endswith(f"-{__version__}-py3-none-any.whl")


def test_no_install_ever_asks_an_index_for_innytypes(harness: CliHarness, tmp_path: Path) -> None:
    """The regression guard, on the command line, for both sources an addon can come from.

    The failure a plugin author meets today is `innytypes was not found in the package
    registry`, and it comes from the host asking an index for itself by name. Nothing the
    installer is handed names innytypes as a version to resolve.
    """
    install(harness, "monty", "1.4.0")
    install_path(harness, source_tree(tmp_path), addon_id="whodunnit", version="2.0.0")

    made = harness.installer.calls_to("install")
    assert len(made) == 2
    for call in made:
        assert not any(argument.startswith(f"{HOST_DISTRIBUTION}==") for argument in call)
        assert any(argument.startswith(f"{HOST_DISTRIBUTION} @ file://") for argument in call)


def test_install_records_the_manifest_the_addons_entry_point_returned(
    harness: CliHarness,
) -> None:
    document = manifest_document("monty", version="1.4.0", emits=["monty.recorded.v1"])

    install(harness, "monty", "1.4.0", document=document)

    assert harness.installer.call("read_manifest") == (
        "read_manifest",
        str(addon_environment(harness.root, "monty")),
        "monty",
    )
    recorded = recorded_manifest_path(harness.root, "monty").read_text(encoding="utf-8")
    assert "monty.recorded.v1" in recorded


def test_what_install_records_is_what_discovery_reads(harness: CliHarness) -> None:
    """Install and discovery agree by construction: no manifest is written by hand here."""
    install(harness, "monty", "1.4.0")
    install(harness, "whodunnit", "2.0.0")

    found = discover_addons(harness.root)

    assert found.broken == ()
    assert [(addon.id, addon.manifest.version) for addon in found.installed] == [
        ("monty", "1.4.0"),
        ("whodunnit", "2.0.0"),
    ]
    assert found.installed[0].environment == addon_environment(harness.root, "monty")


def test_installing_one_addon_leaves_another_addons_environment_alone(
    harness: CliHarness,
) -> None:
    install(harness, "monty", "1.4.0")
    before = tree_snapshot(addon_root(harness.root, "monty"))

    install(harness, "whodunnit", "2.0.0")

    assert tree_snapshot(addon_root(harness.root, "monty")) == before
    assert addon_environment(harness.root, "whodunnit").is_dir()
    assert recorded_manifest_path(harness.root, "whodunnit").is_file()


# --- install: the refusals -----------------------------------------------------------------


def test_a_second_install_of_the_same_version_is_refused_and_changes_nothing(
    harness: CliHarness,
) -> None:
    install(harness, "monty", "1.4.0")
    before = tree_snapshot(harness.root)
    calls = list(harness.installer.calls)

    result = install(harness, "monty", "1.4.0")

    assert result.exit_code != 0
    assert "already installed" in result.output
    assert tree_snapshot(harness.root) == before
    assert harness.installer.calls == calls


def test_a_second_install_at_another_version_is_refused_as_an_update(
    harness: CliHarness,
) -> None:
    install(harness, "monty", "1.4.0")
    before = tree_snapshot(harness.root)

    result = install(harness, "monty", "1.5.0")

    assert result.exit_code != 0
    assert "is an update, not an install" in result.output
    assert tree_snapshot(harness.root) == before


def test_force_replaces_the_installation_the_refusal_protected(harness: CliHarness) -> None:
    """The mutation proof of the two refusals above: with --force the same call succeeds."""
    install(harness, "monty", "1.4.0")

    result = install(harness, "monty", "1.5.0", force=True)

    assert result.exit_code == 0, result.output
    found = discover_addons(harness.root)
    assert [(addon.id, addon.manifest.version) for addon in found.installed] == [("monty", "1.5.0")]


def test_a_failed_install_leaves_no_half_built_addon_behind(harness: CliHarness) -> None:
    harness.installer.fails_at = "install"

    result = install(harness, "monty", "1.4.0")

    assert result.exit_code != 0
    assert "the installer was told to fail at install" in result.output
    assert not addon_root(harness.root, "monty").exists()
    assert discover_addons(harness.root).broken == ()


def test_a_manifest_naming_another_addon_is_refused(harness: CliHarness) -> None:
    result = install(harness, "monty", "1.4.0", document=manifest_document("whodunnit"))

    assert result.exit_code != 0
    assert "an addon has one identity" in result.output
    assert not addon_root(harness.root, "monty").exists()


def test_a_manifest_reporting_another_version_is_refused(harness: CliHarness) -> None:
    document = manifest_document("monty", version="9.9.9")

    result = install(harness, "monty", "1.4.0", document=document)

    assert result.exit_code != 0
    assert "reports version 9.9.9" in result.output
    assert not addon_root(harness.root, "monty").exists()


def test_a_manifest_the_grammar_refuses_is_refused(harness: CliHarness) -> None:
    document = manifest_document("monty", version="1.4.0", emits=["whodunnit.transcribed.v1"])

    result = install(harness, "monty", "1.4.0", document=document)

    assert result.exit_code != 0
    assert "was refused" in result.output
    assert not addon_root(harness.root, "monty").exists()


def test_an_addon_asked_for_without_an_exact_version_is_refused(harness: CliHarness) -> None:
    result = harness.invoke("addons", "install", "monty")

    assert result.exit_code != 0
    assert "exact version" in result.output
    assert harness.installer.calls == []


def test_a_second_install_over_an_unreadable_manifest_is_still_refused(
    harness: CliHarness,
) -> None:
    """A record too broken to read is still an installation: refusing it is what protects it."""
    install(harness, "monty", "1.4.0")
    recorded_manifest_path(harness.root, "monty").write_bytes(b"{ not json")

    result = install(harness, "monty", "1.4.0")

    assert result.exit_code != 0
    assert "an unreadable manifest" in result.output
    assert recorded_manifest_path(harness.root, "monty").read_bytes() == b"{ not json"


def test_an_installation_that_cannot_be_replaced_is_refused(harness: CliHarness) -> None:
    addon_root(harness.root, "monty").parent.mkdir(parents=True)
    addon_root(harness.root, "monty").write_bytes(b"not a directory")

    result = install(harness, "monty", "1.4.0", force=True)

    assert result.exit_code != 0
    assert "could not be replaced" in result.output
    assert addon_root(harness.root, "monty").read_bytes() == b"not a directory"


# --- install from a local path -------------------------------------------------------------


def source_tree(tmp_path: Path, name: str = "a-checkout") -> Path:
    """A directory to install an addon from, named nothing like the addon it holds."""
    directory = tmp_path / name
    directory.mkdir()
    (directory / "pyproject.toml").write_text('[project]\nname = "whatever"\n', encoding="utf-8")
    return directory


def install_path(
    harness: CliHarness,
    source: Path,
    *,
    addon_id: str = "monty",
    version: str = "1.4.0",
    document: Mapping[str, object] | None = None,
    force: bool = False,
    editable: bool = False,
    root: Path | None = None,
) -> Result:
    """Install from a path the way a person does: through the command line.

    The manifest the environment will export is registered under ``addon_id``, and the
    environment is told to export it as its sole manifest — which is what makes the id the
    command discovers come from the manifest rather than from anything on the path.
    """
    harness.installer.documents[addon_id] = (
        manifest_document(addon_id, version=version) if document is None else document
    )
    harness.installer.exported = addon_id

    arguments = ["addons"]
    if root is not None:
        arguments += ["--addons-root", str(root)]
    arguments += ["install", str(source)]
    if force:
        arguments.append("--force")
    if editable:
        arguments.append("--editable")
    return harness.invoke(*arguments)


def test_installing_from_a_path_builds_an_environment_and_records_what_discovery_reads(
    harness: CliHarness, tmp_path: Path
) -> None:
    """Acceptance 1, all three halves: the environment, the manifest read inside it, the record."""
    result = install_path(harness, source_tree(tmp_path))

    assert result.exit_code == 0, result.output
    assert addon_environment(harness.root, "monty").is_dir()
    assert [call[0] for call in harness.installer.calls] == [
        # The addon's own wheel, then the host's: two artifacts on this machine, and neither
        # of them resolved from anywhere.
        "build_wheel",
        "build_wheel",
        "create_environment",
        "install",
        "read_manifest",
        "read_manifest",
    ]
    found = discover_addons(harness.root)
    assert found.broken == ()
    assert [(addon.id, addon.manifest.version) for addon in found.installed] == [("monty", "1.4.0")]
    assert found.installed[0].environment == addon_environment(harness.root, "monty")


def test_installing_from_a_path_installs_the_artifact_built_from_it_and_the_hosts_pin(
    harness: CliHarness, tmp_path: Path
) -> None:
    """A directory is never what gets installed: the wheel built from it is (acceptance 2)."""
    source = source_tree(tmp_path)

    install_path(harness, source)

    addon_build, host_build = harness.installer.calls_to("build_wheel")
    assert addon_build[1] == str(source.resolve())
    assert host_build[1] == str(host_source())

    _, _, artifact, host = harness.installer.call("install")
    assert artifact == f"monty @ file://{Path(addon_build[2]) / harness.installer.wheel_name}"
    assert host == (
        f"{HOST_DISTRIBUTION} @ file://{Path(host_build[2]) / harness.installer.host_wheel_name}"
    )


def test_installing_from_a_wheel_installs_that_wheel_and_builds_no_addon(
    harness: CliHarness, tmp_path: Path
) -> None:
    wheel = tmp_path / "monty-1.4.0-py3-none-any.whl"
    wheel.write_bytes(b"a wheel somebody built earlier")

    result = install_path(harness, wheel)

    assert result.exit_code == 0, result.output
    # One build, and it is the host's own: a wheel that already exists is not rebuilt, and
    # the host's has to be built whatever the addon came from.
    assert [call[1] for call in harness.installer.calls_to("build_wheel")] == [str(host_source())]
    _, _, artifact, _host = harness.installer.call("install")
    assert artifact == f"monty @ file://{wheel}"


def test_the_id_and_the_version_come_from_the_manifest_not_from_the_path(
    harness: CliHarness, tmp_path: Path
) -> None:
    """Acceptance 3: the directory says one thing, the manifest says another, the manifest wins."""
    source = source_tree(tmp_path, name="whodunnit-9.9.9")

    result = install_path(harness, source, addon_id="monty", version="1.4.0")

    assert result.exit_code == 0, result.output
    assert not addon_root(harness.root, "whodunnit-9.9.9").exists()
    assert [entry.name for entry in sorted(harness.root.iterdir())] == ["monty"]
    assert "Installed monty 1.4.0" in result.output
    assert discover_addons(harness.root).installed[0].manifest.version == "1.4.0"


def test_the_manifest_is_read_again_under_the_id_it_claims(
    harness: CliHarness, tmp_path: Path
) -> None:
    """The id in the entry point and the id in the manifest are one string, or nothing is
    installed — the same rule an install from an index obeys, asked of a source that states
    no id at all."""
    install_path(harness, source_tree(tmp_path))

    first, second = harness.installer.calls_to("read_manifest")
    assert first[2] == ""
    assert second[2] == "monty"


def test_a_manifest_claiming_an_id_the_environment_does_not_export_is_refused(
    harness: CliHarness, tmp_path: Path
) -> None:
    harness.installer.documents["monty"] = manifest_document("whodunnit")
    harness.installer.exported = "monty"

    result = harness.invoke("addons", "install", str(source_tree(tmp_path)))

    assert result.exit_code != 0
    assert "exports no innytypes.addons entry point named 'whodunnit'" in result.output
    assert list(harness.root.iterdir()) == []


def test_a_manifest_the_grammar_refuses_is_refused_for_a_path_too(
    harness: CliHarness, tmp_path: Path
) -> None:
    document = manifest_document("monty", version="1.4.0", emits=["whodunnit.transcribed.v1"])

    result = install_path(harness, source_tree(tmp_path), document=document)

    assert result.exit_code != 0
    assert "was refused" in result.output
    assert list(harness.root.iterdir()) == []


def test_reinstalling_the_same_checkout_needs_no_force(harness: CliHarness, tmp_path: Path) -> None:
    """The author's loop: build this checkout again, including at a new version.

    The refusal exists to stop an installation being replaced by code from somewhere else,
    and the recorded source is what tells the two apart.
    """
    source = source_tree(tmp_path)
    install_path(harness, source)

    result = install_path(harness, source, version="1.5.0")

    assert result.exit_code == 0, result.output
    found = discover_addons(harness.root)
    assert [(addon.id, addon.manifest.version) for addon in found.installed] == [("monty", "1.5.0")]


def test_an_installation_from_another_checkout_is_refused_and_changes_nothing(
    harness: CliHarness, tmp_path: Path
) -> None:
    """Acceptance 4, where it still applies: this is somebody else's code arriving."""
    install_path(harness, source_tree(tmp_path, name="the-one-installed"))
    before = tree_snapshot(harness.root)

    result = install_path(harness, source_tree(tmp_path, name="a-different-clone"))

    assert result.exit_code != 0
    assert "already installed" in result.output
    assert "is from somewhere else" in result.output
    assert "the-one-installed" in result.output, (
        "the refusal names where the installed one came from"
    )
    assert tree_snapshot(harness.root) == before


def test_an_addon_installed_from_an_index_is_not_replaced_by_a_checkout_without_force(
    harness: CliHarness, tmp_path: Path
) -> None:
    """An index install records no source, so no checkout can claim to be the one it came from."""
    install(harness, "monty", "1.4.0")
    before = tree_snapshot(harness.root)

    result = install_path(harness, source_tree(tmp_path))

    assert result.exit_code != 0
    assert "from a package index" in result.output
    assert tree_snapshot(harness.root) == before


def test_an_installation_whose_source_record_is_broken_is_still_protected(
    harness: CliHarness, tmp_path: Path
) -> None:
    """A record nobody can read cannot say this is the same checkout, so the refusal stands —
    and the message says that rather than inventing a provenance the file never stated."""
    source = source_tree(tmp_path)
    install_path(harness, source)
    recorded_source_path(harness.root, "monty").write_bytes(b"{ not json")
    before = tree_snapshot(harness.root)

    result = install_path(harness, source)

    assert result.exit_code != 0
    assert "whose record this host cannot read" in result.output
    assert tree_snapshot(harness.root) == before


def test_force_replaces_an_installation_that_came_from_another_source(
    harness: CliHarness, tmp_path: Path
) -> None:
    """The mutation proof of the two refusals above: with --force the same command succeeds."""
    install(harness, "monty", "1.4.0")

    result = install_path(harness, source_tree(tmp_path), version="1.5.0", force=True)

    assert result.exit_code == 0, result.output
    found = discover_addons(harness.root)
    assert [(addon.id, addon.manifest.version) for addon in found.installed] == [("monty", "1.5.0")]
    assert found.installed[0].source is not None


def test_a_failed_install_from_a_path_leaves_nothing_under_the_addons_root(
    harness: CliHarness, tmp_path: Path
) -> None:
    harness.installer.fails_at = "install"

    result = install_path(harness, source_tree(tmp_path))

    assert result.exit_code != 0
    assert "the installer was told to fail at install" in result.output
    assert list(harness.root.iterdir()) == []
    assert discover_addons(harness.root) == DiscoveryResult(installed=(), broken=())


def test_a_path_that_is_not_there_is_refused_naming_both_spellings(harness: CliHarness) -> None:
    result = harness.invoke("addons", "install", "./no-such-checkout")

    assert result.exit_code != 0
    assert "exact version" in result.output
    assert "nor a path on this machine" in result.output
    assert harness.installer.calls == []


def test_a_source_that_is_neither_a_directory_nor_a_wheel_is_refused(
    harness: CliHarness, tmp_path: Path
) -> None:
    sdist = tmp_path / "monty-1.4.0.tar.gz"
    sdist.write_bytes(b"not a wheel")

    result = harness.invoke("addons", "install", str(sdist))

    assert result.exit_code != 0
    assert "neither a directory nor a wheel" in result.output
    assert list(harness.root.iterdir()) == []


def test_the_addons_root_option_installs_where_it_says(harness: CliHarness, tmp_path: Path) -> None:
    """The option a person needs to try an addon out somewhere that is not their own root."""
    elsewhere = tmp_path / "elsewhere"

    result = install_path(harness, source_tree(tmp_path), root=elsewhere)

    assert result.exit_code == 0, result.output
    assert addon_environment(elsewhere, "monty").is_dir()
    assert not harness.root.exists()
    assert [addon.id for addon in discover_addons(elsewhere).installed] == ["monty"]

    listed = harness.invoke("addons", "--addons-root", str(elsewhere), "list")
    assert "monty  1.4.0  installed" in listed.output


# --- the plugin author's loop: an editable install ------------------------------------------


def test_an_editable_install_points_the_environment_at_the_checkout(
    harness: CliHarness, tmp_path: Path
) -> None:
    source = source_tree(tmp_path)

    result = install_path(harness, source, editable=True)

    assert result.exit_code == 0, result.output
    _, _, name, pointed_at = harness.installer.call("install_editable")
    assert name == "monty", "the lock knows the addon by its distribution name"
    assert pointed_at == str(source.resolve())


def test_an_editable_install_says_at_install_time_that_it_is_not_locked(
    harness: CliHarness, tmp_path: Path
) -> None:
    """The guarantee changes here, and the person who changed it is standing right here."""
    source = source_tree(tmp_path)

    result = install_path(harness, source, editable=True)

    assert str(source.resolve()) in result.output
    assert "which is not locked" in result.output
    assert "restart the addon" in result.output


def test_a_locally_installed_addon_records_where_it_came_from(
    harness: CliHarness, tmp_path: Path
) -> None:
    source = source_tree(tmp_path)

    install_path(harness, source)

    recorded = json.loads(recorded_source_path(harness.root, "monty").read_text(encoding="utf-8"))
    assert recorded == {"editable": False, "path": str(source.resolve())}
    (addon,) = discover_addons(harness.root).installed
    assert addon.source == InstalledSource(path=source.resolve(), editable=False)


def test_an_editable_installation_is_recorded_as_editable(
    harness: CliHarness, tmp_path: Path
) -> None:
    source = source_tree(tmp_path)

    install_path(harness, source, editable=True)

    (addon,) = discover_addons(harness.root).installed
    assert addon.source == InstalledSource(path=source.resolve(), editable=True)


def test_an_addon_from_an_index_records_no_source_and_reads_back_as_none(
    harness: CliHarness,
) -> None:
    install(harness, "monty", "1.4.0")

    assert not recorded_source_path(harness.root, "monty").exists()
    assert discover_addons(harness.root).installed[0].source is None


def test_list_shows_which_checkout_an_addon_was_installed_from(
    harness: CliHarness, tmp_path: Path
) -> None:
    """At a glance, and the editable one says so: those are different guarantees."""
    install_path(harness, source_tree(tmp_path, name="monty-checkout"))
    install_path(harness, source_tree(tmp_path, name="whodunnit-checkout"), addon_id="whodunnit")
    install(harness, "from-an-index", "3.0.0")

    lines = harness.invoke("addons", "list").output.splitlines()

    assert f"monty  1.4.0  installed  (from {tmp_path / 'monty-checkout'})" in lines
    assert "from-an-index  3.0.0  installed" in lines

    harness.invoke("addons", "install", str(tmp_path / "whodunnit-checkout"), "--editable")
    listed = harness.invoke("addons", "list").output
    assert (
        f"whodunnit  1.4.0  installed  (editable from {tmp_path / 'whodunnit-checkout'})" in listed
    )


def test_a_source_record_that_cannot_be_read_is_a_broken_addon(
    harness: CliHarness, tmp_path: Path
) -> None:
    """It is the file that says whether this addon can still be edited underneath us, so a
    record nobody can read is not quietly treated as "came from an index"."""
    install_path(harness, source_tree(tmp_path))
    recorded_source_path(harness.root, "monty").write_text('{"editable": "sort of"}', "utf-8")

    found = discover_addons(harness.root)

    assert found.installed == ()
    assert [broken.id for broken in found.broken] == ["monty"]
    assert "source" in found.broken[0].reason


def test_a_wheel_cannot_be_installed_editable(harness: CliHarness, tmp_path: Path) -> None:
    wheel = tmp_path / "monty-1.4.0-py3-none-any.whl"
    wheel.write_bytes(b"a wheel somebody built earlier")

    result = install_path(harness, wheel, editable=True)

    assert result.exit_code != 0
    assert "a wheel cannot be installed editable" in result.output
    assert not harness.root.exists(), "refused before anything was created"


def test_an_addon_from_an_index_cannot_be_installed_editable(harness: CliHarness) -> None:
    result = harness.invoke("addons", "install", "monty==1.4.0", "--editable")

    assert result.exit_code != 0
    assert "--editable installs a checkout" in result.output
    assert harness.installer.calls == []


def test_up_installs_nothing_after_an_addon_was_installed_from_a_path(
    harness: CliHarness, tmp_path: Path
) -> None:
    """Acceptance 5: a local source changes nothing about a startup that installs nothing."""
    install_path(harness, source_tree(tmp_path))
    after_install = list(harness.installer.calls)
    assert after_install != [], "the installer must really have been called by the install"

    result = harness.invoke("up")

    assert result.exit_code == 0, result.output
    assert harness.spawns != [], "up must really have started the host"
    assert harness.installer.calls == after_install


# --- list ----------------------------------------------------------------------------------


def test_list_prints_every_installed_addon_with_its_id_version_and_status(
    harness: CliHarness,
) -> None:
    install(harness, "monty", "1.4.0")
    install(harness, "whodunnit", "2.0.0")

    result = harness.invoke("addons", "list")

    assert result.exit_code == 0, result.output
    assert "monty  1.4.0  installed" in result.output
    assert "whodunnit  2.0.0  installed" in result.output


def test_list_prints_a_broken_addon_with_its_reason_rather_than_omitting_it(
    harness: CliHarness,
) -> None:
    install(harness, "monty", "1.4.0")
    break_addon(harness.root, "wrecked")

    result = harness.invoke("addons", "list")

    assert "monty  1.4.0  installed" in result.output
    assert "wrecked" in result.output
    assert "broken: " in result.output
    assert "not valid JSON" in result.output


def test_list_says_so_when_nothing_is_installed(harness: CliHarness) -> None:
    result = harness.invoke("addons", "list")

    assert result.exit_code == 0
    assert result.output.strip() == "No addons installed."


def test_a_core_child_declaring_a_profile_is_still_not_an_installed_addon(
    harness: CliHarness,
) -> None:
    """Plan 0010 gives core children somewhere to declare; the addons inventory must not care.

    The host, the MCP child, Anytype and the helper now go through the same profile lookup a
    plugin goes through, which is the whole of slice 01. None of them is thereby something a
    person installed: `addons list` shows what was built into an environment on this machine,
    and a command naming a core child as an addon is refused by name — exactly as both were
    before any core child could declare anything.
    """
    install(harness, "monty", "1.4.0")

    listed = harness.invoke("addons", "list")
    assert listed.exit_code == 0, listed.output
    # Read as ids rather than searched for as text, so a core child printed in any shape at
    # all fails this rather than only one spelling of it.
    assert {line.split()[0] for line in listed.output.splitlines() if line.strip()} == {"monty"}

    for core_id in (HOST_ID, MCP_CHILD_ID, ANYTYPE_APP_ID, HELPER_ID):
        refused = harness.invoke("addons", "update", core_id)
        assert refused.exit_code == 1, refused.output
        assert f"{core_id} is not installed" in refused.output

    # And the declarations themselves can never be an addon's: a plugin declares in its own
    # manifest, and that is what keeps the two apart.
    assert ChildKind.ADDON not in CORE_PROFILES


# --- up --------------------------------------------------------------------------------


def test_up_starts_the_mcp_child_and_every_installed_addon(harness: CliHarness) -> None:
    install(harness, "monty", "1.4.0")

    result = harness.invoke("up")

    assert result.exit_code == 0, result.output
    assert harness.spawned_ids() == [MCP_CHILD_ID, "monty"]
    assert f"started {MCP_CHILD_ID}" in result.output
    assert "started monty" in result.output


def test_up_launches_an_addon_with_its_own_environments_interpreter(
    harness: CliHarness,
) -> None:
    install(harness, "monty", "1.4.0")

    harness.invoke("up")

    argv, _environment = harness.spawns[-1]
    assert argv[0] == str(addon_interpreter(addon_environment(harness.root, "monty")))


def test_up_installs_nothing_though_installing_does(harness: CliHarness) -> None:
    """The zero is a fact: the same counter moved when an install actually happened."""
    install(harness, "monty", "1.4.0")
    after_install = list(harness.installer.calls)
    # Without this line the zero below would also pass against an installer nobody ever calls.
    assert after_install != []

    result = harness.invoke("up")

    assert result.exit_code == 0, result.output
    assert harness.spawns != [], "up must really have started the host"
    assert harness.installer.calls == after_install


def test_up_and_list_back_to_back_install_nothing(harness: CliHarness) -> None:
    break_addon(harness.root, "wrecked")

    assert harness.invoke("up").exit_code == 0
    assert harness.invoke("addons", "list").exit_code == 0

    assert harness.installer.calls == []


def test_up_names_a_broken_addon_and_starts_everything_else(harness: CliHarness) -> None:
    install(harness, "monty", "1.4.0")
    break_addon(harness.root, "wrecked")

    result = harness.invoke("up")

    assert "skipped wrecked" in result.output
    assert harness.spawned_ids() == [MCP_CHILD_ID, "monty"]


def test_up_names_an_addon_the_resolver_holds_back_and_never_spawns_it(
    harness: CliHarness,
) -> None:
    document = manifest_document("gamma", version="1.0.0", requires=["beta==1.0.0"])
    install(harness, "gamma", "1.0.0", document=document)

    result = harness.invoke("up")

    assert "held back gamma" in result.output
    assert harness.spawned_ids() == [MCP_CHILD_ID]


def test_up_stops_every_child_it_started(harness: CliHarness) -> None:
    install(harness, "monty", "1.4.0")

    harness.invoke("up")

    assert [report.id for report in harness.exits] == ["monty", MCP_CHILD_ID]
    assert all(report.expected for report in harness.exits)
    # No record survives the process it describes; a leftover is the phantom the helper hunts.
    assert harness.run_state.records() == ()


def test_up_hands_the_running_host_to_the_wait_it_was_given(harness: CliHarness) -> None:
    install(harness, "monty", "1.4.0")

    harness.invoke("up")

    assert len(harness.supervised) == 1
    assert harness.supervised[0].start_order == (MCP_CHILD_ID, "monty")


def test_up_reports_an_unreachable_anytype_and_starts_every_addon_anyway(
    make_harness: MakeHarness,
) -> None:
    """Anytype is not running: `up` says so, starts the rest, and exits 0.

    This test asserted the opposite — a refusal with nothing spawned — while `up` assembled
    its own children and `innytypes.host` degraded in a file nobody called. Both cannot be
    right, and plan 0001 invariant 5 says which one is: a missing requirement degrades.
    """
    harness = make_harness(reachable=False)
    install(harness, "monty", "1.4.0")

    result = harness.invoke("up")

    assert result.exit_code == 0, result.output
    assert "did not answer" in result.output
    assert f"not started {MCP_CHILD_ID}" in result.output
    assert harness.spawned_ids() == ["monty"]


def test_up_reports_a_missing_key_and_starts_every_addon_anyway(
    make_harness: MakeHarness,
) -> None:
    """No key on this machine: the host has no MCP child, says where to put one, exits 0."""
    harness = make_harness(key=None)
    install(harness, "monty", "1.4.0")

    result = harness.invoke("up")

    assert result.exit_code == 0, result.output
    assert API_KEY_ENV_VAR in result.output
    assert f"not started {MCP_CHILD_ID}" in result.output
    assert harness.spawned_ids() == ["monty"]


class RefusingHost(Host):
    """A host that starts one child and then refuses, the way an unspawnable child does.

    :class:`~innytypes.children.ChildError` is the family `innytypes.children` raises when a
    child cannot be started at all — a missing interpreter, a child this host does not have —
    which is a broken installation on this machine rather than a designed degradation.
    """

    def start(self) -> HostReport:
        self.children.start(MCP_CHILD_ID)
        raise ChildError("monty could not be started: its interpreter is missing")


def test_up_refuses_loudly_when_a_child_cannot_be_started_at_all(
    make_harness: MakeHarness,
) -> None:
    """The one failure that is not a degradation, and what `up` leaves behind when it hits it.

    A missing requirement degrades (the two tests above); a child that cannot be spawned is a
    machine that cannot run what it says is installed, and there is nothing to wait for. What
    matters as much as the refusal is that the child which *did* start is stopped first: a
    refusing `up` that left one running would leave a process nothing owns.
    """
    harness = make_harness()
    # Nowhere: this test reads `harness.exits`, which the harness records on its own way
    # past, and a second destination here would count every exit twice.
    built = harness.context.host(harness.root, lambda _exit: None, lambda _failure: None)
    context = replace(
        harness.context,
        host=lambda _root, _exits, _failures: RefusingHost(children=built.children),
    )

    result = harness.runner.invoke(cli, ["up"], obj=context, catch_exceptions=False)

    assert result.exit_code != 0
    assert "its interpreter is missing" in result.output
    assert [report.id for report in harness.exits] == [MCP_CHILD_ID]
    assert harness.run_state.records() == ()
    # Never waited on a host that never came up.
    assert harness.supervised == []


def test_up_prints_the_hosts_own_report_and_assembles_nothing_of_its_own(
    make_harness: MakeHarness,
) -> None:
    """One start path: what `up` prints is what `Host.start()` returned.

    The two assertions that say so are the host count and the identity of the supervisor
    handed to the wait — a second assembly would show up as a supervisor `up` built itself.
    The degradation line names a `Degradation.component`, which exists nowhere but the
    report, and the command still exits 0 with the addon running.
    """
    harness = make_harness(reachable=False)
    install(harness, "monty", "1.4.0")

    result = harness.invoke("up")

    assert len(harness.hosts) == 1
    assert harness.supervised == [harness.hosts[0].children]
    assert result.exit_code == 0, result.output
    assert f"  not started {MCP_CHILD_ID}: " in result.output
    assert harness.spawned_ids() == ["monty"]


# --- the production wiring `up` uses when nothing is injected ------------------------------


def test_the_host_up_builds_when_nothing_is_injected_is_the_hosts_own(
    monkeypatch: pytest.MonkeyPatch,
    harness: CliHarness,
) -> None:
    """`up`'s default is `innytypes.host.build_host`, with the terminal as the exit reporter."""
    monkeypatch.setenv(API_KEY_ENV_VAR, FAKE_KEY)
    install(harness, "monty", "1.4.0")

    host = build_terminal_host(harness.root)

    assert type(host) is Host
    assert host.children.start_order == (MCP_CHILD_ID, "monty")
    assert host.broken == ()


def test_supervising_reports_a_child_that_exited_and_starts_nothing_in_its_place(
    harness: CliHarness,
) -> None:
    install(harness, "monty", "1.4.0")
    host = harness.context.host(harness.root, lambda _exit: None, lambda _failure: None)
    supervisor = host.children
    records = host.start().started
    spawns_before = len(harness.spawns)

    # The addon dies on its own, which is the only thing this loop is there to notice.
    harness.processes[records[-1].pid].returncode = 3

    def sleep(interval: float) -> None:
        raise KeyboardInterrupt

    supervise_children(supervisor, sleep=sleep)

    assert [(report.id, report.exit_code) for report in harness.exits] == [("monty", 3)]
    assert all(not report.expected for report in harness.exits)
    # Nothing was started in its place: restart policy lives in the helper, not here.
    assert len(harness.spawns) == spawns_before


def test_a_child_that_exits_is_printed_for_whoever_is_watching_up(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """The reporter a host with no helper runs with: the person watching the terminal."""
    report_exit(ChildExit(id="monty", kind=ChildKind.ADDON, pid=4321, exit_code=3, expected=False))

    assert "monty exited (process 4321) with code 3" in capsys.readouterr().out


# --- the real installer: the commands it builds, never run ---------------------------------


@dataclass
class RecordingRunner:
    """A command runner that records argv and answers with whatever the test wants."""

    output: str = ""
    error: Exception | None = None
    argvs: list[list[str]] = field(default_factory=list)

    def __call__(self, argv: Sequence[str]) -> str:
        self.argvs.append(list(argv))
        if self.error is not None:
            raise self.error
        return self.output


# --- where the host's own innytypes comes from ---------------------------------------------


def test_the_host_finds_the_source_tree_it_was_installed_from(tmp_path: Path) -> None:
    """The src layout this project uses: the package, then `src/`, then the project root."""
    package = tmp_path / "somewhere" / "src" / "innytypes"
    package.mkdir(parents=True)
    (tmp_path / "somewhere" / "pyproject.toml").write_text(
        '[project]\nname = "InnyTypes"\n', encoding="utf-8"
    )

    # Spelled with a capital and compared as a distribution name, because that is what it is.
    assert host_source(package) == tmp_path / "somewhere"


def test_the_host_finds_a_flat_layout_too(tmp_path: Path) -> None:
    package = tmp_path / "somewhere" / "innytypes"
    package.mkdir(parents=True)
    (tmp_path / "somewhere" / "pyproject.toml").write_text(
        '[project]\nname = "innytypes"\n', encoding="utf-8"
    )

    assert host_source(package) == tmp_path / "somewhere"


def test_a_pyproject_for_another_project_is_not_this_hosts_source(tmp_path: Path) -> None:
    """A package copied into somebody else's tree would otherwise build their wheel."""
    package = tmp_path / "somewhere" / "innytypes"
    package.mkdir(parents=True)
    (tmp_path / "somewhere" / "pyproject.toml").write_text(
        '[project]\nname = "whatever"\n', encoding="utf-8"
    )

    with pytest.raises(InstallError, match="no source tree to build a wheel from"):
        host_source(package)


def test_a_host_with_no_source_tree_refuses_instead_of_falling_back_to_an_index(
    tmp_path: Path,
) -> None:
    """A bundled application, or one unpacked into `site-packages`, has no source tree.

    The refusal is the answer. Resolving `innytypes` from an index instead would put a
    different innytypes in the addon's environment than the one running, which is exactly
    what the version in every addon environment exists to rule out.
    """
    package = tmp_path / "site-packages" / "innytypes"
    package.mkdir(parents=True)

    with pytest.raises(InstallError) as refusal:
        host_source(package)

    assert "no source tree to build a wheel from" in str(refusal.value)
    assert "would install a different innytypes" in str(refusal.value)
    assert str(tmp_path / "site-packages") in str(refusal.value)


def test_the_host_requirement_is_the_wheel_the_host_built_of_itself(tmp_path: Path) -> None:
    installer = RecordingInstaller()

    requirement = host_requirement(installer=installer, into=tmp_path / "host")

    assert requirement == (
        f"{HOST_DISTRIBUTION} @ file://{tmp_path / 'host' / installer.host_wheel_name}"
    )
    assert (tmp_path / "host" / installer.host_wheel_name).is_file()


def test_a_source_tree_that_builds_another_version_of_the_host_is_refused(
    tmp_path: Path,
) -> None:
    """A checkout that has moved past the installation importing it builds the wrong host.

    Installing it would leave the addon's environment holding an `innytypes` that is not the
    one running, which is the failure the version in every addon environment exists to name.
    """
    installer = RecordingInstaller(host_wheel_name="innytypes-9.9.9-py3-none-any.whl")

    with pytest.raises(InstallError, match="builds innytypes 9.9.9, but this host is running"):
        host_requirement(installer=installer, into=tmp_path / "host")


def test_the_uv_installer_creates_the_environment_on_the_hosts_own_python(
    tmp_path: Path,
) -> None:
    runner = RecordingRunner()

    UvInstaller(run=runner).create_environment(tmp_path / "env", python=host_python_version())

    assert runner.argvs == [
        ["uv", "venv", "--python", host_python_version(), str(tmp_path / "env")]
    ]


def test_the_uv_installer_builds_one_wheel_from_a_source_tree(tmp_path: Path) -> None:
    """A directory has no artifact to hash, so the install makes one and hashes that."""
    into = tmp_path / "build"
    into.mkdir()
    source = tmp_path / "a-checkout"
    argvs: list[list[str]] = []

    def build(argv: Sequence[str]) -> str:
        argvs.append(list(argv))
        (into / "monty-1.4.0-py3-none-any.whl").write_bytes(b"built")
        return f"Successfully built {into / 'monty-1.4.0-py3-none-any.whl'}"

    wheel = UvInstaller(run=build).build_wheel(source, into=into)

    assert argvs == [["uv", "build", "--wheel", "--out-dir", str(into), str(source)]]
    # The wheel is found by looking in the directory this build owns, not by parsing a line
    # of `uv` output whose wording is not a contract.
    assert wheel == into / "monty-1.4.0-py3-none-any.whl"


def test_a_build_that_leaves_no_single_wheel_behind_is_refused(tmp_path: Path) -> None:
    """Which artifact was installed has to be a fact, not a guess between two files."""
    into = tmp_path / "build"
    into.mkdir()

    installer = UvInstaller(run=RecordingRunner())

    with pytest.raises(InstallError, match="produced 0 wheels"):
        installer.build_wheel(tmp_path / "a-checkout", into=into)


def test_the_uv_installer_locks_with_hashes_before_it_installs(tmp_path: Path) -> None:
    """Two commands, in this order: resolve to a hash lock, then install from it alone.

    The lock and every refusal around it are covered in `test_plugin_environments.py`; what
    this asserts is the pair of argv the real installer builds (plan 0003, D16).
    """
    environment = tmp_path / "env"
    lock = (
        f"monty==1.4.0 --hash=sha256:{'1' * 64}\n"
        f"innytypes=={__version__} --hash=sha256:{'2' * 64}\n"
    )
    runner = RecordingRunner(output=lock)

    UvInstaller(run=runner).install(environment, ("monty==1.4.0", f"innytypes=={__version__}"))

    compile_argv, install_argv = runner.argvs
    assert compile_argv[:6] == [
        "uv",
        "pip",
        "compile",
        "--generate-hashes",
        "--python",
        str(addon_interpreter(environment)),
    ]
    assert install_argv == [
        "uv",
        "pip",
        "install",
        "--python",
        str(addon_interpreter(environment)),
        "--require-hashes",
        "--no-deps",
        "--requirement",
        str(tmp_path / "lock.txt"),
    ]


def test_the_uv_installer_reads_the_manifest_with_the_addons_own_interpreter(
    tmp_path: Path,
) -> None:
    runner = RecordingRunner(output='{"id": "monty"}')
    environment = tmp_path / "env"

    document = UvInstaller(run=runner).read_manifest(environment, addon_id="monty")

    assert document == {"id": "monty"}
    argv = runner.argvs[0]
    assert argv[0] == str(addon_interpreter(environment))
    assert argv[1] == "-c"
    assert argv[3] == "monty"


def test_a_manifest_that_is_not_json_is_refused(tmp_path: Path) -> None:
    installer = UvInstaller(run=RecordingRunner(output="not json at all"))

    with pytest.raises(InstallError, match="did not return a JSON document"):
        installer.read_manifest(tmp_path / "env", addon_id="monty")


def test_a_manifest_that_is_not_an_object_is_refused(tmp_path: Path) -> None:
    installer = UvInstaller(run=RecordingRunner(output="[1, 2, 3]"))

    with pytest.raises(InstallError, match="not a manifest object"):
        installer.read_manifest(tmp_path / "env", addon_id="monty")


def test_a_failing_installer_command_is_refused_with_what_it_printed(tmp_path: Path) -> None:
    failure = subprocess.CalledProcessError(returncode=1, cmd=["uv"], stderr="no such package")
    installer = UvInstaller(run=RecordingRunner(error=failure))

    with pytest.raises(InstallError, match="no such package"):
        installer.create_environment(tmp_path / "env", python="3.13")


def test_an_installer_command_that_cannot_be_run_at_all_is_refused(tmp_path: Path) -> None:
    installer = UvInstaller(run=RecordingRunner(error=FileNotFoundError("uv")))

    with pytest.raises(InstallError, match="could not be run"):
        installer.create_environment(tmp_path / "env", python="3.13")


# --- the script that reads the manifest inside the addon's environment ---------------------


@dataclass
class FakeEntryPoint:
    """One entry point, as ``importlib.metadata`` hands it over."""

    name: str
    export: object

    def load(self) -> object:
        return self.export


def read_manifest_script(
    monkeypatch: pytest.MonkeyPatch,
    *,
    name: str | None,
    entries: Sequence[FakeEntryPoint],
) -> str:
    """Run the reader script in this interpreter, against entry points the test invents.

    Run rather than shipped-and-hoped-for: it is the one piece of this slice that executes
    inside an addon's environment, where no test can follow it. ``name`` of ``None`` is the
    argv an install from a local path builds: no id, because nothing knows one yet.
    """
    monkeypatch.setattr("importlib.metadata.entry_points", lambda group: list(entries))
    monkeypatch.setattr(sys, "argv", ["-c"] if name is None else ["-c", name])

    stream = io.StringIO()
    with contextlib.redirect_stdout(stream):
        exec(MANIFEST_READER, {"__name__": "__main__"})
    return stream.getvalue()


def test_the_manifest_reader_returns_what_the_entry_point_exports(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    document = manifest_document("monty")
    entry = FakeEntryPoint(name="monty", export=lambda: document)

    output = read_manifest_script(monkeypatch, name="monty", entries=[entry])

    assert json.loads(output) == document


def test_the_manifest_reader_refuses_an_environment_that_exports_no_such_entry_point(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with pytest.raises(SystemExit) as refusal:
        read_manifest_script(monkeypatch, name="monty", entries=[])

    assert ENTRY_POINT_GROUP in str(refusal.value)
    assert "named after its own id" in str(refusal.value)


def test_the_manifest_reader_refuses_two_entry_points_with_one_name(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    entries = [
        FakeEntryPoint(name="monty", export=dict),
        FakeEntryPoint(name="monty", export=dict),
    ]

    with pytest.raises(SystemExit) as refusal:
        read_manifest_script(monkeypatch, name="monty", entries=entries)

    assert "an addon has one manifest" in str(refusal.value)


def test_the_manifest_reader_asked_for_no_name_returns_the_environments_sole_manifest(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """What an install from a path asks for: this environment holds one addon, whatever it
    is called, so its one manifest entry point is the one to read."""
    document = manifest_document("monty")
    entry = FakeEntryPoint(name="monty", export=lambda: document)

    output = read_manifest_script(monkeypatch, name=None, entries=[entry])

    assert json.loads(output) == document


@pytest.mark.parametrize("entries", [0, 2])
def test_the_manifest_reader_asked_for_no_name_refuses_anything_but_one_manifest(
    monkeypatch: pytest.MonkeyPatch, entries: int
) -> None:
    exported = [FakeEntryPoint(name=f"addon{number}", export=dict) for number in range(entries)]

    with pytest.raises(SystemExit) as refusal:
        read_manifest_script(monkeypatch, name=None, entries=exported)

    assert f"exports {entries} {ENTRY_POINT_GROUP} entry points" in str(refusal.value)
    assert "one addon exports exactly one manifest" in str(refusal.value)


def test_the_manifest_reader_refuses_an_entry_point_that_is_not_callable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    entry = FakeEntryPoint(name="monty", export={"id": "monty"})

    with pytest.raises(SystemExit) as refusal:
        read_manifest_script(monkeypatch, name="monty", entries=[entry])

    assert "is not callable" in str(refusal.value)
