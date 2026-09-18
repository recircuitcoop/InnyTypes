"""Plugin environments, from the helper's side: build one elsewhere, then swap it in.

Each plugin has its own `uv` environment (plan 0003, D17), and `innytypes addons install`
already knows how to build one: :func:`~innytypes.addons.install.install_addon` takes an
**injected installer** and the **root it writes into**. This module adds the two things the
helper needs on top of that, and nothing else.

**Build somewhere else.** A new environment is built under a **staging root** — a sibling of
the addons root, never inside it, because discovery enumerates every directory under the
addons root and a half-built environment there would be reported as a broken plugin from the
moment the build started. Staging uses the same `install_addon` with a different root, so a
staged environment and an installed one are the same layout in two places: the manifest
discovery reads and the lock it was installed from, recorded side by side.

**Then swap, keeping what was there.** :func:`swap_in` moves the live environment aside to
the **previous root** and moves the staged one into its place, two renames and no copying.
:func:`roll_back` is the same two renames in reverse. A plugin update is therefore a build
that can fail with the live environment untouched, followed by a swap that can be undone.

**This module sequences nothing.** Plan 0003 applies an update to a *group* of plugins:
stop what is affected, swap each one, start them in order, and roll the **whole group** back
if any of them fails to become healthy. Each of those swaps is one call here. Deciding which
plugins are in the group, stopping them and judging their health is plan 0003 slices 12 and
13 — this module is the primitive they are built from, and it starts and stops nothing.

**Renames, not copies.** The three roots live side by side under one per-user data directory
so `os.replace` stays within one filesystem, where it is atomic. A swap that lands across a
filesystem boundary is refused by name rather than silently degraded into a copy, because a
half-copied environment is exactly what the rename was chosen to make impossible.
"""

from __future__ import annotations

import os
import shutil
from dataclasses import dataclass
from pathlib import Path

from platformdirs import user_data_path

from innytypes.addons.discovery import (
    APPLICATION_NAME,
    InstalledAddon,
    addon_root,
    recorded_manifest_path,
)
from innytypes.addons.install import AddonInstaller, install_addon
from innytypes.addons.lock import recorded_lock_path
from innytypes.addons.manifest import Requirement

__all__ = [
    "PREVIOUS_DIRNAME",
    "STAGING_DIRNAME",
    "SwapError",
    "SwappedEnvironment",
    "default_previous_root",
    "default_staging_root",
    "roll_back",
    "stage_environment",
    "swap_in",
]

# Siblings of `addons` under the per-user data directory, never children of it: discovery
# reads every directory under the addons root as a plugin, and neither of these is one.
STAGING_DIRNAME = "staging"
PREVIOUS_DIRNAME = "previous"


class SwapError(RuntimeError):
    """Raised when an environment cannot be swapped in or rolled back, naming what stopped it.

    Every refusal below happens **before** the first rename, or is undone by the second, so a
    caller that sees this exception knows the live environment is the one that was there.
    """


@dataclass(frozen=True)
class SwappedEnvironment:
    """What one swap did: where the plugin now lives, and where its old environment went.

    ``previous`` is ``None`` when there was nothing to replace — a plugin being installed for
    the first time through the staging path. That is the one case :func:`roll_back` has
    nothing to do, and saying so here is what lets a caller tell it apart from a swap it could
    undo.
    """

    id: str
    live: Path
    previous: Path | None


def default_staging_root() -> Path:
    """Where environments are built before they are live, for this user."""
    return user_data_path(APPLICATION_NAME, appauthor=False) / STAGING_DIRNAME


def default_previous_root() -> Path:
    """Where the environment a swap replaced is kept, for this user."""
    return user_data_path(APPLICATION_NAME, appauthor=False) / PREVIOUS_DIRNAME


def stage_environment(
    requirement: Requirement,
    *,
    installer: AddonInstaller,
    staging_root: Path,
) -> InstalledAddon:
    """Build one plugin's new environment under ``staging_root``, touching nothing live.

    The same install as `innytypes addons install`, pointed somewhere else: the plugin at its
    exact version, its dependencies locked with hashes and `innytypes` pinned at the running
    host's version, with the manifest recorded beside it. Everything the plugin's own
    interpreter is asked to do happens here, before anything is stopped.

    ``force`` is always on. A staged build left behind by an update that failed, or by one the
    user never applied, is scrap — refusing to overwrite it would strand the plugin on a build
    nobody asked to keep.
    """
    return install_addon(requirement, installer=installer, root=staging_root, force=True)


def swap_in(
    addon_id: str,
    *,
    live_root: Path,
    staging_root: Path,
    previous_root: Path,
) -> SwappedEnvironment:
    """Make the staged environment live, keeping the one it replaced.

    Two renames: the live environment to ``previous_root``, then the staged one into its
    place. Either the plugin is running its old environment or it is running its new one;
    there is no state in between where it is running half of each.
    """
    staged = addon_root(staging_root, addon_id)
    live = addon_root(live_root, addon_id)
    kept = addon_root(previous_root, addon_id)

    _insist_complete(staged, addon_id)

    live_root.mkdir(parents=True, exist_ok=True)
    previous_root.mkdir(parents=True, exist_ok=True)

    # The `previous` from an earlier swap is spent: one environment is kept, the one this
    # swap replaces, and keeping a chain of them would be a disk leak nobody empties.
    shutil.rmtree(kept, ignore_errors=True)

    replaced = live.exists()
    if replaced:
        _rename(live, kept, addon_id)

    try:
        _rename(staged, live, addon_id)
    except SwapError:
        # The first rename happened and the second did not. Put the old environment back:
        # a plugin with no environment at all is worse than a plugin that was not updated.
        if replaced:
            _rename(kept, live, addon_id)
        raise

    return SwappedEnvironment(id=addon_id, live=live, previous=kept if replaced else None)


def roll_back(addon_id: str, *, live_root: Path, previous_root: Path) -> Path:
    """Put back the environment the last swap replaced, and return where it now lives.

    Refuses when there is nothing kept for this plugin, rather than removing the live
    environment and leaving the plugin with none: "roll back to nothing" is not a rollback.
    """
    kept = addon_root(previous_root, addon_id)
    live = addon_root(live_root, addon_id)

    if not kept.is_dir():
        raise SwapError(
            f"{addon_id} cannot be rolled back: nothing is kept for it at {kept}. A rollback "
            "restores the environment a swap replaced, and no swap has replaced one."
        )

    live_root.mkdir(parents=True, exist_ok=True)

    # The environment being rolled back is moved aside rather than deleted outright, so the
    # window in which the plugin has no environment at all is one rename wide.
    discarded = previous_root / f"{addon_id}.rolled-back"
    shutil.rmtree(discarded, ignore_errors=True)

    moved = live.exists()
    if moved:
        _rename(live, discarded, addon_id)

    try:
        _rename(kept, live, addon_id)
    except SwapError:
        if moved:
            _rename(discarded, live, addon_id)
        raise

    shutil.rmtree(discarded, ignore_errors=True)
    return live


def _insist_complete(staged: Path, addon_id: str) -> None:
    """Refuse to swap in anything that is not a finished environment.

    A staged directory is finished when it carries both records an install writes: the
    manifest discovery will read, and the lock the environment was installed from. Swapping
    in a directory missing either one would replace a working plugin with one the host
    reports as broken.
    """
    if not staged.is_dir():
        raise SwapError(
            f"nothing is staged for {addon_id} at {staged}: build the environment before "
            "swapping it in"
        )

    manifest = recorded_manifest_path(staged.parent, addon_id)
    if not manifest.is_file():
        raise SwapError(
            f"the environment staged for {addon_id} records no manifest at {manifest}: it is "
            "a half-built environment, and swapping it in would replace a working plugin "
            "with a broken one"
        )

    lock = recorded_lock_path(staged.parent, addon_id)
    if not lock.is_file():
        raise SwapError(
            f"the environment staged for {addon_id} records no lock at {lock}: an environment "
            "that cannot say what it was built from is not one to swap in"
        )


def _rename(source: Path, destination: Path, addon_id: str) -> None:
    """One atomic rename, with every way it can fail named after the plugin it belongs to."""
    try:
        os.replace(source, destination)
    except OSError as error:
        raise SwapError(
            f"{addon_id}: {source} could not be moved to {destination}: {error}. A plugin "
            "environment is swapped by renaming it, which needs both paths on one filesystem."
        ) from error
