"""A value changed under a running plugin, so the helper restarts it (plan 0004, D10).

A plugin reads its settings **once**, when it starts (:mod:`innytypes.addons.run`), which is
what lets an addon author treat `context.settings` as a plain mapping and never wonder whether
it moved. The price of that promise is this module: something has to notice that the window,
the command line or a hand-edited file changed a value, and bring the plugin back on the new
one.

**It is the existing restart, not a second one.** Nothing here spawns, stops or signals
anything. It asks :class:`~innytypes.helper.restart.RestartPolicy` for a restart, which sends
one ``RESTART`` command down the control channel to the host, which stops the child and starts
it again. That stop is the host's own, so the exit it reports is **expected**: the policy
counts no attempt for it (:meth:`RestartPolicy.child_exited` returns ``None`` for an expected
exit), no intervention is recorded, and the breaker never hears about it. A restart that is a
consequence of configuration must not spend a plugin's crash budget — five settings changes in
ten minutes would otherwise quarantine a perfectly healthy plugin.

**What counts as a change is the mapping the plugin was handed**, not the file's bytes and not
its modification time. Saving a form that records the same value again, or a write that only
moves the `[written.<id>]` bookkeeping, leaves the plugin's settings identical and restarts
nothing. A restart is a visible interruption, and a plugin that is restarted must have a
reason a person can point at.

**A plugin is never restarted for its own write.** `context.write_settings` exists for a
plugin that has just completed an authorisation (D11); the value it recorded is in its hands
already, and restarting it would throw away whatever it was in the middle of — and, for a
plugin that writes on every start, would be a loop. So a change whose every field is
attributed to the plugin itself (F2's ``[written.<id>].by``) is taken up silently. A change
the *user* made, in the same tick and to the same plugin, restarts it as usual.

**A file that cannot be read is not a change.** A settings file somebody left mid-edit refuses
to parse; that is not a reason to restart a running plugin, and it is not a reason for the
helper to stop watching one either. It is logged, the last good values are kept, and the next
tick tries again.

Whether the plugin comes back up is not decided here. A value that changed into one its
declaration refuses holds the plugin disabled with the reason (D5), and the availability rule
is what acts on that — this module's job ends at "it must not keep running on the old value".
"""

from __future__ import annotations

from collections.abc import Mapping

from innytypes.addons.settings import Attribution, RecordedSettings, SettingsError, SettingsStore
from innytypes.helper.restart import RestartPolicy
from innytypes.logs import get_logger

__all__ = ["SettingsWatch"]

log = get_logger(__name__)


class SettingsWatch:
    """The plugins whose recorded values the helper is watching, and what they held last.

    One entry per **running** plugin: :meth:`watch` when it starts, :meth:`forget` when it
    stops. A plugin that is not running has nothing to restart, so it is not watched — and a
    value changed while it was stopped is read by the start that follows, not by this.
    """

    def __init__(self, policy: RestartPolicy) -> None:
        self._policy = policy
        # Per addon id, the store to re-read it through and the values it is running on.
        self._stores: dict[str, SettingsStore] = {}
        self._values: dict[str, Mapping[str, object]] = {}

    def watch(self, store: SettingsStore) -> None:
        """Watch one plugin that has just started, from the values it started with.

        The store carries the declaration the plugin's **recorded manifest** holds, which is
        the same one the runner judged the file against — so the values compared here are the
        values the plugin was handed, rather than a second reading of the same file under a
        different declaration.
        """
        addon_id = store.addon_id
        self._stores[addon_id] = store
        settings = self._read(addon_id)
        # An unreadable file at start is no values at all, so the first readable tick after it
        # is a change and the plugin is brought back on what the file really says.
        self._values[addon_id] = {} if settings is None else settings.values

    def forget(self, addon_id: str) -> None:
        """Stop watching one plugin, because it is no longer running."""
        self._stores.pop(addon_id, None)
        self._values.pop(addon_id, None)

    @property
    def watching(self) -> tuple[str, ...]:
        """Every plugin being watched, sorted, so a caller can assert on the whole set."""
        return tuple(sorted(self._stores))

    def values_for(self, addon_id: str) -> Mapping[str, object]:
        """The values one watched plugin is currently running on."""
        return self._values.get(addon_id, {})

    def tick(self) -> tuple[str, ...]:
        """Restart every watched plugin whose values have changed. Returns the ids restarted.

        Called from the helper's own tick, beside the restart policy's. Each plugin is judged
        on its own file: a plugin whose settings did not change is not touched, and one whose
        file cannot be read does not stop the others being judged.
        """
        restarted: list[str] = []

        for addon_id in sorted(self._stores):
            settings = self._read(addon_id)
            if settings is None:
                continue

            changed = _changed_fields(self._values[addon_id], settings.values)
            if not changed:
                continue

            self._values[addon_id] = settings.values

            if _is_its_own(addon_id, changed, settings.attribution):
                log.info(
                    "%s recorded %s itself; it is not restarted for its own write",
                    addon_id,
                    ", ".join(changed),
                )
                continue

            log.info("%s was reconfigured (%s); restarting it", addon_id, ", ".join(changed))
            self._policy.restart(addon_id)
            restarted.append(addon_id)

        return tuple(restarted)

    # --- reading one plugin's file ----------------------------------------------------------

    def _read(self, addon_id: str) -> RecordedSettings | None:
        """One watched plugin's file as of now, or None when it cannot be read.

        One read per plugin per tick, because the values and who wrote them are two halves of
        the same judgement: read twice, a write landing in between would let the values of one
        reading be explained by the attributions of another.
        """
        try:
            return self._stores[addon_id].read()
        except SettingsError as error:
            # A file being edited, or one somebody mangled. The plugin keeps running on what
            # it has, and the next tick reads it again.
            log.warning("the settings of %s could not be read: %s", addon_id, error)
            return None


def _is_its_own(
    addon_id: str, changed: tuple[str, ...], attribution: Mapping[str, Attribution]
) -> bool:
    """Whether every changed field was last written by the plugin itself (F2).

    A field with no attribution at all — a file a person edited by hand, which records no
    `[written.<id>]` — is **not** the plugin's own write, which is the answer that restarts
    the plugin. Silence about who wrote a value is the case this rule exists to keep working.
    """
    return all(
        field_id in attribution and attribution[field_id].by == addon_id for field_id in changed
    )


def _changed_fields(before: Mapping[str, object], after: Mapping[str, object]) -> tuple[str, ...]:
    """Every field whose value differs between two readings, appearing or disappearing included.

    A field that was refused on the second reading is *gone* from the mapping rather than
    changed (the store hands over only values that pass), and that is a change: the plugin is
    running on a value the declaration no longer accepts.
    """
    return tuple(
        sorted(
            field_id
            for field_id in set(before) | set(after)
            if _differs(before.get(field_id, _ABSENT), after.get(field_id, _ABSENT))
        )
    )


class _Absent:
    """A field that is not in a reading at all — never a value, so never equal to one."""

    def __repr__(self) -> str:  # pragma: no cover - diagnostics only
        return "<absent>"


_ABSENT = _Absent()


def _differs(before: object, after: object) -> bool:
    """Whether two readings of one field hold different values.

    ``True == 1`` in Python, so a `switch` turned on and a `number` set to 1 would otherwise
    compare equal — the same distinction `shown_when` already has to make, for the same
    reason: a comparison that means one thing in the form and another here is a restart that
    does or does not happen for reasons nobody can see.
    """
    if isinstance(before, bool) != isinstance(after, bool):
        return True
    return before != after
