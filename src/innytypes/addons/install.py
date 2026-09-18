"""Explicit install — the write side of everything discovery reads.

Installation happens because a person asked for it (plan 0001, invariant 6). Nothing here is
reachable from starting the host: `innytypes up` calls no function in this module, and that
absence is the point — a startup that mutates an environment is a startup nobody can debug.

Installing one addon is four steps, in this order:

1. **Refuse a second install.** An addon already installed is left exactly as it is unless
   ``--force`` was passed. The check happens before anything is created, so a refusal cannot
   half-replace the environment it refused to touch.
2. **Create the addon's own environment**, on the same Python the host is running.
3. **Install the addon at its exact version, with `innytypes` pinned beside it** at exactly
   the version of the running host, so the addon sees the host API contracts this host
   enforces (plan 0001, *Each addon has its own environment*). :class:`UvInstaller` resolves
   that pair to a **hash lock** first, records it beside the environment and installs from
   nothing else, because the lock is the only thing standing between an auto-updating plugin
   and whatever its index serves next (plan 0003, D16; invariant 10).
4. **Read the manifest from inside that environment** and record it beside it, at the path
   :func:`~innytypes.addons.discovery.recorded_manifest_path` reads. Install writes exactly
   what discovery reads; there is no second description of the layout here.

**The installer is injected.** :class:`AddonInstaller` is the whole of what this module needs
from the outside world — three calls, no `uv` and no subprocess of its own — so the gate
proves the install logic on a machine with no `uv` and no network, and plan 0003 slice 11
reuses the same seam to build a *staged* environment somewhere else. :class:`UvInstaller` is
the production implementation, and it injects its command runner for the same reason.

**The host still imports no addon code.** The manifest is read by the addon's *own*
interpreter, in its own environment, through the ``innytypes.addons`` entry point group; what
crosses back is a JSON document. The entry point is **named after the addon's id** and names
a callable taking no arguments that returns the manifest document — one spelling, so the id
in the directory name, the id in the entry point and the id in the manifest are the same
string or the install is refused.

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
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from innytypes import __version__
from innytypes.addons.discovery import (
    InstalledAddon,
    addon_environment,
    addon_root,
    default_addons_root,
    recorded_manifest_path,
)
from innytypes.addons.lock import EnvironmentLock, LockError, lock_path, parse_lock
from innytypes.addons.manifest import AddonManifest, ManifestError, Requirement, parse_manifest

__all__ = [
    "ENTRY_POINT_GROUP",
    "AddonInstaller",
    "InstallError",
    "Runner",
    "UvInstaller",
    "host_python_version",
    "install_addon",
]

# The entry point group an addon exports its manifest from, read inside the addon's own
# environment. The entry point's *name* is the addon's id.
ENTRY_POINT_GROUP = "innytypes.addons"

# Read in the addon's interpreter, printing the manifest document as JSON on stdout. It is a
# script rather than an import because running it in the host's interpreter would be the host
# importing addon code, which is the one thing the whole design forbids (plan 0001).
_MANIFEST_READER = """\
import json
import sys
from importlib.metadata import entry_points

group = "innytypes.addons"
name = sys.argv[1]

found = [entry for entry in entry_points(group=group) if entry.name == name]
if not found:
    raise SystemExit(
        f"this environment exports no {group} entry point named {name!r}: an addon exports "
        "its manifest from an entry point named after its own id"
    )
if len(found) > 1:
    raise SystemExit(
        f"this environment exports {len(found)} {group} entry points named {name!r}: an "
        "addon has one manifest"
    )

export = found[0].load()
if not callable(export):
    raise SystemExit(
        f"the {group} entry point named {name!r} is not callable: it names a function that "
        "takes no arguments and returns the manifest document"
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


class AddonInstaller(Protocol):
    """Everything installing an addon needs from the outside world, and nothing else.

    Three calls, in the order :func:`install_addon` makes them. An implementation may run
    `uv`, unpack a staged environment (plan 0003 slice 11) or record what it was asked for
    and create nothing at all, which is what the gate does.
    """

    def create_environment(self, environment: Path, *, python: str) -> None:
        """Create the addon's own environment at ``environment``, on ``python``."""
        ...

    def install(self, environment: Path, requirements: Sequence[str]) -> None:
        """Install ``requirements`` — the addon and the host's pin — into that environment."""
        ...

    def read_manifest(self, environment: Path, *, addon_id: str) -> Mapping[str, object]:
        """Read the manifest the addon exports, **inside** that environment."""
        ...


# A command runner: argv in, its standard output back. The seam that keeps `uv` out of the
# gate, shaped like the `spawn` the supervisors already take.
Runner = Callable[[Sequence[str]], str]


def _default_run(argv: Sequence[str]) -> str:
    """Run one command to completion, raising ``CalledProcessError`` if it failed."""
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
    run: Runner = _default_run

    def create_environment(self, environment: Path, *, python: str) -> None:
        """`uv venv` on the host's own Python, so every addon runs the interpreter the host
        was built against."""
        self._run([self.uv, "venv", "--python", python, str(environment)])

    def install(self, environment: Path, requirements: Sequence[str]) -> None:
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
                    str(addon_interpreter(environment)),
                    str(source),
                ]
            )

        try:
            return parse_lock(text)
        except LockError as error:
            raise InstallError(
                f"the lock resolved for {' '.join(requirements)} was refused: {error}"
            ) from error

    def read_manifest(self, environment: Path, *, addon_id: str) -> Mapping[str, object]:
        """Ask the addon's interpreter for the manifest its entry point exports."""
        output = self._run([str(_addon_interpreter(environment)), "-c", _MANIFEST_READER, addon_id])

        try:
            document = json.loads(output)
        except ValueError as error:
            raise InstallError(
                f"the {ENTRY_POINT_GROUP} entry point of {addon_id!r} did not return a JSON "
                f"document: {error}"
            ) from error

        if not isinstance(document, Mapping):
            raise InstallError(
                f"the {ENTRY_POINT_GROUP} entry point of {addon_id!r} returned a "
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


def install_addon(
    requirement: Requirement,
    *,
    installer: AddonInstaller,
    root: Path | None = None,
    force: bool = False,
) -> InstalledAddon:
    """Install one addon into its own environment and record its manifest beside it.

    Returns the addon exactly as :func:`~innytypes.addons.discovery.discover_addons` will
    report it, because both sides read the one layout described in ``discovery``.
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
        installer.create_environment(environment, python=host_python_version())
        installer.install(environment, (str(requirement), f"innytypes=={__version__}"))
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
