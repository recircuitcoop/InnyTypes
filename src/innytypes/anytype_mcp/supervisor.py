"""Starting and stopping the Node MCP server as a child process.

The supervisor owns one child: ``npx -y @anyproto/anytype-mcp@<pinned> ``. It speaks MCP
over stdio, so the pipes are wired but not interpreted here — exposing that stream to
addons through the host API is plan 0002, slice 05.

The spawn call is injected rather than hard-wired to :mod:`subprocess`, so the argv and
environment this module builds can be asserted on a machine where Node is not installed.
That is what keeps the gate hermetic.
"""

from __future__ import annotations

import subprocess
from collections.abc import Callable, Sequence
from dataclasses import dataclass

from innytypes.anytype_mcp.config import ServerConfig

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


@dataclass
class Supervisor:
    """Owns the lifecycle of exactly one Node MCP server process."""

    config: ServerConfig
    spawn: Spawn = _default_spawn
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
        """Launch the server. Refuses to start a second child over a live one."""
        if self.is_running:
            raise SupervisorError("server is already running; stop it before starting again")

        self._process = self.spawn(self.command(), self.config.environment())
        return self._process

    def stop(self, timeout: float = 5.0) -> int | None:
        """Terminate the child, escalating to a kill if it does not go quietly.

        Returns its exit code, or None when there was nothing to stop.
        """
        process = self._process
        if process is None:
            return None

        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                # A server wedged mid-request would otherwise hold up host shutdown.
                process.kill()
                process.wait()

        self._process = None
        return process.returncode
