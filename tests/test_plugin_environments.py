"""Plugin environments: locked with hashes, built in staging, swapped in, rolled back.

Plan 0003 D17 gives every plugin its own `uv` environment, and D16 makes the **lock** the
only thing that check an auto update: what gets installed is exactly what was resolved. So
these tests exercise the real :class:`~innytypes.addons.install.UvInstaller` — the class that
builds the `uv` argv — against a fake index that behaves the way `uv` behaves.

**The fake obeys the flags it is given**, which is what makes these tests able to fail. It
verifies an artifact's digest only when the install argv carries ``--require-hashes``, and it
installs transitive dependencies only when the argv does *not* carry ``--no-deps``. Drop
either flag from the installer and a test below goes red rather than quietly passing on a
mock that was told to be happy.

Nothing real runs: no `uv`, no `pip`, no network, no subprocess, and every path written is
under `tmp_path`.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path

import pytest
from click.testing import CliRunner, Result

from innytypes import HOST_API_VERSION, __version__
from innytypes.addons.discovery import (
    addon_environment,
    addon_root,
    discover_addons,
    recorded_manifest_path,
)
from innytypes.addons.install import (
    InstallError,
    UvInstaller,
    host_python_version,
    install_addon,
    install_addon_from_path,
)
from innytypes.addons.lock import (
    LOCK_FILENAME,
    EnvironmentLock,
    LockedRequirement,
    LockError,
    parse_lock,
    recorded_lock_path,
)
from innytypes.addons.manifest import Requirement
from innytypes.children import addon_interpreter
from innytypes.cli import CliContext, cli
from innytypes.helper.environments import (
    PREVIOUS_DIRNAME,
    STAGING_DIRNAME,
    SwapError,
    default_previous_root,
    default_staging_root,
    roll_back,
    stage_environment,
    swap_in,
)

# --- a package index that exists only in this file -----------------------------------------


def _digest(text: str) -> str:
    """The `sha256:` digest of some text, used as a stand-in for an artifact's digest."""
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class Distribution:
    """One distribution the fake index can serve, at exactly one version.

    ``tampered`` is the whole point of the class: the digest the index *publishes* and the
    digest of the artifact it *serves* come apart, which is the attack a hash lock exists to
    stop and the one an `auto` update has no other protection against (plan 0003, D16).
    """

    name: str
    version: str
    requires: tuple[str, ...] = ()
    tampered: bool = False

    @property
    def published_digest(self) -> str:
        """What the resolver would write into the lock."""
        return _digest(f"{self.name}=={self.version}")

    @property
    def served_digest(self) -> str:
        """What actually comes down the wire when the install runs."""
        if self.tampered:
            return _digest(f"{self.name}=={self.version}:substituted")
        return self.published_digest


def _artifact_digest(url: str) -> str:
    """The digest of an artifact on this machine, read from the file the URL names."""
    return _digest(Path(url.removeprefix("file://")).read_text(encoding="utf-8"))


def _host_distribution() -> Distribution:
    """`innytypes` at exactly the version this host is running."""
    return Distribution(name="innytypes", version=__version__)


@dataclass
class FakeUv:
    """A command runner that answers like `uv`, for the four commands the installer runs.

    It is a runner rather than an installer: the argv under test is the real one
    :class:`UvInstaller` builds, so a change to a flag changes what this fake is asked to do.
    """

    distributions: dict[str, Distribution] = field(default_factory=dict)
    manifests: dict[str, Mapping[str, object]] = field(default_factory=dict)
    # Every argv, in order, so a test can assert what was never asked for as well as what was.
    argvs: list[list[str]] = field(default_factory=list)
    # The requirements each compile was asked to resolve, in order.
    compiled: list[tuple[str, ...]] = field(default_factory=list)
    # environment -> the pins installed into it.
    installed: dict[Path, tuple[str, ...]] = field(default_factory=dict)
    # Set to make the resolver fail the way a conflicting dependency set makes `uv` fail.
    conflict: str | None = None
    # Emitted verbatim in place of a resolution, for the locks a resolver should never write.
    lock_text: str | None = None
    # What a build produces from a source tree, and which manifest an environment built from
    # one exports when it is asked for its sole manifest — a local path states neither.
    wheel_name: str = "monty-1.4.0-py3-none-any.whl"
    exported: str | None = None
    # Rewrites every local artifact *after* it has been resolved, which is the local-source
    # shape of an index serving something other than what it published.
    tamper: bool = False

    def add(self, distribution: Distribution) -> None:
        self.distributions[distribution.name] = distribution

    def __call__(self, argv: Sequence[str]) -> str:
        self.argvs.append(list(argv))

        if argv[:2] == ["uv", "venv"]:
            return self._venv(argv)
        if argv[:2] == ["uv", "build"]:
            return self._build(argv)
        if argv[:3] == ["uv", "pip", "compile"]:
            return self._compile(argv)
        if argv[:3] == ["uv", "pip", "install"]:
            return self._install(argv)
        if len(argv) == 4 and argv[1] == "-c":
            return json.dumps(self.manifests[argv[3]])
        if len(argv) == 3 and argv[1] == "-c":
            assert self.exported is not None, "no manifest was published for this environment"
            return json.dumps(self.manifests[self.exported])

        raise AssertionError(f"the fake was asked to run something it does not know: {argv}")

    # --- the commands ----------------------------------------------------------------------

    def _venv(self, argv: Sequence[str]) -> str:
        environment = Path(argv[-1])
        addon_interpreter(environment).parent.mkdir(parents=True)
        return ""

    def _build(self, argv: Sequence[str]) -> str:
        """`uv build --wheel`: one artifact, with bytes of its own to be hashed."""
        source = Path(argv[-1])
        into = Path(argv[argv.index("--out-dir") + 1])
        (into / self.wheel_name).write_text(f"the wheel built from {source}\n", encoding="utf-8")
        return f"Successfully built {into / self.wheel_name}"

    def _compile(self, argv: Sequence[str]) -> str:
        assert "--generate-hashes" in argv, "a lock without hashes is not a lock"

        requested = tuple(
            line.strip()
            for line in Path(argv[-1]).read_text(encoding="utf-8").splitlines()
            if line.strip()
        )
        self.compiled.append(requested)

        if self.conflict is not None:
            raise self._failed(argv, self.conflict)
        if self.lock_text is not None:
            return self.lock_text

        resolved: dict[str, Distribution] = {}
        local: list[str] = []
        for requirement in requested:
            name, separator, url = requirement.partition(" @ ")
            if separator:
                # An artifact on this machine: what `uv` hashes is the file itself, and a
                # source it cannot hash — a directory — it writes out with no hash at all.
                local.append(f"{requirement} \\\n    --hash={_artifact_digest(url)}")
                continue

            name, _, version = requirement.partition("==")
            self._resolve(name, version, into=resolved, argv=argv)

        lines = [
            f"{distribution.name}=={distribution.version} \\\n"
            f"    --hash={distribution.published_digest}"
            for distribution in sorted(resolved.values(), key=lambda found: found.name)
        ]
        if self.tamper:
            for requirement in requested:
                _, separator, url = requirement.partition(" @ ")
                if separator:
                    Path(url.removeprefix("file://")).write_text("substituted\n", encoding="utf-8")

        return "# resolved by the fake index\n" + "\n".join(lines + local)

    def _resolve(
        self,
        name: str,
        version: str | None,
        *,
        into: dict[str, Distribution],
        argv: Sequence[str],
    ) -> None:
        distribution = self.distributions.get(name)
        if distribution is None:
            raise self._failed(argv, f"No solution found: no versions of {name} are available")
        if version and distribution.version != version:
            raise self._failed(
                argv, f"No solution found: {name}=={version} is not available in the index"
            )

        if name in into:
            return
        into[name] = distribution

        for required in distribution.requires:
            self._resolve(required, None, into=into, argv=argv)

    def _install(self, argv: Sequence[str]) -> str:
        environment = Path(argv[argv.index("--python") + 1]).parent.parent
        lock = parse_lock(Path(argv[argv.index("--requirement") + 1]).read_text(encoding="utf-8"))

        wanted = list(lock.requirements)
        if "--no-deps" not in argv:
            # What `uv` would do without the flag: resolve past the file it was handed.
            for requirement in lock.requirements:
                distribution = self.distributions[requirement.name]
                wanted.extend(
                    LockedRequirement(
                        name=self.distributions[required].name,
                        version=self.distributions[required].version,
                        hashes=(self.distributions[required].published_digest,),
                    )
                    for required in distribution.requires
                )

        for local in lock.path_requirements:
            served = _artifact_digest(local.url)
            if "--require-hashes" in argv and served not in local.hashes:
                raise self._failed(
                    argv,
                    f"Failed to install `{local}`: hash mismatch for {local.name}, expected "
                    f"one of {', '.join(local.hashes)}, got {served}",
                )

        for requirement in wanted:
            distribution = self.distributions[requirement.name]
            if "--require-hashes" in argv and distribution.served_digest not in requirement.hashes:
                raise self._failed(
                    argv,
                    f"Failed to download `{requirement}`: hash mismatch for {requirement.name}, "
                    f"expected one of {', '.join(requirement.hashes)}, "
                    f"got {distribution.served_digest}",
                )

        self.installed[environment] = tuple(
            str(requirement) for requirement in [*wanted, *lock.path_requirements]
        )
        return ""

    def _failed(self, argv: Sequence[str], message: str) -> subprocess.CalledProcessError:
        return subprocess.CalledProcessError(returncode=1, cmd=list(argv), stderr=message)


def _manifest(addon_id: str, version: str, **extra: object) -> dict[str, object]:
    """The document a plugin's entry point returns, at the version it was installed at."""
    return {
        "id": addon_id,
        "version": version,
        "host_api": HOST_API_VERSION,
        "requires": [],
        "emits": [],
        "subscribes": [],
        **extra,
    }


# --- a harness: one addons root, one staging root, one previous root ------------------------


@dataclass
class Harness:
    """Every root under `tmp_path`, plus the fake index the installer resolves against."""

    uv: FakeUv
    live_root: Path
    staging_root: Path
    previous_root: Path
    runner: CliRunner

    @property
    def installer(self) -> UvInstaller:
        return UvInstaller(run=self.uv)

    def publish(self, addon_id: str, version: str, requires: tuple[str, ...] = ()) -> Requirement:
        """Put one plugin in the fake index, with the manifest its environment will export."""
        self.uv.add(Distribution(name=addon_id, version=version, requires=requires))
        self.uv.manifests[addon_id] = _manifest(addon_id, version)
        return Requirement(addon_id=addon_id, version=version)

    def install(self, requirement: Requirement, *, force: bool = False) -> Path:
        """Install straight into the live root, the way `addons install` does."""
        return install_addon(
            requirement, installer=self.installer, root=self.live_root, force=force
        ).environment

    def stage(self, requirement: Requirement) -> Path:
        return stage_environment(
            requirement, installer=self.installer, staging_root=self.staging_root
        ).environment

    def swap(self, addon_id: str) -> object:
        return swap_in(
            addon_id,
            live_root=self.live_root,
            staging_root=self.staging_root,
            previous_root=self.previous_root,
        )

    def invoke(self, *args: str) -> Result:
        context = CliContext(installer=self.installer, addons_root=self.live_root)
        return self.runner.invoke(cli, list(args), obj=context, catch_exceptions=False)

    def live_lock(self, addon_id: str) -> EnvironmentLock:
        return parse_lock(recorded_lock_path(self.live_root, addon_id).read_text(encoding="utf-8"))

    def installed_version(self, addon_id: str) -> str:
        found = discover_addons(self.live_root)
        return next(addon.manifest.version for addon in found.installed if addon.id == addon_id)


@pytest.fixture
def harness(tmp_path: Path) -> Iterator[Harness]:
    uv = FakeUv()
    uv.add(_host_distribution())
    yield Harness(
        uv=uv,
        live_root=tmp_path / "addons",
        staging_root=tmp_path / STAGING_DIRNAME,
        previous_root=tmp_path / PREVIOUS_DIRNAME,
        runner=CliRunner(),
    )


# --- the install builds one locked environment per plugin -----------------------------------


def test_install_builds_the_environment_on_the_hosts_python_and_locks_what_it_asked_for(
    harness: Harness,
) -> None:
    harness.uv.add(Distribution(name="anyio", version="4.12.0"))
    requirement = harness.publish("monty", "1.4.0", requires=("anyio",))

    environment = harness.install(requirement)

    assert harness.uv.argvs[0] == [
        "uv",
        "venv",
        "--python",
        host_python_version(),
        str(environment),
    ]
    # Exactly the spec plan 0003 states: the plugin at its exact version, and `innytypes` at
    # the version of the host doing the installing.
    assert harness.uv.compiled == [("monty==1.4.0", f"innytypes=={__version__}")]


def test_the_lock_records_every_transitive_dependency_pinned_and_hashed(
    harness: Harness,
) -> None:
    harness.uv.add(Distribution(name="anyio", version="4.12.0", requires=("idna",)))
    harness.uv.add(Distribution(name="idna", version="3.11"))
    requirement = harness.publish("monty", "1.4.0", requires=("anyio",))

    harness.install(requirement)
    lock = harness.live_lock("monty")

    assert {locked.name: locked.version for locked in lock.requirements} == {
        "monty": "1.4.0",
        "innytypes": __version__,
        # Transitive, and transitive of transitive: a lock that stopped at direct
        # dependencies would leave the rest to resolve at install time.
        "anyio": "4.12.0",
        "idna": "3.11",
    }
    assert all(locked.hashes for locked in lock.requirements)


def test_the_install_never_receives_an_unpinned_requirement(harness: Harness) -> None:
    harness.uv.add(Distribution(name="anyio", version="4.12.0"))
    requirement = harness.publish("monty", "1.4.0", requires=("anyio",))

    harness.install(requirement)

    # Everything the installer ever asks for, on either side of the resolution: the file the
    # resolver was handed, and the file the install was run from.
    asked_for = [pin for compiled in harness.uv.compiled for pin in compiled]
    asked_for += [str(locked) for locked in harness.live_lock("monty").requirements]

    for pin in asked_for:
        name, separator, version = pin.partition("==")
        assert separator == "==", f"{pin!r} is not an exact pin"
        assert name and version and not set(version) & set("><~!*, ")


def test_the_install_runs_from_the_lock_alone(harness: Harness) -> None:
    requirement = harness.publish("monty", "1.4.0")

    environment = harness.install(requirement)
    install_argv = next(argv for argv in harness.uv.argvs if argv[:3] == ["uv", "pip", "install"])

    assert install_argv == [
        "uv",
        "pip",
        "install",
        "--python",
        str(addon_interpreter(environment)),
        "--require-hashes",
        "--no-deps",
        "--requirement",
        str(recorded_lock_path(harness.live_root, "monty")),
    ]


def test_what_the_install_records_is_what_it_installed_from(harness: Harness) -> None:
    requirement = harness.publish("monty", "1.4.0")

    harness.install(requirement)

    # The recorded file is re-emitted from the parsed lock, so it parses back to the same
    # document rather than to whatever the resolver happened to print.
    recorded = recorded_lock_path(harness.live_root, "monty").read_text(encoding="utf-8")
    assert parse_lock(recorded).requirements == harness.live_lock("monty").requirements


def test_a_lock_that_resolved_another_version_of_the_plugin_is_refused(
    harness: Harness,
) -> None:
    harness.publish("monty", "1.4.0")
    harness.uv.lock_text = (
        f"monty==1.3.0 \\\n    --hash={_digest('monty==1.3.0')}\n"
        f"innytypes=={__version__} \\\n    --hash={_digest('x')[:7]}"
        f"{'a' * 64}\n"
    )

    with pytest.raises(InstallError, match="the lock holds monty 1.3.0"):
        harness.install(Requirement(addon_id="monty", version="1.4.0"))


def test_a_lock_that_forgot_the_hosts_own_pin_is_refused(harness: Harness) -> None:
    harness.publish("monty", "1.4.0")
    harness.uv.lock_text = f"monty==1.4.0 \\\n    --hash={_digest('monty==1.4.0')}\n"

    with pytest.raises(InstallError, match="the lock does not contain innytypes"):
        harness.install(Requirement(addon_id="monty", version="1.4.0"))


def test_a_lock_with_a_floating_range_is_refused_before_anything_is_installed(
    harness: Harness,
) -> None:
    harness.publish("monty", "1.4.0")
    harness.uv.lock_text = "monty>=1.4.0 --hash=" + _digest("monty")

    with pytest.raises(InstallError, match="was refused: line 1: 'monty>=1.4.0' is not an exact"):
        harness.install(Requirement(addon_id="monty", version="1.4.0"))

    assert harness.uv.installed == {}
    assert not addon_root(harness.live_root, "monty").exists()


# --- the hash is the check ------------------------------------------------------------------


def test_an_artifact_whose_hash_is_not_the_locked_one_is_refused(harness: Harness) -> None:
    """The one check plan 0003 D16 relies on: what is installed is what was resolved."""
    harness.publish("monty", "1.4.0", requires=("anyio",))
    # Resolved and locked honestly; the artifact that comes down the wire is another one.
    harness.uv.add(Distribution(name="anyio", version="4.12.0", tampered=True))

    with pytest.raises(InstallError, match="hash mismatch for anyio"):
        harness.install(Requirement(addon_id="monty", version="1.4.0"))

    # And the refusal leaves nothing installed and nothing recorded.
    assert harness.uv.installed == {}
    assert not addon_root(harness.live_root, "monty").exists()


def test_the_plugins_own_artifact_is_checked_against_the_lock_too(harness: Harness) -> None:
    harness.uv.add(Distribution(name="monty", version="1.4.0", tampered=True))
    harness.uv.manifests["monty"] = _manifest("monty", "1.4.0")

    with pytest.raises(InstallError, match="hash mismatch for monty"):
        harness.install(Requirement(addon_id="monty", version="1.4.0"))


def test_nothing_outside_the_lock_arrives_alongside_it(harness: Harness) -> None:
    """`--no-deps`: the lock is the whole set, so a dependency it omits is never resolved."""
    harness.uv.add(Distribution(name="anyio", version="4.12.0"))
    requirement = harness.publish("monty", "1.4.0", requires=("anyio",))
    # A lock naming only the plugin and the host. Without `--no-deps` the installer would
    # pull `anyio` in behind the lock's back; with it, the environment holds exactly two.
    harness.uv.lock_text = (
        f"monty==1.4.0 \\\n    --hash={_digest('monty==1.4.0')}\n"
        f"innytypes=={__version__} \\\n    --hash={_digest(f'innytypes=={__version__}')}\n"
    )

    environment = harness.install(requirement)

    assert harness.uv.installed[environment] == ("monty==1.4.0", f"innytypes=={__version__}")


# --- `innytypes addons install`, end to end --------------------------------------------------


def test_addons_install_records_a_manifest_discovery_reads_without_importing_the_plugin(
    harness: Harness,
) -> None:
    harness.publish("monty", "1.4.0")

    result = harness.invoke("addons", "install", "monty==1.4.0")
    assert result.exit_code == 0, result.output

    found = discover_addons(harness.live_root)
    assert [(addon.id, addon.manifest.version) for addon in found.installed] == [("monty", "1.4.0")]
    assert found.broken == ()
    assert recorded_manifest_path(harness.live_root, "monty").is_file()
    assert recorded_lock_path(harness.live_root, "monty").is_file()
    # The manifest crossed a process boundary as JSON; nothing of the plugin was imported.
    assert "monty" not in sys.modules


def test_addons_install_prints_the_refusal_when_the_lock_does_not_verify(
    harness: Harness,
) -> None:
    harness.uv.add(Distribution(name="monty", version="1.4.0", tampered=True))
    harness.uv.manifests["monty"] = _manifest("monty", "1.4.0")

    result = harness.invoke("addons", "install", "monty==1.4.0")

    assert result.exit_code == 1
    assert "hash mismatch for monty" in result.output


# --- two plugins, two environments ----------------------------------------------------------


def test_two_plugins_resolve_to_their_own_independently_locked_environments(
    harness: Harness,
) -> None:
    harness.uv.add(Distribution(name="shared", version="1.0.0"))
    harness.publish("monty", "1.4.0", requires=("shared",))
    harness.install(Requirement(addon_id="monty", version="1.4.0"))

    # The same dependency at a different version for the second plugin — impossible in one
    # shared environment, unremarkable when each plugin has its own (plan 0003, D17).
    harness.uv.add(Distribution(name="shared", version="2.0.0"))
    harness.publish("whodunnit", "0.9.0", requires=("shared",))
    harness.install(Requirement(addon_id="whodunnit", version="0.9.0"))

    monty_shared = harness.live_lock("monty").find("shared")
    whodunnit_shared = harness.live_lock("whodunnit").find("shared")

    assert monty_shared is not None and monty_shared.version == "1.0.0"
    assert whodunnit_shared is not None and whodunnit_shared.version == "2.0.0"
    assert addon_environment(harness.live_root, "monty") in harness.uv.installed
    assert addon_environment(harness.live_root, "whodunnit") in harness.uv.installed


def test_a_conflict_in_one_plugins_lock_leaves_the_other_plugin_untouched(
    harness: Harness,
) -> None:
    harness.uv.add(Distribution(name="shared", version="1.0.0"))
    harness.publish("monty", "1.4.0", requires=("shared",))
    harness.publish("whodunnit", "0.9.0", requires=("shared",))
    harness.install(Requirement(addon_id="monty", version="1.4.0"))
    harness.install(Requirement(addon_id="whodunnit", version="0.9.0"))

    untouched = recorded_lock_path(harness.live_root, "whodunnit").read_bytes()
    host_dependencies = (Path(__file__).parent.parent / "pyproject.toml").read_bytes()

    # A new version of monty whose dependencies cannot be satisfied together.
    harness.uv.add(Distribution(name="monty", version="1.5.0", requires=("shared",)))
    harness.uv.manifests["monty"] = _manifest("monty", "1.5.0")
    harness.uv.conflict = "No solution found: shared==1.0.0 and shared==2.0.0 are incompatible"

    with pytest.raises(InstallError, match="are incompatible"):
        harness.stage(Requirement(addon_id="monty", version="1.5.0"))

    # The other plugin's environment, the failed plugin's live environment, and the host's
    # own dependencies: none of the three moved.
    assert recorded_lock_path(harness.live_root, "whodunnit").read_bytes() == untouched
    assert harness.installed_version("monty") == "1.4.0"
    assert harness.live_lock("monty").find("shared") is not None
    assert (Path(__file__).parent.parent / "pyproject.toml").read_bytes() == host_dependencies
    assert not addon_root(harness.staging_root, "monty").exists()


def test_every_path_the_installer_touches_is_inside_the_roots_it_was_given(
    harness: Harness, tmp_path: Path
) -> None:
    harness.uv.add(Distribution(name="shared", version="1.0.0"))
    harness.publish("monty", "1.4.0", requires=("shared",))
    harness.install(Requirement(addon_id="monty", version="1.4.0"))

    for argv in harness.uv.argvs:
        for argument in argv:
            if argument.startswith("/"):
                assert Path(argument).is_relative_to(tmp_path), argument


# --- staging, the swap, and the way back ------------------------------------------------------


def test_a_staged_environment_is_built_beside_the_live_one_not_inside_it(
    harness: Harness,
) -> None:
    harness.publish("monty", "1.4.0")
    harness.install(Requirement(addon_id="monty", version="1.4.0"))

    harness.uv.add(Distribution(name="monty", version="1.5.0"))
    harness.uv.manifests["monty"] = _manifest("monty", "1.5.0")
    staged = harness.stage(Requirement(addon_id="monty", version="1.5.0"))

    assert staged.is_relative_to(harness.staging_root)
    # The live plugin is still the old one, and discovery — which reads every directory under
    # the addons root — has not been shown a half-built environment.
    assert harness.installed_version("monty") == "1.4.0"
    assert discover_addons(harness.live_root).broken == ()


def test_staging_over_an_abandoned_staged_build_replaces_it(harness: Harness) -> None:
    harness.publish("monty", "1.5.0")
    harness.stage(Requirement(addon_id="monty", version="1.5.0"))

    harness.uv.add(Distribution(name="monty", version="1.6.0"))
    harness.uv.manifests["monty"] = _manifest("monty", "1.6.0")
    harness.stage(Requirement(addon_id="monty", version="1.6.0"))

    staged = parse_lock(
        recorded_lock_path(harness.staging_root, "monty").read_text(encoding="utf-8")
    ).find("monty")
    assert staged is not None and staged.version == "1.6.0"


def test_the_swap_makes_the_staged_environment_live_and_keeps_the_old_one(
    harness: Harness,
) -> None:
    harness.publish("monty", "1.4.0")
    harness.install(Requirement(addon_id="monty", version="1.4.0"))

    harness.uv.add(Distribution(name="monty", version="1.5.0"))
    harness.uv.manifests["monty"] = _manifest("monty", "1.5.0")
    harness.stage(Requirement(addon_id="monty", version="1.5.0"))

    swapped = harness.swap("monty")

    assert harness.installed_version("monty") == "1.5.0"
    assert swapped.previous == addon_root(harness.previous_root, "monty")
    assert swapped.previous is not None and (swapped.previous / "manifest.json").is_file()
    # The staged copy moved rather than being copied: nothing is left behind to go stale.
    assert not addon_root(harness.staging_root, "monty").exists()


def test_rolling_back_puts_the_environment_the_swap_replaced_back(harness: Harness) -> None:
    harness.publish("monty", "1.4.0")
    harness.install(Requirement(addon_id="monty", version="1.4.0"))
    harness.uv.add(Distribution(name="monty", version="1.5.0"))
    harness.uv.manifests["monty"] = _manifest("monty", "1.5.0")
    harness.stage(Requirement(addon_id="monty", version="1.5.0"))
    harness.swap("monty")

    live = roll_back("monty", live_root=harness.live_root, previous_root=harness.previous_root)

    assert live == addon_root(harness.live_root, "monty")
    assert harness.installed_version("monty") == "1.4.0"
    # The lock came back with it: the rolled-back plugin is the environment it was built as.
    rolled_back = harness.live_lock("monty").find("monty")
    assert rolled_back is not None and rolled_back.version == "1.4.0"
    # And the kept copy is spent, so a second rollback has nothing to undo.
    assert not addon_root(harness.previous_root, "monty").exists()


def test_a_swap_that_replaced_nothing_keeps_nothing_and_cannot_be_rolled_back(
    harness: Harness,
) -> None:
    harness.publish("monty", "1.4.0")
    harness.stage(Requirement(addon_id="monty", version="1.4.0"))

    swapped = harness.swap("monty")

    assert swapped.previous is None
    assert harness.installed_version("monty") == "1.4.0"
    with pytest.raises(SwapError, match="nothing is kept for it"):
        roll_back("monty", live_root=harness.live_root, previous_root=harness.previous_root)


def test_only_the_swapped_plugin_moves(harness: Harness) -> None:
    harness.publish("monty", "1.4.0")
    harness.publish("whodunnit", "0.9.0")
    harness.install(Requirement(addon_id="monty", version="1.4.0"))
    harness.install(Requirement(addon_id="whodunnit", version="0.9.0"))

    untouched = recorded_lock_path(harness.live_root, "whodunnit").read_bytes()

    harness.uv.add(Distribution(name="monty", version="1.5.0"))
    harness.uv.manifests["monty"] = _manifest("monty", "1.5.0")
    harness.stage(Requirement(addon_id="monty", version="1.5.0"))
    harness.swap("monty")

    assert harness.installed_version("whodunnit") == "0.9.0"
    assert recorded_lock_path(harness.live_root, "whodunnit").read_bytes() == untouched
    assert not addon_root(harness.previous_root, "whodunnit").exists()


def test_a_second_swap_keeps_the_environment_it_replaced_not_the_one_before_it(
    harness: Harness,
) -> None:
    harness.publish("monty", "1.4.0")
    harness.install(Requirement(addon_id="monty", version="1.4.0"))

    for version in ("1.5.0", "1.6.0"):
        harness.uv.add(Distribution(name="monty", version=version))
        harness.uv.manifests["monty"] = _manifest("monty", version)
        harness.stage(Requirement(addon_id="monty", version=version))
        harness.swap("monty")

    roll_back("monty", live_root=harness.live_root, previous_root=harness.previous_root)

    assert harness.installed_version("monty") == "1.5.0"


def test_swapping_in_a_half_built_environment_is_refused_and_the_live_one_survives(
    harness: Harness,
) -> None:
    harness.publish("monty", "1.4.0")
    harness.install(Requirement(addon_id="monty", version="1.4.0"))

    # A staged directory that exists but records no manifest: what an interrupted build
    # would leave behind if it were not cleaned up.
    addon_root(harness.staging_root, "monty").mkdir(parents=True)

    with pytest.raises(SwapError, match="records no manifest"):
        harness.swap("monty")

    assert harness.installed_version("monty") == "1.4.0"
    assert not addon_root(harness.previous_root, "monty").exists()


def test_swapping_in_an_environment_that_records_no_lock_is_refused(harness: Harness) -> None:
    harness.publish("monty", "1.4.0")
    harness.install(Requirement(addon_id="monty", version="1.4.0"))
    harness.stage(Requirement(addon_id="monty", version="1.4.0"))
    recorded_lock_path(harness.staging_root, "monty").unlink()

    with pytest.raises(SwapError, match="records no lock"):
        harness.swap("monty")

    assert harness.installed_version("monty") == "1.4.0"


def test_swapping_in_a_plugin_nothing_was_staged_for_is_refused(harness: Harness) -> None:
    with pytest.raises(SwapError, match="nothing is staged for monty"):
        harness.swap("monty")


def test_a_swap_that_cannot_complete_puts_the_live_environment_back(
    harness: Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    harness.publish("monty", "1.4.0")
    harness.install(Requirement(addon_id="monty", version="1.4.0"))
    harness.uv.add(Distribution(name="monty", version="1.5.0"))
    harness.uv.manifests["monty"] = _manifest("monty", "1.5.0")
    harness.stage(Requirement(addon_id="monty", version="1.5.0"))

    real_replace = __import__("os").replace
    calls: list[int] = []

    def replace_once(source: object, destination: object) -> None:
        calls.append(1)
        # The first rename moves the live environment aside; the second is the one that
        # fails, which is the only moment a plugin could be left with no environment at all.
        if len(calls) == 2:
            raise OSError("cross-device link")
        real_replace(source, destination)  # type: ignore[arg-type]

    monkeypatch.setattr("innytypes.helper.environments.os.replace", replace_once)

    with pytest.raises(SwapError, match="could not be moved"):
        harness.swap("monty")

    assert harness.installed_version("monty") == "1.4.0"


def test_a_rollback_that_cannot_complete_leaves_the_live_environment_where_it_was(
    harness: Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    harness.publish("monty", "1.4.0")
    harness.install(Requirement(addon_id="monty", version="1.4.0"))
    harness.uv.add(Distribution(name="monty", version="1.5.0"))
    harness.uv.manifests["monty"] = _manifest("monty", "1.5.0")
    harness.stage(Requirement(addon_id="monty", version="1.5.0"))
    harness.swap("monty")

    real_replace = __import__("os").replace
    calls: list[int] = []

    def replace_once(source: object, destination: object) -> None:
        calls.append(1)
        if len(calls) == 2:
            raise OSError("cross-device link")
        real_replace(source, destination)  # type: ignore[arg-type]

    monkeypatch.setattr("innytypes.helper.environments.os.replace", replace_once)

    with pytest.raises(SwapError, match="could not be moved"):
        roll_back("monty", live_root=harness.live_root, previous_root=harness.previous_root)

    assert harness.installed_version("monty") == "1.5.0"


def test_the_three_roots_are_siblings_so_a_swap_is_a_rename(harness: Harness) -> None:
    """Staging and previous sit beside the addons root, never inside it."""
    from innytypes.addons.discovery import default_addons_root

    assert default_staging_root().parent == default_addons_root().parent
    assert default_previous_root().parent == default_addons_root().parent
    assert not default_staging_root().is_relative_to(default_addons_root())
    assert not default_previous_root().is_relative_to(default_addons_root())


# --- an addon installed from a path on this machine ----------------------------------------


def _checkout(tmp_path: Path) -> Path:
    """A source tree to install from, named nothing like the addon it holds."""
    source = tmp_path / "a-checkout"
    source.mkdir()
    return source


def test_a_local_install_is_locked_with_the_digest_of_the_artifact_built_from_it(
    harness: Harness, tmp_path: Path
) -> None:
    """The lock of a local install is a lock: an artifact, its digest, `--require-hashes`.

    The source is a directory, which a resolver cannot hash — so the install builds a wheel
    from it and locks that, and this is where the whole design either holds or does not.
    """
    harness.uv.manifests["monty"] = _manifest("monty", "1.4.0")
    harness.uv.exported = "monty"

    installed = install_addon_from_path(
        _checkout(tmp_path), installer=harness.installer, root=harness.live_root
    )

    lock = harness.live_lock("monty")
    (artifact,) = lock.path_requirements
    assert artifact.name == "monty"
    assert artifact.url.endswith(harness.uv.wheel_name)
    assert [digest.startswith("sha256:") for digest in artifact.hashes] == [True]
    # The host's own pin is in the same lock, hashed, exactly as an index install leaves it.
    host = lock.find("innytypes")
    assert host is not None and host.version == __version__ and host.hashes

    install_argv = next(argv for argv in harness.uv.argvs if argv[:3] == ["uv", "pip", "install"])
    assert "--require-hashes" in install_argv and "--no-deps" in install_argv
    # Keyed by the environment the install ran in, which is the scratch one it was built in
    # before the finished directory was renamed into place.
    (into_environment,) = harness.uv.installed.values()
    assert into_environment == (f"innytypes=={__version__}", str(artifact))
    assert installed.environment == addon_environment(harness.live_root, "monty")


def test_a_local_artifact_that_is_not_the_one_that_was_locked_is_refused(
    harness: Harness, tmp_path: Path
) -> None:
    """The mutation proof of the lock above: change the wheel after it was resolved and the
    install refuses, because `--require-hashes` checks a local artifact like any other."""
    harness.uv.manifests["monty"] = _manifest("monty", "1.4.0")
    harness.uv.exported = "monty"
    harness.uv.tamper = True

    with pytest.raises(InstallError, match="hash mismatch"):
        install_addon_from_path(
            _checkout(tmp_path), installer=harness.installer, root=harness.live_root
        )

    assert harness.uv.installed == {}
    assert list(harness.live_root.iterdir()) == []


def test_a_local_install_that_cannot_be_hashed_is_refused_rather_than_installed_unlocked(
    harness: Harness, tmp_path: Path
) -> None:
    """What `uv` writes for a directory: a reference with no hash at all. It is refused —
    an environment that cannot be locked is not installed and then apologised for."""
    harness.uv.manifests["monty"] = _manifest("monty", "1.4.0")
    harness.uv.exported = "monty"
    harness.uv.lock_text = (
        f"monty @ file://{tmp_path / 'a-checkout'}\n{_pin('innytypes', __version__)}\n"
    )

    with pytest.raises(InstallError, match="locked with no hash"):
        install_addon_from_path(
            _checkout(tmp_path), installer=harness.installer, root=harness.live_root
        )

    assert harness.uv.installed == {}
    assert list(harness.live_root.iterdir()) == []


def test_a_source_that_is_not_there_is_refused_before_anything_is_built(
    harness: Harness, tmp_path: Path
) -> None:
    """Asked of the function as well as of the command: nothing runs on a path that is gone."""
    with pytest.raises(InstallError, match="does not exist"):
        install_addon_from_path(
            tmp_path / "never-cloned", installer=harness.installer, root=harness.live_root
        )

    assert harness.uv.argvs == []


def test_a_lock_that_took_the_addon_from_another_artifact_is_refused(
    harness: Harness, tmp_path: Path
) -> None:
    """The lock has to be a lock *of what was asked for*, one source kind along."""
    harness.uv.manifests["monty"] = _manifest("monty", "1.4.0")
    harness.uv.exported = "monty"
    harness.uv.lock_text = (
        f"monty @ file://{tmp_path / 'somewhere-else.whl'} --hash={_digest('other')}\n"
        f"{_pin('innytypes', __version__)}\n"
    )

    with pytest.raises(InstallError, match="the lock takes monty from"):
        install_addon_from_path(
            _checkout(tmp_path), installer=harness.installer, root=harness.live_root
        )

    assert list(harness.live_root.iterdir()) == []


# --- the lock document on its own ---------------------------------------------------------


def _pin(name: str, version: str) -> str:
    return f"{name}=={version} --hash={_digest(name + version)}"


def _artifact(name: str, wheel: str) -> str:
    return f"{name} @ file:///tmp/{wheel} --hash={_digest(wheel)}"


def test_a_lock_parses_continuations_and_ignores_comments() -> None:
    lock = parse_lock(
        "# autogenerated\n"
        f"click==8.5.0 \\\n    --hash={_digest('a')} \\\n    --hash={_digest('b')}\n"
        "\n"
        f"idna==3.11 \\\n    --hash={_digest('c')}  # via anyio\n"
    )

    assert [str(requirement) for requirement in lock.requirements] == ["click==8.5.0", "idna==3.11"]
    click = lock.find("Click")
    assert click is not None and len(click.hashes) == 2
    # Sorted, so two resolutions of one set produce one file.
    assert click.hashes == tuple(sorted(click.hashes))


def test_a_lock_ending_mid_continuation_is_still_judged() -> None:
    with pytest.raises(LockError, match="locked with no hash"):
        parse_lock("click==8.5.0 \\\n")


def test_a_lock_round_trips_through_the_file_it_writes() -> None:
    lock = parse_lock(
        f"{_pin('click', '8.5.0')}\n{_pin('idna', '3.11')}\n"
        f"{_artifact('monty', 'monty-1.4.0-py3-none-any.whl')}\n"
    )

    assert parse_lock(lock.text()) == lock


def test_a_local_artifact_is_locked_by_the_digest_of_the_file_it_names() -> None:
    lock = parse_lock(_artifact("monty", "monty-1.4.0-py3-none-any.whl"))

    (artifact,) = lock.path_requirements
    assert artifact.name == "monty"
    assert artifact.url == "file:///tmp/monty-1.4.0-py3-none-any.whl"
    assert artifact.hashes == (_digest("monty-1.4.0-py3-none-any.whl"),)
    # Checked by name, like every other entry, and by the artifact it was asked for.
    lock.must_contain(["monty @ file:///tmp/monty-1.4.0-py3-none-any.whl"])
    with pytest.raises(LockError, match="the lock takes monty from"):
        lock.must_contain(["monty @ file:///tmp/monty-1.5.0-py3-none-any.whl"])
    with pytest.raises(LockError, match="does not take whodunnit from a local artifact"):
        lock.must_contain(["whodunnit @ file:///tmp/whodunnit-1.0.0-py3-none-any.whl"])


@pytest.mark.parametrize(
    ("text", "refusal"),
    [
        ("click>=8.5.0 --hash=" + _digest("a"), "is not an exact pin"),
        ("click --hash=" + _digest("a"), "is not an exact pin"),
        ("click==8.5.0", "locked with no hash"),
        ("monty @ file:///tmp/a-checkout", "is locked with no hash"),
        ("monty @ file:///tmp/monty.whl --hash=md5:abc", "is not a sha256 hash"),
        ("monty @ https://example.test/monty.whl", "is not pinned to a commit"),
        ("click==8.5.0 --hash=md5:abc", "is not a sha256 hash"),
        ("click==8.5.0 --hash=sha256:NOTHEX" + "0" * 58, "is not a sha256 hash"),
        ("click==8.5.0 --index-url=https://pypi.org/simple", "is not a hash"),
        ("# nothing but a comment\n", "the lock is empty"),
    ],
)
def test_a_lock_that_breaks_a_rule_is_refused(text: str, refusal: str) -> None:
    with pytest.raises(LockError, match=refusal):
        parse_lock(text)


def test_a_distribution_locked_twice_is_refused() -> None:
    with pytest.raises(LockError, match="is locked twice"):
        parse_lock(f"{_pin('click', '8.5.0')}\n{_pin('Click', '8.4.0')}\n")


def test_a_lock_is_checked_against_a_request_that_is_itself_an_exact_pin() -> None:
    lock = parse_lock(_pin("click", "8.5.0"))

    with pytest.raises(LockError, match="is not an exact pin"):
        lock.must_contain(["click>=8"])


def test_names_that_differ_only_in_spelling_are_one_name() -> None:
    lock = parse_lock(_pin("Typing_Extensions", "4.15.0"))

    lock.must_contain(["typing-extensions==4.15.0"])
    assert lock.find("typing.extensions") is not None


def test_the_recorded_lock_sits_beside_the_manifest(tmp_path: Path) -> None:
    assert recorded_lock_path(tmp_path, "monty") == tmp_path / "monty" / LOCK_FILENAME
    assert (
        recorded_lock_path(tmp_path, "monty").parent
        == recorded_manifest_path(tmp_path, "monty").parent
    )
