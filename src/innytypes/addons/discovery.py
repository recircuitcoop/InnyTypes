"""Addon discovery — how the host learns what is installed without knowing any addon by name.

Each addon lives in **its own environment** (plan 0001, plan 0003 D17), and
`innytypes addons install` records the addon's manifest beside that environment. Discovery
enumerates those environments and reads the recorded manifests. That is the whole mechanism
that keeps the dependency direction one-way: the host reads a JSON document it wrote itself
at install time, so it never imports addon code and never puts an addon environment on
`sys.path`.

**The layout** — written by `innytypes addons install` (slice 08), read here, and a contract
between the two::

    <addons root>/
        <addon-id>/              one addon environment, named by the addon's id
            manifest.json        the manifest recorded at install time
            env/                 the addon's own uv environment

The **directory name is the addon's identity**. It is the only id discovery has before the
manifest has been read, and it is therefore the name a broken addon is reported under; a
recorded manifest claiming a different id is refused, because one addon answering to two
names could be started, namespaced and reported inconsistently.

The root is `<user data dir>/innytypes/addons`, resolved by `platformdirs`, and it is
injectable: every test passes its own root, so no test ever reads or writes the real one.

**One broken addon must not hide the other nine.** Every failure — a missing record, an
unreadable file, a document that is not JSON, a manifest that fails validation — is captured
as a :class:`BrokenAddon` carrying the id and the reason, and enumeration continues. Both
groups come back from one call, so a caller can print what works and what does not together.

**Discovery is the read side only.** It creates no environment, records no manifest and
invokes no installer. Installation is explicit (plan 0001): `innytypes addons install`,
never a side effect of looking.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from platformdirs import user_data_path

from innytypes.addons.manifest import AddonManifest, ManifestError, parse_manifest

__all__ = [
    "ADDONS_DIRNAME",
    "APPLICATION_NAME",
    "ENVIRONMENT_DIRNAME",
    "MANIFEST_FILENAME",
    "BrokenAddon",
    "DiscoveryResult",
    "InstalledAddon",
    "addon_environment",
    "addon_root",
    "default_addons_root",
    "discover_addons",
    "recorded_manifest_path",
]

# The per-user directory names. `appauthor=False` keeps the Windows vendor folder out of the
# path, so the layout reads the same on every platform the host runs on.
APPLICATION_NAME = "innytypes"
ADDONS_DIRNAME = "addons"

# The two names inside one addon environment root.
MANIFEST_FILENAME = "manifest.json"
ENVIRONMENT_DIRNAME = "env"


@dataclass(frozen=True)
class InstalledAddon:
    """One addon whose recorded manifest was read and validated.

    ``manifest`` is a parsed :class:`~innytypes.addons.manifest.AddonManifest`, never a dict:
    the resolver, the bus and the lifecycle read it by attribute and re-validate nothing.
    """

    id: str
    manifest: AddonManifest
    root: Path
    environment: Path
    manifest_path: Path


@dataclass(frozen=True)
class BrokenAddon:
    """One addon that could not be read, named so a human can go and fix it.

    ``id`` is the environment's directory name — the identity that survives a manifest too
    broken to state one — and ``reason`` is what was wrong, in the words of the failure.
    """

    id: str
    root: Path
    reason: str


@dataclass(frozen=True)
class DiscoveryResult:
    """Everything one enumeration found: what works, and what does not.

    Both groups travel together on purpose. A caller that wants only the working addons can
    ignore ``broken``, but it can never be handed a silently shortened list.
    """

    installed: tuple[InstalledAddon, ...]
    broken: tuple[BrokenAddon, ...]


def default_addons_root() -> Path:
    """Where addon environments live for this user, creating nothing."""
    return user_data_path(APPLICATION_NAME, appauthor=False) / ADDONS_DIRNAME


def addon_root(root: Path, addon_id: str) -> Path:
    """The one directory belonging to ``addon_id``."""
    return root / addon_id


def addon_environment(root: Path, addon_id: str) -> Path:
    """The addon's own uv environment, inside its directory."""
    return addon_root(root, addon_id) / ENVIRONMENT_DIRNAME


def recorded_manifest_path(root: Path, addon_id: str) -> Path:
    """The manifest recorded beside the environment at install time."""
    return addon_root(root, addon_id) / MANIFEST_FILENAME


def discover_addons(root: Path | None = None) -> DiscoveryResult:
    """Enumerate the installed addon environments and read every recorded manifest.

    Returns the validated addons and the broken ones, sorted by id so two runs of
    `addons list` cannot disagree about the order. Nothing is written, nothing is installed
    and no addon code is imported.
    """
    base = default_addons_root() if root is None else root

    # Nothing installed yet is not an error, and it is certainly not a reason to create the
    # directory: discovery never writes.
    if not base.is_dir():
        return DiscoveryResult(installed=(), broken=())

    installed: list[InstalledAddon] = []
    broken: list[BrokenAddon] = []

    for entry in sorted(base.iterdir()):
        # An addon environment is a directory. A stray file — `.DS_Store`, a download — is
        # not a half-installed addon, so it is not reported as one.
        if not entry.is_dir():
            continue

        addon_id = entry.name
        manifest_path = recorded_manifest_path(base, addon_id)

        try:
            manifest = _read_recorded_manifest(manifest_path, addon_id=addon_id)
        except ManifestError as error:
            broken.append(BrokenAddon(id=addon_id, root=entry, reason=str(error)))
            continue
        except OSError as error:
            broken.append(
                BrokenAddon(
                    id=addon_id,
                    root=entry,
                    reason=f"recorded manifest at {manifest_path} could not be read: {error}",
                )
            )
            continue

        installed.append(
            InstalledAddon(
                id=addon_id,
                manifest=manifest,
                root=entry,
                environment=addon_environment(base, addon_id),
                manifest_path=manifest_path,
            )
        )

    return DiscoveryResult(installed=tuple(installed), broken=tuple(broken))


def _read_recorded_manifest(path: Path, *, addon_id: str) -> AddonManifest:
    """Read and validate one recorded manifest, raising :class:`ManifestError` with the reason.

    Every refusal below names the file, because the person reading the message has to find it.
    """
    if not path.exists():
        raise ManifestError(
            f"no {MANIFEST_FILENAME} recorded at {path}: the environment exists but nothing "
            "was recorded beside it — reinstall the addon with `innytypes addons install`"
        )

    # Bytes first: a recorded manifest that is not text at all is a broken addon, not an
    # exception escaping discovery.
    raw = path.read_bytes()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ManifestError(f"recorded manifest at {path} is not UTF-8 text: {error}") from error

    try:
        document = json.loads(text)
    except json.JSONDecodeError as error:
        raise ManifestError(f"recorded manifest at {path} is not valid JSON: {error}") from error

    manifest = parse_manifest(document)

    if manifest.id != addon_id:
        raise ManifestError(
            f"recorded manifest at {path} claims id {manifest.id!r}, but it is installed as "
            f"{addon_id!r}: an addon has one identity, and it is the one it was installed under"
        )

    return manifest
