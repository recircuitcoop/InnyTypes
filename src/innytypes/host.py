"""The host itself: what it starts, what it does when it cannot, and what addons may ask it.

Two things live here, and they are the two halves of plan 0002 slice 05.

**Starting the children, and degrading instead of crashing.** The host brings up the Anytype
MCP server as a **core child** — not an addon — through the child supervisor that already
owns spawning and stopping (:mod:`innytypes.children`). Two things can stop that child from
starting, and neither of them may take the host down with it (plan 0001, *A missing
requirement degrades, it does not crash*):

* **No API key.** There is then no :class:`~innytypes.anytype_mcp.ServerConfig` to build a
  supervisor from, so this host simply **has no MCP child at all** — it is absent from the
  child supervisor's start order rather than present and failing. That is the honest answer
  to a later ``start innytypes.anytype_mcp`` from the helper too: this host, as configured,
  has no such child, and the fix is `innytypes anytype-mcp get-key`, not a restart.
* **Anytype is not running.** The supervisor's health gate refuses before it spawns, so the
  child never exists. The host records why and carries on.

Either way the host reaches its running state, every addon that does not need Anytype starts,
and the reason is in :class:`HostReport` and in the log. Nothing is retried here: a host that
re-tried the MCP child would be the second restart policy in the application, and plan 0003
owns the first one.

**The tool surface, readable by an addon that never imports the MCP package.**
:func:`anytype_tools` is the host API function an addon calls, and it answers with plain
strings and mappings — no type from :mod:`innytypes.anytype_mcp` crosses the seam, so an
addon needs one import, ``innytypes.host``, and nothing else. That matters because an addon
lives in its own environment and its own process: what it can rely on is the host API, and
the MCP package is the host's private business.

**A live server's surface never supersedes the committed one.** :func:`anytype_tools` reads
``src/innytypes/anytype_mcp/tool_surface.json`` whether or not the MCP child is running, and
it would still read it if asking the running child were free. Three reasons, in order of how
much they would cost to get wrong:

1. **A deviation is evidence, not a better answer.** The committed record is what the pinned
   pair `(PACKAGE_VERSION, ANYTYPE_VERSION)` exposes, reviewed and landed as such. A running
   server that answers differently has found a *disagreement* — the running Anytype serves a
   different OpenAPI document than the pin claims — and plan 0002's whole upgrade procedure
   exists to make that visible as a diff a person reads. Serving the live answer instead
   would swallow exactly the failure the fixture was created to catch: a tool that keeps its
   name and changes its arguments. `innytypes anytype-mcp refresh-tool-surface` is where a
   live surface belongs, because it *prints the difference* rather than quietly winning.
2. **The answer must not depend on the machine.** An addon asks what tools exist in order to
   decide what it can do. If that answer came from a running child, it would differ between
   two machines on the same version, and it would be unavailable on precisely the degraded
   host this module exists to keep running.
3. **Addons are separate processes.** An addon's call cannot reach the host's child anyway
   without a request channel that would have to exist, be bounded, and fail somehow. The
   committed record is shipped data in every addon environment, and reading it needs none of
   that.

So :func:`anytype_tools` answers what the pinned pair exposes, **not** whether a server is up
right now. Those are different questions, and the second one is the child supervisor's:
:attr:`Host.children` lists what is actually running.

**The event bus is assembled here too, and nowhere else.** :func:`build_host` builds the one
:class:`~innytypes.events.bus.EventBus`, the one
:class:`~innytypes.events.emitter.KindRegistry` and the
:class:`~innytypes.events.channel.SocketPairChannels` that opens an addon's connection when the
supervisor spawns it. Before that, every rule of the bus was landed and tested and no running
host had one: a bus nothing constructs is a bus nothing carries.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType

from innytypes.addons.discovery import BrokenAddon, discover_addons
from innytypes.anytype_mcp.config import ConfigError, load_config
from innytypes.anytype_mcp.logs import get_logger
from innytypes.anytype_mcp.supervisor import Supervisor, SupervisorError
from innytypes.anytype_mcp.tools import load_tool_surface
from innytypes.children import (
    MCP_CHILD_ID,
    ChildExit,
    ChildRecord,
    ChildSupervisor,
    DisabledChildError,
    ExitReporter,
    HoldsBack,
    RunStateFile,
    Spawn,
    default_spawn,
)
from innytypes.events.bus import ADDON_FAILED, LISTENER_FAILED, EventBus
from innytypes.events.channel import AddonChannels, SocketPairChannels
from innytypes.events.emitter import KindRegistry
from innytypes.helper.config import HelperSettings
from innytypes.helper.enablement import StartGate

__all__ = [
    "AnytypeTools",
    "Degradation",
    "Host",
    "HostReport",
    "McpSupervisorFactory",
    "anytype_tools",
    "build_host",
    "default_mcp_supervisor",
]

log = get_logger(__name__)


@dataclass(frozen=True)
class AnytypeTools:
    """The Anytype tools an addon may call, as plain data.

    Every field is a string or a mapping of strings, deliberately: an addon reads this
    without importing :mod:`innytypes.anytype_mcp`, and a return value carrying that
    package's own types would make the import necessary again by the back door.

    ``signatures`` maps a tool name to a SHA-256 fingerprint of that tool's input schema.
    The fingerprint is what makes a *reshaped* tool visible — the failure that otherwise
    shows up as an addon that keeps calling a tool and starts failing.
    """

    package_version: str
    anytype_version: str
    # How the record was captured: `live-server` or `bundled-spec`. Passed through rather
    # than hidden, because the two are not equally strong evidence (plan 0002).
    source: str
    captured_at: str
    signatures: Mapping[str, str]

    @property
    def names(self) -> tuple[str, ...]:
        """Every tool name, sorted, so two readings cannot disagree about the order."""
        return tuple(sorted(self.signatures))


def anytype_tools() -> AnytypeTools:
    """The Anytype tool surface, for an addon that imports only this module.

    Answers from the record committed with the host, at the two pinned versions, and it
    answers whether or not the MCP child is running — see this module's docstring for why a
    live server never supersedes it.

    Raises :class:`~innytypes.anytype_mcp.ToolSurfaceError`, a ``RuntimeError``, when the
    shipped record is missing or malformed. That is a broken installation rather than a
    degradation: there is no weaker answer to give, and an addon that wants to survive it
    can catch ``RuntimeError`` without naming the MCP package.
    """
    surface = load_tool_surface()
    return AnytypeTools(
        package_version=surface.package_version,
        anytype_version=surface.anytype_version,
        source=surface.source,
        captured_at=surface.captured_at,
        # Read-only, so an addon cannot edit the host's answer and hand the edited version
        # to the next caller that happens to share it.
        signatures=MappingProxyType(dict(surface.tools)),
    )


@dataclass(frozen=True)
class Degradation:
    """One part of the host that is **not** running, and the reason in full.

    ``component`` is the child id the missing part would have had, so a reader can match it
    against the run-state file and against what the helper was told; ``reason`` is the
    message of the failure, unedited, because the fix is in it.
    """

    component: str
    reason: str


@dataclass(frozen=True)
class HostReport:
    """What starting the host actually produced: what came up, and what did not.

    Returned rather than raised, because "the MCP server is missing" is a state the host
    goes on running in, not an error that ends anything.
    """

    started: tuple[ChildRecord, ...]
    degraded: tuple[Degradation, ...]
    # Children that were not started because the user switched them off, or because their
    # settings are not yet valid (plan 0004). Kept apart from `degraded` because they need a
    # different sentence and a different action: nothing is broken.
    held: tuple[Degradation, ...] = ()

    @property
    def is_complete(self) -> bool:
        """True when nothing was left out — every child the host has is running."""
        return not self.degraded


# How the host obtains a configured MCP supervisor. A callable rather than a `ServerConfig`
# because **the key may not exist**: raising `ConfigError` from here is how the host learns
# that this machine has no MCP child, and it is the same seam a test uses to hand over a
# supervisor wired to a fake spawn and an in-process health client.
McpSupervisorFactory = Callable[[], Supervisor]


def default_mcp_supervisor() -> Supervisor:
    """The MCP supervisor as production builds it: the ambient key, the pinned versions."""
    return Supervisor(config=load_config())


def _log_child_exit(exit_report: ChildExit) -> None:
    """Where a child exit goes when no helper is connected to hear it.

    A host the helper started reports its exits over the control channel
    (:meth:`innytypes.helper.control.HelperLink.report_exit`, passed in as ``report_exit``).
    This is the default for a host that has no helper — started by hand, or started before the
    helper was listening — and it is not a silent one: the helper is what decides what to do
    about an exit, and a host whose reports went nowhere *without saying so* would look
    identical to a host whose children never died.
    """
    log.info(
        "child %s (process %s) exited with code %s; no helper is connected to hear it",
        exit_report.id,
        exit_report.pid,
        exit_report.exit_code,
    )


class Host:
    """The running host: its children, and everything that is missing from them.

    Built by :func:`build_host`, which is where the degradations that happen *before*
    anything can start — an absent API key, most of all — are discovered and handed over.
    """

    def __init__(
        self,
        *,
        children: ChildSupervisor,
        events: EventBus | None = None,
        kinds: KindRegistry | None = None,
        degraded: Sequence[Degradation] = (),
        broken: Sequence[BrokenAddon] = (),
    ) -> None:
        self._children = children
        # A host assembled by hand gets a bus of its own rather than none at all, because a
        # `None` here would be an attribute every reader has to check. The host `innytypes up`
        # runs is assembled by `build_host`, which passes the one bus its children are wired to.
        self._events = EventBus() if events is None else events
        self._kinds = KindRegistry() if kinds is None else kinds
        self._degraded = tuple(degraded)
        self._broken = tuple(broken)
        self._running = False

    @property
    def children(self) -> ChildSupervisor:
        """The child supervisor, which is what a helper command is carried out against."""
        return self._children

    @property
    def events(self) -> EventBus:
        """The host's one event bus. Every addon process is a subscriber on it.

        One bus per host, not per addon: the matching, the per-subscriber bound and the drop
        that follows are the bus's, and an addon in another process is a subscription whose
        handler writes to that addon's connection (:mod:`innytypes.events.channel`).
        """
        return self._events

    @property
    def kinds(self) -> KindRegistry:
        """Every event kind this host will accept: its own, and each addon's as it starts.

        The host registry is what makes an *undeclared* kind refusable at the process
        boundary. The emitters themselves live in the addon processes, each bound to one
        addon's id, because that is where an addon runs.
        """
        return self._kinds

    @property
    def broken(self) -> tuple[BrokenAddon, ...]:
        """The installed addons discovery could not read, with the reason for each.

        Carried on the host rather than left in the log, so the one caller that has a person
        in front of it can print them. A second `discover_addons` call in that caller would
        be a second answer to what is installed, taken a moment later than this one.
        """
        return self._broken

    @property
    def is_running(self) -> bool:
        """True once :meth:`start` has run, whatever it had to leave out."""
        return self._running

    def start(self) -> HostReport:
        """Start every child this host has, and report what it could not start.

        The MCP child is the one start that is allowed to fail: an unreachable Anytype means
        the server has nothing to wrap, and the host plus every addon that does not need
        Anytype is still worth running. An addon that cannot be spawned still raises — that
        is a broken installation on this machine rather than a designed degradation, and the
        resolver has already held back the addons whose *requirements* are missing.

        **A child the user switched off, or one held back because its settings are not yet
        valid, is not a failure at all** (plan 0004, the enable switch and F1). It is skipped
        and named in ``held``, and the host goes on starting everything else. Raising here
        instead was a real defect: an installed plugin waiting to be configured took down the
        whole application, which is precisely what plan 0001 invariant 5 forbids.
        """
        started: list[ChildRecord] = []
        degraded = list(self._degraded)
        held: list[Degradation] = []

        for child_id in self._children.start_order:
            try:
                started.append(self._children.start(child_id))
            except DisabledChildError as error:
                # Not a degradation: nothing is wrong with it, and the word already says what
                # the user would have to do — switch it on, or finish its settings.
                log.info("%s was not started: %s", child_id, error)
                held.append(Degradation(component=child_id, reason=str(error)))
            except SupervisorError as error:
                if child_id != MCP_CHILD_ID:
                    raise
                # Reported, not retried. The child does not exist, so there is nothing to
                # restart, and restart policy is the helper's in any case (plan 0003).
                log.warning("the Anytype MCP server did not start: %s", error)
                degraded.append(Degradation(component=child_id, reason=str(error)))

        self._running = True
        return HostReport(started=tuple(started), degraded=tuple(degraded), held=tuple(held))

    def shutdown(self) -> None:
        """Stop every running child, MCP server included, and leave no orphan behind.

        The stopping itself is :meth:`ChildSupervisor.shutdown`'s — reverse start order, a
        kill after a terminate that is ignored — and is not repeated here. A second shutdown
        path would be a second answer to "what is still running".
        """
        self._children.shutdown()
        self._running = False


def build_host(
    *,
    addons_root: Path | None = None,
    mcp: McpSupervisorFactory = default_mcp_supervisor,
    spawn: Spawn = default_spawn,
    run_state: RunStateFile | None = None,
    report_exit: ExitReporter = _log_child_exit,
    channels: AddonChannels | None = None,
    clock: Callable[[], float] = time.time,
    environment: Mapping[str, str] | None = None,
    holds_back: HoldsBack | None = None,
) -> Host:
    """Assemble the host from what is installed on this machine, missing pieces included.

    Every seam the outside world reaches through is a parameter, exactly as
    :class:`~innytypes.children.ChildSupervisor` and
    :class:`~innytypes.anytype_mcp.Supervisor` already take theirs, which is what lets the
    whole startup be exercised with no Node, no Anytype and no process at all.

    Nothing is installed, downloaded or written to an addon environment here (plan 0001,
    *Installation is explicit*): discovery reads what `innytypes addons install` recorded,
    and a host that fixed up what it found would be a host nobody can debug.

    ``holds_back`` is what decides whether a child may run at all, and it defaults to
    :class:`~innytypes.helper.enablement.StartGate` — the user's switch in the helper's
    `config.toml`, and each plugin's own settings (plan 0004, *The enable switch*). A plugin
    it holds back is not started, and nothing else about it changes: it is still installed,
    still discovered, and still a child this host knows, so it starts where the resolver put
    it the moment the switch goes back on or its settings are completed.

    **This is where the event bus becomes real.** The bus, the kind registry and the addon
    channels are built exactly once, here, and handed to the child supervisor — so an addon
    the host spawns is a subscriber on the same bus, with the same bound and the same
    matching, as one that ran in this process. A host assembled without them would pass every
    test the bus has and carry no events at all.
    """
    discovered = discover_addons(addons_root)
    for broken in discovered.broken:
        # Named at startup rather than only by `addons list`: an addon that is installed and
        # unreadable is the one a user is waiting for and will not get.
        log.warning("addon %s will not start: %s", broken.id, broken.reason)

    supervisor, degraded = _mcp_supervisor(mcp)

    events = EventBus()
    kinds = KindRegistry()
    # The host's own kinds belong to no manifest, so they are registered here or an inbound
    # frame carrying one would be refused as undeclared.
    kinds.register(LISTENER_FAILED, ADDON_FAILED)

    children = ChildSupervisor(
        mcp=supervisor,
        addons=discovered.installed,
        run_state=RunStateFile() if run_state is None else run_state,
        report_exit=report_exit,
        spawn=spawn,
        channels=SocketPairChannels(bus=events, kinds=kinds) if channels is None else channels,
        clock=clock,
        environment=environment,
        # Live rather than a snapshot, so a plugin switched off — or a settings form
        # completed — while the host is running is obeyed by the next start (plan 0004).
        holds_back=(
            StartGate(settings=HelperSettings(), installed=discovered.installed)
            if holds_back is None
            else holds_back
        ),
    )
    return Host(
        children=children,
        events=events,
        kinds=kinds,
        degraded=degraded,
        broken=discovered.broken,
    )


def _mcp_supervisor(factory: McpSupervisorFactory) -> tuple[Supervisor | None, list[Degradation]]:
    """The configured MCP supervisor, or ``None`` and the reason there is none.

    A missing key is the reason, and it is a `ConfigError` rather than a return value
    because the key is loaded far from here. It degrades: the host has no MCP child, says
    so, and starts everything else.
    """
    try:
        return factory(), []
    except ConfigError as error:
        log.warning("the Anytype MCP server has no configuration, so it will not start: %s", error)
        return None, [Degradation(component=MCP_CHILD_ID, reason=str(error))]
