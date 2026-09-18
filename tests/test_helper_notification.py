"""Telling the user: the five conditions, the words, the once-only rule, and the OS seam.

Nothing here posts a notification, opens a socket or starts a process. The notifier is injected
everywhere — :class:`RecordingNotifier` for the behaviour, a recording runner for the macOS one —
which is how the gate can assert what macOS *would* have been asked to do without asking it.
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

import pytest
from click.testing import CliRunner

from innytypes.cli import cli
from innytypes.helper import notification
from innytypes.helper.breaker import HOST_ID, QuarantineFile, default_quarantine_path
from innytypes.helper.config import (
    HelperConfig,
    PluginOverride,
    PluginSettings,
    UpdateMode,
)
from innytypes.helper.notification import (
    MACOS_SCRIPT,
    NOTICES_FILENAME,
    Announcer,
    MacNotifier,
    Message,
    Notice,
    NoticeFile,
    NoticeKind,
    RecordingNotifier,
    UnsupportedPlatform,
    compose,
    current_notices,
    default_notices_path,
    notifier_for,
)
from innytypes.helper.swap import ReadyRelease, ReleaseConfirmation
from innytypes.helper.update import Version
from innytypes.helper.versions import (
    ConsistencyRule,
    PluginReport,
    PluginState,
    TargetSet,
    VersionCheck,
)

# A reason a person could really see, and one that would end a shell command, close an
# AppleScript string and start a new statement if any of this were ever built into a script.
NASTY_REASON = 'pid 4242 exited: "$(touch /tmp/pwned)"; `id` & rm -rf ~'


@pytest.fixture
def notifier() -> RecordingNotifier:
    return RecordingNotifier()


def staged_release(
    version: str = "1.5.0",
    *,
    automatic: bool = True,
    blocked_reason: str = "",
) -> ReadyRelease:
    """A release sitting in staging, as slice 09 leaves one for the next quit."""
    major, minor, patch = (int(part) for part in version.split("."))
    root = Path("/does/not/exist/staging")
    return ReadyRelease(
        version=Version(major, minor, patch),
        host_api=1,
        platform="macos",
        directory=root,
        artifact_path=root / f"innytypes-{version}-macos.tar.gz",
        sha256="0" * 64,
        signature="untrusted comment: fake\nRWQ=\n",
        automatic=automatic,
        blocked_reason=blocked_reason,
    )


def blocked_report(
    plugin_id: str,
    *,
    rule: ConsistencyRule,
    reason: str,
    installed: str = "1.0.0",
    newest: str = "2.0.0",
) -> PluginReport:
    """One plugin line the version check produced: a newer version the rules refuse to take."""
    return PluginReport(
        id=plugin_id,
        installed_version=installed,
        state=PluginState.BLOCKED,
        target_version=installed,
        newest_version=newest,
        rule=rule,
        reason=reason,
    )


def check_with(*reports: PluginReport) -> VersionCheck:
    """A version check that answered, carrying only the lines a test cares about."""
    return VersionCheck(checked=True, target=TargetSet(plugins=()), reports=reports)


# ── one notification per event kind ──────────────────────────────────────────────────────────


def test_a_quarantined_process_raises_exactly_one_notification(
    notifier: RecordingNotifier,
) -> None:
    announcer = Announcer(notifier=notifier)

    announcer.announce(current_notices(quarantines={"monty": "exited with code 1 five times"}))

    assert len(notifier.posted) == 1
    message = notifier.posted[0]
    assert message.notice.kind is NoticeKind.PROCESS_QUARANTINED
    assert message.title == "InnyTypes stopped restarting monty"
    assert "exited with code 1 five times" in message.body
    # The one thing a person can do about it is in the words they are shown.
    assert "innytypes helper release monty" in message.body


def test_a_rolled_back_update_names_the_update_that_rolled_back(
    notifier: RecordingNotifier,
) -> None:
    announcer = Announcer(notifier=notifier)
    rollback = ReleaseConfirmation(
        version="1.5.0",
        confirmed=False,
        rolled_back_to="1.4.0",
        blocked="1.5.0",
        restarted=True,
        reason="1.5.0 sent no healthy heartbeat within 120 seconds",
    )

    announcer.announce(current_notices(rollback=rollback))

    assert len(notifier.posted) == 1
    message = notifier.posted[0]
    assert message.notice.kind is NoticeKind.UPDATE_ROLLED_BACK
    assert "1.5.0" in message.title
    assert "sent no healthy heartbeat" in message.body


def test_a_confirmed_release_is_not_worth_telling_anyone(notifier: RecordingNotifier) -> None:
    announcer = Announcer(notifier=notifier)

    posted = announcer.announce(
        current_notices(rollback=ReleaseConfirmation(version="1.5.0", confirmed=True))
    )

    assert posted == ()
    assert notifier.posted == []


def test_a_staged_release_is_announced_once_staging_completes(
    notifier: RecordingNotifier,
) -> None:
    announcer = Announcer(notifier=notifier)

    # Nothing staged yet: the helper has checked and there is nothing to say.
    assert announcer.announce(current_notices()) == ()
    assert notifier.posted == []

    announcer.announce(current_notices(staged=staged_release("1.5.0")))

    assert len(notifier.posted) == 1
    message = notifier.posted[0]
    assert message.notice.kind is NoticeKind.UPDATE_STAGED
    assert message.title == "InnyTypes 1.5.0 is ready to install"
    assert "quit InnyTypes" in message.body


def test_a_staged_release_that_waits_for_the_user_does_not_claim_a_quit_will_install_it(
    notifier: RecordingNotifier,
) -> None:
    """A host API change (D13) stages and then waits; the words must not promise otherwise."""
    announcer = Announcer(notifier=notifier)

    announcer.announce(
        current_notices(
            staged=staged_release(
                "2.0.0",
                automatic=False,
                blocked_reason="release 2.0.0 changes the host API, and two plugins have not "
                "been rebuilt for it",
            )
        )
    )

    message = notifier.posted[0]
    assert message.title == "InnyTypes 2.0.0 is ready to install"
    assert "changes the host API" in message.body
    assert "innytypes update apply" in message.body
    assert "quit InnyTypes" not in message.body


def test_a_pending_manual_update_and_a_blocked_set_are_distinguishable(
    notifier: RecordingNotifier,
) -> None:
    announcer = Announcer(notifier=notifier)
    config = HelperConfig(
        plugins=PluginSettings(
            update_mode=UpdateMode.AUTO,
            overrides=(PluginOverride(id="monty", update_mode=UpdateMode.MANUAL),),
        )
    )
    check = check_with(
        blocked_report(
            "monty",
            rule=ConsistencyRule.MODE_OR_PIN,
            reason="monty is in manual mode, and the set would move it to 2.0.0",
        ),
        blocked_report(
            "whodunnit",
            rule=ConsistencyRule.REQUIRES,
            reason="whodunnit 3.0.0 requires summarize >=2, and summarize is held at 1.4.0",
        ),
    )

    announcer.announce(current_notices(check=check, config=config))

    kinds = [message.notice.kind for message in notifier.posted]
    assert kinds == [NoticeKind.PLUGIN_UPDATE_PENDING, NoticeKind.PLUGIN_SET_BLOCKED]

    pending, held = notifier.posted
    assert pending.title == "monty 2.0.0 is available"
    assert "innytypes addons update monty" in pending.body
    assert held.title == "whodunnit 2.0.0 is being held back"
    # The blocked one names why it is blocked, which is the whole of what makes it useful.
    assert "requires summarize >=2" in held.body
    assert pending.title != held.title


@pytest.mark.parametrize(
    "override",
    [
        PluginOverride(id="monty", update_mode=UpdateMode.OFF),
        PluginOverride(id="monty", update_mode=UpdateMode.AUTO, pinned=True),
    ],
)
def test_a_pinned_or_switched_off_plugin_is_not_pending_anything(
    notifier: RecordingNotifier, override: PluginOverride
) -> None:
    """Rule 4 refuses `manual`, `off` and pinned alike; only one of the three is news."""
    announcer = Announcer(notifier=notifier)
    config = HelperConfig(plugins=PluginSettings(overrides=(override,)))
    check = check_with(
        blocked_report(
            "monty",
            rule=ConsistencyRule.MODE_OR_PIN,
            reason="monty is held at its installed version",
        )
    )

    assert announcer.announce(current_notices(check=check, config=config)) == ()
    assert notifier.posted == []


def test_all_five_conditions_at_once_produce_five_notifications(
    notifier: RecordingNotifier,
) -> None:
    announcer = Announcer(notifier=notifier)

    posted = announcer.announce(
        current_notices(
            quarantines={"monty": "exited with code 1 five times"},
            rollback=ReleaseConfirmation(version="1.5.0", confirmed=False, reason="never started"),
            staged=staged_release("1.6.0"),
            check=check_with(
                blocked_report(
                    "summarize",
                    rule=ConsistencyRule.MODE_OR_PIN,
                    reason="summarize is in manual mode",
                ),
                blocked_report(
                    "whodunnit",
                    rule=ConsistencyRule.LOCK,
                    reason="whodunnit 2.0.0 does not resolve to a fully pinned lock",
                ),
            ),
        )
    )

    assert {notice.kind for notice in posted} == set(NoticeKind)
    assert len(notifier.posted) == 5


# ── the deduplication rule ───────────────────────────────────────────────────────────────────


def test_the_same_quarantine_on_the_next_tick_says_nothing_again(
    notifier: RecordingNotifier,
) -> None:
    announcer = Announcer(notifier=notifier)
    notices = current_notices(quarantines={"monty": "exited with code 1 five times"})

    announcer.announce(notices)
    for _ in range(10):
        assert announcer.announce(notices) == ()

    assert len(notifier.posted) == 1


def test_an_unchanged_set_of_every_kind_is_silent_on_every_later_tick(
    notifier: RecordingNotifier,
) -> None:
    announcer = Announcer(notifier=notifier)
    notices = current_notices(
        quarantines={"monty": "exited with code 1 five times"},
        rollback=ReleaseConfirmation(version="1.5.0", confirmed=False, reason="never started"),
        staged=staged_release("1.6.0"),
        check=check_with(
            blocked_report("summarize", rule=ConsistencyRule.MODE_OR_PIN, reason="manual mode")
        ),
    )

    announcer.announce(notices)
    announcer.announce(notices)
    announcer.announce(notices)

    assert len(notifier.posted) == 4


def test_a_new_condition_is_told_without_repeating_the_old_ones(
    notifier: RecordingNotifier,
) -> None:
    announcer = Announcer(notifier=notifier)
    quarantines = {"monty": "exited with code 1 five times"}

    announcer.announce(current_notices(quarantines=quarantines))
    posted = announcer.announce(
        current_notices(quarantines=quarantines, staged=staged_release("1.5.0"))
    )

    assert [notice.kind for notice in posted] == [NoticeKind.UPDATE_STAGED]
    assert len(notifier.posted) == 2


def test_a_condition_that_goes_away_and_comes_back_is_told_again(
    notifier: RecordingNotifier,
) -> None:
    announcer = Announcer(notifier=notifier)
    notices = current_notices(quarantines={"monty": "exited with code 1 five times"})

    announcer.announce(notices)
    # `innytypes helper release monty`, and then it happens again.
    announcer.announce(current_notices())
    announcer.announce(notices)

    assert len(notifier.posted) == 2


def test_the_same_process_quarantined_for_a_new_reason_is_news(
    notifier: RecordingNotifier,
) -> None:
    announcer = Announcer(notifier=notifier)

    announcer.announce(current_notices(quarantines={"monty": "exited with code 1 five times"}))
    announcer.announce(current_notices(quarantines={"monty": "went over its memory limit"}))

    assert len(notifier.posted) == 2
    assert "memory limit" in notifier.posted[1].body


def test_two_identical_conditions_in_one_tick_are_one_notification(
    notifier: RecordingNotifier,
) -> None:
    announcer = Announcer(notifier=notifier)
    duplicate = Notice(kind=NoticeKind.PROCESS_QUARANTINED, subject="monty", detail="crashed")

    posted = announcer.announce([duplicate, duplicate])

    assert posted == (duplicate,)
    assert len(notifier.posted) == 1


# ── clicking a notification ──────────────────────────────────────────────────────────────────


def test_clicking_a_notification_opens_the_window_once_per_click() -> None:
    opened: list[str] = []
    notifier = RecordingNotifier(on_click=lambda: opened.append("window"))
    announcer = Announcer(notifier=notifier)
    announcer.announce(current_notices(quarantines={"monty": "crashed"}))

    assert opened == []

    notifier.click()
    assert opened == ["window"]

    notifier.click()
    assert opened == ["window", "window"]


def test_a_click_cannot_be_claimed_for_a_notification_that_was_never_shown() -> None:
    opened: list[str] = []
    notifier = RecordingNotifier(on_click=lambda: opened.append("window"))

    with pytest.raises(IndexError):
        notifier.click()

    assert opened == []


def test_a_click_with_no_window_to_open_is_not_an_error(notifier: RecordingNotifier) -> None:
    """Nothing wired the window up yet (slice 07b): the click is still a click."""
    Announcer(notifier=notifier).announce(current_notices(quarantines={"monty": "crashed"}))

    notifier.click()


# ── the macOS notifier: text is data, never script ───────────────────────────────────────────


class RecordingRunner:
    """Stands in for `osascript`, recording what it would have been handed."""

    def __init__(self) -> None:
        self.calls: list[tuple[list[str], str]] = []

    def __call__(self, argv: Sequence[str], script: str) -> None:
        self.calls.append((list(argv), script))


def test_the_macos_notifier_passes_the_text_as_arguments_not_as_script() -> None:
    runner = RecordingRunner()
    notifier = MacNotifier(run=runner)
    announcer = Announcer(notifier=notifier)

    announcer.announce(current_notices(quarantines={'monty"; do shell script "id': NASTY_REASON}))

    assert len(runner.calls) == 1
    argv, script = runner.calls[0]

    # The script is the constant, unchanged: nothing about the message reached it.
    assert script == MACOS_SCRIPT
    assert NASTY_REASON not in script
    assert "monty" not in script

    # The message travelled as two arguments, after the `-` that makes osascript read the
    # script from standard input. Everything after it is data for `on run argv`.
    assert argv[0] == "/usr/bin/osascript"
    assert argv[1] == "-"
    assert len(argv) == 4
    title, body = argv[2], argv[3]
    assert 'monty"; do shell script "id' in title
    assert NASTY_REASON in body


def test_a_version_full_of_metacharacters_also_travels_as_an_argument() -> None:
    runner = RecordingRunner()
    notifier = MacNotifier(run=runner)

    notifier.post(
        compose(
            Notice(
                kind=NoticeKind.PLUGIN_SET_BLOCKED,
                subject="whodunnit",
                version='2.0.0" & (do shell script "id") & "',
                detail="the lock does not resolve",
            )
        )
    )

    argv, script = runner.calls[0]
    assert script == MACOS_SCRIPT
    assert "do shell script" not in script
    assert 'do shell script "id"' in argv[2]


def test_the_macos_script_never_formats_anything_into_itself() -> None:
    """The constant is the security argument, so it is asserted directly.

    Two placeholders, both reading from `argv`, and no substitution syntax of any kind — an
    f-string, a `%s` or a `{}` in here would mean the text is compiled rather than passed.
    """
    assert MACOS_SCRIPT == (
        "on run argv\n"
        "\tdisplay notification (item 2 of argv) with title (item 1 of argv)\n"
        "end run\n"
    )
    assert "{" not in MACOS_SCRIPT
    assert "%" not in MACOS_SCRIPT


def test_the_macos_notifier_never_runs_a_shell() -> None:
    """`shell=False` is not enough on its own; there must be no command line to quote into."""
    runner = RecordingRunner()

    notice = Notice(kind=NoticeKind.UPDATE_STAGED, subject=HOST_ID, version="1.5.0")
    MacNotifier(run=runner).post(Message(title="a title", body="a body", notice=notice))

    argv, _ = runner.calls[0]
    # An argument vector, not a string a shell would split.
    assert isinstance(argv, list)
    assert all(isinstance(part, str) for part in argv)


def test_the_production_runner_hands_osascript_a_vector_and_no_shell(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The default runner, with `subprocess.run` itself replaced — nothing is executed.

    This is the one path with no injection seam in front of it, so the properties that make it
    safe are asserted here: a list of arguments, the script on standard input, and no `shell`.
    """
    calls: list[tuple[tuple[object, ...], dict[str, object]]] = []

    class Completed:
        returncode = 0
        stderr = ""

    def fake_run(*args: object, **kwargs: object) -> Completed:
        calls.append((args, kwargs))
        return Completed()

    monkeypatch.setattr(notification.subprocess, "run", fake_run)
    MacNotifier().post(
        compose(Notice(kind=NoticeKind.PROCESS_QUARANTINED, subject="monty", detail=NASTY_REASON))
    )

    (argv,), kwargs = calls[0]
    assert isinstance(argv, list)
    assert argv[:3] == ["/usr/bin/osascript", "-", "InnyTypes stopped restarting monty"]
    assert kwargs["input"] == MACOS_SCRIPT
    assert kwargs["check"] is False
    assert "shell" not in kwargs
    assert NASTY_REASON in argv[3]


def test_a_failing_osascript_does_not_take_the_helper_down(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A notification that cannot be shown is a warning, not the end of the helper's tick."""

    class Failed:
        returncode = 1
        stderr = "execution error"

    monkeypatch.setattr(notification.subprocess, "run", lambda *a, **k: Failed())

    MacNotifier().post(
        compose(Notice(kind=NoticeKind.UPDATE_STAGED, subject=HOST_ID, version="1.5.0"))
    )


# ── the platform seams ───────────────────────────────────────────────────────────────────────


def test_macos_has_a_notifier() -> None:
    assert isinstance(notifier_for("Darwin"), MacNotifier)


def test_linux_has_a_notifier() -> None:
    """Slice 15 filled this seam; the wording it shows is still composed here."""
    from innytypes.helper.linux import LinuxNotifier

    assert isinstance(notifier_for("Linux"), LinuxNotifier)


def test_an_operating_system_nobody_ships_for_is_refused_too() -> None:
    with pytest.raises(UnsupportedPlatform):
        notifier_for("Plan9")


# ── what `status` says, notification or no notification ──────────────────────────────────────


def test_the_notices_file_is_written_even_when_nothing_is_posted(tmp_path: Path) -> None:
    store = NoticeFile(path=tmp_path / "notices.json")
    notifier = RecordingNotifier()
    announcer = Announcer(notifier=notifier, store=store)
    notices = current_notices(quarantines={"monty": "crashed"}, staged=staged_release("1.5.0"))

    announcer.announce(notices)
    posted_first_time = len(notifier.posted)
    announcer.announce(notices)

    # The second tick posted nothing, and the file still holds everything that is true.
    assert len(notifier.posted) == posted_first_time
    assert store.read() == notices


def test_the_default_notices_file_sits_beside_the_other_runtime_state() -> None:
    """Runtime, not data: it describes this moment, and a reboot is right to clear it."""
    assert default_notices_path().name == NOTICES_FILENAME
    assert default_notices_path().parent == default_quarantine_path().parent
    assert NoticeFile().path == default_notices_path()


def test_a_notices_file_that_cannot_be_read_is_read_as_nothing(tmp_path: Path) -> None:
    store = NoticeFile(path=tmp_path / "notices.json")
    assert store.read() == ()

    store.path.write_text("{not json", encoding="utf-8")
    assert store.read() == ()

    store.path.write_text('{"kind": "update-staged"}', encoding="utf-8")
    assert store.read() == ()


def test_a_notices_file_written_by_a_newer_helper_keeps_the_lines_this_one_understands(
    tmp_path: Path,
) -> None:
    """`status` is a report: one entry it has no words for must not cost it the others."""
    store = NoticeFile(path=tmp_path / "notices.json")
    store.path.write_text(
        '[{"kind": "something-invented-later", "subject": "monty"}, '
        '"not an object", '
        '{"kind": "update-staged", "subject": "innytypes", "version": "9.9.9"}]',
        encoding="utf-8",
    )

    assert store.read() == (
        Notice(kind=NoticeKind.UPDATE_STAGED, subject="innytypes", version="9.9.9"),
    )


def test_status_reports_a_quarantine_and_a_staged_update_with_no_notification_ever_shown(
    tmp_path: Path,
) -> None:
    """Acceptance: `status` is independent of whether a notification was ever posted.

    The notifier below is wired up and never called: `status` reads the files the helper keeps,
    so a notification that was missed, dismissed, or never posted at all changes nothing.
    """
    notifier = RecordingNotifier()
    quarantine = tmp_path / "quarantine.json"
    QuarantineFile(path=quarantine).save({"monty": "exited with code 1 five times"})
    NoticeFile(path=tmp_path / "notices.json").write(
        current_notices(
            quarantines={"monty": "exited with code 1 five times"},
            staged=staged_release("1.5.0"),
        )
    )

    result = CliRunner().invoke(
        cli,
        [
            "helper",
            "status",
            "--run-state",
            str(tmp_path / "run-state.json"),
            "--quarantine",
            str(quarantine),
            "--notices",
            str(tmp_path / "notices.json"),
        ],
    )

    assert result.exit_code == 0, result.output
    assert "monty: quarantined" in result.output
    assert "InnyTypes 1.5.0 is ready to install" in result.output
    assert notifier.posted == []


def test_status_reports_every_update_condition_in_the_words_of_the_notification(
    tmp_path: Path,
) -> None:
    NoticeFile(path=tmp_path / "notices.json").write(
        current_notices(
            rollback=ReleaseConfirmation(
                version="1.5.0", confirmed=False, reason="it sent no healthy heartbeat"
            ),
            check=check_with(
                blocked_report(
                    "summarize", rule=ConsistencyRule.MODE_OR_PIN, reason="summarize is manual"
                ),
                blocked_report(
                    "whodunnit", rule=ConsistencyRule.LOCK, reason="the lock does not resolve"
                ),
            ),
        )
    )

    result = CliRunner().invoke(
        cli,
        [
            "helper",
            "status",
            "--run-state",
            str(tmp_path / "run-state.json"),
            "--quarantine",
            str(tmp_path / "quarantine.json"),
            "--notices",
            str(tmp_path / "notices.json"),
        ],
    )

    assert result.exit_code == 0, result.output
    assert "InnyTypes 1.5.0 did not start, and was undone" in result.output
    assert "summarize 2.0.0 is available" in result.output
    assert "whodunnit 2.0.0 is being held back" in result.output


def test_status_says_so_when_no_update_is_waiting(tmp_path: Path) -> None:
    result = CliRunner().invoke(
        cli,
        [
            "helper",
            "status",
            "--run-state",
            str(tmp_path / "run-state.json"),
            "--quarantine",
            str(tmp_path / "quarantine.json"),
            "--notices",
            str(tmp_path / "notices.json"),
        ],
    )

    assert result.exit_code == 0, result.output
    assert "Nothing is running, and nothing is quarantined." in result.output
    assert "No update is waiting, and nothing is held back." in result.output


def test_a_quarantine_is_not_reported_twice_by_status(tmp_path: Path) -> None:
    quarantine = tmp_path / "quarantine.json"
    QuarantineFile(path=quarantine).save({"monty": "crashed"})
    NoticeFile(path=tmp_path / "notices.json").write(
        current_notices(quarantines={"monty": "crashed"})
    )

    result = CliRunner().invoke(
        cli,
        [
            "helper",
            "status",
            "--run-state",
            str(tmp_path / "run-state.json"),
            "--quarantine",
            str(quarantine),
            "--notices",
            str(tmp_path / "notices.json"),
        ],
    )

    assert result.exit_code == 0, result.output
    assert result.output.count("monty") == 1
    assert "No update is waiting, and nothing is held back." in result.output


# ── the words themselves ─────────────────────────────────────────────────────────────────────


def test_every_kind_has_words(notifier: RecordingNotifier) -> None:
    """`compose` is the only place words are written, so every kind must reach it."""
    for kind in NoticeKind:
        message = compose(Notice(kind=kind, subject="monty", version="2.0.0", detail="because"))
        assert message.title
        assert message.body
        assert message.notice.kind is kind


def test_a_reason_that_already_ends_in_a_full_stop_is_not_given_a_second_one() -> None:
    message = compose(
        Notice(kind=NoticeKind.PROCESS_QUARANTINED, subject="monty", detail="it crashed.")
    )

    assert ".." not in message.body
