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

**The host also keeps the MCP child's heartbeat, because the child cannot.**
:class:`McpHeartbeat` pings the child over the one MCP session this host holds and records a
beat **only for a ping the child answered** — never for a process that merely exists. That is
what lets the helper judge a wedged Node server stale rather than waiting for it to die (plan
0002, *The child promises a heartbeat, and the host keeps it*). Nothing is decided here about
what a stale child costs: this module makes the silence visible and plan 0003 acts on it.

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
from dataclasses import dataclass, field
from functools import partial
from pathlib import Path
from types import MappingProxyType

from innytypes.addons.discovery import BrokenAddon, discover_addons
from innytypes.anytype_mcp.config import PACKAGE_VERSION, ConfigError, load_config
from innytypes.anytype_mcp.endpoint import GatewayError
from innytypes.anytype_mcp.gateway import McpGateway, load_gateway_config
from innytypes.anytype_mcp.session import McpSession
from innytypes.anytype_mcp.supervisor import (
    MCP_HEARTBEAT_INTERVAL,
    Supervisor,
    SupervisorError,
)
from innytypes.anytype_mcp.tools import load_tool_surface
from innytypes.children import (
    MCP_CHILD_ID,
    ChildExit,
    ChildRecord,
    ChildSupervisor,
    Command,
    CommandName,
    CommandResult,
    # Defined in `children` rather than here, because the control channel puts it on the
    # wire and `innytypes.helper.control` must not import the host. Re-exported below, so
    # `from innytypes.host import Degradation` is still how every caller names it.
    Degradation,
    DisabledChildError,
    ExitReporter,
    HoldsBack,
    RunStateFile,
    Spawn,
    StartFailureReporter,
    default_spawn,
    log_start_failure,
)
from innytypes.events.bus import ADDON_FAILED, LISTENER_FAILED, EventBus
from innytypes.events.channel import AddonChannels, RefusalReporter, SocketPairChannels
from innytypes.events.emitter import KindRegistry
from innytypes.helper.config import HelperSettings
from innytypes.helper.enablement import StartGate
from innytypes.helper.heartbeat import Heartbeat, HeartbeatSink, ProcessState
from innytypes.logs import get_logger

__all__ = [
    "AnytypeTools",
    "Degradation",
    "Host",
    "HostReport",
    "McpHeartbeat",
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
    return Supervisor(config=load_config(), session_factory=McpSession)


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


@dataclass
class McpHeartbeat:
    """The beat the MCP child promised and cannot send, kept by the host that can.

    ``@anyproto/anytype-mcp`` knows nothing of InnyTypes and never will — the seam between
    the two ecosystems is a child process with an environment — so the child cannot beat and
    will not be taught to. What already exists is better: this host holds the **only** MCP
    session to it, and MCP defines ``ping``. So the host beats on the child's behalf
    (plan 0002, *The child promises a heartbeat, and the host keeps it*).

    **The rule that makes it honest: a beat is recorded only for a ping the child answered.**
    Not for a process that exists, not for a session object that was constructed, not for a
    request that was merely sent. A beat therefore means *the child answered MCP at that
    moment*, which is strictly more than liveness proves and is exactly what staleness is
    for. A ping that fails, times out or raises records nothing, and the child goes stale on
    the window it declared (:data:`~innytypes.anytype_mcp.supervisor.MCP_STABILITY`).

    Three consequences, each a decision rather than an accident:

    * **A wedged host stops the beats**, and the child is then judged stale though it may be
      answering. That is the right direction to fail: the helper watches this host too, so a
      host that stopped pinging is itself a condition somebody sees, and a supervisor that
      assumed liveness because it could not check is the failure being removed.
    * **The interval outlasts the pass that reads it**, so a promise cannot be judged missed
      before it could be kept. The number, and why it is that number, are with the
      declaration.
    * **The ping is bounded by the session's existing request timeout** and costs the child
      one round trip. No second timeout is added here; :meth:`~innytypes.anytype_mcp.session
      .McpSession.ping` says why.

    Nothing here restarts, stops or counts anything. It makes the child's silence *visible*;
    plan 0003 still owns every restart in the application.
    """

    # Asked afresh on every beat rather than held, because a child that was restarted has a
    # new session and a host holding the old one would be pinging a pipe nobody reads.
    # ``None`` is an ordinary answer: this machine has no MCP child, or it has not started.
    session: Callable[[], McpSession | None]
    # The child's identity as the run-state file carries it. The beat is *about the child*,
    # so it carries the child's process id and start time and not this host's — anything
    # reading a beat back is entitled to check which process answered.
    child: Callable[[], ChildRecord | None]
    # The pinned version of the package the child is running. Part of the beat because a
    # reader is entitled to know which release answered, exactly as for any other process.
    version: str
    interval: float = MCP_HEARTBEAT_INTERVAL
    # Two clocks, because they answer two questions. The schedule is monotonic, so a machine
    # whose wall clock is corrected does not skip or repeat a beat; ``progress_at`` is
    # wall-clock seconds, because that is the clock every other heartbeat's marker is on.
    elapsed: Callable[[], float] = time.monotonic
    clock: Callable[[], float] = time.time

    # When the next beat is due. ``None`` means "now": a child that has just come up should
    # be known to be answering rather than assumed to be for its first interval.
    _due_at: float | None = field(default=None, init=False, repr=False)

    def tick(self, record: HeartbeatSink) -> Heartbeat | None:
        """Beat if one is due, and answer with the beat that was recorded, or ``None``.

        Called once per pass of the host's own loop, which runs far more often than the
        interval — so this is where the interval is actually honoured, and the loop stays
        free to notice a child exit in between.

        **The schedule moves whether or not the child answered.** A ping that failed is not
        a reason to ping again on the next pass: the child has a whole stale window to start
        answering in, and a host retrying every second would be a second cadence nobody
        chose.
        """
        now = self.elapsed()
        if self._due_at is not None and now < self._due_at:
            return None

        self._due_at = now + self.interval
        return self.beat(record)

    def beat(self, record: HeartbeatSink) -> Heartbeat | None:
        """Ping the child once, and hand ``record`` a beat **only** if it answered.

        The broad ``except`` is the rule rather than an oversight. What can come back from a
        ping is a refusal, a timeout, a closed session, a pipe whose far end has gone or an
        operating system that would not write — and every one of them is the same answer:
        *no evidence the child is working*, so nothing is recorded. An exception allowed out
        of here would end the host's loop over a child that is merely unwell.
        """
        session, child = self.session(), self.child()
        if session is None or child is None:
            # Not a failed beat: there is no child to be silent. A host with no MCP child
            # records nothing about one, and the helper has no record to judge either.
            return None

        try:
            session.ping()
        except Exception as error:  # noqa: BLE001 - every way a ping can fail means the same
            log.warning("the Anytype MCP child did not answer a ping, so no beat: %s", error)
            return None

        beat = Heartbeat(
            id=child.id,
            kind=child.kind,
            pid=child.pid,
            started_at=child.started_at,
            version=self.version,
            # The moment the child answered, which is when it last did real work as far as
            # anything here can honestly say. It has to *change* between beats or the helper
            # judges the marker frozen, and a monotonic reading would be a different clock
            # from the one every other beat's marker is written against.
            progress_at=self.clock(),
            state=ProcessState.READY,
        )

        try:
            record(beat)
        except Exception as error:  # noqa: BLE001 - a helper that is not listening is not news
            log.debug("the Anytype MCP child's beat reached no helper: %s", error)
            return None

        return beat


def _no_mcp_child() -> None:
    """The session and the record of a host that has no MCP child: there is nothing."""
    return None


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
        gateway: McpGateway | None = None,
        heartbeat: McpHeartbeat | None = None,
    ) -> None:
        self._children = children
        # A host assembled by hand keeps a beat that has no child to ping rather than no
        # beat at all, for the same reason it gets a bus of its own: a ``None`` here would be
        # an attribute every caller has to check, and the caller that forgot would be the
        # one that silently stopped watching the child this application most depends on.
        self._heartbeat = (
            McpHeartbeat(
                session=_no_mcp_child,
                child=_no_mcp_child,
                version=PACKAGE_VERSION,
            )
            if heartbeat is None
            else heartbeat
        )
        # A host assembled by hand gets a bus of its own rather than none at all, because a
        # `None` here would be an attribute every reader has to check. The host `innytypes up`
        # runs is assembled by `build_host`, which passes the one bus its children are wired to.
        self._events = EventBus() if events is None else events
        self._kinds = KindRegistry() if kinds is None else kinds
        self._degraded = tuple(degraded)
        self._broken = tuple(broken)
        self._gateway = gateway
        self._running = False

    @property
    def children(self) -> ChildSupervisor:
        """The child supervisor, which is what a helper command is carried out against."""
        return self._children

    @property
    def heartbeat(self) -> McpHeartbeat:
        """The beat this host keeps on the MCP child's behalf, for whoever drives the loop.

        Not driven here: **where a beat goes is the process's business**, exactly as where a
        child's exit goes is (:data:`~innytypes.children.ExitReporter`). A host the helper
        started puts it on the helper's heartbeat socket; a host somebody ran in a terminal
        has nobody to tell. So the sink is an argument to :meth:`McpHeartbeat.tick` and the
        command that knows which of those two this is — ``innytypes up`` — supplies it.
        """
        return self._heartbeat

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

    def execute(self, command: Command) -> CommandResult:
        """Carry out one of the helper's commands, whichever part of this host it is about.

        **This is what the control channel is given** (:func:`innytypes.helper.control
        .connect_to_helper`), rather than :meth:`ChildSupervisor.execute` alone, because the
        helper asks this host for two different kinds of thing and only one of them is a
        child. Every command plan 0003 defines is a child's and goes straight through;
        ``SET_ENDPOINT`` is the MCP listener's, and the listener is the host's own (plan
        0008). Routing here rather than inside the supervisor keeps the supervisor about
        children, and keeps the helper talking to one object.

        A command this host cannot carry out **raises**, and that is the answer: the link
        turns it into a refusal naming the reason, which crosses the wire as a refusal
        rather than as silence (:meth:`innytypes.helper.control.HelperLink.serve_one`).
        """
        if command.name is CommandName.SET_ENDPOINT:
            url, moved = self._move_endpoint(command)
            return CommandResult(name=command.name, endpoint=url, endpoint_moved=moved)
        return self._children.execute(command)

    def _move_endpoint(self, command: Command) -> tuple[str, bool]:
        """Serve the address the helper asked for: the URL now served, and whether it moved.

        **A host with no gateway starts none.** ``None`` here does not mean "switched off":
        it means this host's Anytype child was never validated, so there is no session for a
        listener to serve. Opening one anyway would put a URL on the machine that accepts a
        client's connection and can answer nothing through it, which reads to that client as
        a broken service rather than as an InnyTypes that is not ready (plan 0007). So the
        reason is named and nothing is bound.

        **The address already being served is a success that does nothing.** Somebody who
        opens the panel and presses Save without editing anything is asking for the endpoint
        they already have, and the honest answer is that they have it. Handed on to
        :meth:`~innytypes.anytype_mcp.gateway.McpGateway.serve_at` it would instead be a
        bind against a port this very service is holding — a failure, reported to that
        person as "the port is taken", by their own MCP endpoint. The judgement belongs here
        rather than inside ``rebind``, which is honest as it stands: it genuinely cannot bind
        a port it holds, and a ``rebind`` that quietly succeeded at doing nothing would blur
        what a real bind failure means. The check is against what is **being served**, so a
        host whose listener never came up still binds the address it is asked for.

        Everything else — whether the address may be served at all, bind-before-close, and
        what a failed bind leaves behind — is ``serve_at``'s. Nothing is judged twice here,
        so a refusal reaches the person in the words the listener refused it in.
        """
        if command.endpoint is None:
            raise GatewayError(
                "a set-endpoint command carries the address to serve, and this one carries none"
            )
        if self._gateway is None:
            raise GatewayError(
                "this host has no MCP endpoint to move: the Anytype child was never "
                "validated, so there is no session to serve and no listener to put up"
            )

        serving = self._gateway.config
        if self._gateway.is_running and (serving.host, serving.port) == command.endpoint:
            log.info("the MCP endpoint is already being served at %s", serving.url)
            return serving.url, False

        return self._gateway.serve_at(*command.endpoint).url, True

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

        if self._gateway is not None:
            try:
                self._gateway.start()
            except GatewayError as error:
                log.warning("the Anytype MCP HTTP service did not start: %s", error)
                degraded.append(
                    Degradation(component="innytypes.anytype-mcp-http", reason=str(error))
                )

        self._running = True
        return HostReport(started=tuple(started), degraded=tuple(degraded), held=tuple(held))

    def shutdown(self) -> None:
        """Stop every running child, MCP server included, and leave no orphan behind.

        The stopping itself is :meth:`ChildSupervisor.shutdown`'s — reverse start order, a
        kill after a terminate that is ignored — and is not repeated here. A second shutdown
        path would be a second answer to "what is still running".
        """
        if self._gateway is not None:
            self._gateway.stop()
        self._children.shutdown()
        self._running = False


def build_host(
    *,
    addons_root: Path | None = None,
    mcp: McpSupervisorFactory = default_mcp_supervisor,
    spawn: Spawn = default_spawn,
    run_state: RunStateFile | None = None,
    report_exit: ExitReporter = _log_child_exit,
    report_start_failure: StartFailureReporter = log_start_failure,
    report_refusals: RefusalReporter | None = None,
    channels: AddonChannels | None = None,
    clock: Callable[[], float] = time.time,
    environment: Mapping[str, str] | None = None,
    holds_back: HoldsBack | None = None,
    settings: HelperSettings | None = None,
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

    ``report_start_failure`` is the other half of what the helper is told: a child that could
    not be started at all. It defaults to :func:`~innytypes.children.log_start_failure` for the
    same reason ``report_exit`` defaults to a log — a host started by hand has no helper to
    report to — and `innytypes up` hands over the helper's own when there is one. It changes
    nothing about the degradation this host already returns in :attr:`HostReport.degraded`;
    that sentence is still the host's, and this is a second **destination** for the fact, not
    a second wording of it.

    ``report_refusals`` is where an addon's refused kinds go — the third thing the helper is
    told about a child, and the one plan 0012 slice 03 adds: a plugin sending an event its
    manifest never declared. ``None`` leaves the WARNING each refused frame already writes to
    the log as the only record, which is what a host started by hand, with no helper, has.

    ``settings`` is the helper's `config.toml` view, and it answers two of this host's
    questions: whether a plugin may start, and — since plan 0008 — what address the MCP
    endpoint is served on. It is a parameter so a test can hand over a file of its own
    rather than the developer's real one.

    **This is where the event bus becomes real.** The bus, the kind registry and the addon
    channels are built exactly once, here, and handed to the child supervisor — so an addon
    the host spawns is a subscriber on the same bus, with the same bound and the same
    matching, as one that ran in this process. A host assembled without them would pass every
    test the bus has and carry no events at all.
    """
    # One settings view for the whole host, because two of its decisions come out of the
    # same file: which plugins may start, and what address the MCP endpoint is served on.
    # A second view would be a second answer to the second question, and the helper's window
    # reads that answer too (plan 0008, slice 01).
    helper_settings = HelperSettings() if settings is None else settings

    discovered = discover_addons(addons_root)
    for broken in discovered.broken:
        # Named at startup rather than only by `addons list`: an addon that is installed and
        # unreadable is the one a user is waiting for and will not get.
        log.warning("addon %s will not start: %s", broken.id, broken.reason)

    supervisor, degraded = _mcp_supervisor(mcp)
    gateway = None
    if supervisor is not None and supervisor.session_factory is not None:
        try:
            gateway = McpGateway(
                load_gateway_config(environment, settings=helper_settings),
                lambda: supervisor.session,
            )
        except GatewayError as error:
            degraded.append(Degradation(component="innytypes.anytype-mcp-http", reason=str(error)))

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
        report_start_failure=report_start_failure,
        spawn=spawn,
        channels=(
            SocketPairChannels(bus=events, kinds=kinds, report_refusals=report_refusals)
            if channels is None
            else channels
        ),
        clock=clock,
        environment=environment,
        # Live rather than a snapshot, so a plugin switched off — or a settings form
        # completed — while the host is running is obeyed by the next start (plan 0004).
        holds_back=(
            StartGate(settings=helper_settings, installed=discovered.installed)
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
        gateway=gateway,
        # Both seams read the live objects rather than a snapshot taken here: the session is
        # replaced whenever the child is restarted, and the record exists only while the
        # child is running. A host with no MCP supervisor answers ``None`` to both, which is
        # a beat that never happens rather than a beat about nothing.
        heartbeat=McpHeartbeat(
            session=(lambda: None if supervisor is None else supervisor.session),
            child=partial(_running_mcp_child, children),
            version=PACKAGE_VERSION if supervisor is None else supervisor.config.package_version,
        ),
    )


def _running_mcp_child(children: ChildSupervisor) -> ChildRecord | None:
    """The MCP child's record while it is running, and ``None`` when it is not.

    Read from the supervisor's own live set rather than from the run-state file, so a beat
    can never be sent about a child this host has already stopped or lost.
    """
    return next((record for record in children.running() if record.id == MCP_CHILD_ID), None)


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
