"""The drawing: the window's model turned into widgets, and the icon it still refuses to add.

Slice 07b proved what the window *decides*; this proves what the toolkit *builds* out of those
decisions. The two are deliberately separate — the model is toolkit-independent and is tested
against the real launcher, and everything here is about whether the right widget appears, with
the right words on it, wired to the right effect.

**The toolkit is a stand-in, and that is honest rather than convenient.** Toga is installed
inside the built bundle and nowhere else (see `[tool.briefcase]`), so the gate has no GUI stack
and must never need one. :class:`~innytypes.helper.toolkit.Toolkit` exists precisely so this is
a value a test can hand over rather than an import a test has to intercept. What a stand-in
cannot show — that a window actually appears on a screen — is not claimed by any test here; it
is claimed by opening the built bundle, and recorded in `docs/log.md`.

**The rule with no widget.** :meth:`~innytypes.helper.toolkit.TogaDesktop.add_status_item`
refuses (plan 0003, F4). This is the implementation with a real toolkit behind it, so it is the
one that *could* have put an icon in the system tray, and the assertion that it will not is
worth more here than anywhere else. The whole-source scan in `tests/test_application_window.py`
covers this module too.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any

import pytest

from innytypes import HOST_API_VERSION, __version__
from innytypes.addons.manifest import parse_manifest
from innytypes.addons.settings import SettingsStore
from innytypes.addons.settings_form import SettingsForm
from innytypes.helper.breaker import ProcessStatus, RunState
from innytypes.helper.config import BUNDLE_IDENTIFIER, HelperSettings
from innytypes.helper.launcher import LaunchAtLogin, QuitReason, QuitReport, UnpackagedLoginItem
from innytypes.helper.plugin_lists import CatalogueEntryView, CatalogueList
from innytypes.helper.toolkit import (
    APPLICATION_TITLE,
    NO_LABEL,
    SAVE_LABEL,
    YES_LABEL,
    TogaDesktop,
    Toolkit,
    load_toolkit,
)
from innytypes.helper.window import (
    LAUNCH_AT_LOGIN_LABEL,
    QUIT_LABEL,
    TELEMETRY_LABEL,
    AnytypeGroup,
    ApplicationTab,
    ApplicationWindow,
    Control,
    Desktop,
    InstalledPlugin,
    PluginEntry,
    PluginRunState,
    PluginView,
    ProcessRow,
    SwitchRow,
    SwitchState,
    TabbedContents,
    UpdateKind,
    UpdateRow,
    WindowContents,
    WindowError,
)


def tabbed_view(tmp_path: Path) -> tuple[TabbedContents, SettingsStore]:
    """A text and a table, so a switch must preserve both widget shapes."""
    manifest = parse_manifest(
        {
            "id": "monty",
            "version": "1.0.0",
            "host_api": HOST_API_VERSION,
            "requires": [],
            "emits": [],
            "subscribes": [],
            "settings": [
                {"id": "name", "type": "text", "label": "Name"},
                {
                    "id": "recorders",
                    "type": "table",
                    "label": "Recorders",
                    "row_label": "recorder",
                    "row": [{"id": "label", "type": "text", "label": "Label"}],
                },
            ],
        }
    )
    store = SettingsStore("monty", manifest.settings, path=tmp_path / "monty.toml")
    store.write({"name": "recorded", "recorders": [{"label": "one"}]}, by="user")
    entry = PluginEntry(
        plugin_id="monty",
        run_state=PluginRunState.RUNNING,
        form=SettingsForm(store).publish(),
    )
    return TabbedContents(installed=PluginView((entry,))), store


# --- a toolkit that records instead of drawing ----------------------------------------------


@dataclass
class Widget:
    """One widget the stand-in was asked for: what kind, and everything it was given."""

    kind: str
    options: dict[str, Any] = field(default_factory=dict)

    @property
    def text(self) -> str:
        return str(self.options.get("text", ""))

    @property
    def value(self) -> Any:
        return self.options.get("value")

    @value.setter
    def value(self, value: Any) -> None:
        self.options["value"] = value

    @property
    def children(self) -> list[Widget]:
        return list(self.options.get("children", []))

    @property
    def content(self) -> list[tuple[str, Widget]]:
        content = self.options.get("content", [])
        return list(content) if isinstance(content, list) else []

    @property
    def current_tab(self) -> int:
        return int(self.options.get("current_tab", 0))

    @current_tab.setter
    def current_tab(self, value: int) -> None:
        self.options["current_tab"] = value

    def press(self) -> None:
        """Press this widget, the way the toolkit would call its handler."""
        self.options["on_press"](self)

    def move(self, to: bool) -> None:
        """Move this switch, the way the toolkit would: set the value, then call the handler."""
        self.options["value"] = to
        self.options["on_change"](self)

    def select(self, position: int) -> None:
        self.current_tab = position
        self.options["on_select"](self)


@dataclass
class FakeWindow:
    """A stand-in window: what it was titled, what it holds, and what was done to it."""

    title: str
    content: Widget | None = None
    shown: int = 0
    hidden: int = 0
    closed: int = 0
    size: tuple[int, int] | None = None

    def show(self) -> None:
        self.shown += 1

    def hide(self) -> None:
        self.hidden += 1

    def close(self) -> None:
        self.closed += 1


@dataclass
class FakeLoop:
    """The toolkit's event loop, as far as signal registration is concerned."""

    handlers: dict[int, Any] = field(default_factory=dict)

    def add_signal_handler(self, number: int, handler: Any, *arguments: Any) -> None:
        self.handlers[number] = lambda: handler(*arguments)


@dataclass
class FakeApp:
    """A stand-in application: the identity it was created with, and its startup."""

    toga: FakeToga
    options: dict[str, Any]
    main_window: FakeWindow | None = None
    loops: int = 0
    exits: int = 0
    requested_exits: int = 0
    loop: FakeLoop = field(default_factory=FakeLoop)

    def main_loop(self) -> None:
        """The toolkit's own order of events, which is the thing being relied on.

        The real one makes the main window, asks the startup method for its contents, shows it,
        and only then starts the loop and calls `on_running`. It never returns until the user
        quits; this one records and returns, so a test can assert on all of it.
        """
        self.loops += 1
        self.main_window = self.toga.MainWindow(title=self.options["formal_name"])
        self.main_window.content = self.options["startup"](self)
        self.main_window.show()
        self.options["on_running"](self)

    def request_exit(self) -> None:
        # What the toolkit does for its own Quit command: ask, then exit if allowed.
        self.requested_exits += 1
        if self.options["on_exit"](self):
            self.exit()

    def exit(self) -> None:
        self.exits += 1


class FakeToga(ModuleType):
    """Everything :mod:`innytypes.helper.toolkit` asks of Toga, and nothing else."""

    def __init__(self) -> None:
        super().__init__("toga")
        self.windows: list[FakeWindow] = []
        self.apps: list[FakeApp] = []

    def App(self, **options: Any) -> FakeApp:  # noqa: N802 - the toolkit's own spelling
        app = FakeApp(toga=self, options=options)
        self.apps.append(app)
        return app

    def MainWindow(self, **options: Any) -> FakeWindow:  # noqa: N802
        window = FakeWindow(title=options["title"])
        self.windows.append(window)
        return window

    def Window(self, **options: Any) -> FakeWindow:  # noqa: N802
        return self.MainWindow(**options)

    def Box(self, **options: Any) -> Widget:  # noqa: N802
        return Widget(kind="box", options=options)

    def Label(self, **options: Any) -> Widget:  # noqa: N802
        return Widget(kind="label", options=options)

    def Button(self, **options: Any) -> Widget:  # noqa: N802
        return Widget(kind="button", options=options)

    def Switch(self, **options: Any) -> Widget:  # noqa: N802
        return Widget(kind="switch", options=options)

    def OptionContainer(self, **options: Any) -> Widget:  # noqa: N802
        return Widget(kind="tabs", options=options)

    def ScrollContainer(self, **options: Any) -> Widget:  # noqa: N802
        return Widget(kind="scroll", options=options)

    def TextInput(self, **options: Any) -> Widget:  # noqa: N802
        return Widget(kind="text-input", options=options)

    def MultilineTextInput(self, **options: Any) -> Widget:  # noqa: N802
        return Widget(kind="multiline-input", options=options)

    def NumberInput(self, **options: Any) -> Widget:  # noqa: N802
        return Widget(kind="number-input", options=options)

    def Selection(self, **options: Any) -> Widget:  # noqa: N802
        return Widget(kind="selection", options=options)

    def PasswordInput(self, **options: Any) -> Widget:  # noqa: N802
        return Widget(kind="password-input", options=options)


@pytest.fixture
def toga() -> FakeToga:
    return FakeToga()


@pytest.fixture
def toolkit(toga: FakeToga) -> Toolkit:
    return Toolkit(toga=toga, pack=dict, column="column")


@pytest.fixture
def desktop(toolkit: Toolkit, toga: FakeToga) -> TogaDesktop:
    """A desktop with a window already open, as it is once :meth:`run` has started it."""
    drawing = TogaDesktop(toolkit=toolkit)
    drawing.run(lambda: None)
    return drawing


def descendants(box: Widget) -> list[Widget]:
    scroll_content = box.options.get("content") if box.kind == "scroll" else None
    nested = box.children + [pane for _, pane in box.content]
    if scroll_content is not None:
        nested.append(scroll_content)
    return [item for child in nested for item in (descendants(child) + [child])]


def kinds(box: Widget, kind: str) -> list[Widget]:
    return [child for child in descendants(box) if child.kind == kind]


def labelled(box: Widget, text: str) -> Widget:
    found = [child for child in descendants(box) if child.text == text]
    assert found, f"nothing in the window says {text!r}: {[c.text for c in descendants(box)]}"
    return found[0]


def input_for(box: Widget, label: str) -> Widget:
    found = [child for child in descendants(box) if child.options.get("placeholder") == label]
    assert found, f"no input has the placeholder {label!r}"
    return found[0]


# --- finding the toolkit ---------------------------------------------------------------------


def test_a_machine_with_no_toolkit_says_so_rather_than_failing(monkeypatch: Any) -> None:
    # The ordinary case for an unpackaged installation, and not an error: the caller falls
    # back to the headless desktop and the application still runs and still quits.
    monkeypatch.setitem(sys.modules, "toga", None)

    assert load_toolkit() is None


def test_an_installed_toolkit_is_resolved_into_a_value(monkeypatch: Any, toga: FakeToga) -> None:
    style = ModuleType("toga.style")
    style.Pack = dict  # type: ignore[attr-defined]
    constants = ModuleType("toga.style.pack")
    constants.COLUMN = "column"  # type: ignore[attr-defined]
    constants.ROW = "row"  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "toga", toga)
    monkeypatch.setitem(sys.modules, "toga.style", style)
    monkeypatch.setitem(sys.modules, "toga.style.pack", constants)

    found = load_toolkit()

    assert found is not None
    assert found.toga is toga
    assert found.column == "column"
    assert found.row == "row"


# --- starting the application -----------------------------------------------------------------


def test_the_application_is_created_under_the_bundle_identifier(
    toolkit: Toolkit, toga: FakeToga
) -> None:
    # The identity the operating system files the window under. The same string as the macOS
    # bundle, the Linux `.desktop` entry and the Windows AppUserModelID (D27), or a click on
    # a notification reaches nothing.
    drawing = TogaDesktop(toolkit=toolkit)
    drawn: list[str] = []

    drawing.run(lambda: drawn.append("first draw"))

    app = toga.apps[0]
    assert app.options["app_id"] == BUNDLE_IDENTIFIER
    # Wired at creation, because the toolkit's own Quit command exists from that moment.
    assert app.options["on_exit"] == drawing._exiting
    assert app.options["formal_name"] == APPLICATION_TITLE
    # The toolkit's window, adopted rather than a second one made beside it, and the first
    # draw deferred to the moment the loop is running.
    assert drawing.window is app.main_window
    assert drawn == ["first draw"]


def test_every_way_of_quitting_runs_the_one_quit(desktop: TogaDesktop, toga: FakeToga) -> None:
    # The window's button, macOS's own Quit command and the Dock's Quit are one path, because
    # the button asks the toolkit to exit and the toolkit asks `on_exit`. Without this, ⌘Q
    # would end the helper and leave the host, the MCP server and the plugins running.
    quits: list[str] = []
    desktop.on_quit = lambda: quits.append("quit")
    desktop.present(WindowContents())

    labelled(desktop.window.content, QUIT_LABEL).press()

    app = toga.apps[0]
    assert quits == ["quit"]
    assert (app.requested_exits, app.exits) == (1, 1)

    # The toolkit's own Quit command, which never touches the window at all.
    app.request_exit()

    assert quits == ["quit", "quit"]


def test_a_caught_signal_is_registered_on_the_loop_and_quits(
    desktop: TogaDesktop, toga: FakeToga
) -> None:
    # A Python signal handler runs between bytecodes, and an application inside the operating
    # system's event loop executes none — so a terminate would do nothing at all until
    # something killed the process. Registered on the loop, it arrives.
    caught: list[int] = []
    desktop.on_signal(15, lambda number, frame: caught.append(number))

    toga.apps[0].loop.handlers[15]()

    assert caught == [15]


def test_signals_cannot_be_registered_before_there_is_a_loop(toolkit: Toolkit) -> None:
    with pytest.raises(WindowError, match="event loop"):
        TogaDesktop(toolkit=toolkit).on_signal(15, lambda number, frame: None)


def test_stopping_ends_the_application_without_asking_again(
    desktop: TogaDesktop, toga: FakeToga
) -> None:
    # What a caught signal uses: the quit has already stopped everything, and this hands the
    # process back. Asking `on_exit` again would run the quit twice.
    desktop.on_quit = lambda: pytest.fail("the quit must not run a second time")

    desktop.stop()

    assert (toga.apps[0].exits, toga.apps[0].requested_exits) == (1, 0)


def test_drawing_before_the_application_started_refuses(toolkit: Toolkit) -> None:
    with pytest.raises(WindowError, match="has not started"):
        TogaDesktop(toolkit=toolkit).present(WindowContents())


# --- what gets drawn ---------------------------------------------------------------------------


def rich_contents() -> WindowContents:
    """A window with something of every kind in it."""
    return WindowContents(
        processes=(
            ProcessRow(child_id="innytypes.host", state=RunState.RUNNING),
            ProcessRow(
                child_id="monty",
                state=RunState.QUARANTINED,
                detail="4 restarts in 10 minutes",
            ),
        ),
        updates=(
            UpdateRow(
                kind=UpdateKind.CORE,
                subject="InnyTypes",
                version="1.2.0",
                apply=Control(label="Apply 1.2.0"),
                detail="Waiting for you.",
            ),
            UpdateRow(kind=UpdateKind.PLUGIN, subject="monty", version="0.4.0", detail="auto"),
        ),
        telemetry=SwitchRow(label=TELEMETRY_LABEL, state=SwitchState.ON),
        launch_at_login=SwitchRow(label=LAUNCH_AT_LOGIN_LABEL, state=SwitchState.OFF),
    )


def test_every_part_of_the_window_becomes_a_widget(desktop: TogaDesktop) -> None:
    # The toolkit shows the (empty) window itself at startup, so what this counts is the draw.
    before = desktop.window.shown
    desktop.present(rich_contents())

    box = desktop.window.content
    texts = [child.text for child in descendants(box)]

    assert "innytypes.host — running" in texts
    assert "monty — quarantined (4 restarts in 10 minutes)" in texts
    assert "InnyTypes 1.2.0 — Waiting for you." in texts
    assert "monty 0.4.0 — auto" in texts

    switches = kinds(box, "switch")
    assert [switch.text for switch in switches] == [TELEMETRY_LABEL, LAUNCH_AT_LOGIN_LABEL]
    assert [switch.value for switch in switches] == [True, False]

    assert desktop.window.shown == before + 1


def test_quit_is_drawn_last_and_always(desktop: TogaDesktop) -> None:
    # F1: turning the application off is never hidden, so it is in every window this can
    # draw — including the emptiest one there is.
    desktop.present(WindowContents())

    box = desktop.window.content
    assert box.children[-1].text == QUIT_LABEL
    assert box.children[-1].kind == "button"


def test_an_update_waiting_for_the_user_gets_a_button_and_an_automatic_one_does_not(
    desktop: TogaDesktop,
) -> None:
    desktop.present(rich_contents())

    buttons = [button.text for button in kinds(desktop.window.content, "button")]

    assert buttons == ["Apply 1.2.0", QUIT_LABEL]


def test_drawing_again_replaces_what_was_drawn(desktop: TogaDesktop) -> None:
    # The contents are rebuilt from the world on every draw, so the widgets are too: a tree
    # patched in place would be a second model of the same state.
    before = desktop.window.shown
    desktop.present(rich_contents())
    desktop.present(WindowContents())

    assert [title for title, _ in desktop.window.content.children[0].content] == ["InnyTypes"]
    assert desktop.window.shown == before + 2


@pytest.mark.parametrize("platform", ["darwin", "linux", "win32"])
def test_tabs_follow_the_model_and_switching_folds_text_and_table_widgets(
    desktop: TogaDesktop, tmp_path: Path, monkeypatch: Any, platform: str
) -> None:
    monkeypatch.setattr(sys, "platform", platform)
    tabs, store = tabbed_view(tmp_path)
    before = store.path.read_bytes()
    desktop.present(tabs)
    strip = desktop.window.content.children[0]
    assert [title for title, _ in strip.content] == ["InnyTypes", "monty"]
    assert strip.current_tab == 0

    strip.select(1)
    name = input_for(desktop.window.content, "Name")
    cell = input_for(desktop.window.content, "Label")
    name.value = "typed"
    cell.value = "changed row"
    desktop.window.content.children[0].select(0)

    plugin = tabs.tab("monty").plugin
    assert plugin.value("name") == "typed"
    assert plugin.table("recorders").values() == ({"label": "changed row"},)
    assert store.path.read_bytes() == before

    tabs.select("monty")
    desktop.present(tabs)
    assert desktop.window.content.children[0].current_tab == 1
    assert input_for(desktop.window.content, "Name").value == "typed"
    assert input_for(desktop.window.content, "Label").value == "changed row"


def test_save_and_cancel_buttons_route_through_the_plugin_tab(
    desktop: TogaDesktop, tmp_path: Path
) -> None:
    tabs, store = tabbed_view(tmp_path)
    desktop.on_configure = lambda plugin_id, values: store.write(values, by="user")
    tabs.select("monty")
    desktop.present(tabs)

    input_for(desktop.window.content, "Name").value = "saved"
    labelled(desktop.window.content, "Save").press()
    assert store.read().values["name"] == "saved"

    input_for(desktop.window.content, "Name").value = "mistake"
    labelled(desktop.window.content, "Cancel").press()
    assert input_for(desktop.window.content, "Name").value == "saved"
    assert store.read().values["name"] == "saved"


def test_one_failing_plugin_tab_is_replaced_by_its_reason(
    desktop: TogaDesktop, monkeypatch: Any
) -> None:
    entries = PluginView(
        (
            PluginEntry(plugin_id="broken"),
            PluginEntry(plugin_id="healthy"),
        )
    )
    original = desktop._plugin_tab_box

    def draw(tab: Any) -> Widget:
        if tab.plugin_id == "broken":
            raise WindowError("broken cannot be drawn")
        return original(tab)

    monkeypatch.setattr(desktop, "_plugin_tab_box", draw)
    desktop.present(TabbedContents(installed=entries))

    strip = desktop.window.content.children[0]
    assert [title for title, _ in strip.content] == ["InnyTypes", "broken", "healthy"]
    assert "broken cannot be drawn" in [child.text for child in descendants(strip.content[1][1])]
    assert any(child.text.startswith("healthy") for child in descendants(strip.content[2][1]))
    assert desktop.window.shown > 0
    assert desktop.window.content.children[-1].text == QUIT_LABEL


def test_closing_hides_the_window_and_stops_nothing(desktop: TogaDesktop) -> None:
    desktop.present(WindowContents())

    desktop.dismiss()

    assert desktop.window.hidden == 1
    assert desktop.window.closed == 0


# --- what the controls do ---------------------------------------------------------------------


def test_pressing_quit_runs_the_quit_it_was_given(desktop: TogaDesktop) -> None:
    quits: list[str] = []
    desktop.on_quit = lambda: quits.append("quit")
    desktop.present(WindowContents())

    labelled(desktop.window.content, QUIT_LABEL).press()

    assert quits == ["quit"]


def test_a_window_built_with_no_way_to_quit_says_so(desktop: TogaDesktop) -> None:
    # Never the user's problem in a real application, and never a silent one either: F1 is the
    # requirement this refusal protects.
    desktop.present(WindowContents())

    with pytest.raises(WindowError, match="F1"):
        labelled(desktop.window.content, QUIT_LABEL).press()


def test_moving_a_switch_carries_its_new_value(desktop: TogaDesktop) -> None:
    telemetry: list[bool] = []
    login: list[bool] = []
    desktop.on_telemetry = telemetry.append
    desktop.on_launch_at_login = login.append
    desktop.present(rich_contents())

    labelled(desktop.window.content, TELEMETRY_LABEL).move(False)
    labelled(desktop.window.content, LAUNCH_AT_LOGIN_LABEL).move(True)

    assert telemetry == [False]
    assert login == [True]


def test_pressing_apply_applies_that_row(desktop: TogaDesktop) -> None:
    applied: list[UpdateRow] = []
    desktop.on_apply = applied.append
    contents = rich_contents()
    desktop.present(contents)

    labelled(desktop.window.content, "Apply 1.2.0").press()

    assert applied == [contents.updates[0]]


def test_applying_with_nowhere_to_apply_refuses(desktop: TogaDesktop) -> None:
    desktop.present(rich_contents())

    with pytest.raises(WindowError, match="apply"):
        labelled(desktop.window.content, "Apply 1.2.0").press()


# --- the first-launch question ------------------------------------------------------------------


def test_the_question_is_asked_with_its_notice_and_answers_nothing_yet(
    desktop: TogaDesktop, toga: FakeToga
) -> None:
    # F2: an unanswered question is not a "no". The dialog resolves on the toolkit's loop, so
    # `ask` reports "nobody has answered" and the switch stays unanswered until somebody does.
    answer = desktop.ask("Send usage and error reports?", "Nothing personal leaves this machine.")

    assert answer is None
    question = toga.windows[-1]
    assert question.shown == 1
    texts = [child.text for child in question.content.children]
    assert texts == [
        "Nothing personal leaves this machine.",
        "Send usage and error reports?",
        YES_LABEL,
        NO_LABEL,
    ]


@pytest.mark.parametrize(("label", "expected"), [(YES_LABEL, True), (NO_LABEL, False)])
def test_answering_the_question_reports_the_answer_and_closes_it(
    desktop: TogaDesktop, toga: FakeToga, label: str, expected: bool
) -> None:
    answers: list[bool] = []
    desktop.on_answer = answers.append
    desktop.ask("Send usage and error reports?", "Nothing personal leaves this machine.")

    labelled(toga.windows[-1].content, label).press()

    assert answers == [expected]
    assert toga.windows[-1].closed == 1
    assert desktop.question_window is None


# --- the rule with no widget ---------------------------------------------------------------------


def test_the_toolkit_desktop_refuses_to_put_anything_in_the_system_tray(
    desktop: TogaDesktop, toga: FakeToga
) -> None:
    # The owner's rule (F4), enforced where it could actually have been broken.
    with pytest.raises(WindowError, match="system tray"):
        desktop.add_status_item(QUIT_LABEL)

    assert toga.windows == [desktop.window]


# --- the real window, drawn through the real toolkit desktop --------------------------------------


def test_the_window_drives_this_desktop_exactly_as_it_drives_the_headless_one(
    desktop: TogaDesktop, tmp_path: Path
) -> None:
    """The protocol conformance that matters: the window, unchanged, drawing through Toga.

    Nothing about :class:`~innytypes.helper.window.ApplicationWindow` is adapted for the
    toolkit — it is handed this desktop in place of the headless one and behaves identically,
    which is what the seam was for.
    """
    settings = HelperSettings(path=tmp_path / "config.toml")
    reports: list[QuitReason] = []

    def quit_everything(reason: QuitReason) -> QuitReport:
        reports.append(reason)
        return QuitReport(reason=reason)

    seam: Desktop = desktop
    window = ApplicationWindow(
        desktop=seam,
        settings=settings,
        launch_at_login=LaunchAtLogin(settings=settings, login_item=UnpackagedLoginItem()),
        quit=quit_everything,
        statuses=lambda: [
            ProcessStatus(child_id="innytypes.host", state=RunState.RUNNING, interventions=0)
        ],
    )
    desktop.on_quit = window.quit

    window.open()

    box = desktop.window.content
    assert labelled(box, "innytypes.host — running").kind == "label"
    # The question was asked, because this configuration has never answered it.
    assert desktop.question_window is not None

    labelled(box, QUIT_LABEL).press()

    assert reports == [QuitReason.MENU]
    assert window.visible is False


def test_the_grouped_application_tab_draws_every_shipped_group(
    desktop: TogaDesktop, tmp_path: Path
) -> None:
    present_key = "only-presence-is-published"
    entry = CatalogueEntryView(
        "whodunnit",
        "Finds authors.",
        "pypi:whodunnit",
        "friends",
        False,
        Control("Install"),
    )
    lists = SimpleNamespace(
        groups=(
            (),
            CatalogueList("Official plugins", "official"),
            CatalogueList("friends", "friends", entries=(entry,), remove=Control("Remove source")),
        ),
        register=lambda *args, **kwargs: SimpleNamespace(accepted=True, message="registered"),
        remove_source=lambda name: SimpleNamespace(accepted=True, message="removed"),
        install_entry=lambda offered: SimpleNamespace(accepted=True, message="installed"),
    )
    tab = ApplicationTab(
        anytype=AnytypeGroup.from_state(
            # fake: only presence reaches the model; this value must not.
            mcp_running=True,
            mcp_reason=None,
            api_key=present_key,
        ),
        helper=ApplicationTab.for_settings(HelperSettings(tmp_path / "config.toml")).helper,
        installed=(
            InstalledPlugin(
                "monty",
                PluginRunState.RUNNING,
                Control("Remove"),
                update=UpdateRow(
                    UpdateKind.PLUGIN,
                    "monty",
                    "2.0.0",
                    apply=Control("Apply 2.0.0"),
                ),
            ),
        ),
        plugin_lists=lists,
    )

    desktop.present(TabbedContents(application=tab))

    box = desktop.window.content
    texts = [widget.text for widget in descendants(box)]
    assert all(group in texts for group in tab.groups)
    assert "Anytype API key — set" in texts
    assert f"Version — {__version__}" in texts
    assert "monty — running" in texts
    assert "whodunnit: Finds authors. (friends) — unverified" in texts
    assert labelled(box, SAVE_LABEL).kind == "button"
    assert labelled(box, "Apply 2.0.0").kind == "button"
    assert labelled(box, "Register source").kind == "button"
    assert labelled(box, QUIT_LABEL).kind == "button"


def test_missing_key_pairing_accepts_anytypes_code(desktop: TogaDesktop) -> None:
    completed: list[str] = []
    group = AnytypeGroup(
        pairing_started=True,
        pairing_message="Anytype is showing a new four-digit pairing code.",
        start_pairing=lambda: (True, "started"),
        complete_pairing=lambda code: (completed.append(code) is None, "stored securely"),
    )
    desktop.present(TabbedContents(application=ApplicationTab(anytype=group)))

    code = input_for(desktop.window.content, "Four-digit pairing code")
    code.value = "1234"
    labelled(desktop.window.content, "Finish pairing").press()

    assert completed == ["1234"]
    assert group.api_key_set
    assert any(
        widget.text.startswith("Pairing complete. Restart InnyTypes")
        for widget in descendants(desktop.window.content)
    )


def test_helper_draft_survives_switching_to_a_plugin_tab(
    desktop: TogaDesktop, tmp_path: Path
) -> None:
    tab = ApplicationTab.for_settings(HelperSettings(tmp_path / "config.toml"))
    plugin = PluginEntry("monty", run_state=PluginRunState.RUNNING)
    desktop.present(TabbedContents(application=tab, installed=PluginView((plugin,))))
    tick = kinds(desktop.window.content, "number-input")[0]
    tick.value = 2.5

    desktop.window.content.children[0].select(1)
    desktop.window.content.children[0].select(0)

    assert kinds(desktop.window.content, "number-input")[0].value == 2.5
    assert not (tmp_path / "config.toml").exists()


def test_every_helper_number_gives_toga_a_numeric_step(
    desktop: TogaDesktop, tmp_path: Path
) -> None:
    """Real Toga refuses NumberInput(step=None), which used to blank the whole main tab."""
    tab = ApplicationTab.for_settings(HelperSettings(tmp_path / "config.toml"))

    desktop.present(TabbedContents(application=tab))

    number_inputs = kinds(desktop.window.content, "number-input")
    assert number_inputs
    assert all(isinstance(widget.options["step"], (int, float)) for widget in number_inputs)


def test_helper_fields_have_visible_labels_and_explanations(
    desktop: TogaDesktop, tmp_path: Path
) -> None:
    tab = ApplicationTab.for_settings(HelperSettings(tmp_path / "config.toml"))

    desktop.present(TabbedContents(application=tab))

    published = tab.helper.publish().fields
    texts = [widget.text for widget in descendants(desktop.window.content)]
    assert all(field.label in texts for field in published)
    assert all(field.help and field.help in texts for field in published)
    help_texts = {field.help for field in published}
    help_labels = [
        widget for widget in descendants(desktop.window.content) if widget.text in help_texts
    ]
    assert all(widget.options["style"]["font_size"] == 11 for widget in help_labels)
    assert all(widget.options["style"]["color"] == "#666666" for widget in help_labels)


def test_each_tab_scrolls_inside_a_bounded_window(desktop: TogaDesktop, tmp_path: Path) -> None:
    tab = ApplicationTab.for_settings(HelperSettings(tmp_path / "config.toml"))
    desktop.present(TabbedContents(application=tab))

    strip = desktop.window.content.children[0]
    assert desktop.window.size == (900, 700)
    assert strip.options["style"]["flex"] == 1
    assert all(pane.kind == "scroll" and pane.options["vertical"] for _, pane in strip.content)
    assert desktop.window.content.children[-1].text == QUIT_LABEL


def test_numeric_lists_use_one_comma_separated_text_field(
    desktop: TogaDesktop, tmp_path: Path
) -> None:
    tab = ApplicationTab.for_settings(HelperSettings(tmp_path / "config.toml"))
    desktop.present(TabbedContents(application=tab))

    field = input_for(desktop.window.content, "Restart delays (seconds)")
    assert field.kind == "text-input"
    assert field.value == "1.0, 2.0, 4.0, 8.0, 16.0"
    assert not any(
        widget.text == "Add Restart delays (seconds)"
        for widget in descendants(desktop.window.content)
    )
    field.value = "1, 2.5, 4"
    labelled(desktop.window.content, SAVE_LABEL).press()
    assert tab.helper.publish().field("restart_backoff").value == (1.0, 2.5, 4.0)


def test_an_invalid_restart_delay_is_refused_without_crashing(
    desktop: TogaDesktop, tmp_path: Path
) -> None:
    tab = ApplicationTab.for_settings(HelperSettings(tmp_path / "config.toml"))
    desktop.present(TabbedContents(application=tab))

    input_for(desktop.window.content, "Restart delays (seconds)").value = "1, soon, 4"
    labelled(desktop.window.content, SAVE_LABEL).press()

    published = tab.helper.publish().field("restart_backoff")
    assert published.value == (1.0, 2.0, 4.0, 8.0, 16.0)
    assert published.error
    assert published.error in [widget.text for widget in descendants(desktop.window.content)]


def test_helper_save_and_cancel_are_in_one_action_row(desktop: TogaDesktop, tmp_path: Path) -> None:
    tab = ApplicationTab.for_settings(HelperSettings(tmp_path / "config.toml"))

    desktop.present(TabbedContents(application=tab))

    action_rows = [
        box
        for box in kinds(desktop.window.content, "box")
        if [child.text for child in box.children] == [SAVE_LABEL, "Cancel"]
    ]
    assert len(action_rows) == 1
    assert action_rows[0].options["style"]["direction"] == "row"


def test_the_stand_in_is_not_hiding_a_real_toolkit() -> None:
    # If Toga ever became an installed dependency of this package, every test above would
    # still pass while proving something else. This is the assertion that would fail first.
    assert load_toolkit() is None, (
        "the window toolkit is installed in this environment; it belongs to the bundle alone "
        "(see `[tool.briefcase]`), and the gate must not depend on it"
    )


def test_the_stand_in_offers_only_what_the_module_uses() -> None:
    # Keeps the stand-in from drifting into a toolkit of its own: every call the module makes
    # on `toga` is one of these, and a new one has to be added here deliberately.
    source = (Path(__file__).resolve().parents[1] / "src/innytypes/helper/toolkit.py").read_text(
        encoding="utf-8"
    )
    used = {
        name
        for name in (
            "App",
            "Window",
            "Box",
            "Label",
            "Button",
            "Switch",
            "OptionContainer",
            "ScrollContainer",
            "TextInput",
            "MultilineTextInput",
            "NumberInput",
            "Selection",
            "PasswordInput",
        )
    }
    called = {name for name in used if f"toga.{name}(" in source}

    assert called == used
    assert isinstance(SimpleNamespace(**{name: getattr(FakeToga(), name) for name in used}), object)
