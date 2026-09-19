"""The module an addon process runs: `<its env>/bin/python -m innytypes.addons.run <addon-id>`.

This is the far side of the process boundary the whole design rests on. :mod:`innytypes.children`
spawns exactly this argv (:data:`~innytypes.children.ADDON_RUNNER_MODULE`), inside the addon's
**own** environment, where ``innytypes`` is installed at exactly the host's version. So the code
below is host code running as the addon's process: it imports the addon, and the host never
does.

**What an addon must provide.** Two entry points, both named after the addon's own id:

* ``innytypes.addons`` — a callable taking no arguments and returning the **manifest document**.
  It is read at install time, in the addon's interpreter, and read again here, which is what
  makes an addon's declaration one document rather than two that can disagree.
* ``innytypes.addons.run`` — a callable taking one :class:`AddonContext` and returning an
  :class:`Addon`: an object with ``handle(event)`` and ``stop()``. Being called **is** the
  addon's start; there is no separate ``start`` to forget to call, and an addon that cannot
  start raises out of it.

The runner does the rest, and deliberately does it rather than leaving it to the addon:

**The settings arrive with the addon, already judged.** :attr:`AddonContext.settings` is the
values the host recorded for *this* addon, validated against its own declaration with declared
defaults filled in (plan 0004, "What a plugin gets"). An addon therefore never opens a settings
file, never validates one and never handles a missing key. A `secret` is not in that mapping —
its value lives in a file of its own (D6) — and is reached through :attr:`AddonContext.secret`,
bound to this addon like everything else here. :attr:`AddonContext.write_settings` is the way
back: a plugin that completes an authorisation at run time records what it was given, through
the host, into the same files the window reads (D11, F2).

**The emitter is bound, and the subscriptions come from the manifest.** The addon is handed an
:class:`~innytypes.events.emitter.Emitter` bound to its own id, carrying the kinds its manifest
registered — so it can emit those and nothing else — and its ``handle`` is subscribed to exactly
what its manifest ``subscribes`` declared. An addon that could subscribe itself would have a
second declaration of what it listens to, and the resolver reads the manifest's.

**The addon's bus is not the host's bus.** What the addon emits goes to a local spool the
transport drains onto the wire; what arrives from the host is published on a local bus its
handler reads. That asymmetry is what stops an addon subscribed to its own kinds from bouncing
events between the two processes for ever.

**The channel arrives as standard input.** The host opens the socketpair when it spawns the
child (:mod:`innytypes.events.channel`) and gives the child end to the process as fd 0, which
every process inherits by construction. Standard output and standard error stay ordinary pipes,
so an addon that prints cannot corrupt the event stream.

**A failure to start is reported, not hung on.** An entry point that is missing, uncallable or
raising is written to the host as ``innytypes.addon-failed.v1`` — the host's own kind, sent by
the runner, which holds the socket the addon never sees — and the process exits non-zero. The
alternative, a child that sits there having failed, is the one outcome a supervisor cannot tell
from a healthy addon with nothing to say.

**A stop ends the serve loop, and there is one of those.** The host closing the channel ends it,
and so does ``SIGTERM`` — the host's polite stop — which is turned into an exception on the
serve loop rather than left to end the process where it stands. Either way the same shutdown
runs: the addon's ``stop`` is called with nothing else of its own still running, whatever that
emitted is flushed onto the wire, and the process exits zero. The run-state record for the child
is removed by the host that stopped it (:mod:`innytypes.children`), never from here — a process
does not get to write its own death certificate.
"""

from __future__ import annotations

import signal
import socket
import sys
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from importlib.metadata import entry_points
from pathlib import Path
from types import FrameType
from typing import IO, Protocol, cast

from innytypes.addons.install import ENTRY_POINT_GROUP
from innytypes.addons.manifest import (
    AddonManifest,
    SettingsField,
    parse_manifest,
    parse_subscription,
)
from innytypes.addons.secrets import (
    SecretStore,
    default_secrets_root,
    secret_is_set_for,
    store_secret,
)
from innytypes.addons.settings import (
    FieldProblem,
    SettingsStore,
    WriteOutcome,
    default_settings_path,
    is_secret_field,
    writer_refusal,
)
from innytypes.anytype_mcp.logs import get_logger
from innytypes.events.bus import ADDON_FAILED, EventBus, Subscription
from innytypes.events.delivery import ThreadedDelivery
from innytypes.events.emitter import Emitter, Event, KindRegistry
from innytypes.events.transport import (
    Connection,
    EventTransport,
    FramingError,
    PeerGoneError,
    StreamConnection,
    frame_event,
)

__all__ = [
    "FAILED_EXIT_CODE",
    "RUNTIME_ENTRY_POINT_GROUP",
    "SETTINGS_HOST_API",
    "Addon",
    "AddonContext",
    "AddonFactory",
    "AddonRunError",
    "EntryPointLoader",
    "PluginSettings",
    "SettingsOpener",
    "load_entry_point",
    "main",
    "no_settings",
    "open_settings",
    "run",
    "user_settings",
]

log = get_logger(__name__)

# The entry point group an addon exports its **runtime** from, as `innytypes.addons` is the
# group it exports its manifest from. The group is spelled like this module's own import path
# on purpose: the thing an addon exports here is what this module runs.
RUNTIME_ENTRY_POINT_GROUP = "innytypes.addons.run"

# What the process exits with when the addon could not be started, or could not be stopped
# cleanly. Any non-zero code says the same thing to the host; one constant says it once.
FAILED_EXIT_CODE = 1

# The host, as the addon's own transport names its peer. The addon talks to exactly one.
HOST_PEER = "innytypes"

# The host API version from which an addon's context carries its settings (plan 0004, D3). A
# manifest declaring anything older is opened against **no declaration at all**, which is how
# "a plugin declaring 1 still starts and sees an empty settings mapping" is implemented: not as
# a branch in the runner, but as an addon with no declared fields.
SETTINGS_HOST_API = 2


class _Terminated(Exception):
    """Raised on this process's main thread when the host sends ``SIGTERM``.

    Private because it is not an outcome: it is how a signal reaches the serve loop, and the
    outcome it produces is the ordinary clean shutdown.
    """


class AddonRunError(RuntimeError):
    """Raised when an addon cannot be loaded from the environment it was installed into.

    Distinct from :class:`~innytypes.addons.manifest.ManifestError`, which is a manifest that
    is wrong, and from whatever the addon's own entry point raises, which is an addon that
    failed to start. All three are reported to the host the same way; they are separate here
    because the person reading the reason has three different things to go and fix.
    """


@dataclass(frozen=True)
class AddonContext:
    """Everything the host gives an addon when it starts it, and nothing else.

    Six fields, and **every one of them is already bound to this addon**. That is the shape of
    the whole contract: there is no argument anywhere below that names an addon, so there is
    nothing to pass another addon's id to. An addon that needs the Anytype tool surface calls
    :func:`innytypes.host.anytype_tools` for itself — it is committed data present in every
    addon environment — and an addon that needs to know what else is installed is asking the
    host a question no contract answers yet.
    """

    # The addon's own id: the directory it was installed into, the name of both its entry
    # points, the namespace of its kinds, and the id the host reports its process under.
    id: str
    manifest: AddonManifest
    # Bound to `id` for its whole life. There is no `source` argument anywhere on it, so an
    # addon cannot publish as anybody else.
    emitter: Emitter

    # The recorded values, validated against this addon's own declaration with declared
    # defaults filled in: every declared field is here, so there is no missing key to handle
    # and nothing to parse. A `secret` is **not** here, whatever the settings file says (D6),
    # and neither is a field whose recorded value no longer fits — that value is a hold the
    # host acts on (D5), not something to hand over half-judged.
    #
    # Read once, when the addon started. A value changed afterwards restarts this addon
    # through the control channel (D10), so what is in here is what is on disk, and an addon
    # never has to ask whether its settings moved under it.
    settings: Mapping[str, object]

    # One of this addon's own `secret` fields, or None when none is stored. Separate from
    # `settings` because a secret's value never enters a mapping anything else can be handed:
    # this is the one way back to one, it takes a field id and nothing else, and it answers
    # only for the addon whose context this is. A field id that is not a declared secret of
    # this addon raises rather than answering "not set", which would be a lie.
    secret: Callable[[str], str | None]

    # This addon writing its own values back (D11): an OAuth token it just exchanged, a device
    # it just paired. Validated against the same declaration as a person's entry and refused
    # the same way, field by field, and every field it records is attributed to this addon
    # rather than to the user (F2). It records only fields declared `plugin` or `both`; a
    # `user` field is refused by name and left exactly as it was.
    write_settings: Callable[[Mapping[str, object]], WriteOutcome]


class Addon(Protocol):
    """What an addon's ``innytypes.addons.run`` entry point returns.

    Two methods, both of which the runner calls and neither of which an addon calls itself.
    An addon with an empty ``subscribes`` still has ``handle``; it is simply never called.
    """

    def handle(self, event: Event) -> None:
        """One event this addon's manifest subscribed to.

        Called on this addon's own delivery thread. It may take as long as it honestly needs:
        a handler that falls too far behind is dropped at its queue's bound rather than waited
        on, which is the same promise an in-process subscriber gets.
        """
        ...

    def stop(self) -> None:
        """Shut down, because the host is stopping this addon.

        Called once, after the addon's delivery thread has finished, so nothing else of the
        addon's is running. Anything emitted from here is flushed onto the wire before the
        channel is released.
        """
        ...


# The runtime entry point: the context in, a started addon out. Being called is the start.
AddonFactory = Callable[[AddonContext], Addon]

# How an object is loaded out of this environment's entry points: (group, name) in, the loaded
# object out. Injected so the gate can drive the runner against an addon that was never
# installed — the one seam that keeps this module testable without a package on disk.
EntryPointLoader = Callable[[str, str], object]


def load_entry_point(group: str, name: str) -> object:
    """The one object this environment exports as ``name`` in ``group``.

    Refuses an absent and a duplicated entry point by name, in the same words
    :mod:`innytypes.addons.install` uses when it reads the manifest at install time: an addon
    has one manifest and one runtime, and two of either is an environment nobody can reason
    about.
    """
    found = [entry for entry in entry_points(group=group) if entry.name == name]
    if not found:
        raise AddonRunError(
            f"this environment exports no {group} entry point named {name!r}: an addon "
            "exports its manifest and its runtime from entry points named after its own id"
        )
    if len(found) > 1:
        raise AddonRunError(
            f"this environment exports {len(found)} {group} entry points named {name!r}: an "
            "addon has one of each"
        )
    return found[0].load()


# --- the addon's own settings -----------------------------------------------------------------


@dataclass(frozen=True)
class PluginSettings:
    """One addon's settings, opened: the three things its context is built from.

    Exists so that *where* settings come from is one injected seam
    (:data:`SettingsOpener`) rather than a pair of paths threaded through the runner. Each
    member is already bound to one addon, which is the property the context inherits.
    """

    values: Mapping[str, object]
    secret: Callable[[str], str | None]
    write: Callable[[Mapping[str, object]], WriteOutcome]


# Where an addon's settings come from, given its validated manifest. Injected for the same
# reason the entry-point loader is: the runner is exercised against files under a temporary
# directory, and **nothing but** :func:`main` ever reaches this user's real config directory.
SettingsOpener = Callable[[AddonManifest], PluginSettings]


def no_settings(manifest: AddonManifest) -> PluginSettings:
    """An addon opened against no settings store at all — the default for :func:`run`.

    Deliberately the default, rather than this user's real files: a caller that forgets to say
    where settings live gets an addon that has none, not one reading whatever happens to be in
    ``~/.config``. An addon opened this way sees an empty mapping, no secret, and every write
    refused by name.
    """
    return _settings_over(
        SettingsStore(manifest.id, (), path=_NOWHERE),
        secrets=SecretStore(root=_NOWHERE),
    )


def open_settings(
    manifest: AddonManifest,
    *,
    settings_path: Path,
    secrets_root: Path,
) -> PluginSettings:
    """One addon's settings, from the two files the host records them in.

    **`host_api` 1 is opened against no declaration** (plan 0004, D3). Such a manifest was
    written before settings existed, so it is given the empty mapping it expects — and it is
    given it by having no declared fields at all, which makes every other rule here follow on
    its own: nothing to read, no secret to reach, and a write refused because the addon
    declares no such setting.
    """
    fields = manifest.settings if manifest.host_api >= SETTINGS_HOST_API else ()
    secrets = SecretStore(root=secrets_root)
    store = SettingsStore(
        manifest.id,
        fields,
        path=settings_path,
        secret_is_set=secret_is_set_for(manifest.id, secrets),
    )
    return _settings_over(store, secrets=secrets)


def user_settings(manifest: AddonManifest) -> PluginSettings:
    """This user's recorded settings for one addon. The one opener that reads real files."""
    return open_settings(
        manifest,
        settings_path=default_settings_path(manifest.id),
        secrets_root=default_secrets_root(),
    )


# Where :func:`no_settings` points its stores. Nothing reads it and nothing writes it: an
# empty declaration has no field to record and no secret to reach, so neither store is ever
# asked for a path. Named rather than spelled inline so that a change which *did* touch the
# filesystem fails loudly here instead of quietly creating a directory.
_NOWHERE = Path("/nonexistent/innytypes-has-no-settings-here")


def _settings_over(store: SettingsStore, *, secrets: SecretStore) -> PluginSettings:
    """Turn one addon's two stores into the three answers its context carries.

    The values are read **once**, here, at start. A value that changes afterwards restarts
    this addon (D10), so re-reading them per call would be a second way to learn the same
    thing — and the two would disagree for the length of a restart.
    """
    addon_id = store.addon_id
    declared: Mapping[str, SettingsField] = {field.id: field for field in store.fields}
    recorded = store.read()

    def secret(field_id: str) -> str | None:
        """This addon's own secret, by field id — never another addon's, and never a value
        that is not a secret."""
        field = declared.get(field_id)
        if field is None or not is_secret_field(field):
            raise KeyError(f"{addon_id} declares no secret setting {field_id!r}")
        return secrets.read(addon_id, field_id)

    def write(values: Mapping[str, object]) -> WriteOutcome:
        """Record this addon's own values, validated exactly as a person's entry is (F2).

        A `secret` goes to the secret store and everything else to the settings store, which
        is the same split saving a form makes — and the same
        :class:`~innytypes.addons.settings.WriteOutcome` comes back from both, so a caller has
        one kind of answer to read whatever it wrote.
        """
        recorded_here: list[str] = []
        refused: list[FieldProblem] = []
        plain: dict[str, object] = {}

        for field_id, value in values.items():
            field = declared.get(field_id)
            if field is None or not is_secret_field(field):
                # Undeclared too: the settings store refuses it by name, in the words the
                # window already shows for a field a plugin does not declare.
                plain[field_id] = value
                continue

            # Asked here because the secret store does not judge `written_by` — that rule is
            # the settings store's, and a secret is subject to it like any other field.
            problem = writer_refusal(field, by=addon_id, addon_id=addon_id)
            if problem is not None:
                refused.append(problem)
                continue

            outcome = store_secret(
                store.fields,
                addon_id=addon_id,
                field_id=field_id,
                value=value,
                store=secrets,
            )
            recorded_here.extend(outcome.recorded)
            refused.extend(outcome.refused)

        if plain:
            # `by` is this addon and cannot be anything else: the store refuses a write made
            # in any other name, and there is no argument here to make one in.
            outcome = store.write(plain, by=addon_id)
            recorded_here.extend(outcome.recorded)
            refused.extend(outcome.refused)

        return WriteOutcome(recorded=tuple(recorded_here), refused=tuple(refused))

    return PluginSettings(values=dict(recorded.values), secret=secret, write=write)


def run(
    addon_id: str,
    *,
    connection: Connection,
    load: EntryPointLoader = load_entry_point,
    settings: SettingsOpener = no_settings,
) -> int:
    """Run one addon on one connection until the host stops it. Returns the exit code.

    Everything that can go wrong before the addon is running is reported to the host and
    exits non-zero: a missing entry point, a manifest that does not validate, a manifest
    claiming another addon's id, a settings file that cannot be read at all, and whatever the
    addon's own entry point raises.
    """
    try:
        manifest = _manifest_of(addon_id, load)
        addon, inbox, transport = _start(
            manifest, connection=connection, load=load, settings=settings
        )
    except _Terminated:
        # A stop, not a failure to start: it is the host's own signal, and reporting it as an
        # addon that could not be loaded would send the host a reason that is not true.
        raise
    except Exception as error:
        reason = f"{type(error).__name__}: {error}"
        log.error("addon %s did not start: %s", addon_id, reason)
        _report_failure(connection, addon_id=addon_id, reason=reason)
        connection.close()
        return FAILED_EXIT_CODE

    return _serve(addon_id, addon=addon, inbox=inbox, transport=transport, connection=connection)


def main(
    argv: Sequence[str] | None = None,
    *,
    load: EntryPointLoader = load_entry_point,
    settings: SettingsOpener = user_settings,
) -> int:
    """The process entry point: one argument, the addon's id, and fd 0 is its channel.

    The one place that reads this user's real settings, which is why :func:`run` defaults to
    none: everything below the process entry point is reached by tests, and a default that
    opened ``~/.config`` would make them depend on the machine they run on.
    """
    arguments = list(sys.argv[1:] if argv is None else argv)
    if len(arguments) != 1:
        sys.stderr.write(
            "usage: python -m innytypes.addons.run <addon-id>\n"
            "This module is started by the host, once per installed addon.\n"
        )
        return FAILED_EXIT_CODE

    try:
        connection = _channel_from_standard_input()
    except AddonRunError as error:
        sys.stderr.write(f"{error}\n")
        return FAILED_EXIT_CODE

    _stop_on_terminate()
    try:
        return run(arguments[0], connection=connection, load=load, settings=settings)
    except _Terminated:
        # The signal landed outside the serve loop — during startup, or during the shutdown
        # that was already under way. Either way the host asked for this process to end, and
        # ending is not a failure.
        log.info("%s was terminated while it was starting or stopping", arguments[0])
        return 0


def _manifest_of(addon_id: str, load: EntryPointLoader) -> AddonManifest:
    """This addon's manifest, read from its own entry point and validated again here.

    Validated rather than trusted: the host validated the document it recorded at install
    time, and this is a different read of a package that may have been reinstalled since.
    """
    export = load(ENTRY_POINT_GROUP, addon_id)
    if not callable(export):
        raise AddonRunError(
            f"the {ENTRY_POINT_GROUP} entry point named {addon_id!r} is not callable: it "
            "names a function that takes no arguments and returns the manifest document"
        )

    document = export()
    if not isinstance(document, Mapping):
        raise AddonRunError(
            f"the {ENTRY_POINT_GROUP} entry point named {addon_id!r} returned a "
            f"{type(document).__name__}, not a manifest document"
        )

    manifest = parse_manifest(document)
    if manifest.id != addon_id:
        raise AddonRunError(
            f"the addon installed as {addon_id!r} exports a manifest claiming id "
            f"{manifest.id!r}: an addon has one identity, and it is the one it was installed "
            "under"
        )
    return manifest


def _start(
    manifest: AddonManifest,
    *,
    connection: Connection,
    load: EntryPointLoader,
    settings: SettingsOpener,
) -> tuple[Addon, Subscription, EventTransport]:
    """Build the addon's side of the bus, start the addon, and subscribe it.

    The order is deliberate. The transport exists before the addon does, so that a report of
    an addon that raises on the way up has somewhere to go; the subscription is made after the
    addon returns, so that no event can reach a handler belonging to an addon that never
    finished starting.

    The settings are opened before the addon, so a settings file this addon's values cannot be
    read out of at all is a start that failed with a reason the host is told, rather than an
    addon already running when it is discovered.
    """
    addon_id = manifest.id

    # Two buses, because an addon is a client of the host's one bus rather than the owner of a
    # second one: `spool` is what it emits, drained onto the wire, and `local` is what arrives.
    spool = EventBus()
    local = EventBus()

    registry = KindRegistry()
    emitter = registry.emitter_for(manifest, sink=spool.publish)

    transport = EventTransport(
        peer=HOST_PEER,
        connection=connection,
        outbound=spool,
        # Everything this addon may emit, which its own emitter has already limited to the
        # kinds it owns and declared.
        forwards=[parse_subscription(f"{addon_id}.*")],
        inbound=local.publish,
    )

    opened = settings(manifest)
    factory = _factory_of(addon_id, load)
    addon = factory(
        AddonContext(
            id=addon_id,
            manifest=manifest,
            emitter=emitter,
            settings=opened.values,
            secret=opened.secret,
            write_settings=opened.write,
        )
    )

    inbox = local.subscribe(
        subscriber=addon_id,
        patterns=manifest.subscribes,
        handler=addon.handle,
    )
    return addon, inbox, transport


def _factory_of(addon_id: str, load: EntryPointLoader) -> AddonFactory:
    """This addon's runtime entry point, checked to be callable before it is called."""
    export = load(RUNTIME_ENTRY_POINT_GROUP, addon_id)
    if not callable(export):
        raise AddonRunError(
            f"the {RUNTIME_ENTRY_POINT_GROUP} entry point named {addon_id!r} is not callable: "
            "it names a function that takes the addon's context and returns the addon"
        )
    return cast(AddonFactory, export)


def _serve(
    addon_id: str,
    *,
    addon: Addon,
    inbox: Subscription,
    transport: EventTransport,
    connection: Connection,
) -> int:
    """Carry events both ways until the host closes the channel, then shut down.

    The inbound direction is this thread, blocked on the read; the outbound direction and the
    addon's own handler are delivery threads, so a handler that takes its time delays neither
    the host nor this loop.
    """
    delivery = ThreadedDelivery()
    delivery.run(inbox)
    delivery.run(transport.subscription)

    try:
        while transport.alive:
            try:
                transport.pump_inbound()
            except FramingError as error:
                # One unreadable frame is a bug in the host end, not a reason to take this
                # addon down with it. Reported, and the channel stays open.
                log.warning("addon %s could not read a frame: %s", addon_id, error)
    except PeerGoneError:
        log.info("the host closed the channel to %s; stopping", addon_id)
    except _Terminated:
        log.info("the host terminated %s; stopping", addon_id)

    # Nothing of the addon's runs after this: the handler thread is done before `stop` is
    # called, so an addon is never stopped while it is still being handed events.
    delivery.close()

    exit_code = 0
    try:
        addon.stop()
    except Exception as error:
        log.exception("addon %s did not stop cleanly", addon_id)
        _report_failure(connection, addon_id=addon_id, reason=f"{type(error).__name__}: {error}")
        exit_code = FAILED_EXIT_CODE

    # Whatever `stop` emitted, onto the wire before the channel goes. A send into a channel
    # the host has already closed drops this peer on the spool, which nothing is listening to.
    transport.subscription.deliver_pending()
    transport.close()
    return exit_code


def _report_failure(connection: Connection, *, addon_id: str, reason: str) -> None:
    """Tell the host why this process is about to exit, if it is still listening.

    Sent as a frame rather than written to standard error because standard error is a pipe
    nobody reads, and the reason has to reach the host that decides what to do about it. A
    host that has already gone is not a second failure: the exit code says the rest.
    """
    event = Event(kind=ADDON_FAILED, payload={"addon": addon_id, "reason": reason})
    try:
        connection.send(frame_event(event))
    except (PeerGoneError, FramingError) as error:
        log.warning("could not tell the host why %s failed: %s", addon_id, error)


def _channel_from_standard_input() -> Connection:
    """The host's channel, as this process inherited it.

    Standard input is a socket here, not a pipe: the host handed the child end of a socketpair
    to the spawn, and a socket is duplex, so one file object carries both directions.
    """
    try:
        channel = socket.socket(fileno=sys.stdin.fileno())
    except OSError as error:
        raise AddonRunError(
            "standard input is not this addon's event channel: "
            f"{type(error).__name__}: {error}. "
            "`python -m innytypes.addons.run` is started by the host, which opens a socketpair "
            "per addon and gives the child end to the process as standard input."
        ) from error

    # `cast` because `makefile` is typed as returning a `BufferedRWPair`, which reads,
    # writes, flushes and closes exactly as `IO[bytes]` requires without being one
    # nominally.
    stream = cast(IO[bytes], channel.makefile("rwb"))
    # The stream is now the descriptor's one owner; see `innytypes.events.channel` for why the
    # socket object is closed the moment it has handed the descriptor over.
    channel.close()
    return StreamConnection(reader=stream, writer=stream)


def _stop_on_terminate() -> None:
    """Make ``SIGTERM`` end the serve loop, which is the one way this process shuts down.

    The host's polite stop is a ``terminate`` (:meth:`innytypes.children.ChildSupervisor.stop`),
    and it has to arrive somewhere the addon's own ``stop`` still gets called — the default
    disposition would end the process between two events with nothing shut down at all.

    It **raises** rather than closing the channel. A signal handler runs on the main thread, in
    the middle of whatever it interrupted, and that is usually a buffered read: closing a
    buffered stream from inside its own read is a reentrant call, which fails. Raising is how
    ``SIGINT`` has always ended a blocking read, and it unwinds to the loop below by itself.
    """

    def stop(signal_number: int, frame: FrameType | None) -> None:
        raise _Terminated

    signal.signal(signal.SIGTERM, stop)


if __name__ == "__main__":  # pragma: no cover - the process entry point itself
    raise SystemExit(main())
