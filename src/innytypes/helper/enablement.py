"""The enable switch: the user's own on and off, and the three ways a plugin can be off.

Plan 0004, *The enable switch*. Every installed plugin is enabled or disabled. The state is
recorded in the helper's `config.toml`, beside `pinned` and this plugin's update mode
(:class:`~innytypes.helper.config.PluginOverride`), and **not** in the plugin's settings file
and **not** beside the quarantines. Three reasons, in the order they would cost something to
get wrong:

1. **It has to survive a reboot, and a quarantine must not.** Quarantine lives in the runtime
   directory precisely because a machine that came back up should not still be refusing to
   start something for a reason nobody can see any more
   (:func:`~innytypes.helper.breaker.default_quarantine_path`). A switch the user flipped is
   the opposite: it is an instruction, and an instruction the reboot forgot would turn a
   plugin back on behind their back.
2. **It is a decision about the plugin, not an answer the plugin asked for.** The settings
   file holds values against the fields a plugin *declares*
   (:mod:`innytypes.addons.settings`); no plugin declares whether it may run. Putting the
   switch there would also make it removable by a plugin writing its own settings back (D11).
3. **`config.toml` already holds exactly this kind of per-plugin decision**, is already
   re-read live, already atomic to write, and is already injectable everywhere — so the
   switch costs no new file, no new path and no new write discipline.

**Absence means enabled** (D7). Installing a plugin is the act of wanting it, so a freshly
installed plugin is enabled with nothing written down anywhere, and the file records only the
departures from that.

**The four words are one vocabulary.**
:class:`~innytypes.addons.settings.PluginAvailability` is it — ``enabled``, ``held-disabled``,
``disabled``, ``quarantined`` — and :func:`plugin_state` is the one place that picks between
them, because three states that need three different remedies must never be shown as one:

* **disabled** — the user switched it off. Only the user switches it back on.
* **quarantined** — the helper gave up restarting it (plan 0003). It takes `helper release`.
* **held disabled** — its required settings are missing or no longer fit (F1, D5). It clears
  itself when the values are corrected; there is no switch to flip.

When more than one is true at once the word names **what has to be done first for the plugin
to run again**. The user's own switch comes first — nobody releases a quarantine on a plugin
they turned off — then the quarantine, which nothing clears by itself, and then the hold,
which does.

**Recording comes before acting.** :meth:`EnableSwitch.disable` writes the switch and only
then asks the host to stop the plugin, so a stop that fails leaves a plugin the helper will
not restart, rather than a plugin that is off and recorded on. The stop itself goes through
the control channel as an ordinary ``stop`` command, which the host reports as an **expected**
exit — so the restart policy does not undo it and the breaker counts nothing.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

from innytypes.addons.discovery import InstalledAddon
from innytypes.addons.secrets import SecretStore, default_secrets_root, secret_is_set_for
from innytypes.addons.settings import (
    SETTINGS_DIRECTORY,
    PluginAvailability,
    SettingsError,
    SettingsStore,
)
from innytypes.addons.settings_form import PluginState
from innytypes.children import Command, CommandName
from innytypes.helper.config import HelperSettings
from innytypes.helper.restart import ControlChannel

__all__ = [
    "DISABLED_REASON",
    "EnableSwitch",
    "StartGate",
    "SwitchResult",
    "held_reason",
    "plugin_state",
    "plugin_states",
]

# What the window and the command line say beside a plugin the user switched off. A sentence
# rather than nothing, because "disabled" alone reads like a fault on a page full of faults.
DISABLED_REASON = "switched off; enable it to start it again"


@dataclass(frozen=True)
class SwitchResult:
    """What flipping one switch did: where the plugin now stands, and what the host did.

    ``started`` and ``stopped`` are ids rather than flags because enabling a plugin can start
    more than the plugin itself — anything else that was waiting to run starts in the same
    pass, in the resolver's order — and a caller with a person in front of it should be able
    to say what actually happened.
    """

    plugin_id: str
    enabled: bool
    started: tuple[str, ...] = ()
    stopped: tuple[str, ...] = ()


def plugin_state(
    *,
    enabled: bool,
    quarantine: str | None = None,
    held: str | None = None,
) -> PluginState:
    """The one word for why a plugin is, or is not, going to run — and the sentence for it.

    The single place the four words are chosen between, so the window, `helper status` and
    the settings form cannot disagree about which one a plugin is in. ``quarantine`` is the
    reason the helper recorded when it gave up; ``held`` is
    :attr:`~innytypes.addons.settings.Hold.reason`, or any other reason the settings could
    not be judged at all. Both are ``None`` when that is not this plugin's situation.

    The answer is a :class:`~innytypes.addons.settings_form.PluginState` because that is what
    the published form already takes for everything it does not decide itself.
    """
    if not enabled:
        return PluginState(availability=PluginAvailability.DISABLED, reason=DISABLED_REASON)

    if quarantine is not None:
        return PluginState(availability=PluginAvailability.QUARANTINED, reason=quarantine)

    if held is not None:
        return PluginState(availability=PluginAvailability.HELD, reason=held)

    return PluginState(availability=PluginAvailability.ENABLED)


def plugin_states(
    *,
    installed: Sequence[InstalledAddon],
    enabled: Callable[[str], bool],
    quarantines: Mapping[str, str] | None = None,
    config_path: Path | None = None,
    secrets: SecretStore | None = None,
) -> tuple[tuple[str, PluginState], ...]:
    """Every installed plugin and the one word for it, in the order they were discovered.

    The view `helper status` prints and the window draws, built once here so that neither has
    a rule of its own about which of the four words wins. It reads the three things that can
    hold a plugin back and asks :func:`plugin_state` to choose between them:

    * the **switch**, through the ``enabled`` predicate — the helper's `config.toml`;
    * the **quarantines**, as the helper recorded them (they are a file, so the caller reads
      them and passes them in: the same file `helper release` clears);
    * the **settings**, judged against each plugin's own declaration.

    ``config_path`` is the helper's config file, and a plugin's settings file lives *beside*
    it (D4) — so one path answers both questions and no caller has to know the layout. It is
    ``None`` for this user's real files. Secrets are a separate store because they are kept
    somewhere else entirely (D6), and it is injected for the same reason everything else here
    is: nothing in a test reaches the real one.

    A settings file that cannot even be read leaves the plugin **held** with the reason the
    store gave, which is the truthful answer: the values cannot be judged, so the plugin is
    not started, and the sentence names the file.
    """
    recorded = {} if quarantines is None else quarantines
    secret_store = SecretStore(root=default_secrets_root()) if secrets is None else secrets

    return tuple(
        (
            addon.id,
            plugin_state(
                enabled=enabled(addon.id),
                quarantine=recorded.get(addon.id),
                held=held_reason(addon, config_path=config_path, secrets=secret_store),
            ),
        )
        for addon in installed
    )


def held_reason(
    addon: InstalledAddon,
    *,
    config_path: Path | None = None,
    secrets: SecretStore | None = None,
) -> str | None:
    """Why this plugin's own settings hold it disabled, or ``None`` when they do not (F1, D5).

    The settings store does the judging; this reads the file it judges every time it is asked,
    because a hold clears itself the moment the values are corrected and there is no switch to
    flip and nothing to invalidate. A file that cannot be read at all is a hold too, with the
    store's own sentence: values that cannot be judged are values that must not be run on.
    """
    directory = None if config_path is None else config_path.parent / SETTINGS_DIRECTORY
    store = SettingsStore(
        addon.id,
        addon.manifest.settings,
        path=None if directory is None else directory / f"{addon.id}.toml",
        secret_is_set=secret_is_set_for(
            addon.id, SecretStore(root=default_secrets_root()) if secrets is None else secrets
        ),
    )

    try:
        hold = store.read().hold
    except SettingsError as error:
        return str(error)

    # `why`, not `reason`: every caller of this pairs it with the word "held disabled" it has
    # already drawn or printed, so the whole sentence would read "held disabled: held disabled:
    # destination is required". That is what the window showed until it was opened and read.
    return None if hold is None else hold.why


@dataclass(frozen=True)
class StartGate:
    """Why a child of the host must not start right now — the host's own :data:`HoldsBack`.

    The production answer to the one question :class:`innytypes.children.ChildSupervisor`
    asks before it spawns anything, and :class:`~innytypes.helper.restart.RestartPolicy`
    asks before it brings anything back. It answers a **word**, not a sentence, because that
    word is what the resolver puts in "requires monty, which is disabled" and what the
    refusal to start says; the sentence explaining which field is missing belongs in
    `helper status` and the window, and :func:`plugin_states` is where they get it.

    Two things it deliberately does not know about:

    * **Anything that is not an installed plugin** — the MCP child, above all — is never
      held back by this gate. It has no switch and no settings form; the host's own reasons
      for not having it are the host's (plan 0002 slice 05).
    * **Quarantine.** That is the helper having given up *restarting* something, and the
      helper expresses it by not asking for a restart (plan 0003). A host that also refused
      would be a second opinion about a decision that has one owner.

    Every answer is read afresh: the switch from `config.toml`, the hold from the plugin's
    settings file. ``installed`` is what the host discovered, passed in rather than
    rediscovered, so this asks no question about *what is installed* — only about what is
    allowed to run.
    """

    settings: HelperSettings
    installed: Sequence[InstalledAddon] = ()
    config_path: Path | None = None
    secrets: SecretStore | None = None

    def __call__(self, child_id: str) -> str | None:
        addon = next((candidate for candidate in self.installed if candidate.id == child_id), None)
        if addon is None:
            return None

        state = plugin_state(
            enabled=self.settings.is_enabled(child_id),
            held=held_reason(addon, config_path=self.config_path, secrets=self.secrets),
        )
        return None if state.availability is PluginAvailability.ENABLED else str(state.availability)


class EnableSwitch:
    """One plugin's on and off: recorded here, carried out through the control channel.

    Built with the live view of `config.toml` and with the channel the helper already talks
    to the host through (:class:`~innytypes.helper.restart.ControlChannel`) — the same channel
    the restart policy uses, so there is one way to ask the host to do something and one place
    that decides what the host is asked.

    This object does **not** decide whether a plugin is held disabled or quarantined: those
    are the settings store's and the breaker's answers, and :func:`plugin_state` puts all
    three together for whoever has to show a word to a person.
    """

    def __init__(self, *, settings: HelperSettings, channel: ControlChannel) -> None:
        self._settings = settings
        self._channel = channel

    def is_enabled(self, plugin_id: str) -> bool:
        """Whether this plugin is switched on, as of this instant."""
        return self._settings.is_enabled(plugin_id)

    def disable(self, plugin_id: str) -> SwitchResult:
        """Switch a plugin off, and stop it if it is running.

        The record is written first. A stop that fails then leaves a plugin that is running
        and recorded off — which the helper will not restart, and which the next start-up will
        not start — rather than a plugin that is stopped and recorded on, which the helper
        would bring straight back.
        """
        self._settings.set_enabled(plugin_id, False)

        if plugin_id not in self._running():
            return SwitchResult(plugin_id=plugin_id, enabled=False)

        # An ordinary stop, which the host reports as an expected exit: the switch is not a
        # crash, and nothing about it should reach the restart policy or the breaker as one.
        self._channel.send(Command(name=CommandName.STOP, child_id=plugin_id))
        return SwitchResult(plugin_id=plugin_id, enabled=False, stopped=(plugin_id,))

    def enable(self, plugin_id: str) -> SwitchResult:
        """Switch a plugin on, and start it in the resolver's order among what is not running.

        The host is asked to start everything that should be running and is not, rather than
        this plugin by name, because *where* a plugin starts is the resolver's answer and the
        host is the only thing that holds it: a plugin that publishes what another subscribes
        to has to come up first, and a switch that named one child could not know that.
        """
        self._settings.set_enabled(plugin_id, True)

        if plugin_id in self._running():
            return SwitchResult(plugin_id=plugin_id, enabled=True)

        result = self._channel.send(Command(name=CommandName.START_ALL))
        return SwitchResult(
            plugin_id=plugin_id,
            enabled=True,
            started=tuple(record.id for record in result.children),
        )

    def _running(self) -> tuple[str, ...]:
        """What the host says is running right now, asked rather than remembered."""
        answer = self._channel.send(Command(name=CommandName.LIST))
        return tuple(record.id for record in answer.children)
