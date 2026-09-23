"""Starting and stopping the Node MCP server as a child process.

The supervisor owns one child: ``npx -y @anyproto/anytype-mcp@<pinned> ``. It speaks MCP
over stdio, so the pipes are wired but not interpreted here — exposing that stream to
addons through the host API is plan 0002, slice 05.

The spawn call is injected rather than hard-wired to :mod:`subprocess`, so the argv and
environment this module builds can be asserted on a machine where Node is not installed.
The health client is injected for the same reason, so the start gate can be asserted on a
machine where Anytype is not running. That is what keeps the gate hermetic.

Two behaviours here are about not making a bad day worse:

``start`` refuses when Anytype's local API does not answer. Launching the server anyway
produces a child that runs happily and fails every tool call, which reads as a broken
wrapper rather than as a desktop app nobody started.

Everything this module logs goes through :mod:`innytypes.logs`, which strips
the credential out of the rendered record. That is not decoration: the useful thing to
print when a child dies is the environment it was launched with, and that environment is
exactly where the API key lives.

Restarting the child is deliberately absent. InnyTypesHelper (plan 0003) owns restart
policy for every managed process in the application; a restart loop here would be a second
way to do the same thing, with its own backoff to disagree about.
"""

from __future__ import annotations

import subprocess
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any

import httpx

from innytypes.addons.manifest import StabilityProfile
from innytypes.anytype_mcp.config import ServerConfig
from innytypes.anytype_mcp.health import is_api_reachable
from innytypes.anytype_mcp.session import McpSession, SessionError
from innytypes.logs import get_logger, redact

log = get_logger(__name__)

# How often the host pings this child on its behalf, and therefore how often the helper is
# entitled to hear from it (plan 0010 slice 02).
#
# **It has to outlast the pass that reads it**, or a promise is judged missed before it could
# be kept. The supervision pass samples on `helper.tick`, 5 s today and a `config.toml`
# setting defaulting to **10 s** once plan 0010 slice 03 lands. Thirty seconds is three times
# the later number and six times the present one, so it is right on both sides of that change
# and stays right if somebody doubles the tick by hand.
#
# It also has to be short enough that silence means something before a person gives up. Three
# of these is the stale window — 90 s — so a wedged child is noticed within about a hundred
# seconds, against *never* today. The walkthrough measured about sixty seconds from a kill to
# a restart, so this is the same order of patience the application already asks for.
#
# And it has to be cheap, because the host pays it forever: two round trips a minute, on the
# pipes a `tools/call` already uses.
MCP_HEARTBEAT_INTERVAL = 30.0

# What the MCP child declares about how the helper should watch it, in the same shape a
# plugin's manifest declares (plan 0010). Published here, beside the code that owns the child,
# so the host's beat and the helper's table read **one** number and cannot drift apart.
#
# Every value is a decision about *this* child — a pinned Node process that translates
# JSON-RPC into HTTP calls against a desktop application on the same machine — rather than the
# "any plugin" defaults it inherited until now:
#
# * `heartbeat_interval` — see above. Declaring it at all is what makes staleness apply:
#   something that never promised heartbeats is never judged stale, and that is exactly the
#   hole this child was sitting in.
# * `stale_after` is deliberately **not named**, so the manifest's own rule decides it: three
#   missed beats, 90 s. Nothing about this child wants different arithmetic from every plugin,
#   and naming a window would be a second number to keep in step with the interval.
# * `max_rss_mb=512`, halved from 1024. The child holds one parsed OpenAPI document and one
#   request at a time; a Node process doing that sits in the tens of megabytes. Half a
#   gigabyte is roughly ten times any honest working set, so staying over it for longer than
#   the grace window is a leak rather than a busy moment — and the machine it leaks on is also
#   running the Anytype desktop app.
# * `max_cpu_percent=50`, down from 90. This child computes nothing; it forwards. Ninety
#   percent is the number a plugin that legitimately works — loads a model, indexes a corpus —
#   needs, and a forwarder averaging half a core across two whole minutes is spinning.
#   Averaged over `cpu_window`, even a burst of tool calls is nowhere near it.
# * `max_open_files=256`, down from 1024. A thousand descriptors is the shape of a server
#   accepting connections; this child accepts none — it has one client, on a pipe, for its
#   whole life, and one HTTP connection to Anytype. A quarter of the old number is still many
#   times any steady state, and a count climbing past it is descriptors to the desktop API
#   being leaked, which is the failure worth catching early.
# * `cpu_window` and `breach_grace` stay at the shared defaults on purpose: nothing about this
#   child makes two minutes the wrong averaging window or a minute the wrong grace, and
#   restating them would be two more numbers to keep in step for no gain.
# * `max_children` stays inherited, and that is a decision rather than an oversight. The
#   recorded process is `npx`, which runs the pinned package as a child of its own, and the
#   helper counts descendants recursively — so an honest limit depends on what the Node
#   runtime does on three operating systems, which nothing here has measured. A number nobody
#   can defend is worse than the helper-wide default.
# * `restartable=True`, written out rather than inherited by omission. The child holds no user
#   state: the host owns the only session to it and runs the whole handshake again on a fresh
#   one, and the desktop application it wraps is untouched by its death. Judging it stale
#   would be pointless if nothing could act on the verdict. *When* it comes back is still plan
#   0003's — the breaker quarantines a child that keeps wedging rather than restarting it
#   forever.
MCP_STABILITY = StabilityProfile(
    heartbeat_interval=MCP_HEARTBEAT_INTERVAL,
    max_rss_mb=512,
    max_cpu_percent=50,
    max_open_files=256,
    restartable=True,
)

# A spawn function: argv and environment in, a handle with wait/terminate out.
Spawn = Callable[[Sequence[str], dict[str, str]], "subprocess.Popen[bytes]"]
SessionFactory = Callable[[Any], McpSession]


def _default_spawn(argv: Sequence[str], env: dict[str, str]) -> subprocess.Popen[bytes]:
    """Launch the child with stdio pipes, which is how MCP servers are spoken to."""
    return subprocess.Popen(
        list(argv),
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        # The child may narrate startup and failures indefinitely. A pipe nobody drains
        # eventually blocks the process, so stderr follows the host instead of becoming a
        # third protocol stream.
        stderr=None,
    )


class SupervisorError(RuntimeError):
    """Raised on an illegal lifecycle transition, such as starting a running child."""


class ApiUnreachableError(SupervisorError):
    """Anytype's local API did not answer, so there is nothing for the server to wrap.

    Named rather than generic because the caller's response is specific: tell the user to
    start Anytype, not to reinstall the MCP server.
    """

    def __init__(self, api_base_url: str) -> None:
        # The message is built from the base URL alone — the key is never part of it. It
        # still goes through the redactor, because ``ANYTYPE_API_BASE_URL`` is
        # user-supplied: a credential embedded in that URL would otherwise ride out in an
        # exception message that every caller is free to log.
        super().__init__(
            redact(
                f"Anytype's local API did not answer at {api_base_url}; "
                "start the Anytype desktop app, or point ANYTYPE_API_BASE_URL at it"
            )
        )


@dataclass
class Supervisor:
    """Owns the lifecycle of exactly one Node MCP server process."""

    config: ServerConfig
    spawn: Spawn = _default_spawn
    # Injected exactly like the client :func:`is_api_reachable` already takes, so the start
    # gate is exercised without anything listening on port 31009. ``None`` means the health
    # check opens its own short-lived client, which is what production does.
    health_client: httpx.Client | None = None
    session_factory: SessionFactory | None = None
    _process: subprocess.Popen[bytes] | None = None
    _session: McpSession | None = None

    def command(self) -> list[str]:
        """The argv for the child: npx, non-interactive, at the exact pinned version.

        ``-y`` suppresses the install prompt; the version is pinned in the spec itself so
        a cached floating install can never be what actually runs.
        """
        return ["npx", "-y", self.config.package_spec]

    @property
    def is_running(self) -> bool:
        """True while the child exists and has not exited."""
        return self._process is not None and self._process.poll() is None

    @property
    def session(self) -> McpSession | None:
        """The validated live session, absent until protocol initialization succeeds."""
        return self._session

    def start(self) -> subprocess.Popen[bytes]:
        """Launch the server, once, and only when Anytype is actually there."""
        if self.is_running:
            raise SupervisorError("server is already running; stop it before starting again")

        # The health gate comes before the spawn, so an absent desktop app is reported once,
        # here, instead of as a tool call that times out somewhere far away much later.
        if not is_api_reachable(self.config, client=self.health_client):
            raise ApiUnreachableError(self.config.api_base_url)

        log.info("starting %s against %s", self.config.package_spec, self.config.api_base_url)
        self._process = self.spawn(self.command(), self.config.environment())
        if self.session_factory is not None:
            try:
                session = self.session_factory(self._process)
                session.initialize()
            except (SessionError, OSError, ValueError) as error:
                process = self._process
                self._process = None
                if process.poll() is None:
                    process.terminate()
                    process.wait()
                raise SupervisorError(
                    f"the Anytype MCP child could not initialize: {error}"
                ) from error
            self._session = session
        return self._process

    def stop(self, timeout: float = 5.0) -> int | None:
        """Terminate the child, escalating to a kill if it does not go quietly.

        Returns its exit code, or None when there was nothing to stop.
        """
        process = self._process
        if process is None:
            return None

        if self._session is not None:
            self._session.close()
            self._session = None

        # Asked before we touch it: a child that has already gone died on its own, which is
        # a different event from one we are about to terminate, and reads differently in a
        # log. This is a report, not a restart — plan 0003 decides what to do about it.
        died_on_its_own = process.poll() is not None

        log.info("stopping %s", self.config.package_spec)
        if not died_on_its_own:
            process.terminate()
            try:
                process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                # A server wedged mid-request would otherwise hold up host shutdown.
                process.kill()
                process.wait()

        self._process = None
        self._report_exit(process.returncode, unexpected=died_on_its_own)
        return process.returncode

    def child_exited(self) -> None:
        """Release protocol state after the generic supervisor observes child death."""
        if self._session is not None:
            self._session.close()
            self._session = None
        self._process = None

    def _launch_environment(self) -> dict[str, str]:
        """Only the variables this module sets for the child, never the inherited ones.

        The child also receives PATH and everything else the host was started with, and
        none of that belongs in a log: the user's own environment is full of credentials
        that have nothing to do with Anytype, and redaction cannot help with secrets this
        package has never been shown.
        """
        return self.config.environment(base={})

    def _report_exit(self, returncode: int | None, *, unexpected: bool) -> None:
        """Report the child's exit, and for an unexpected one, what it was launched with.

        A child we terminated ourselves needs no diagnosis. A child that died on its own is
        almost always a wrong base URL, a stale ``Anytype-Version`` or a credential the
        desktop app has since revoked, and none of those can be read off an exit code. So
        that case — and only that case — prints the configuration the child really got, and
        the redactor is what makes printing it safe. Confining it to that case also keeps
        credential-shaped material out of every routine shutdown, which is a much smaller
        blast radius on the day the redactor regresses.

        Formatted as ``name=value`` rather than with ``repr``: a repr escapes its string,
        and an escaped credential is one an exact-match redactor no longer recognises.
        """
        if not unexpected:
            log.info("%s exited with code %s", self.config.package_spec, returncode)
            return

        overlay = ", ".join(f"{name}={value}" for name, value in self._launch_environment().items())
        log.warning(
            "%s exited on its own with code %s; it was launched as `%s` with %s",
            self.config.package_spec,
            returncode,
            " ".join(self.command()),
            overlay,
        )
