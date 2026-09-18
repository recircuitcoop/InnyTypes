"""Explicit install — the write side of everything discovery reads.

Installation happens because a person asked for it (plan 0001, invariant 6). Nothing here is
reachable from starting the host: `innytypes up` calls no function in this module, and that
absence is the point — a startup that mutates an environment is a startup nobody can debug.

Installing one addon is four steps, in this order:

1. **Refuse a second install.** An addon already installed is left exactly as it is unless
   ``--force`` was passed. The check happens before anything is created, so a refusal cannot
   half-replace the environment it refused to touch.
2. **Create the addon's own environment**, on the same Python the host is running.
3. **Install the addon at its exact version, with `innytypes` beside it** at exactly the
   version of the running host, so the addon sees the host API contracts this host enforces
   (plan 0001, *Each addon has its own environment*). :class:`UvInstaller` resolves that pair
   to a **hash lock** first, records it beside the environment and installs from nothing
   else, because the lock is the only thing standing between an auto-updating plugin and
   whatever its index serves next (plan 0003, D16; invariant 10).
4. **Read the manifest from inside that environment** and record it beside it, at the path
   :func:`~innytypes.addons.discovery.recorded_manifest_path` reads. Install writes exactly
   what discovery reads; there is no second description of the layout here.

**The host supplies its own `innytypes`, and no index ever does.** The rule above — every
addon environment holds exactly the version of the host that installed it — has exactly one
source that can always satisfy it, and it is the host itself: it is installed, it knows where
it is, and it can build a wheel of itself. Asking a package index for `innytypes==<version>`
cannot work, because this project is published on no index; it also *should* not work, since
an index that happened to serve that name would put a different `innytypes` in the addon's
environment than the one running here. So :func:`host_requirement` builds a wheel from the
source tree the running installation lives in, through the same ``build_wheel`` an addon
installed from a directory goes through, and the addon environment installs
`innytypes @ file://<that wheel>` — resolved, hashed, locked and installed exactly like every
other artifact. A host that cannot build a wheel of itself **refuses the install** and says
so; there is no fallback to an index, because a quiet fallback is how the wrong `innytypes`
gets installed. The core update does the same thing from the other side: it moves an addon
environment to a new host version with the wheel out of the release
(:meth:`innytypes.helper.swap.UvCoreInstaller.set_host_version`), never with a resolution.

**The installer is injected.** :class:`AddonInstaller` is the whole of what this module needs
from the outside world — four calls, no `uv` and no subprocess of its own — so the gate
proves the install logic on a machine with no `uv` and no network, and plan 0003 slice 11
reuses the same seam to build a *staged* environment somewhere else. :class:`UvInstaller` is
the production implementation, and it injects its command runner for the same reason.

**The host still imports no addon code.** The manifest is read by the addon's *own*
interpreter, in its own environment, through the ``innytypes.addons`` entry point group; what
crosses back is a JSON document. The entry point is **named after the addon's id** and names
a callable taking no arguments that returns the manifest document — one spelling, so the id
in the directory name, the id in the entry point and the id in the manifest are the same
string or the install is refused.

**An addon can also be installed from a path on this machine**, with
:func:`install_addon_from_path` — `innytypes addons install <directory or wheel>`. It is the
same four steps in a different order, because a path states no id and no version: nothing on
a path can be trusted to say
which addon it holds, so the environment is built **in a scratch directory first**, the
manifest is read out of it, and only then is the addon's own directory claimed under the id
that manifest states. A refusal or a failure therefore throws away a scratch directory and
touches nothing under the addons root. What is installed is still a hash-locked artifact: a
directory has none, so a wheel is **built** from it and that wheel is what gets resolved,
locked and installed (plan 0001, *Installing from a local path*).

**A failed install leaves nothing behind.** Anything that goes wrong after the directory was
created removes it again, because a half-built environment would be enumerated as a broken
addon for ever afterwards by a discovery that cannot know an install was interrupted.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import tomllib
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from innytypes import __version__
from innytypes.addons.discovery import (
    InstalledAddon,
    InstalledSource,
    addon_environment,
    addon_root,
    default_addons_root,
    read_recorded_source,
    recorded_manifest_path,
    recorded_source_path,
)
from innytypes.addons.lock import EnvironmentLock, LockError, lock_path, parse_lock
from innytypes.addons.manifest import AddonManifest, ManifestError, Requirement, parse_manifest

__all__ = [
    "ENTRY_POINT_GROUP",
    "HOST_DISTRIBUTION",
    "AddonInstaller",
    "EditableInstall",
    "InstallError",
    "Runner",
    "UvInstaller",
    "host_python_version",
    "host_requirement",
    "host_source",
    "install_addon",
    "install_addon_from_path",
    "run_command",
]

# The entry point group an addon exports its manifest from, read inside the addon's own
# environment. The entry point's *name* is the addon's id.
ENTRY_POINT_GROUP = "innytypes.addons"

# What this host is called as a distribution — the name under which every addon environment
# holds it, and the name the lock is checked by.
HOST_DISTRIBUTION = "innytypes"

# The directory this package occupies on disk, from which the source tree it was installed
# from is looked for. Computed from this file rather than from `innytypes.__file__` because
# it is the same answer and one less import of the package this module is inside.
_PACKAGE_DIRECTORY = Path(__file__).resolve().parents[1]

# What the host's own wheel is built into, inside the scratch directory an install already
# owns. Named so that a scratch directory holding both wheels tells them apart.
_HOST_BUILD_DIRNAME = "host"

# What an addon's directory is called while it is being built from a local path, before its
# manifest has said what it is really called. It never appears under the addons root: the
# scratch directory holding it is a sibling of that root and is removed either way.
_STAGED_DIRNAME = "addon"

# Read in the addon's interpreter, printing the manifest document as JSON on stdout. It is a
# script rather than an import because running it in the host's interpreter would be the host
# importing addon code, which is the one thing the whole design forbids (plan 0001).
_MANIFEST_READER = """\
import json
import sys
from importlib.metadata import entry_points

group = "innytypes.addons"
# No name means the environment was built from a source that never stated an id — a local
# path (plan 0001, *Installing from a local path*). The addon still has exactly one manifest,
# so the sole entry point in the group is it, and anything else is refused rather than picked.
name = sys.argv[1] if len(sys.argv) > 1 else None

if name is None:
    found = list(entry_points(group=group))
    if len(found) != 1:
        raise SystemExit(
            f"this environment exports {len(found)} {group} entry points, and one addon "
            "exports exactly one manifest"
        )
else:
    found = [entry for entry in entry_points(group=group) if entry.name == name]
    if not found:
        raise SystemExit(
            f"this environment exports no {group} entry point named {name!r}: an addon "
            "exports its manifest from an entry point named after its own id"
        )
    if len(found) > 1:
        raise SystemExit(
            f"this environment exports {len(found)} {group} entry points named {name!r}: an "
            "addon has one manifest"
        )

entry = found[0]
export = entry.load()
if not callable(export):
    raise SystemExit(
        f"the {group} entry point named {entry.name!r} is not callable: it names a function "
        "that takes no arguments and returns the manifest document"
    )

json.dump(export(), sys.stdout)
"""


class InstallError(RuntimeError):
    """Raised when an addon cannot be installed, naming what stopped it.

    One family for every refusal in this module — an addon already installed, an installer
    command that failed, a manifest the environment would not give up or that does not
    describe the addon that was asked for — because the caller's response to all of them is
    the same: print it and stop.
    """


def _addon_interpreter(environment: Path) -> Path:
    """The interpreter inside an addon's environment, as `innytypes.children` defines it.

    There is exactly one definition of that path in this repository and it is that module's:
    the process the host launches an addon with has to be the process this module installed
    into. It is looked up **when an addon is being installed** rather than imported at the top
    of this file, because `innytypes.children` imports this package — a module-level import
    back would be a cycle, and whichever of the two a process imported first on a cold
    interpreter would fail.
    """
    from innytypes.children import addon_interpreter

    return addon_interpreter(environment)


@dataclass(frozen=True)
class EditableInstall:
    """An addon installed as a pointer to the source tree it was built from.

    ``name`` is the addon's **distribution** name, which is what the lock knows it by: the
    artifact entry under that name is what an editable install replaces, so it is what has to
    be named. ``source`` is the working tree the environment will point at, and the reason
    this exists at all — a plugin author edits it and restarts the addon, instead of
    reinstalling after every change.
    """

    name: str
    source: Path


class AddonInstaller(Protocol):
    """Everything installing an addon needs from the outside world, and nothing else.

    Four calls, in the order :func:`install_addon` and :func:`install_addon_from_path` make
    them. An implementation may run `uv`, unpack a staged environment (plan 0003 slice 11) or
    record what it was asked for and create nothing at all, which is what the gate does.
    """

    def build_wheel(self, source: Path, *, into: Path) -> Path:
        """Build one wheel from the source tree at ``source``, into ``into``, and return it.

        Only an install from a local directory needs this: it is how a source with no
        released artifact gets one, so there is something for the lock to hash.
        """
        ...

    def create_environment(self, environment: Path, *, python: str) -> None:
        """Create the addon's own environment at ``environment``, on ``python``."""
        ...

    def install(
        self,
        environment: Path,
        requirements: Sequence[str],
        *,
        editable: EditableInstall | None = None,
    ) -> None:
        """Install ``requirements`` — the addon and the host's pin — into that environment.

        ``editable`` replaces the addon's own artifact with a pointer to the source tree it
        was built from, leaving everything else installed from the lock exactly as it would
        be. It is the plugin author's loop: edit the checkout, restart the addon.
        """
        ...

    def read_manifest(
        self, environment: Path, *, addon_id: str | None = None
    ) -> Mapping[str, object]:
        """Read the manifest the addon exports, **inside** that environment.

        ``addon_id`` names the entry point to read, which is how an install that was asked
        for one addon insists it got that one. ``None`` means the environment was built from
        a source that stated no id, and the addon's sole manifest entry point is read
        whatever it is called.
        """
        ...


# A command runner: argv in, its standard output back. The seam that keeps `uv` out of the
# gate, shaped like the `spawn` the supervisors already take.
Runner = Callable[[Sequence[str]], str]


def run_command(argv: Sequence[str]) -> str:
    """Run one command to completion, raising ``CalledProcessError`` if it failed.

    The default :data:`Runner`, public because it is the default for every seam of this
    shape: plan 0003 resolves a plugin's new version through the same kind of runner, and a
    second copy of these six lines would be a second answer to "how is a command run".
    """
    completed = subprocess.run(
        list(argv),
        check=True,
        capture_output=True,
        text=True,
    )
    return completed.stdout


@dataclass(frozen=True)
class UvInstaller:
    """The production installer: one `uv` environment per addon, locked and pinned.

    ``run`` is injected so the argv this class builds can be asserted on a machine that has
    no `uv` at all, which is how the hermetic gate covers the real implementation rather than
    only a fake of it.
    """

    uv: str = "uv"
    run: Runner = run_command

    def build_wheel(self, source: Path, *, into: Path) -> Path:
        """`uv build --wheel`, so a directory with no released artifact gets one.

        The wheel is what the lock can hash and what `--require-hashes` can then enforce, so
        building it is not a convenience: it is the step that makes a local install carry the
        same guarantee as an install from an index (plan 0001, *Installing from a local
        path*). ``into`` is a directory this install owns and nothing else writes to, so the
        one wheel that appears in it is the one that was just built — `uv` prints where it
        wrote it, but reading the directory does not depend on the wording of that line.
        """
        self._run([self.uv, "build", "--wheel", "--out-dir", str(into), str(source)])

        built = sorted(into.glob("*.whl"))
        if len(built) != 1:
            raise InstallError(
                f"building a wheel from {source} produced {len(built)} wheels in {into}, "
                "and an addon is installed from exactly one artifact"
            )
        return built[0]

    def create_environment(self, environment: Path, *, python: str) -> None:
        """`uv venv` on the host's own Python, so every addon runs the interpreter the host
        was built against."""
        self._run([self.uv, "venv", "--python", python, str(environment)])

    def install(
        self,
        environment: Path,
        requirements: Sequence[str],
        *,
        editable: EditableInstall | None = None,
    ) -> None:
        """Lock the requirements with hashes, record the lock, and install from it alone.

        Two `uv` calls rather than one, and the order is the point. Resolving first produces
        a list of exact versions with the hashes of the artifacts that serve them; installing
        from that list with ``--require-hashes`` means `uv` refuses any artifact whose digest
        is not the one that was resolved, and ``--no-deps`` means nothing outside the lock can
        arrive alongside it. Installing the requirements directly would resolve at install
        time, which is a different set of packages every time the index changes.

        Everything lands in the addon's *own* interpreter, never the host's.
        """
        lock = self._compile(environment, requirements)

        try:
            # The lock has to be a lock *of what was asked for*: the addon at its exact
            # version, and this host's own `innytypes`. A resolver that answered with
            # something else would install an environment nobody requested.
            lock.must_contain(requirements)
        except LockError as error:
            raise InstallError(
                f"the lock resolved for {' '.join(requirements)} is wrong: {error}"
            ) from error

        if editable is not None:
            # The addon's own artifact was resolved and checked above — that is what ties the
            # lock to what was asked for — and it is then dropped, because what goes into the
            # environment is a pointer to the source tree instead. A lock naming a digest
            # nothing in the environment has would be this file claiming a guarantee the
            # install does not carry.
            lock = lock.without_local_artifact(editable.name)

        recorded = lock_path(environment)
        # Recorded before the install, and installed from the recorded file: what `uv` reads
        # is the document this host judged, byte for byte.
        recorded.write_text(lock.text(), encoding="utf-8")

        self._run(
            [
                self.uv,
                "pip",
                "install",
                "--python",
                str(_addon_interpreter(environment)),
                "--require-hashes",
                "--no-deps",
                "--requirement",
                str(recorded),
            ]
        )

        if editable is not None:
            # Last, and with `--no-deps`: everything this addon needs is already in the
            # environment, hash-locked, and nothing resolved here may add to it. There is no
            # `--require-hashes` on this line and there cannot be — a working tree has no
            # digest, which is the whole of what an editable install gives up.
            self._run(
                [
                    self.uv,
                    "pip",
                    "install",
                    "--python",
                    str(_addon_interpreter(environment)),
                    "--no-deps",
                    "--editable",
                    str(editable.source),
                ]
            )

    def _compile(self, environment: Path, requirements: Sequence[str]) -> EnvironmentLock:
        """Resolve ``requirements`` to every transitive dependency, pinned and hashed."""
        directory = environment.parent

        # Inside the addon's own directory, so a resolution that is interrupted leaves its
        # scratch file where the failed install already removes everything it made.
        with tempfile.TemporaryDirectory(dir=directory) as scratch:
            source = Path(scratch) / "requirements.in"
            source.write_text("\n".join(requirements) + "\n", encoding="utf-8")

            text = self._run(
                [
                    self.uv,
                    "pip",
                    "compile",
                    "--generate-hashes",
                    "--python",
                    str(_addon_interpreter(environment)),
                    str(source),
                ]
            )

        try:
            return parse_lock(text)
        except LockError as error:
            raise InstallError(
                f"the lock resolved for {' '.join(requirements)} was refused: {error}"
            ) from error

    def read_manifest(
        self, environment: Path, *, addon_id: str | None = None
    ) -> Mapping[str, object]:
        """Ask the addon's interpreter for the manifest its entry point exports.

        With no ``addon_id`` the script reads the environment's sole manifest entry point,
        which is the only thing an install from a local path can ask for before it knows
        which addon it is holding.
        """
        argv = [str(_addon_interpreter(environment)), "-c", _MANIFEST_READER]
        if addon_id is not None:
            argv.append(addon_id)
        output = self._run(argv)

        described = "the addon in this environment" if addon_id is None else repr(addon_id)

        try:
            document = json.loads(output)
        except ValueError as error:
            raise InstallError(
                f"the {ENTRY_POINT_GROUP} entry point of {described} did not return a JSON "
                f"document: {error}"
            ) from error

        if not isinstance(document, Mapping):
            raise InstallError(
                f"the {ENTRY_POINT_GROUP} entry point of {described} returned a "
                f"{type(document).__name__}, not a manifest object"
            )
        return document

    def _run(self, argv: Sequence[str]) -> str:
        """Run one command, turning every way it can fail into an :class:`InstallError`."""
        try:
            return self.run(argv)
        except subprocess.CalledProcessError as error:
            # The command printed why it failed; repeating it here is the difference between
            # "install failed" and a message the user can act on.
            detail = (error.stderr or error.stdout or "").strip()
            raise InstallError(f"`{' '.join(argv)}` failed: {detail or error}") from error
        except OSError as error:
            raise InstallError(f"`{' '.join(argv)}` could not be run: {error}") from error


def host_python_version(version: tuple[int, int] | None = None) -> str:
    """The Python an addon environment is built on: the one this host is running.

    `<major>.<minor>`, because that is the contract `requires-python` pins and the version an
    addon author targets. Injectable only so the gate can assert the argv on any interpreter.
    """
    major, minor = sys.version_info[:2] if version is None else version
    return f"{major}.{minor}"


def host_source(package: Path | None = None) -> Path:
    """The source tree the running `innytypes` was installed from, or a refusal naming why.

    The host is asked to supply a wheel of itself, so the first question is where the thing
    to build it from is. It is looked for **relative to this package on disk**, in the one or
    two directories that can hold the project's ``pyproject.toml``: directly above the
    package for a flat layout, two above for the src layout this project uses. A directory
    counts only if that file declares *this* project — a `pyproject.toml` belonging to
    whatever tree the package happens to have been copied into builds somebody else's wheel.

    **A bundled application has no source tree**, and neither does an installation unpacked
    from a released wheel into `site-packages`. That is not a case to work around: it is a
    refusal, stated here, because the only way past it would be to resolve `innytypes` from a
    package index, which would put a different `innytypes` in the addon's environment than
    the one running. Until a bundle carries a wheel of itself, addons are installed from a
    checkout — see plan 0001, *Where an addon environment's `innytypes` comes from*.

    ``package`` is injectable only so the gate can ask the question about a directory that is
    not this one; nothing in production passes it.
    """
    directory = _PACKAGE_DIRECTORY if package is None else package
    candidates = (directory.parent, directory.parent.parent)

    for candidate in candidates:
        if _declares_host(candidate / "pyproject.toml"):
            return candidate

    looked_in = " or ".join(str(candidate) for candidate in candidates)
    raise InstallError(
        f"the {HOST_DISTRIBUTION} running from {directory} has no source tree to build a "
        f"wheel from: no pyproject.toml declaring {HOST_DISTRIBUTION} in {looked_in}. Every "
        "addon environment holds this host's own innytypes at exactly the version it is "
        "running, and the host is the only thing that can supply it — resolving it from a "
        "package index would install a different innytypes than the one running here. "
        "Install addons from a checkout of innytypes."
    )


def _declares_host(pyproject: Path) -> bool:
    """Whether this ``pyproject.toml`` is the one that builds *this* distribution.

    Anything unreadable is a no rather than a raise: the caller's next step is to look one
    directory further, and a file that cannot be parsed has not declared anything.
    """
    try:
        document = tomllib.loads(pyproject.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False

    project = document.get("project")
    name = project.get("name") if isinstance(project, Mapping) else None
    # Compared the way a distribution name is compared (PEP 503), so `Inny_Types` in somebody's
    # fork of this file is still this project.
    return isinstance(name, str) and name.strip().lower().replace("_", "-") == HOST_DISTRIBUTION


def host_requirement(*, installer: AddonInstaller, into: Path) -> str:
    """Build this host's own wheel into ``into``, and return what installs it.

    The one answer to "where does an addon environment's `innytypes` come from": a wheel
    built from :func:`host_source` by the same ``build_wheel`` an addon installed from a
    directory goes through, named as a direct reference — `innytypes @ file://<wheel>` — so
    the resolver hashes it, :mod:`innytypes.addons.lock` judges it and `--require-hashes`
    enforces it, exactly like every other artifact in the environment.

    **The wheel is built per install and thrown away with the scratch directory it was built
    in.** Caching one between installs would be keyed by version, and a version is not a
    statement about the bytes: a checkout changes all day without its version moving, so a
    cache would serve a stale host to the very machine that needs this path most. A build is
    one `uv` call beside the two the install already makes.

    **The version is checked before it is used.** A source tree that builds a different
    version from the one this process is running — a checkout moved on past the installation
    importing it — would put an `innytypes` in the addon's environment that is not this
    host's, which is the whole thing the pin exists to prevent.
    """
    into.mkdir(parents=True, exist_ok=True)
    wheel = installer.build_wheel(host_source(), into=into)

    built = _wheel_version(wheel)
    if built != __version__:
        raise InstallError(
            f"the source tree at {host_source()} builds {HOST_DISTRIBUTION} {built}, but this "
            f"host is running {__version__}. An addon environment holds the version of the "
            "host that installed it, so the two have to be the same — reinstall the host from "
            "this source tree, or install the addon from the checkout this host was built from."
        )

    return _artifact_requirement(wheel)


def _wheel_version(wheel: Path) -> str:
    """The version a wheel's file name states (PEP 427: the name, then the version, then tags)."""
    parts = wheel.name.removesuffix(".whl").split("-")
    if len(parts) < 2 or not parts[1]:
        raise InstallError(
            f"{wheel.name} does not name a version: a wheel is called "
            "'<name>-<version>-<tags>.whl', and the version is what says which host this is"
        )
    return parts[1]


def install_addon(
    requirement: Requirement,
    *,
    installer: AddonInstaller,
    root: Path | None = None,
    force: bool = False,
    requirement_text: str | None = None,
) -> InstalledAddon:
    """Install one addon into its own environment and record its manifest beside it.

    Returns the addon exactly as :func:`~innytypes.addons.discovery.discover_addons` will
    report it, because both sides read the one layout described in ``discovery``.

    ``requirement_text`` is what the installer is *asked for*, when that is spelled
    differently from the requirement itself. A git-sourced plugin is installed from a direct
    reference carrying the **commit hash** — `<name> @ git+<url>@<commit>` — while the
    requirement still says which addon at which version the manifest must turn out to report
    (plan 0003, D15: a tag is a name, the commit is the code). Left out, the requirement is
    its own text, which is every install a person types.
    """
    base = default_addons_root() if root is None else root

    directory = addon_root(base, requirement.addon_id)
    environment = addon_environment(base, requirement.addon_id)
    manifest_path = recorded_manifest_path(base, requirement.addon_id)

    if directory.exists():
        if not force:
            raise InstallError(_already_installed(directory, manifest_path, requirement))
        # Replaced whole rather than installed over: leftovers from the previous version are
        # indistinguishable from the new one once the environment is mixed.
        _replace(directory)

    try:
        directory.mkdir(parents=True)
        # Inside the addon's own directory, and removed at the end of the install either way:
        # the wheel is an input to the install, not part of what the install leaves behind.
        with tempfile.TemporaryDirectory(dir=directory) as scratch:
            host = host_requirement(installer=installer, into=Path(scratch) / _HOST_BUILD_DIRNAME)
            installer.create_environment(environment, python=host_python_version())
            asked_for = str(requirement) if requirement_text is None else requirement_text
            installer.install(environment, (asked_for, host))

        document = installer.read_manifest(environment, addon_id=requirement.addon_id)
        manifest = _judge(document, requirement=requirement)
        _record(manifest_path, document)
    except Exception:
        # Every failure, not only the ones named above: whatever went wrong, what must not
        # survive it is a directory that discovery will report as a broken addon for ever.
        shutil.rmtree(directory, ignore_errors=True)
        raise

    return InstalledAddon(
        id=manifest.id,
        manifest=manifest,
        root=directory,
        environment=environment,
        manifest_path=manifest_path,
    )


def install_addon_from_path(
    source: Path,
    *,
    installer: AddonInstaller,
    root: Path | None = None,
    force: bool = False,
    editable: bool = False,
) -> InstalledAddon:
    """Install the addon at ``source`` — a directory or a wheel on this machine.

    The same environment, the same hash-locked install, the same recorded manifest and the
    same refusal to replace an installation that came from somewhere else. What differs is
    that a path says nothing about *which* addon it holds, so the order changes: everything
    is built in a scratch directory beside the addons root, and the addon's own directory is
    claimed only once its manifest has stated the id and version to claim it under. Nothing
    under the addons root is created, replaced or removed before that point.

    The scratch directory is a sibling of the addons root rather than inside it, so a build
    that is interrupted leaves nothing for discovery to enumerate, and so the finished
    directory is moved into place by a rename within one filesystem — the same move the
    helper's staging makes (plan 0003, *Staging, the swap and the way back*).

    ``editable`` is the plugin author's loop: the environment gets a pointer to ``source``
    rather than the artifact built from it, so editing the checkout and restarting the addon
    is the whole cycle. The dependencies are locked with hashes either way; what an editable
    install gives up is the lock on the addon's **own** code, and the installation records
    that it did (:class:`~innytypes.addons.discovery.InstalledSource`).

    **Reinstalling the same source needs no ``force``.** The refusal exists to stop an
    installation being replaced by different code arriving from somewhere else; building the
    same checkout again is what an author does all day, and the recorded source is what makes
    "the same checkout" a fact rather than a guess. An installation that came from an index,
    or from another path, is still refused until ``force`` says otherwise.
    """
    base = default_addons_root() if root is None else root
    resolved = source.expanduser().resolve()

    if not resolved.exists():
        raise InstallError(f"{resolved} does not exist, so there is no addon there to install")

    if editable and not resolved.is_dir():
        raise InstallError(
            f"{resolved} is a wheel, and a wheel cannot be installed editable: an editable "
            "install points the environment at a source tree somebody can edit, and a built "
            "artifact is the opposite of one. Install the checkout it was built from."
        )

    # Created before the scratch directory, because the scratch directory is its sibling and
    # the rename at the end depends on the two being on one filesystem.
    base.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix=".innytypes-install-", dir=base.parent) as scratch:
        staged = addon_root(Path(scratch), _STAGED_DIRNAME)
        environment = addon_environment(Path(scratch), _STAGED_DIRNAME)

        artifact = _artifact(resolved, installer=installer, into=Path(scratch) / "build")
        # After the addon's own artifact, so a source that is neither a directory nor a wheel
        # is refused before this host is asked to build anything of its own.
        host = host_requirement(installer=installer, into=Path(scratch) / _HOST_BUILD_DIRNAME)

        staged.mkdir(parents=True)
        installer.create_environment(environment, python=host_python_version())

        # Built and resolved even when the install is editable: it is how the addon's
        # dependency set is discovered and hash-locked, and how the lock is tied back to what
        # was asked for. Only the last step differs.
        distribution = _distribution_name(artifact)
        asked_for = _artifact_requirement(artifact)
        installer.install(
            environment,
            (asked_for, host),
            editable=EditableInstall(name=distribution, source=resolved) if editable else None,
        )

        # Twice, on purpose. The first read is the only one possible — nothing yet knows what
        # this addon is called — and the second asks the environment for the manifest of the
        # id that first one claimed, which is how a path install ends up under the same rule
        # every other install obeys: the id in the entry point, the id in the manifest and
        # the id in the directory name are one string.
        claimed = _claimed(installer.read_manifest(environment), source=resolved)
        document = installer.read_manifest(environment, addon_id=claimed.addon_id)
        manifest = _judge(document, requirement=claimed)

        _record(recorded_manifest_path(Path(scratch), _STAGED_DIRNAME), document)
        _record(
            recorded_source_path(Path(scratch), _STAGED_DIRNAME),
            {"editable": editable, "path": str(resolved)},
        )

        directory = addon_root(base, manifest.id)
        if directory.exists():
            if not force and not _came_from(base, manifest.id, resolved):
                raise InstallError(_installed_from_elsewhere(base, manifest.id, claimed))
            _replace(directory)

        staged.rename(directory)

    return InstalledAddon(
        id=manifest.id,
        manifest=manifest,
        root=directory,
        environment=addon_environment(base, manifest.id),
        manifest_path=recorded_manifest_path(base, manifest.id),
        # The same fact discovery will read back off the record just written, handed to the
        # caller that is about to tell somebody what it did.
        source=InstalledSource(path=resolved, editable=editable),
    )


def _artifact(source: Path, *, installer: AddonInstaller, into: Path) -> Path:
    """The one artifact the environment is built from, built from ``source`` if need be.

    A wheel is already an artifact with a digest. A directory is not — a resolver locks it
    with no hash at all, which is an unlocked environment under another name — so a wheel is
    built from it first and everything downstream sees the wheel (plan 0001, *Installing from
    a local path*).
    """
    if source.is_dir():
        into.mkdir(parents=True)
        return installer.build_wheel(source, into=into)

    if source.suffix == ".whl":
        return source

    raise InstallError(
        f"{source} is neither a directory nor a wheel. An addon is installed from a source "
        "tree to build, or from the wheel built from one."
    )


def _distribution_name(artifact: Path) -> str:
    """The name the artifact declares, which is the name the lock knows it by.

    The installer is asked for `<name> @ file://<wheel>` rather than the bare path a resolver
    would also accept, because the lock is checked *by name* — a lock entry nobody can look up
    under the name that was asked for proves nothing about what was installed. PEP 427 puts
    that name before the first hyphen of a wheel's file name, with every run of `-`, `_` or
    `.` written as one `_`. It is the name the artifact declares, never the directory the
    source happened to sit in, and never the addon's id: the id comes from the manifest.
    """
    return artifact.name.split("-")[0].replace("_", "-").lower()


def _came_from(base: Path, addon_id: str, source: Path) -> bool:
    """Whether the installation under ``addon_id`` was installed from ``source`` already.

    Read from the record the install itself wrote, so "the same checkout" is a fact rather
    than a guess. Anything unreadable answers ``False`` — a record nobody can read cannot say
    the two are the same, and the refusal that follows is the safe way to be wrong.
    """
    recorded = _recorded_source(base, addon_id)
    return recorded is not None and recorded.path == source


def _claimed(document: Mapping[str, object], *, source: Path) -> Requirement:
    """The id and version the manifest states, which is the only place they come from.

    Not the directory name, not the wheel's file name and not anything the person typed: an
    addon installed under a name it does not answer to could not be started, updated or
    reported consistently afterwards.
    """
    try:
        manifest = parse_manifest(document)
    except ManifestError as error:
        raise InstallError(
            f"the manifest exported by the addon at {source} was refused: {error}"
        ) from error

    return Requirement(addon_id=manifest.id, version=manifest.version)


def _installed_from_elsewhere(base: Path, addon_id: str, requirement: Requirement) -> str:
    """Why a local install was refused, naming where the installation it found came from."""
    directory = addon_root(base, addon_id)
    recorded = _recorded_source(base, addon_id)

    if recorded is not None:
        found = str(recorded)
    elif recorded_source_path(base, addon_id).exists():
        # There is a record and it could not be read. Saying "from a package index" here —
        # which is what no record means — would be this message inventing a provenance.
        found = "from a source whose record this host cannot read"
    else:
        found = "from a package index"

    return (
        f"{requirement.addon_id} is already installed in {directory}, {found}, and this "
        "install is from somewhere else. Replacing it means replacing code that did not come "
        "from this source: pass --force. Reinstalling the source it is already installed "
        "from needs no flag."
    )


def _recorded_source(base: Path, addon_id: str) -> InstalledSource | None:
    """The source recorded for an installation, or ``None`` when there is none to read.

    One reader for that record, and it is discovery's: a second description of the file here
    is a second thing to keep in step with the one that writes it. A record that is present
    but refused comes back as ``None`` — an unreadable record cannot claim two sources are
    the same, and the refusal it causes is the safe way to be wrong about that.
    """
    try:
        return read_recorded_source(recorded_source_path(base, addon_id))
    except ManifestError:
        return None


def _already_installed(directory: Path, manifest_path: Path, requirement: Requirement) -> str:
    """Why a second install was refused, naming the version that is actually installed."""
    installed = _recorded_version(manifest_path)

    if installed == requirement.version:
        return (
            f"{requirement.addon_id} {requirement.version} is already installed in "
            f"{directory}: nothing to do. Pass --force to build its environment again."
        )

    found = "an unreadable manifest" if installed is None else f"version {installed}"
    return (
        f"{requirement.addon_id} is already installed in {directory} with {found}, and you "
        f"asked for version {requirement.version}. Changing the version of an installed "
        "addon is an update, not an install: pass --force to replace its environment."
    )


def _recorded_version(manifest_path: Path) -> str | None:
    """The version in the recorded manifest, or ``None`` if it cannot be read.

    Only ever used to write a better refusal message, so a manifest too broken to read is
    reported as such rather than raising over a file nobody was asked to repair.
    """
    try:
        document = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None

    version = document.get("version") if isinstance(document, Mapping) else None
    return version if isinstance(version, str) else None


def _replace(directory: Path) -> None:
    """Remove an existing installation so the new one starts from nothing."""
    try:
        shutil.rmtree(directory)
    except OSError as error:
        raise InstallError(f"{directory} could not be replaced: {error}") from error


def _judge(document: Mapping[str, object], *, requirement: Requirement) -> AddonManifest:
    """Validate what the environment exported, and insist it is the addon that was asked for.

    An addon whose manifest names a different id or version would be installed under one name
    and report another — the same disagreement discovery refuses when it reads the record
    back, caught here where it can still be undone.
    """
    try:
        manifest = parse_manifest(document)
    except ManifestError as error:
        raise InstallError(
            f"the manifest exported by {requirement.addon_id!r} was refused: {error}"
        ) from error

    if manifest.id != requirement.addon_id:
        raise InstallError(
            f"the environment installed for {requirement.addon_id!r} exports a manifest "
            f"claiming id {manifest.id!r}: an addon has one identity, and it is the one it "
            "was installed under"
        )

    if manifest.version != requirement.version:
        raise InstallError(
            f"you asked for {requirement.addon_id} {requirement.version}, but the installed "
            f"environment reports version {manifest.version}"
        )

    return manifest


def _record(manifest_path: Path, document: Mapping[str, object]) -> None:
    """Write the manifest where discovery reads it: UTF-8 JSON, beside the environment.

    The document is recorded as the addon exported it — validated, never rewritten — so what
    discovery parses is what the entry point returned.
    """
    manifest_path.write_text(
        json.dumps(dict(document), indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
