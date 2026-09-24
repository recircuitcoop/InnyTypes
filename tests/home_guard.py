"""The suite's own home directory: no test can reach this user's, and one that tries fails.

A test that writes into the real per-user directories is not hermetic, and on the machine of
somebody who runs InnyTypes it is writing next to a *live* helper — into the directory whose
sockets, run state and notices that helper is using. It was twice found only by chance, months
apart, from a file that should not have been there (plan 0012, slice 05). This module makes
the next one fail the suite instead. It is imported by ``conftest.py`` before anything imports
:mod:`innytypes`, and does two independent things:

* **Everything that finds a per-user directory finds a scratch one.** ``HOME`` — and the XDG
  variables and ``USERPROFILE``, which stand in for it elsewhere — point into a directory made
  for this session. That is where `platformdirs`, :meth:`pathlib.Path.home` and ``~`` all look,
  so it is where every production path resolves, in this process and in every child a test
  starts with the environment it inherited. Nothing a test does can land in the real directories
  that way, and the fixture in ``conftest.py`` fails any test after which this scratch home is
  not empty: a leak is *observed on disk*, not predicted from a list of functions that write.
* **The real directories are closed to this process.** They are worked out first, while
  ``HOME`` is still this user's, and an audit hook (:func:`sys.addaudithook`) refuses every
  write-shaped operation on a path inside them — before it reaches the filesystem — and records
  it, so a test fails even if the code under test swallows the refusal. This catches the one
  thing redirection cannot: a path spelled out, or captured before the redirection happened.

What it cannot see, said plainly: a child process started with an environment built from
nothing, which falls back to the account database for its home directory. Such a child is
outside both halves.
"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
from pathlib import Path

import platformdirs

APPLICATION_NAME = "innytypes"

if APPLICATION_NAME in sys.modules:
    # Module-level paths in the application — `CREDENTIALS_DIRECTORY`, `DEFAULT_KEY_FILE` — are
    # computed on import. Imported before the redirection below, they would point at the real
    # home for the rest of the session, and this guard would be quietly half of itself.
    raise RuntimeError(
        "innytypes was imported before the suite's home guard; import `home_guard` first"
    )


class WriteToRealDirectory(RuntimeError):
    """A test tried to change something in this user's real per-user directories.

    Not an :class:`OSError`, so production code that handles a failed write — as most of it
    does — cannot mistake this for one and carry on.
    """


def _real_roots() -> tuple[Path, ...]:
    """Every per-user location the application writes to, as this user's account has them."""
    home = Path.home()
    per_user = {
        find(APPLICATION_NAME, appauthor=False)
        for find in (
            platformdirs.user_runtime_path,
            platformdirs.user_data_path,
            platformdirs.user_config_path,
            platformdirs.user_cache_path,
            platformdirs.user_state_path,
            platformdirs.user_log_path,
        )
    }
    others = {
        # `innytypes.addons.secrets.CREDENTIALS_DIRECTORY`: the API key and the MCP token.
        home / ".config" / APPLICATION_NAME,
        # Where the helper registers itself to start at login, on macOS and on Linux.
        home / "Library" / "LaunchAgents",
        home / ".config" / "autostart",
    }
    return tuple(sorted(per_user | others))


#: Worked out while ``HOME`` is still the real one — which is the point of them.
REAL_ROOTS = _real_roots()
_REAL_PREFIXES = tuple(
    sorted({str(root) for root in REAL_ROOTS} | {str(root.resolve()) for root in REAL_ROOTS})
)

#: Names the scratch home to any process started from this one.
SANDBOX_VARIABLE = "INNYTYPES_TEST_HOME"

# A process a test starts that imports this suite again — a `multiprocessing` child unpickling
# a test module's function does — inherits a scratch home that is already set up, and uses it
# rather than making one of its own that nothing would remove. Only while `HOME` still points
# at it: `pytester` moves `HOME` for the session it runs, and that session gets its own.
_inherited = os.environ.get(SANDBOX_VARIABLE)
_OWNED = not (_inherited and os.environ.get("HOME") == _inherited)

#: The home every test runs in. Made fresh for the session and removed when it ends.
SANDBOX_HOME = (
    Path(tempfile.mkdtemp(prefix="inny-home-")).resolve() if _OWNED else Path(str(_inherited))
)

os.environ[SANDBOX_VARIABLE] = str(SANDBOX_HOME)
os.environ["HOME"] = str(SANDBOX_HOME)
os.environ["USERPROFILE"] = str(SANDBOX_HOME)
os.environ["XDG_CONFIG_HOME"] = str(SANDBOX_HOME / ".config")
os.environ["XDG_DATA_HOME"] = str(SANDBOX_HOME / ".local" / "share")
os.environ["XDG_STATE_HOME"] = str(SANDBOX_HOME / ".local" / "state")
os.environ["XDG_CACHE_HOME"] = str(SANDBOX_HOME / ".cache")
os.environ["XDG_RUNTIME_DIR"] = str(SANDBOX_HOME / "run")

_blocked: list[str] = []

_WRITE_FLAGS = os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND
_PATH_EVENTS = frozenset(
    {"os.mkdir", "os.remove", "os.rmdir", "os.chmod", "os.chown", "os.truncate", "os.utime"}
)
_TWO_PATH_EVENTS = frozenset({"os.rename", "os.link", "os.symlink"})


def _inside_a_real_root(target: object) -> str | None:
    if isinstance(target, bytes):
        target = os.fsdecode(target)
    if not isinstance(target, str | os.PathLike):
        return None
    path = os.path.abspath(target)
    for prefix in _REAL_PREFIXES:
        if path == prefix or path.startswith(prefix + os.sep):
            return path
    return None


def _targets(event: str, args: tuple[object, ...]) -> tuple[object, ...]:
    """The paths an audit event would change, or nothing when it changes none."""
    if event == "open":
        _path, mode, flags = args
        writing = isinstance(mode, str) and any(letter in mode for letter in "wax+")
        # `os.open` reports no mode, only the flags it was given.
        if mode is None and isinstance(flags, int):
            writing = bool(flags & _WRITE_FLAGS)
        return (args[0],) if writing else ()
    if event in _PATH_EVENTS:
        return (args[0],)
    if event in _TWO_PATH_EVENTS:
        return (args[0], args[1])
    if event == "socket.bind" and isinstance(args[1], str | bytes):
        return (args[1],)
    return ()


def _refuse_real_writes(event: str, args: tuple[object, ...]) -> None:
    for target in _targets(event, args):
        path = _inside_a_real_root(target)
        if path is None:
            continue
        _blocked.append(f"{event} {path}")
        raise WriteToRealDirectory(f"a test tried to {event} {path}, in this user's real home")


sys.addaudithook(_refuse_real_writes)


def collect_leaks() -> list[str]:
    """Everything written into a home since the last call, then forgotten so it is told once.

    The refusals the audit hook recorded, and every entry the scratch home now holds. The
    scratch home is emptied afterwards, so one leaking test fails and the next starts clean.
    """
    leaks = [f"refused: {entry}" for entry in _blocked]
    _blocked.clear()
    for entry in sorted(SANDBOX_HOME.iterdir()):
        leaks.extend(
            f"written: ~/{path.relative_to(SANDBOX_HOME)}"
            for path in sorted([entry, *entry.rglob("*")])
            if not path.is_dir() or not any(path.iterdir())
        )
        if entry.is_dir() and not entry.is_symlink():
            shutil.rmtree(entry, ignore_errors=True)
        else:
            entry.unlink(missing_ok=True)
    return leaks


def remove_sandbox() -> None:
    """Remove the scratch home when the session ends — if this process is the one that made it."""
    if _OWNED:
        shutil.rmtree(SANDBOX_HOME, ignore_errors=True)
