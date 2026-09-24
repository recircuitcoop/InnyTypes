"""The home guard, seen failing: a guard nobody has watched fail is not a guard.

Each proof runs a whole pytest session of its own, in a child process, with this suite's
real ``conftest.py`` and ``home_guard.py`` copied in beside a test that writes somewhere it
must not. The session is asserted to fail that test, and a test that writes only where it may
is asserted to pass in the same session, so the guard is shown to tell the two apart rather
than to fail everything.

`pytester` points ``HOME`` at a directory of its own before the child starts, so the "real"
home the child's guard protects is that directory and not this machine's. Nothing here can
touch the per-user directories of whoever runs the suite, even when a proof goes wrong.
"""

from __future__ import annotations

import dataclasses
from pathlib import Path
from types import ModuleType

import platformdirs
import pytest

from innytypes.helper import breaker, launcher, linux, macos, notification

TESTS = Path(__file__).parent


def guarded_session(pytester: pytest.Pytester, body: str) -> pytest.RunResult:
    """Run ``body`` as a test module under this suite's own conftest and guard."""
    pytester.makeconftest((TESTS / "conftest.py").read_text(encoding="utf-8"))
    pytester.makepyfile(home_guard=(TESTS / "home_guard.py").read_text(encoding="utf-8"))
    pytester.makepyfile(test_leaks=body)
    return pytester.runpytest_subprocess("-p", "no:cacheprovider", "-rA")


def test_writing_into_the_real_runtime_and_log_directories_fails_and_writes_nothing(
    pytester: pytest.Pytester,
) -> None:
    """A path spelled out in full is refused before it reaches the disk, and fails the test.

    The runtime directory is where the live helper keeps its sockets, run state and notices,
    and the log directory is where slice 04's log is appended to; both are named here as the
    child will see them, before its guard moves the home. One of the two writes is wrapped in
    the ``except Exception`` a careless caller might use, which must not save it: the refusal
    is recorded as well as raised.
    """
    runtime = platformdirs.user_runtime_path("innytypes", appauthor=False)
    log = platformdirs.user_log_path("innytypes", appauthor=False)
    result = guarded_session(
        pytester,
        f"""
        from pathlib import Path

        def test_writes_notices_into_the_real_runtime_directory():
            path = Path({str(runtime)!r}) / "notices.json"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("[]")

        def test_writes_the_log_and_swallows_what_went_wrong():
            path = Path({str(log)!r}) / "innytypes.log"
            try:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("a line")
            except Exception:
                pass

        def test_writes_only_into_its_own_tmp_path(tmp_path):
            (tmp_path / "notices.json").write_text("[]")
        """,
    )

    result.assert_outcomes(passed=2, failed=1, errors=2)
    result.stdout.fnmatch_lines(
        [
            "PASSED test_leaks.py::test_writes_only_into_its_own_tmp_path",
            "ERROR test_leaks.py::test_writes_notices_into_the_real_runtime_directory*",
            "ERROR test_leaks.py::test_writes_the_log_and_swallows_what_went_wrong*",
            "FAILED test_leaks.py::test_writes_notices_into_the_real_runtime_directory*",
        ]
    )
    result.stdout.fnmatch_lines([f"*refused: os.mkdir {log}*"])
    # Refused before the filesystem was reached, not cleaned up after it.
    assert not runtime.exists()
    assert not log.exists()


def test_writing_where_production_code_looks_fails_even_from_a_child_process(
    pytester: pytest.Pytester,
) -> None:
    """The ordinary way to leak — calling production code with its defaults — fails the test.

    These write through the application's own path functions, which is how both leaks this
    guard was built for happened: the notices file through :class:`NoticeFile`'s default and
    the MCP token through :func:`load_or_create_proxy_token`'s. They land in the scratch home
    and are found there. The last one does the same from a separate process, which inherits
    the scratch home and so is caught by what it leaves on disk.
    """
    result = guarded_session(
        pytester,
        """
        import subprocess
        import sys

        from innytypes.anytype_mcp.gateway import load_or_create_proxy_token
        from innytypes.helper.notification import NoticeFile

        def test_writes_notices_where_the_helper_keeps_them():
            NoticeFile().write([])

        def test_creates_the_mcp_token_where_the_host_keeps_it():
            load_or_create_proxy_token()

        def test_a_child_process_writes_the_quarantine_file():
            subprocess.run(
                [sys.executable, "-c", "from innytypes.helper.breaker import QuarantineFile; "
                 "QuarantineFile().path.parent.mkdir(parents=True, exist_ok=True); "
                 "QuarantineFile().path.write_text('{}')"],
                check=True,
            )

        def test_reads_nothing_and_writes_nothing():
            assert NoticeFile().read() == ()
        """,
    )

    result.assert_outcomes(passed=4, errors=3)
    result.stdout.fnmatch_lines(
        [
            "*written: ~/*/notices.json",
            "*written: ~/.config/innytypes/mcp_proxy_token",
            "*written: ~/*/quarantine.json",
        ]
    )


# --- the trap the first leak came through ------------------------------------------------------


@pytest.mark.parametrize(
    ("module", "record", "field_name", "helper"),
    [
        (notification, "NoticeFile", "path", "default_notices_path"),
        (breaker, "QuarantineFile", "path", "default_quarantine_path"),
        (launcher, "QuitFile", "path", "default_quit_path"),
        (macos, "MacLoginItem", "directory", "default_launch_agents_directory"),
        (linux, "LinuxLoginItem", "directory", "default_autostart_directory"),
    ],
)
def test_a_record_left_at_its_default_path_follows_the_module_it_is_patched_on(
    module: ModuleType, record: str, field_name: str, helper: str, tmp_path: Path
) -> None:
    """Patching a path helper on its module moves the default of every record that uses it.

    Each of these records defaults a field to one of its module's path helpers. Named directly
    as a ``default_factory``, the helper is bound when the class is defined, so a test that
    patches the module — the way every redirection in ``conftest.py`` is done — changes nothing
    and the record goes on writing into the real per-user directory. That is how the first
    notices file got there. The field's own factory is what is called, so the two records
    that need other arguments to be built are asked the same question as the three that do not.
    """
    (default,) = (
        entry for entry in dataclasses.fields(getattr(module, record)) if entry.name == field_name
    )
    elsewhere = tmp_path / "elsewhere"
    with pytest.MonkeyPatch.context() as patched:
        patched.setattr(module, helper, lambda: elsewhere)
        assert default.default_factory() == elsewhere  # type: ignore[misc]
