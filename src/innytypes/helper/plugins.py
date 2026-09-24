"""The plugin page's host: one read-only view, five actions, and nothing of its own.

Plan 0004, *The plugin page* and *What the application is told, in one place*. The window
gains a page listing every installed plugin, and this module is what stands behind it:

* :class:`PluginHost` — the seam the page is built on. One read call
  (:meth:`PluginHost.view`) and one call per action, which is the whole contract. The page
  holds a :class:`PluginHost` and nothing else, so nothing it draws can have been composed
  from three modules and it can reach no manifest, no lock and no environment.
* :class:`InstalledPluginHost` — the production implementation, which *is* that composition,
  in one place, made once per draw.
* :class:`PluginPage` — the page itself: it asks for the view, hands it to the desktop, and
  routes each of the five controls to the host call that already owns the work.

**Every action is somebody else's function.** Add is
:func:`~innytypes.addons.install.install_addon` or
:func:`~innytypes.addons.install.install_addon_from_path` (plan 0001, slices 08 and 08c);
remove is :func:`~innytypes.addons.removal.remove_addon` (slice 07); update is the applier
plan 0003 slices 12 and 13 built, reached through an injected callable; enable and disable are
:class:`~innytypes.helper.enablement.EnableSwitch` (slice 06); configure is
:class:`~innytypes.addons.settings_form.SettingsForm` (slice 04), with the `secret` fields
going to :func:`~innytypes.addons.secrets.store_secret`, which is the secret half of that same
save. There is no fourth way to do any of it here, and there is no logic on the page at all.

**The real secret predicate, wired** (D6). Every settings store this module builds is given
:func:`~innytypes.addons.secrets.secret_is_set_for`, bound to that plugin's id. The store's
own default answers "no secret is set" for everything — the truthful answer when nothing is
wired up, and a lie once the secret store exists: a plugin whose only missing field is a
credential the user already entered would be shown as held disabled for ever. So the wiring is
not a detail, and `tests/test_plugin_page.py` fails if it is removed.

**The page shows what is installed, never an index to browse** (D12). The view is built from
:func:`~innytypes.addons.discovery.discover_addons` and from nothing else that could name a
plugin — a version report for something that is not installed names no entry here, because
entries come from the installations and updates are looked up against them.

**A saved value restarts the plugin, and this module decides none of that** (D10). The host
is given the helper's :class:`~innytypes.helper.settings_watch.SettingsWatch`, keeps it in
step with what each view says is running, and asks it to look again as soon as a save has
written a file. The watch is the one thing that decides a restart is owed, and the restart it
asks for is the existing one — a ``restart`` command down the same control channel — so the
breaker counts nothing and the restart policy undoes nothing.

**Nothing here registers a system-tray icon** (plan 0003, F4), in this module as in every
other one under :mod:`innytypes`.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

from innytypes.addons.discovery import (
    BrokenAddon,
    InstalledAddon,
    default_addons_root,
    discover_addons,
)
from innytypes.addons.install import AddonInstaller, install_addon, install_addon_from_path
from innytypes.addons.manifest import Requirement
from innytypes.addons.removal import RemovedAddon, remove_addon, why_not_removable
from innytypes.addons.secrets import (
    SecretStore,
    default_secrets_root,
    secret_is_set_for,
    store_secret,
)
from innytypes.addons.settings import (
    SETTINGS_DIRECTORY,
    USER,
    FieldProblem,
    SettingsStore,
    WriteOutcome,
    is_secret_field,
)
from innytypes.addons.settings_form import PluginState as AvailabilityState
from innytypes.addons.settings_form import SettingsForm
from innytypes.children import Command, CommandName
from innytypes.helper.config import HelperSettings
from innytypes.helper.control import ControlError
from innytypes.helper.enablement import EnableSwitch, SwitchResult, plugin_states
from innytypes.helper.restart import ControlChannel
from innytypes.helper.rollout import AppliedUpdate
from innytypes.helper.settings_watch import SettingsWatch
from innytypes.helper.versions import PluginReport
from innytypes.helper.window import (
    Desktop,
    PluginEntry,
    PluginSource,
    PluginView,
    pending_update_row,
    run_state_for,
)
from innytypes.logs import get_logger

__all__ = [
    "AddRequest",
    "InstalledPluginHost",
    "PluginHost",
    "PluginPage",
    "PluginPageError",
]

log = get_logger(__name__)


class PluginPageError(RuntimeError):
    """Raised when the page is asked for something it has no way to do."""


@dataclass(frozen=True)
class AddRequest:
    """What the **Add** control was given: a requirement to fetch, or a path on this machine.

    Two members rather than one string the host has to guess at. `innytypes addons install`
    already takes the two as different arguments, and a page that sniffed at a string to
    decide which one it had would be inventing a third rule about what a plugin's name looks
    like — the kind of guess plan 0001's "installation is explicit" exists to rule out.
    """

    requirement: Requirement | None = None
    path: Path | None = None
    editable: bool = False

    def __post_init__(self) -> None:
        if (self.requirement is None) == (self.path is None):
            raise PluginPageError(
                "an Add is either a requirement to fetch or a path on this machine, and this "
                "one names " + ("both" if self.requirement is not None else "neither")
            )
        if self.editable and self.path is None:
            raise PluginPageError(
                "only a path can be installed editable: an editable install points an "
                "environment at a source tree somebody can edit"
            )


class PluginHost(Protocol):
    """Everything the plugin page asks of the application — one read, and five actions.

    Deliberately this small. The page's whole job is to draw the view and to route a press,
    so every method here is either *the* view or *one* of the five actions, and there is no
    call a page could use to look something up on the side.
    """

    def view(self) -> PluginView:
        """Every installed plugin, as of now, in one read-only value."""
        ...

    def add(self, request: AddRequest) -> InstalledAddon:
        """**Add**: install a plugin from an index, a path or an editable checkout."""
        ...

    def remove(self, plugin_id: str) -> RemovedAddon:
        """**Remove**: stop it and take everything it had (plan 0004, D8)."""
        ...

    def update(self, plugin_id: str) -> AppliedUpdate:
        """**Update**: apply the pending update this plugin's line is showing."""
        ...

    def set_enabled(self, plugin_id: str, *, enabled: bool) -> SwitchResult:
        """**Enable / disable**: the user's own switch, and the start or stop it causes."""
        ...

    def configure(self, plugin_id: str, values: Mapping[str, object]) -> WriteOutcome:
        """**Configure**: save the settings form, field by field."""
        ...


class PluginPage:
    """The window's plugin page: draw the view, and route each control to its one call.

    It holds no state about the plugins at all. Every draw asks the host for a fresh
    :class:`~innytypes.helper.window.PluginView` and hands that same object to the desktop, so
    what is on screen is one read of one view and never an accumulation of earlier ones — the
    same rule :class:`~innytypes.helper.window.ApplicationWindow` follows for the rest of the
    window, and for the same reason: a page patched in place is a second model of the state.

    An action re-draws when the page is open, because every one of the five changes something
    the page is showing: an install adds a line, a removal takes one, a switch changes a word,
    an update clears a pending version and a save changes a value or attaches an error.
    """

    def __init__(self, *, desktop: Desktop, host: PluginHost) -> None:
        self._desktop = desktop
        self._host = host
        self._visible = False

    @property
    def visible(self) -> bool:
        """Whether the page is currently on screen."""
        return self._visible

    def contents(self) -> PluginView:
        """The view the page would draw, read fresh and composed nowhere."""
        return self._host.view()

    def open(self) -> PluginView:
        """Draw the page from one read of the host's view."""
        view = self._host.view()
        self._desktop.present_plugins(view)
        self._visible = True
        return view

    def refresh(self) -> PluginView | None:
        """Draw it again, if it is open. ``None`` when it is not, and nothing is drawn."""
        return self.open() if self._visible else None

    # --- the five actions, each one call and no logic ---------------------------------------

    def add(self, request: AddRequest) -> InstalledAddon:
        """**Add** a plugin, through the installer the host was built with."""
        installed = self._host.add(request)
        self.refresh()
        return installed

    def remove(self, plugin_id: str) -> RemovedAddon:
        """**Remove** a plugin and everything it had."""
        removed = self._host.remove(plugin_id)
        self.refresh()
        return removed

    def update(self, plugin_id: str) -> AppliedUpdate:
        """**Update** a plugin to the pending version its line is showing."""
        applied = self._host.update(plugin_id)
        self.refresh()
        return applied

    def set_enabled(self, plugin_id: str, *, enabled: bool) -> SwitchResult:
        """**Enable** or **disable** a plugin with the user's own switch."""
        result = self._host.set_enabled(plugin_id, enabled=enabled)
        self.refresh()
        return result

    def configure(self, plugin_id: str, values: Mapping[str, object]) -> WriteOutcome:
        """**Configure** a plugin: save the form's values, field by field."""
        outcome = self._host.configure(plugin_id, values)
        self.refresh()
        return outcome


# --- the production host --------------------------------------------------------------------


def _nothing_quarantined() -> Mapping[str, str]:
    """The answer when no quarantine file is wired up: the helper has given up on nothing."""
    return {}


def _nothing_reported(plugin_id: str) -> str | None:
    """The answer when no host is wired up to say anything: it has said nothing about a plugin."""
    return None


def _no_reports() -> Sequence[PluginReport]:
    """The answer when no version check is wired up: nothing was asked, so nothing is pending."""
    return ()


@dataclass
class InstalledPluginHost:
    """The real :class:`PluginHost`: the composition the window is not allowed to make.

    Everything that reaches outside this process is a field, so the gate drives the whole page
    with no installer, no process, no network and no per-user directory: ``channel`` is the
    only way a plugin is stopped or started, ``installer`` the only way an environment is
    built, and the three roots are the only paths anything is read from or written to.

    ``quarantines`` and ``reports`` are callables because both are re-read on every draw — a
    quarantine is cleared by `helper release` while the page is open, and a version check
    finishes in the background — and neither is this object's to remember.
    """

    settings: HelperSettings
    channel: ControlChannel
    installer: AddonInstaller | None = None
    # ``None`` means this user's real directory in each case, which is what production passes
    # and what no test ever does.
    addons_root: Path | None = None
    config_path: Path | None = None
    secrets_root: Path | None = None
    quarantines: Callable[[], Mapping[str, str]] = _nothing_quarantined
    reports: Callable[[], Sequence[PluginReport]] = _no_reports
    # What the **host** last said about one plugin, in its own words, or ``None`` — today, the
    # kinds it refused from that plugin because its manifest never declared them (plan 0012,
    # slice 03). Asked on every draw like the two above, because the host says it over the
    # control channel whenever it happens and this object is not the one that holds it:
    # :meth:`~innytypes.helper.supervision.HostDegradations.reason_for` is.
    reported: Callable[[str], str | None] = _nothing_reported
    # `addons update`, as plan 0003 slices 12 and 13 built it, bound to this machine's roots
    # by whoever wired the helper up. Injected rather than constructed here because applying
    # an update needs a staging root, a lock resolver and a heartbeat reader, none of which
    # the plugin page has any business knowing about.
    updater: Callable[[str], AppliedUpdate] | None = None
    # A value changed under a running plugin, so the helper restarts it (D10). The **watch**
    # owns that decision and this host owns neither half of it: it keeps the watch in step
    # with what each view says is running, and asks it to look again the moment a save has
    # changed a file — so a folder typed into a form takes effect while the window is still
    # open, instead of within a tick. Nothing here stops or starts anything.
    watch: SettingsWatch | None = None

    _secrets: SecretStore = field(init=False, repr=False)
    # One form per plugin, held for as long as this host is. The only state a form keeps of
    # its own is the per-field refusals from the last save (plan 0004, *What the form
    # publishes exactly*): a refused write records nothing on disk, so the open form is the
    # one place that reason can live between the save and the redraw. Rebuilding the form on
    # every draw would lose it, and the user would correct a value they could no longer see
    # the complaint about.
    _forms: dict[str, SettingsForm] = field(init=False, repr=False, default_factory=dict)
    # What somebody else decided about each plugin, refreshed on every draw and read through
    # by the form's injected seam — so the held form still hears about a quarantine.
    _states: dict[str, AvailabilityState | None] = field(
        init=False, repr=False, default_factory=dict
    )

    def __post_init__(self) -> None:
        root = default_secrets_root() if self.secrets_root is None else self.secrets_root
        self._secrets = SecretStore(root=root)

    # --- the one read-only view ---------------------------------------------------------

    def view(self) -> PluginView:
        """Every installed plugin and everything the page shows about it, read fresh.

        One pass over what discovery found, and the four questions asked once each for all of
        them: which are running (the host), which are quarantined (the helper's file), which
        have an update waiting (the last version check), and what each one's settings say.
        Nothing here decides a word that somebody else already decides —
        :func:`~innytypes.helper.enablement.plugin_states` chooses between enabled, disabled,
        quarantined and held, and :func:`~innytypes.helper.window.pending_update_row` decides
        whether an update is waiting for the user.
        """
        found = discover_addons(self._addons_root())
        running = self._running()
        states = dict(
            plugin_states(
                installed=found.installed,
                enabled=self.settings.is_enabled,
                quarantines=self.quarantines(),
                config_path=self.config_path,
                secrets=self._secrets,
            )
        )
        pending = {report.id: report for report in self.reports()}

        entries = [
            self._entry(
                addon,
                state=states[addon.id],
                running=addon.id in running,
                report=pending.get(addon.id),
                installed=found.installed,
            )
            for addon in found.installed
        ]
        entries.extend(self._broken_entry(broken) for broken in found.broken)

        return PluginView(plugins=tuple(entries))

    def _entry(
        self,
        addon: InstalledAddon,
        *,
        state: AvailabilityState,
        running: bool,
        report: PluginReport | None,
        installed: Sequence[InstalledAddon],
    ) -> PluginEntry:
        """One installed plugin's line, with its form published from the same read."""
        self._states[addon.id] = state
        published = self._form(addon).publish()
        refusal = why_not_removable(addon.id, installed)
        self._keep_watching(addon, running=running)

        # The host's sentence first when it said one: the host is the only process that sees
        # this plugin's events, and everything else on the line is read from files here.
        said = self.reported(addon.id)
        detail = (
            published.reason
            if said is None
            else said
            if published.reason is None
            else f"{said} {published.reason}"
        )

        return PluginEntry(
            plugin_id=addon.id,
            version=addon.manifest.version,
            source=_source_of(addon),
            source_detail=_source_detail_of(addon),
            enabled=self.settings.is_enabled(addon.id),
            run_state=run_state_for(published.availability, running=running),
            detail=detail,
            pending_update=(
                None
                if report is None
                else pending_update_row(report, mode=self.settings.update_mode(addon.id))
            ),
            form=published,
            removable=refusal is None,
            removal_refusal=refusal,
        )

    def _keep_watching(self, addon: InstalledAddon, *, running: bool) -> None:
        """Keep the settings watch in step with this plugin, from the read that drew it (D10).

        Watched while it is running, forgotten when it is not: a plugin nobody has started has
        nothing to restart, and the values it will run on are the ones its start reads.

        A plugin that is **already** watched is left alone. Re-reading its baseline on every
        draw would quietly forget a change made between two draws — a file edited by hand,
        say — and the restart that change is owed would never happen.
        """
        if self.watch is None:
            return

        if not running:
            self.watch.forget(addon.id)
            return

        if addon.id not in self.watch.watching:
            self.watch.watch(self._store(addon))

    @staticmethod
    def _broken_entry(broken: BrokenAddon) -> PluginEntry:
        """One plugin whose record could not be read, listed rather than hidden.

        It has no version, no source and no form because there is no manifest to state any of
        them, and it is on the page anyway: a plugin that is on the machine and will not start
        is the one a person most needs to be told about. It is removable — removal is the
        remedy, and :func:`~innytypes.addons.removal.remove_addon` has its own refusal for a
        record it will not walk.
        """
        return PluginEntry(
            plugin_id=broken.id,
            enabled=True,
            run_state=run_state_for(None, running=False, broken=True),
            detail=broken.reason,
        )

    # --- the five actions -----------------------------------------------------------------

    def add(self, request: AddRequest) -> InstalledAddon:
        """Install one plugin, through `addons install` and nothing else."""
        if self.installer is None:
            raise PluginPageError(
                "this page was built with no installer, so it cannot add a plugin"
            )

        if request.path is not None:
            return install_addon_from_path(
                request.path,
                installer=self.installer,
                root=self.addons_root,
                editable=request.editable,
            )

        if request.requirement is None:
            # Unreachable through `AddRequest`, which refuses a request naming neither. Kept
            # because this is the one place the two halves are separated again.
            raise PluginPageError("this Add names neither a requirement nor a path")

        return install_addon(
            request.requirement,
            installer=self.installer,
            root=self.addons_root,
        )

    def remove(self, plugin_id: str) -> RemovedAddon:
        """Remove one plugin, through slice 07's own removal and its own refusals."""
        removed = remove_addon(
            plugin_id,
            channel=self.channel,
            root=self.addons_root,
            settings_path=self._settings_path(plugin_id),
            secrets_root=self.secrets_root,
        )
        # Its form went with it. A refusal remembered from before the removal would otherwise
        # be shown against the next installation of the same plugin.
        self._forms.pop(plugin_id, None)
        self._states.pop(plugin_id, None)
        return removed

    def update(self, plugin_id: str) -> AppliedUpdate:
        """Apply one plugin's pending update, through the applier plan 0003 built."""
        if self.updater is None:
            raise PluginPageError(
                f"this page has no way to update {plugin_id}: it was built without one"
            )
        return self.updater(plugin_id)

    def set_enabled(self, plugin_id: str, *, enabled: bool) -> SwitchResult:
        """Move one plugin's switch, through slice 06's switch and its control channel."""
        switch = EnableSwitch(settings=self.settings, channel=self.channel)
        return switch.enable(plugin_id) if enabled else switch.disable(plugin_id)

    def configure(self, plugin_id: str, values: Mapping[str, object]) -> WriteOutcome:
        """Save one plugin's form: the values to the settings store, the secrets to theirs.

        Two halves of one save, not two saves (D6). The settings store refuses a `secret` by
        field, pointing at the secret store; :func:`~innytypes.addons.secrets.store_secret`
        takes it and answers in the same per-field shape. So the page sends each field to one
        of them and merges one kind of result, and a form holding both a folder and a token
        saves in one press.
        """
        addon = self._installed(plugin_id)
        declaration = addon.manifest.settings
        secret_ids = {declared.id for declared in declaration if is_secret_field(declared)}

        recorded: list[str] = []
        refused: list[FieldProblem] = []

        plain = {key: value for key, value in values.items() if key not in secret_ids}
        if plain:
            # The same form the view publishes, so a refusal is beside its field on the redraw.
            outcome = self._form(addon).save(plain, by=USER)
            recorded.extend(outcome.recorded)
            refused.extend(outcome.refused)

        for field_id in values:
            if field_id not in secret_ids:
                continue
            outcome = store_secret(
                declaration,
                addon_id=plugin_id,
                field_id=field_id,
                value=values[field_id],
                store=self._secrets,
            )
            recorded.extend(outcome.recorded)
            refused.extend(outcome.refused)

        if self.watch is not None:
            # D10, decided by the watch and not here: a running plugin whose values have just
            # changed is restarted, on the one restart path, and the watch remembering the new
            # values is what stops the helper's own tick restarting it a second time. A save
            # that recorded nothing changes nothing, and this looks and finds nothing to do.
            self.watch.tick()

        return WriteOutcome(recorded=tuple(recorded), refused=tuple(refused))

    # --- where everything comes from --------------------------------------------------------

    def _form(self, addon: InstalledAddon) -> SettingsForm:
        """This plugin's form, kept between calls, and rebuilt when its declaration moves.

        Kept, because a form remembers the refusals from the last save and those have nowhere
        else to live: a refused write records nothing on disk, so rebuilding here would lose
        the sentence the user needs in order to correct the value.

        Rebuilt when the recorded manifest's declaration changes, which is what a plugin
        update does to it (D5) — the values on disk are unchanged and it is the declaration
        they are judged against that moved, so the old form would judge by a rule that is no
        longer in force.
        """
        held = self._forms.get(addon.id)
        if held is None or held.fields != addon.manifest.settings:
            held = SettingsForm(self._store(addon), state=lambda: self._states.get(addon.id))
            self._forms[addon.id] = held
        return held

    def _store(self, addon: InstalledAddon) -> SettingsStore:
        """One plugin's settings store, with the **real** secret predicate wired up (D6).

        The one line in this module that must never be simplified away. Left out, the store
        falls back to the answer it gives when nothing is wired — no secret is set — and a
        plugin whose only unanswered field is a credential the user already entered stays
        held disabled for ever, with a form insisting on a token that is sitting on disk.
        """
        return SettingsStore(
            addon.id,
            addon.manifest.settings,
            path=self._settings_path(addon.id),
            secret_is_set=secret_is_set_for(addon.id, self._secrets),
        )

    def _settings_path(self, plugin_id: str) -> Path | None:
        """One plugin's settings file, beside `config.toml` (D4). ``None`` for the real one."""
        if self.config_path is None:
            return None
        return self.config_path.parent / SETTINGS_DIRECTORY / f"{plugin_id}.toml"

    def _addons_root(self) -> Path:
        return default_addons_root() if self.addons_root is None else self.addons_root

    def _installed(self, plugin_id: str) -> InstalledAddon:
        """The installation the host recorded for this id, or a refusal naming it."""
        for addon in discover_addons(self._addons_root()).installed:
            if addon.id == plugin_id:
                return addon
        raise PluginPageError(f"{plugin_id} is not installed, so there is no form to save")

    def _running(self) -> frozenset[str]:
        """What the host says is running right now, asked rather than remembered.

        A channel with **no host on the other end** answers "nothing is running" rather than
        refusing the whole view. The helper listens and the host connects
        (:mod:`innytypes.helper.control`), so there is a moment at every launch — and after
        every host restart — when the window is drawn and no host has connected yet. A page
        that raised then would be an application that will not open its own window because one
        of its processes has not finished starting; what the person sees instead is every
        plugin they have, listed as stopped, on a page with a working Quit behind it.
        """
        try:
            answer = self.channel.send(Command(name=CommandName.LIST))
        except ControlError as error:
            log.warning(
                "the host did not say what is running, so the page shows nothing as running: %s",
                error,
            )
            return frozenset()

        return frozenset(record.id for record in answer.children)


def _source_of(addon: InstalledAddon) -> PluginSource:
    """Which of the four words describes where this installation came from.

    The recorded source wins where there is one, because it describes the installation that
    is actually on disk; ``update.source`` describes where *new versions* would come from,
    and is only consulted for a plugin that came from an index — which is what a git-sourced
    plugin's installation looks like on disk.
    """
    if addon.source is not None:
        return PluginSource.EDITABLE if addon.source.editable else PluginSource.PATH

    update = addon.manifest.update
    if update is not None and update.source.startswith("git+"):
        return PluginSource.GIT

    return PluginSource.INDEX


def _source_detail_of(addon: InstalledAddon) -> str | None:
    """The fact behind the word: the path it came from, or the repository. ``None`` for none."""
    if addon.source is not None:
        return str(addon.source.path)

    update = addon.manifest.update
    if update is not None and update.source.startswith("git+"):
        return update.source[len("git+") :]

    return None
