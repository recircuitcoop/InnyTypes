"""Removing a plugin — stop it, refuse while it is still needed, and take everything it had.

`innytypes addons install` is the only way a plugin arrives (plan 0001, invariant 6); this is
the only way one leaves, and it is that install in reverse. Plan 0004, *Removing a plugin*,
gives it four rules, and they are applied in this order:

1. **Refuse what is not there.** A plugin id that is not installed is refused by name, and so
   is one whose recorded manifest could not be read. Removal walks **the installation the
   host recorded**, never a path a caller supplies, so a record it cannot trust is a refusal
   rather than a guess about which directory to delete.
2. **Refuse while another installed plugin requires it**, naming that plugin. It is the rule
   :mod:`innytypes.addons.resolution` already applies when the host starts — a requirement
   that is not installed holds its dependent back — applied *before* the damage instead of
   reported for ever after it. It is asked before the stop as well as before the deletion, so
   a plugin that is going nowhere is not stopped on the way to being told so.
3. **Stop it first**, as an **expected** stop, through the control channel
   (:class:`~innytypes.helper.restart.ControlChannel`). The host owns its children and
   nothing here touches a process or a signal (plan 0001, invariant 9). *Expected* is the
   load-bearing word: an expected exit is the one thing the helper's restart policy does not
   undo (:meth:`innytypes.helper.restart.RestartPolicy.child_exited`), so a removal that
   killed the plugin instead would watch it come back while its environment was being
   deleted. A stop that fails for any other reason stops the removal with nothing yet
   touched, because a plugin that is still running is a plugin still holding its environment
   open.
4. **Then everything it had goes** (D8): the recorded manifest, the environment, the settings
   file and the secrets. Installing the same plugin again afterwards starts from its
   declaration's defaults, which is what "remove" was taken to mean.

**The order of destruction is the whole of what makes an interrupted removal safe.** Removal
is four filesystem operations and any one of them can be the last — the power goes, the
process is killed — so the order is chosen by what each half-finished state looks like to the
next :func:`~innytypes.addons.discovery.discover_addons`:

* **The recorded manifest goes first**, as a single unlink. From that instant discovery
  reports the plugin as a :class:`~innytypes.addons.discovery.BrokenAddon` — "no
  manifest.json recorded … reinstall the addon" — which is honest, visible in `addons list`,
  and invisible to :func:`~innytypes.addons.resolution.resolve_start_order`, which is only
  ever handed manifests that parsed. Nothing will try to start it.
* **The environment goes second**, as one tree. The other order produces the one state that
  must never exist: a manifest that still parses beside an environment that is half deleted,
  which discovery reports as *installed* and the host then tries to launch an interpreter out
  of. Installed-but-actually-gone is worse than broken, because only one of the two says
  anything.
* **The settings file and the secrets go last.** By then the plugin is not installed and what
  is left is inert. The opposite order would leave a whole, startable plugin whose required
  fields have no values — held disabled with a reason nobody caused
  (:class:`~innytypes.addons.settings.Hold`) — which is a worse thing to wake up to than an
  orphaned TOML file.

So every point at which this can be interrupted leaves either a plugin that is entirely
there, or one that is visibly incomplete and started by nobody.

**Nothing here deletes a path it was not told about.** The manifest, the environment and the
directory holding them are what discovery read back; the settings file is the plugin's own
(:func:`~innytypes.addons.settings.default_settings_path`); the secrets go through
:meth:`~innytypes.addons.secrets.SecretStore.clear_addon`, which decides for itself what in
that directory is one of its files and leaves the directory standing if anything else is.
All three roots are injectable and every test passes its own, so no test can reach the real
per-user directories.

This module is deliberately **not** re-exported from :mod:`innytypes.addons`. It imports
:mod:`innytypes.children` for the command vocabulary, and that module imports
:mod:`innytypes.addons.discovery`; putting this one in the package's ``__init__`` would close
that pair into a cycle, exactly as :mod:`innytypes.addons.install` documents for the same
reason.
"""

from __future__ import annotations

import shutil
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from innytypes.addons.discovery import (
    DiscoveryResult,
    InstalledAddon,
    default_addons_root,
    discover_addons,
)
from innytypes.addons.secrets import PluginSecretError, SecretStore, default_secrets_root
from innytypes.addons.settings import default_settings_path
from innytypes.children import Command, CommandName, UnknownChildError
from innytypes.helper.restart import ControlChannel
from innytypes.logs import get_logger

__all__ = [
    "RemovalError",
    "RemovedAddon",
    "remove_addon",
    "why_not_removable",
]

log = get_logger(__name__)


class RemovalError(RuntimeError):
    """Raised when a plugin cannot be removed, naming what stopped it.

    One family for every refusal here — a plugin that is not installed, one whose record
    cannot be read, one another plugin requires, and a deletion the filesystem refused —
    because the caller's response to all of them is the same: print it and stop.
    """


@dataclass(frozen=True)
class RemovedAddon:
    """What one completed removal took, so its caller can say so in a line or two.

    ``stopped`` is ``False`` when the host had no such child to stop, which is the ordinary
    answer for a plugin that was never started. ``settings_removed`` and ``secrets_removed``
    say how much there was to take, not how much there should have been: a plugin that never
    recorded a value had nothing to delete, and that is a clean removal rather than a partial
    one.
    """

    id: str
    version: str
    root: Path
    environment: Path
    manifest_path: Path
    settings_path: Path
    secrets_directory: Path
    stopped: bool
    settings_removed: bool
    secrets_removed: int


def remove_addon(
    addon_id: str,
    *,
    channel: ControlChannel,
    root: Path | None = None,
    settings_path: Path | None = None,
    secrets_root: Path | None = None,
) -> RemovedAddon:
    """Remove one installed plugin and everything the host recorded for it (plan 0004, D8).

    ``addon_id`` is the only thing a caller says about *which* plugin: the paths come from
    what discovery read back, never from an argument. The three roots exist so a test — and a
    second addon set on the same machine — can point the whole operation somewhere else;
    ``None`` means this user's real directory in each case.

    Raises :class:`RemovalError` for every refusal, and raises it **before** anything on disk
    has been touched in all but one case: a deletion the filesystem itself refuses part way
    through, which is reported with what is left behind.
    """
    base = default_addons_root() if root is None else root
    found = discover_addons(base)

    addon = _recorded(addon_id, found)
    _refuse_while_required(addon, found.installed)

    # Nothing below this line can be undone, so the stop is the last thing that can still
    # call the removal off (plan 0004: stop it first, and only then touch its environment).
    stopped = _stop(addon_id, channel=channel)

    settings = default_settings_path(addon_id) if settings_path is None else settings_path
    secrets = SecretStore(root=default_secrets_root() if secrets_root is None else secrets_root)
    secrets_directory = secrets.directory_for(addon_id)

    # 1. The record the host acts on, first: from here the plugin is not installed, and
    #    nothing that resolves a start order can see it again.
    _forget(addon.manifest_path, what=f"the recorded manifest of {addon_id}")

    # 2. The environment, and the directory holding it — the lock and any recorded source
    #    with it, all of which were written by the install this is undoing.
    _forget_tree(addon.root, what=f"the environment of {addon_id}")

    # 3 and 4. Inert by now, and taken because "remove" means a reinstall starts from the
    #    declaration's defaults rather than from whatever the last installation was told.
    settings_removed = _forget(settings, what=f"the settings file of {addon_id}")
    secrets_removed = _forget_secrets(addon_id, secrets)

    log.info(
        "removed %s %s: environment, recorded manifest, %s settings file and %s secrets",
        addon.id,
        addon.manifest.version,
        "its" if settings_removed else "no",
        secrets_removed,
    )

    return RemovedAddon(
        id=addon.id,
        version=addon.manifest.version,
        root=addon.root,
        environment=addon.environment,
        manifest_path=addon.manifest_path,
        settings_path=settings,
        secrets_directory=secrets_directory,
        stopped=stopped,
        settings_removed=settings_removed,
        secrets_removed=secrets_removed,
    )


# --- the refusals, all of them before anything is touched ----------------------------------


def _recorded(addon_id: str, found: DiscoveryResult) -> InstalledAddon:
    """The installation the host recorded for this id, or a refusal saying why there is none.

    A **broken** record is refused as loudly as an absent one, and for the reason this whole
    module is built around: the record is what says which environment belongs to this plugin,
    so a record that could not be read leaves nothing to walk. Deleting the directory anyway
    would be removal by guess, which is the one thing plan 0004 rules out.
    """
    for addon in found.installed:
        if addon.id == addon_id:
            return addon

    for broken in found.broken:
        if broken.id == addon_id:
            raise RemovalError(
                f"{addon_id} cannot be removed: what the host recorded for it could not be "
                f"read, and removal walks that record rather than guessing at a directory — "
                f"{broken.reason}. Nothing was removed."
            )

    raise RemovalError(
        f"{addon_id} is not installed; `innytypes addons list` shows what is. Nothing was removed."
    )


def why_not_removable(addon_id: str, installed: Sequence[InstalledAddon]) -> str | None:
    """Why this plugin cannot be removed while these others are installed, or ``None``.

    The rule, without the raising, because it has a second reader: the window's plugin page
    (plan 0004, slice 08) draws a Remove control per plugin and has to know *before* it draws
    one whether pressing it would be refused. A control that refuses when pressed is worse
    than one that says why it is disabled, and a page with its own copy of this rule would
    eventually disagree with the removal itself.

    The first requirer by id is the one reported, as everywhere else in the host: one broken
    rule, named, rather than a list format nothing else prints. The version it pinned is
    printed the way :mod:`innytypes.addons.resolution` prints a requirement, because the
    sentence this refusal is preventing is that module's.
    """
    for other in installed:
        if other.id == addon_id:
            continue

        for requirement in other.manifest.requires:
            if requirement.addon_id != addon_id:
                continue

            return (
                f"{addon_id} cannot be removed: {other.id} requires {requirement}. Removing "
                f'it would hold {other.id} back every time the host started — "requires '
                f'{requirement}, which is not installed". Remove {other.id} first, or change '
                "what it requires. Nothing was removed."
            )

    return None


def _refuse_while_required(addon: InstalledAddon, installed: Sequence[InstalledAddon]) -> None:
    """Raise :func:`why_not_removable`'s answer, when it has one."""
    refusal = why_not_removable(addon.id, installed)
    if refusal is not None:
        raise RemovalError(refusal)


def _stop(addon_id: str, *, channel: ControlChannel) -> bool:
    """Ask the host to stop the plugin, and say whether there was one to stop.

    ``STOP`` rather than ``KILL``, and through the channel rather than by signalling anything:
    the host marks the exits it was asked for as **expected**, and an expected exit is the one
    the helper's restart policy leaves alone.

    A host that has no such child has nothing to stop — the plugin was never started, or the
    application is not running at all — and that is an answer, not a failure. Every other
    failure is raised: it happens before a single file has been touched, which is exactly
    where a removal that cannot stop its plugin should stop.
    """
    try:
        channel.send(Command(name=CommandName.STOP, child_id=addon_id))
    except UnknownChildError:
        return False

    return True


# --- the destruction, in the order the module docstring argues for --------------------------


def _forget(path: Path, *, what: str) -> bool:
    """Remove one file. ``True`` if there was one, ``False`` if there was not.

    A file that is already gone is the partial record plan 0004 anticipates — a settings file
    a person deleted by hand — and removal completes cleanly for the rest rather than refusing
    over something it wanted gone anyway.
    """
    try:
        path.unlink()
    except FileNotFoundError:
        return False
    except OSError as error:
        raise RemovalError(f"{what} could not be removed from {path}: {error.strerror}") from None

    return True


def _forget_tree(directory: Path, *, what: str) -> None:
    """Remove one directory and everything in it, or say what is left behind."""
    try:
        shutil.rmtree(directory)
    except FileNotFoundError:
        return
    except OSError as error:
        raise RemovalError(
            f"{what} could not be removed from {directory}: {error.strerror}. Its recorded "
            "manifest is already gone, so `innytypes addons list` now reports it broken and "
            "nothing will start it; remove that directory and run the removal again."
        ) from None


def _forget_secrets(addon_id: str, secrets: SecretStore) -> int:
    """Take every secret the plugin had, and say how many there were (D8).

    The store does the removing, because it is the only thing that knows what it wrote: what
    it declines to take keeps the directory standing, and that judgement stays in one place
    rather than being second-guessed here.
    """
    try:
        return secrets.clear_addon(addon_id)
    except PluginSecretError as error:
        raise RemovalError(
            f"the secrets of {addon_id} could not be removed: {error}. Everything else it had "
            "is gone; remove that directory by hand."
        ) from None
