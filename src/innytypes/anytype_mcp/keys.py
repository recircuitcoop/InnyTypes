"""Obtaining the Anytype API key on first run, and storing it where only its owner can read it.

Plan 0002 says the key belongs in ``$ANYTYPE_API_KEY`` or in
``~/.config/innytypes/anytype_api_key``, and :mod:`innytypes.anytype_mcp.config` reads it
from there. This module is the other half: getting a key in the first place, and putting it
in that file correctly. Leaving that to the user is how a credential ends up pasted into a
shell history, a note, or — eventually — a file inside the repository. Making the correct
thing the easy thing is how the host discharges its part of invariant 7.

The wrapped command is the pinned one, ``npx -y @anyproto/anytype-mcp@<pinned> get-key``.
That command is interactive: it asks Anytype for a challenge, the desktop app shows a
four-digit code, and the user types it. So the child keeps **stdin**, which is how the user
answers, while **stdout and stderr are captured** — because that is where the pinned
version prints ``Your API KEY: …`` and an example settings block containing the same key
inside a ``Bearer`` header. Captured, the key goes into the key file; inherited, it would
go onto the user's terminal and into their scrollback.

Three properties are load-bearing here, and each has a test that fails when it is removed:

* **The runner is injected**, exactly as ``Supervisor.spawn`` is, so the gate asserts the
  argv without Node installed and without Anytype running.
* **The key file is created 0600**, by ``os.open`` with that mode rather than by a later
  ``chmod`` — a file that is briefly world-readable is a file that was readable.
* **Nothing here renders the credential.** It is registered with the package redactor the
  moment it is read, no error message repeats the child's output, and the one structure
  that carries the output declares ``repr=False``, as plan 0002 requires of every new
  structure that touches the key.
"""

from __future__ import annotations

import os
import re
import subprocess
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path

from innytypes.anytype_mcp.config import (
    DEFAULT_API_BASE_URL,
    DEFAULT_KEY_FILE,
    PACKAGE_NAME,
    PACKAGE_VERSION,
    ConfigError,
)
from innytypes.logs import get_logger, protect

log = get_logger(__name__)

# The subcommand of the pinned package that walks Anytype's challenge/authorise flow.
GET_KEY_SUBCOMMAND = "get-key"

# Owner-only, for the file and for the directory this module creates around it.
KEY_FILE_MODE = 0o600
KEY_DIRECTORY_MODE = 0o700

# How the pinned ``@anyproto/anytype-mcp`` announces the key it just obtained (see
# ``src/auth/get-key.ts`` in the tarball of :data:`~innytypes.anytype_mcp.config.PACKAGE_VERSION`).
# Tied to that pin on purpose: bumping it is a dependency upgrade, and re-reading this line
# against the new release is part of the procedure. The version is deliberately NOT spelled
# out here — plan 0002 names the four files a version lives in, and a literal in a comment
# nobody updates would be a fifth that goes stale in silence.
_KEY_LINE = re.compile(r"^\s*Your API KEY:\s*(\S+)\s*$", re.IGNORECASE | re.MULTILINE)

# What an Anytype API key may consist of. Conservative rather than clever: anything with a
# space, a newline or a quote in it is a sentence about a key, not a key.
_KEY_SHAPE = re.compile(r"[A-Za-z0-9._~+/=-]{8,}")


class KeyAcquisitionError(ConfigError):
    """First-run key acquisition failed.

    A :class:`~innytypes.anytype_mcp.config.ConfigError`, so a caller that already handles
    "this server cannot be configured" handles these without knowing they exist.

    **No subclass ever carries the credential.** The child prints the key to stdout, so any
    message quoting that output would carry it into whatever log the caller keeps. The
    messages below therefore name the exit code, the command and the file — never a byte
    the child produced.
    """


class GetKeyUnavailableError(KeyAcquisitionError):
    """``npx`` is not on PATH, so the pinned package cannot be run at all."""


class GetKeyFailedError(KeyAcquisitionError):
    """``get-key`` ran and exited non-zero — no Anytype, or the wrong four-digit code."""


class UnusableKeyError(KeyAcquisitionError):
    """``get-key`` succeeded but produced nothing that is a key."""


class KeyFileExistsError(KeyAcquisitionError):
    """A key file is already there, and replacing it was not explicitly asked for."""


@dataclass(frozen=True)
class GetKeyResult:
    """What one run of ``get-key`` produced.

    ``stdout`` holds the credential on a successful run, so both streams are ``repr=False``
    for the same reason :class:`~innytypes.anytype_mcp.config.ServerConfig` hides its key:
    a structure that carries a credential must not print one when something logs it.
    """

    returncode: int
    stdout: str = field(repr=False, default="")
    stderr: str = field(repr=False, default="")


# A runner: argv and environment in, the child's exit code and captured output out.
GetKeyRunner = Callable[[Sequence[str], Mapping[str, str]], GetKeyResult]


def _default_run_get_key(argv: Sequence[str], env: Mapping[str, str]) -> GetKeyResult:
    """Run ``get-key`` for real: the user's stdin, our pipes on stdout and stderr.

    ``check=False`` is deliberate. ``subprocess.run(check=True)`` raises a
    ``CalledProcessError`` that holds the captured output — which, on a partially
    successful run, is the credential — and that exception would be rendered by any caller
    logging a traceback. The return code is inspected by hand instead.
    """
    completed = subprocess.run(  # noqa: S603 - argv is built here, never from user input
        list(argv),
        env=dict(env),
        # stdin is inherited: the four-digit code Anytype displays is typed by the user
        # into this same terminal, and there is nobody else who could answer that prompt.
        stdin=None,
        capture_output=True,
        text=True,
        check=False,
    )
    return GetKeyResult(completed.returncode, completed.stdout, completed.stderr)


def get_key_command(package_version: str = PACKAGE_VERSION) -> list[str]:
    """The argv for key acquisition: npx, non-interactive install, the exact pinned spec.

    The version is pinned in the spec itself, so a cached floating install can never be
    what actually issues the challenge — a key minted by a different server version is a
    key for a tool surface the host has never tested against.
    """
    return ["npx", "-y", f"{PACKAGE_NAME}@{package_version}", GET_KEY_SUBCOMMAND]


def get_key_environment(
    api_base_url: str = DEFAULT_API_BASE_URL,
    base: Mapping[str, str] | None = None,
) -> dict[str, str]:
    """The child's environment: ``base`` plus the base URL it must authenticate against.

    ``base`` defaults to the current environment so the child keeps PATH and can find node.
    No credential is added — there is not one yet, which is the entire point of the call.
    """
    env = dict(os.environ if base is None else base)
    env["ANYTYPE_API_BASE_URL"] = api_base_url
    return env


def extract_api_key(output: str) -> str:
    """The key inside ``get-key``'s output, or :class:`UnusableKeyError`.

    Neither the output nor the rejected candidate appears in the error: on a run that got
    far enough to print something, that text is exactly what must not be repeated.
    """
    match = _KEY_LINE.search(output)
    candidate = match.group(1) if match else output.strip()

    if not candidate:
        raise UnusableKeyError(
            f"`{GET_KEY_SUBCOMMAND}` printed nothing to read a key from; nothing was stored"
        )

    if not _KEY_SHAPE.fullmatch(candidate):
        # Length, not content: enough to tell "it printed an error page" from "it printed
        # almost nothing", and useless to anyone who gets hold of the message.
        raise UnusableKeyError(
            f"`{GET_KEY_SUBCOMMAND}` produced {len(output)} characters with no API key in "
            "them; nothing was stored"
        )

    return candidate


def run_get_key(
    runner: GetKeyRunner = _default_run_get_key,
    *,
    package_version: str = PACKAGE_VERSION,
    api_base_url: str = DEFAULT_API_BASE_URL,
) -> str:
    """Run the pinned ``get-key`` and return the key it produced.

    The key is registered with the package redactor before this function returns, so
    anything that later renders it through one of this package's loggers prints
    ``[redacted]`` instead.
    """
    argv = get_key_command(package_version)

    # The argv carries no credential — there is none yet — so it is safe to log whole, and
    # useful: "which command did it actually run" is the first question when this fails.
    log.info("running `%s` against %s", " ".join(argv), api_base_url)

    try:
        result = runner(argv, get_key_environment(api_base_url))
    except FileNotFoundError as error:
        # Raised by exec, before the child exists, so nothing it could have printed exists
        # either and chaining the original cannot expose anything.
        raise GetKeyUnavailableError(
            f"could not run `{' '.join(argv)}`: npx was not found. "
            "Install Node.js, or create a key in Anytype under App Settings -> API Keys."
        ) from error

    if result.returncode != 0:
        raise GetKeyFailedError(
            f"`{GET_KEY_SUBCOMMAND}` exited with code {result.returncode}; check that the "
            "Anytype desktop app is running and that the four-digit code was entered "
            "correctly. Its output is not repeated here: it can contain the key."
        )

    api_key = extract_api_key(result.stdout)

    # Registered first, logged second. From here on the credential is one this package's
    # loggers know to remove, which is what makes every later log line safe by default.
    protect(api_key)
    log.info("obtained an Anytype API key from `%s`", GET_KEY_SUBCOMMAND)
    return api_key


def _ensure_private_directory(directory: Path) -> None:
    """Create ``directory`` owner-only, and leave an existing one exactly as it was.

    The directory this module creates is its own (``~/.config/innytypes``), and it gets
    0700. A directory that already exists belongs to somebody else's decision —
    ``~/.config`` is normally group- and world-readable, and silently tightening it would
    be a surprising thing for a key-storing helper to do to a user's home directory.
    """
    try:
        directory.mkdir(parents=True, mode=KEY_DIRECTORY_MODE, exist_ok=False)
    except FileExistsError:
        return

    # mkdir's mode is filtered through the process umask, which can only remove bits but
    # can remove the owner's own. Set it again so the result does not depend on a umask.
    os.chmod(directory, KEY_DIRECTORY_MODE)


def store_api_key(
    api_key: str,
    key_file: Path | None = None,
    *,
    force: bool = False,
) -> Path:
    """Write ``api_key`` to the key file with owner-only permissions, and return its path.

    Refuses to replace an existing file unless ``force`` is given. The refusal is the
    ``O_EXCL`` in the open itself rather than a prior ``exists()`` check, so two runs
    racing cannot both decide the file was absent.
    """
    key = api_key.strip()
    if not key:
        # An empty key file reads as a configured host that 401s on every call, which is a
        # much harder thing to diagnose than a missing file.
        raise UnusableKeyError("refusing to store an empty API key")

    # The credential is about to live in a file this process opened; from here on, anything
    # in this package that renders it prints [redacted].
    protect(key)

    path = DEFAULT_KEY_FILE if key_file is None else key_file
    _ensure_private_directory(path.parent)

    # O_NOFOLLOW: never write a credential *through* a symlink. Without it, `--force` on a
    # key path somebody had replaced with a link would write the key wherever that link
    # points — and then chmod that file — which is the cheapest way to get a key out of an
    # owner-only directory. O_EXCL already refuses a symlink on the non-forced path.
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW
    if not force:
        flags |= os.O_EXCL

    try:
        descriptor = os.open(path, flags, KEY_FILE_MODE)
    except FileExistsError:
        # `from None`: FileExistsError names the path, which is also in this message, and
        # the chained traceback would add nothing but noise to a deliberate refusal.
        raise KeyFileExistsError(
            f"{path} already exists; pass --force to replace the key in it"
        ) from None
    except OSError as error:
        # A symlinked path (ELOOP), an unwritable directory, a full disk. The OS message
        # describes the file, never its contents, so repeating it here is safe.
        raise KeyAcquisitionError(
            f"could not open {path} to write the key: {error.strerror}"
        ) from None

    with os.fdopen(descriptor, "wb") as handle:
        # The mode argument of os.open applies only when the file is created, so a forced
        # overwrite of a world-readable file would otherwise keep that file's old mode.
        os.fchmod(descriptor, KEY_FILE_MODE)
        handle.write(key.encode("utf-8"))

    log.info("stored the Anytype API key in %s with mode %o", path, KEY_FILE_MODE)
    return path


def acquire_api_key(
    runner: GetKeyRunner = _default_run_get_key,
    *,
    key_file: Path | None = None,
    force: bool = False,
    package_version: str = PACKAGE_VERSION,
    api_base_url: str = DEFAULT_API_BASE_URL,
) -> Path:
    """The whole first run: obtain a key with ``get-key`` and store it. Returns its path.

    Never returns the key, and never prints it: the only place it lands is the file.
    """
    path = DEFAULT_KEY_FILE if key_file is None else key_file

    # Checked before the flow starts as well as during the write. `store_api_key` is what
    # makes the refusal race-free; this one is what stops a user walking through Anytype's
    # challenge, typing a code, and only then being told the result cannot be kept.
    if path.exists() and not force:
        raise KeyFileExistsError(f"{path} already exists; pass --force to replace the key in it")

    api_key = run_get_key(runner, package_version=package_version, api_base_url=api_base_url)
    return store_api_key(api_key, path, force=force)
