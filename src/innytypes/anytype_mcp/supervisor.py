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

Everything this module logs goes through :mod:`innytypes.anytype_mcp.logs`, which strips
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

import httpx

from innytypes.anytype_mcp.config import ServerConfig
from innytypes.anytype_mcp.health import is_api_reachable
from innytypes.anytype_mcp.logs import get_logger, redact

log = get_logger(__name__)

# A spawn function: argv and environment in, a handle with wait/terminate out.
Spawn = Callable[[Sequence[str], dict[str, str]], "subprocess.Popen[bytes]"]


def _default_spawn(argv: Sequence[str], env: dict[str, str]) -> subprocess.Popen[bytes]:
    """Launch the child with stdio pipes, which is how MCP servers are spoken to."""
    return subprocess.Popen(
        list(argv),
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
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
    _process: subprocess.Popen[bytes] | None = None

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
        return self._process

    def stop(self, timeout: float = 5.0) -> int | None:
        """Terminate the child, escalating to a kill if it does not go quietly.

        Returns its exit code, or None when there was nothing to stop.
        """
        process = self._process
        if process is None:
            return None

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
