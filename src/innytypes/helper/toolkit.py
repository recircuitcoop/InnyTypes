"""The drawing: the window slice 07b modelled, put on a screen by a real toolkit.

Slice 07b landed everything the window *is* — what it shows, what each control does, what
closing means — behind :class:`~innytypes.helper.window.Desktop`, and shipped exactly one
implementation of that seam: :class:`~innytypes.helper.window.HeadlessDesktop`, which renders
nothing and says so. This module is the other implementation. It takes the same
:class:`~innytypes.helper.window.WindowContents` and builds widgets out of them.

**The toolkit is Toga**, BeeWare's own, for one reason that is not taste: Briefcase (F5) is
already this project's packaging, Toga is the toolkit its bundles are built to carry, and a
second GUI stack would mean a second set of platform binaries inside every bundle.

**It is not a dependency of `innytypes`.** Nothing here is imported at module load; the toolkit
is reached through :func:`load_toolkit`, which answers ``None`` when Toga is not installed. So
`pyproject.toml`'s runtime dependencies are unchanged, an unpackaged `pip install innytypes`
pulls no GUI stack, and the gate installs nothing to test this file. What *does* declare Toga is
the Briefcase configuration's `requires`, pinned with `==` like every other runtime pin — it is
a dependency of the **bundle**, which is the only thing that has a screen to draw on.

**No status item, and here that is a refusal rather than an omission** (plan 0003, F4). The
owner's rule is that the controls live only inside the application, never in the system tray.
:meth:`TogaDesktop.add_status_item` is part of the protocol and raises
:class:`~innytypes.helper.window.WindowError` rather than quietly doing nothing, because this is
the implementation that *could* have registered one. The whole-source scan in
`tests/test_application_window.py` covers this file too, so the rule is enforced over the
drawing code and not only over the model.

**The first-launch question is asked in a window, and answered later.** Toga's dialogs resolve
on the event loop, so a blocking "put the question and return the answer" is not something this
toolkit can do from inside a draw. :meth:`TogaDesktop.ask` therefore opens the question with its
privacy notice and returns ``None`` — the value
:class:`~innytypes.helper.window.ApplicationWindow` already means by "nobody answered yet", and
the one that leaves the switch unanswered and the question askable again (F2). The answer,
when it comes, arrives through :attr:`TogaDesktop.on_answer`, which is wired to the same
``set_telemetry`` the switch uses, so a user who presses *Yes* in the question and one who moves
the switch have answered identically.

**Nothing here is exercised against a real screen in the gate**, and nothing pretends
otherwise: the tests drive this class with a stand-in toolkit and assert the widget tree it
builds. What a stand-in cannot prove — that the window actually appears — is proved by building
the bundle and opening it, which is recorded in `docs/log.md` rather than claimed by a test.
"""

from __future__ import annotations

import importlib
import textwrap
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field, replace
from types import ModuleType
from typing import Any, ClassVar

from innytypes.helper.config import BUNDLE_IDENTIFIER
from innytypes.helper.window import (
    APPLY_LABEL,
    PLUGIN_PAGE_TITLE,
    ApplicationTab,
    DrawnField,
    DrawnRow,
    PluginEntry,
    PluginView,
    ProcessRow,
    TabbedContents,
    TabKind,
    TableDrawing,
    UpdateRow,
    WidgetKind,
    WindowContents,
    WindowError,
    draw_fields,
)
from innytypes.logs import get_logger

__all__ = [
    "ADD_LABEL",
    "APPLICATION_TITLE",
    "ENABLED_LABEL",
    "NO_LABEL",
    "REMOVE_LABEL",
    "SAVE_LABEL",
    "SECRET_NOT_SET",
    "SECRET_SET",
    "WINDOW_TITLE",
    "YES_LABEL",
    "TogaDesktop",
    "Toolkit",
    "load_toolkit",
]

log = get_logger(__name__)

# What the user sees: the application's name, not the helper's process name (D27). The same
# string `innytypes.helper.linux` and `innytypes.helper.windows` put under their icons.
APPLICATION_TITLE = "InnyTypes"
WINDOW_TITLE = APPLICATION_TITLE

# The two answers to the first-launch question, spelled once.
YES_LABEL = "Yes, send them"
NO_LABEL = "No, send nothing"

# The words on the plugin page's controls (plan 0004, slice 08). Four of the five actions get
# a control of their own; **Update** reuses the window's `Apply <version>`, so a pending update
# reads the same on the page as it does in the updates section.
ADD_LABEL = "Add a plugin…"
REMOVE_LABEL = "Remove"
SAVE_LABEL = "Save settings"
ENABLED_LABEL = "Enabled"

# What a secret's drawing says about it — the whole of what it is allowed to know (D6). The
# value is never on the page, never in a placeholder and never in one of these two sentences.
SECRET_SET = "A value is stored. Type a new one to replace it."
SECRET_NOT_SET = "No value is stored."

# The spacing the window is built with. Small enough to be unremarkable, named so the two
# places that use it cannot drift.
GAP = 8
MARGIN = 12
# How far one level of a table is drawn in from the level above it. Depth is drawn as
# indentation (plan 0005, D1), and this is the whole of that: one number, applied per level,
# so a table nested three deep needs no third rule.
INDENT = 16
WINDOW_SIZE = (900, 700)
HELP_FONT_SIZE = 11
HELP_COLOR = "#666666"
MESSAGE_WIDTH = 90


@dataclass(frozen=True)
class Toolkit:
    """The pieces of Toga this module uses, resolved once and handed around as a value.

    A value rather than a module-level import, so that this file can be read, type-checked and
    tested on a machine with no GUI stack installed — and so a test can drive it with a
    stand-in without patching import machinery inside every method.
    """

    toga: ModuleType
    pack: type[Any]
    column: str
    row: str = "row"


def load_toolkit() -> Toolkit | None:
    """Toga, if this installation has it; ``None`` if it does not.

    ``None`` is the ordinary case for an unpackaged run and is not an error: the caller falls
    back to :class:`~innytypes.helper.window.HeadlessDesktop`, which is what every test and
    every `pip install` of this package has always used.
    """
    try:
        toga = importlib.import_module("toga")
        style = importlib.import_module("toga.style")
        constants = importlib.import_module("toga.style.pack")
    except ImportError as error:
        log.info("no window toolkit is installed, so InnyTypes draws nothing: %s", error)
        return None

    return Toolkit(toga=toga, pack=style.Pack, column=constants.COLUMN, row=constants.ROW)


@dataclass
class TogaDesktop:
    """A :class:`~innytypes.helper.window.Desktop` that puts the window on the screen.

    Every control's effect is a callable this object was handed, never a decision of its own.
    That is deliberate: the effects are
    :class:`~innytypes.helper.window.ApplicationWindow`'s and are already proved against the
    real launcher, and a toolkit that re-decided any of them would be a second answer to "what
    does Quit do".
    """

    toolkit: Toolkit
    # Each effect returns `object` rather than `None` because the window's methods answer with
    # the row or report they produced, and this desktop ignores all of them: what it draws next
    # comes from re-reading the contents, never from a return value.
    on_quit: Callable[[], object] | None = None
    on_telemetry: Callable[[bool], object] | None = None
    on_launch_at_login: Callable[[bool], object] | None = None
    on_apply: Callable[[UpdateRow], object] | None = None
    on_answer: Callable[[bool], object] | None = None

    # The plugin page's five actions (plan 0004, slice 08). Each one is a callable this object
    # was handed — in practice a :class:`~innytypes.helper.plugins.PluginPage` method — so the
    # drawing decides nothing about what adding, removing, updating, switching or saving does.
    on_add: Callable[[], object] | None = None
    on_remove: Callable[[str], object] | None = None
    on_update: Callable[[str], object] | None = None
    on_enable: Callable[[str, bool], object] | None = None
    on_configure: Callable[[str, dict[str, object]], object] | None = None
    # A `path` field's picker: the plugin, the field and the declared kind in, the chosen
    # path or ``None`` out. A seam like every other effect here, because a file dialog is the
    # toolkit's to open and the answer is the caller's to decide what to do with.
    on_choose_path: Callable[[str, str, str | None], str | None] | None = None

    # The toolkit objects this desktop owns once it is running.
    app: Any = field(default=None, init=False)
    window: Any = field(default=None, init=False)
    question_window: Any = field(default=None, init=False)

    # How to read each drawn field back off its widget, by plugin and field id. Rebuilt with
    # the page on every draw, for the same reason the widgets are: a reader left over from a
    # previous drawing points at a widget nobody can see.
    readers: dict[str, dict[str, Callable[[], object]]] = field(default_factory=dict, init=False)

    # The page as it was last drawn, and every table on it (plan 0005). The view is kept so a
    # row control can draw the page again without asking the host anything: **Add**, Remove,
    # a reorder and the per-row **more** change what is on the screen and nothing on disk, so
    # re-reading the view would answer with the rows before the edit. The tables are kept
    # across that redraw for the same reason, and are replaced by a save that publishes
    # different rows (:func:`~innytypes.helper.window.draw_fields`).
    view: PluginView | None = field(default=None, init=False)
    tables: dict[str, dict[str, TableDrawing]] = field(default_factory=dict, init=False)
    # One model outlives every rebuild of the widget tree.  ``present`` and
    # ``present_plugins`` are the two legacy feeds into it; neither owns selection.
    tabbed: TabbedContents = field(default_factory=TabbedContents, init=False)
    _tabbed_window_started: bool = field(default=False, init=False, repr=False)
    catalogue_message: str | None = field(default=None, init=False)
    helper_values: dict[str, object] = field(default_factory=dict, init=False)

    # --- the application on the desktop ---------------------------------------------------

    def run(self, first_draw: Callable[[], object]) -> None:
        """Create the application and hand it the screen. Returns when the user quits.

        This is the call that does not come back until the application ends, so it is the last
        thing the entry point does.

        **The three hooks are three different moments, and using the right one is the whole of
        this method.** ``startup`` runs before the loop: the toolkit has made the main window
        by then and wants the contents to put in it, so it is handed an empty box — a window
        drawn here would be a window built before anything can run in it. ``on_running`` is the
        first moment the loop is live, so that is where ``first_draw`` goes (in practice
        :meth:`~innytypes.helper.window.ApplicationWindow.open`) and where a caller may
        register signals. ``on_exit`` is the toolkit's own Quit command — ⌘Q, and the Quit in
        the Dock icon's menu — and wiring it is not a detail: without it those two would end
        this process while the host, the MCP server and the plugins kept running. With it,
        every way of quitting runs the one quit (plan 0003, *Turning InnyTypes off*).
        """
        toga = self.toolkit.toga

        def startup(app: Any) -> Any:
            self.window = app.main_window
            self.window.size = WINDOW_SIZE
            return self._column([])

        def running(app: Any, **options: Any) -> None:
            first_draw()

        self.app = toga.App(
            formal_name=APPLICATION_TITLE,
            app_id=BUNDLE_IDENTIFIER,
            startup=startup,
            on_running=running,
            on_exit=self._exiting,
        )
        self.app.main_loop()

    def stop(self) -> None:
        """End the application now, without asking anything else first.

        For the caller that has *already* quit — a caught signal, which records the quit and
        stops every process before it gets here. :meth:`_exiting` is the other direction, where
        the toolkit asks and the quit follows.
        """
        if self.app is not None:
            self.app.exit()

    def on_signal(self, number: int, handler: Callable[[int, Any], None]) -> object:
        """Register one signal handler **on the toolkit's loop** rather than with Python.

        This is the difference between a terminate that quits InnyTypes and one that does
        nothing. A handler installed with ``signal.signal`` runs between Python bytecodes, and
        an application sitting in the operating system's own event loop is executing none: the
        handler waits for a return to Python that a running application does not make, and the
        process survives its own terminate until something kills it outright. The loop's
        registration is delivered by the loop, which is always running.

        It is the ``register`` seam
        :func:`~innytypes.helper.launcher.install_quit_handlers` already takes, so the rule
        about which signals mean a quit stays in one place and is not repeated here.
        """
        if self.app is None:
            raise WindowError("there is no event loop to take signals yet")

        self.app.loop.add_signal_handler(number, handler, number, None)
        return None

    def every(self, seconds: float, work: Callable[[], object]) -> None:
        """Run ``work`` on the toolkit's own loop, over and over, without blocking the drawing.

        This is how the helper's supervision tick
        (:mod:`innytypes.helper.supervision`) runs in the **windowed** application. It is the
        loop's own timer rather than a thread, for the same reason :meth:`on_signal` is the
        loop's own registration: an application sitting in the operating system's event loop
        is running the loop and nothing else, so the loop is the one thing that can be relied
        on to come back. A thread would work too, and would put every widget this tick's
        results are drawn from on the wrong one.

        Each run is scheduled **after** the one before it returns, never on a fixed drumbeat,
        so a slow pass delays the next pass instead of stacking a second one on top of it. A
        pass that raises is still followed by the next: :func:`run_supervision` makes the same
        promise for the loop an installation with no window runs, and the two must not differ
        in whether the helper survives a bad pass.
        """
        if self.app is None:
            raise WindowError("there is no event loop to run this on yet")

        loop = self.app.loop

        def again() -> None:
            try:
                work()
            except Exception as error:  # noqa: BLE001 - there is always a next pass
                log.error("a scheduled pass raised, and the next one is still due: %s", error)
            finally:
                loop.call_later(seconds, again)

        loop.call_soon(again)

    def _exiting(self, app: Any = None, **options: Any) -> bool:
        """What every way of quitting runs: the application's quit, and then the exit.

        Returning ``True`` lets the toolkit finish closing. It is never ``False``: F1 says
        there has to be a clear and easy way of turning InnyTypes off, and an application that
        can refuse its own Quit is not one.
        """
        if self.on_quit is None:
            raise WindowError("this window was built with no way to quit (plan 0003, F1)")

        self.on_quit()
        return True

    def show_application(self) -> None:
        """Put the application in the Dock.

        The Dock entry *is* the application object the toolkit created in :meth:`run`, so there
        is nothing separate to register here — which is exactly why this is logged rather than
        left empty: a reader should be able to see that the absence is the answer.
        """
        log.info("InnyTypes is in the Dock")

    def add_status_item(self, label: str) -> None:
        """Never called, and here it refuses (plan 0003, F4).

        The owner's rule is that InnyTypes' controls live inside its own window. This is the
        implementation with a toolkit behind it — the one that could actually add an icon
        beside the clock — so it is the one where refusing is worth more than recording.
        """
        raise WindowError(
            f"InnyTypes puts nothing in the system tray, so it will not add {label!r} to it; "
            "every control lives in the application's own window (plan 0003, F4)"
        )

    # --- drawing --------------------------------------------------------------------------

    def present(self, contents: WindowContents | TabbedContents) -> None:
        """Draw the window from these contents, replacing whatever was drawn before.

        Rebuilt rather than patched, because :class:`~innytypes.helper.window.WindowContents`
        is rebuilt from the world on every draw: a widget tree updated in place would be a
        second model of the same state, and the two would eventually disagree.
        """
        if self.window is None:
            raise WindowError("there is no window to draw in yet; the application has not started")

        if isinstance(contents, TabbedContents):
            self.tabbed = contents
        else:
            self.tabbed.draw(contents, self.tabbed.installed)
        self._tabbed_window_started = True
        self.window.content = self._contents_box(self.tabbed)
        self.window.show()

    def present_plugins(self, view: PluginView) -> None:
        """Draw the plugin page from the one read-only view the host published.

        Rebuilt whole, like :meth:`present` and for the same reason: the view is read afresh
        on every draw, and a widget tree patched in place would be a second model of it.
        """
        if self.window is None:
            raise WindowError("there is no window to draw in yet; the application has not started")

        self.view = view
        if not self._tabbed_window_started:
            # PluginPage is also a public, independently tested drawing seam.  When it is
            # opened by itself there is no application window to add tabs to, so retain its
            # standalone page drawing.  ApplicationWindow always calls ``present`` first.
            self.readers = {}
            self.window.content = self._plugins_box(view)
            self.window.show()
            return
        if self.tabbed.refresh_application is not None:
            self.tabbed.application = self.tabbed.refresh_application(view)
        self.tabbed.draw(self.tabbed.application, view)
        self.window.content = self._contents_box(self.tabbed)
        self.window.show()

    def select_tab(self, tab_id: str) -> None:
        """Select a tab and redraw the strip from the model's answer."""
        self.tabbed.select(tab_id)
        if self.window is not None and self._tabbed_window_started:
            self.window.content = self._contents_box(self.tabbed)
            self.window.show()

    def _redraw(self) -> None:
        """Draw the page again from the view it was last given, asking the host nothing.

        What a row control changes is on the screen and nowhere else (plan 0005, D5, D6 and
        D7), so there is nothing new to read: the same view is drawn again, and the tables
        carry the rows the person is part-way through editing across it.
        """
        if self.view is not None:
            self.present_plugins(self.view)

    def dismiss(self) -> None:
        """Hide the window. It stops nothing: closing is not quitting."""
        if self.window is not None:
            self.window.hide()

    def ask(self, question: str, notice: str) -> bool | None:
        """Open the first-launch question, and answer ``None`` because nobody has yet.

        The privacy notice is above the question, as F2 requires. The two buttons call
        :attr:`on_answer`; until one of them is pressed the switch stays unanswered, which is
        the state the window already knows how to show and to ask about again.
        """
        toga = self.toolkit.toga
        self.question_window = toga.Window(title=WINDOW_TITLE)
        self.question_window.content = self._column(
            [
                toga.Label(text=notice),
                toga.Label(text=question),
                toga.Button(text=YES_LABEL, on_press=self._answered(True)),
                toga.Button(text=NO_LABEL, on_press=self._answered(False)),
            ]
        )
        self.question_window.show()
        return None

    # --- the widgets ----------------------------------------------------------------------

    def _contents_box(self, contents: TabbedContents) -> Any:
        """One persistent tab strip and the window-level Quit below it."""
        toga = self.toolkit.toga
        self.readers = {}
        panes: list[tuple[str, Any]] = []
        for tab in contents.tabs:
            try:
                pane = (
                    self._application_box(contents.application)
                    if tab.kind is TabKind.APPLICATION
                    else self._plugin_tab_box(tab.plugin)
                )
            except Exception as error:  # noqa: BLE001 - one bad tab never takes the window
                log.error("the %s tab could not be drawn: %s", tab.id, error)
                pane = self._column([toga.Label(text=str(error))])
            panes.append(
                (
                    tab.title,
                    toga.ScrollContainer(
                        content=pane,
                        horizontal=False,
                        vertical=True,
                        style=self.toolkit.pack(flex=1),
                    ),
                )
            )

        strip = toga.OptionContainer(
            content=panes,
            on_select=self._selecting(contents),
            style=self.toolkit.pack(flex=1),
        )
        # Toga's selection is positional.  Assigning it after construction makes the model,
        # rather than a toolkit default, decide what is visible on every redraw.
        strip.current_tab = contents.ids.index(contents.selected_id)
        return self._column(
            [
                strip,
                toga.Button(
                    text=contents.quit.label,
                    enabled=contents.quit.enabled,
                    on_press=self._quit,
                ),
            ]
        )

    def _application_box(self, contents: Any) -> Any:
        """The application's five groups, including the live forms and catalogues."""
        toga = self.toolkit.toga
        children: list[Any] = []

        # WindowContents remains the public flat drawing seam used outside the assembled
        # application. The shipped path hands us ApplicationTab and takes the grouped branch.
        if not isinstance(contents, ApplicationTab):
            for row in contents.processes:
                children.append(toga.Label(text=self._process_text(row)))
            for update in contents.updates:
                children.append(toga.Label(text=self._update_text(update)))
                if update.apply is not None:
                    children.append(
                        toga.Button(
                            text=update.apply.label,
                            enabled=update.apply.enabled,
                            on_press=self._apply(update),
                        )
                    )
            children.append(
                toga.Switch(
                    text=contents.telemetry.label,
                    value=contents.telemetry.on,
                    on_change=self._switched(self.on_telemetry),
                )
            )
            if contents.telemetry.detail:
                children.append(toga.Label(text=contents.telemetry.detail))
            children.append(
                toga.Switch(
                    text=contents.launch_at_login.label,
                    value=contents.launch_at_login.on,
                    on_change=self._switched(self.on_launch_at_login),
                )
            )
            if contents.launch_at_login.detail:
                children.append(toga.Label(text=contents.launch_at_login.detail))
            return self._column(children)

        children.append(toga.Label(text="Running now"))

        for row in contents.processes:
            children.append(toga.Label(text=self._process_text(row)))

        children.append(toga.Label(text="Anytype"))
        children.extend(
            [
                toga.Label(
                    text="Anytype MCP — "
                    + ("running" if contents.anytype.mcp_running else "not running")
                ),
                toga.Label(
                    text="Anytype API key — "
                    + ("set" if contents.anytype.api_key_set else "not set")
                ),
                toga.Label(text=f"Anytype API version — {contents.anytype.anytype_version}"),
                toga.Label(text=f"MCP package version — {contents.anytype.package_version}"),
            ]
        )
        if contents.anytype.mcp_reason:
            children.append(toga.Label(text=contents.anytype.mcp_reason))
        if not contents.anytype.api_key_set and contents.anytype.start_pairing is not None:
            if contents.anytype.pairing_started:
                children.append(toga.Label(text="Enter the four-digit code now shown by Anytype."))
                pairing_code = toga.TextInput(placeholder="Four-digit pairing code")
                children.append(
                    self._row(
                        [
                            pairing_code,
                            toga.Button(
                                text="Finish pairing",
                                on_press=lambda widget: self._finish_pairing(
                                    contents, pairing_code
                                ),
                            ),
                        ]
                    )
                )
            else:
                children.append(
                    toga.Button(
                        text="Start API pairing",
                        on_press=lambda widget: self._start_pairing(contents),
                    )
                )
            if contents.anytype.pairing_message:
                children.extend(self._message_labels(contents.anytype.pairing_message))

        children.append(toga.Label(text="The helper"))
        published_helper = contents.helper.publish()
        for published_field in published_helper.fields:
            self.helper_values.setdefault(published_field.id, published_field.value)
        helper_entry = PluginEntry(plugin_id=contents.helper.addon_id, form=published_helper)
        for drawn in draw_fields(helper_entry):
            drawn = replace(drawn, value=self.helper_values.get(drawn.field_id, drawn.value))
            children.append(self._labelled_field(drawn, depth=1))
        children.append(
            self._row(
                [
                    toga.Button(
                        text=SAVE_LABEL,
                        on_press=lambda widget: self._save_helper(contents),
                    ),
                    toga.Button(
                        text="Cancel",
                        on_press=lambda widget: self._cancel_helper(contents),
                    ),
                ]
            )
        )

        children.append(toga.Label(text="This application"))
        children.append(toga.Label(text=f"Version — {contents.application.version}"))
        for update in contents.application.updates:
            children.append(toga.Label(text=self._update_text(update)))
            if update.apply is not None:
                children.append(
                    toga.Button(
                        text=update.apply.label,
                        enabled=update.apply.enabled,
                        on_press=self._apply(update),
                    )
                )

        children.append(
            toga.Switch(
                text=contents.application.telemetry.label,
                value=contents.application.telemetry.on,
                on_change=self._switched(self.on_telemetry),
            )
        )
        if contents.application.telemetry.detail:
            children.append(toga.Label(text=contents.application.telemetry.detail))

        children.append(
            toga.Switch(
                text=contents.application.launch_at_login.label,
                value=contents.application.launch_at_login.on,
                on_change=self._switched(self.on_launch_at_login),
            )
        )
        if contents.application.launch_at_login.detail:
            children.append(toga.Label(text=contents.application.launch_at_login.detail))

        children.append(toga.Label(text="Plugins"))
        for plugin in contents.installed:
            children.append(toga.Label(text=f"{plugin.plugin_id} — {plugin.state}"))
            children.append(
                toga.Button(
                    text=plugin.remove.label,
                    enabled=plugin.remove.enabled,
                    on_press=self._removing(plugin.plugin_id),
                )
            )
            if plugin.removal_refusal:
                children.append(toga.Label(text=plugin.removal_refusal))
            if plugin.update is not None:
                children.append(toga.Label(text=self._update_text(plugin.update)))
                if plugin.update.apply is not None:
                    children.append(
                        toga.Button(
                            text=plugin.update.apply.label,
                            enabled=plugin.update.apply.enabled,
                            on_press=self._updating(plugin.plugin_id),
                        )
                    )
        if contents.plugin_lists is not None:
            children.extend(self._catalogue_widgets(contents.plugin_lists))

        return self._column(children)

    def _start_pairing(self, contents: ApplicationTab) -> None:
        assert contents.anytype.start_pairing is not None
        accepted, message = contents.anytype.start_pairing()
        contents.anytype.pairing_started = accepted
        contents.anytype.pairing_message = message
        self._redraw_application()

    def _finish_pairing(self, contents: ApplicationTab, code: Any) -> None:
        assert contents.anytype.complete_pairing is not None
        accepted, message = contents.anytype.complete_pairing(str(code.value))
        contents.anytype.api_key_set = accepted
        contents.anytype.pairing_started = not accepted
        contents.anytype.pairing_message = message
        if accepted:
            contents.anytype.mcp_reason = (
                "Pairing complete. Restart InnyTypes to start the MCP server."
            )
        self._redraw_application()

    def _save_helper(self, contents: ApplicationTab) -> None:
        self._fold_helper(contents)
        contents.helper.save(self.helper_values)
        self._redraw_application()

    def _fold_helper(self, contents: ApplicationTab) -> None:
        for field_id, read in self.readers.get(contents.helper.addon_id, {}).items():
            self.helper_values[field_id] = read()

    def _cancel_helper(self, contents: ApplicationTab) -> None:
        self.helper_values = {
            published_field.id: published_field.value
            for published_field in contents.helper.publish().fields
        }
        self._redraw_application()

    def _redraw_application(self) -> None:
        if self.window is not None:
            self.window.content = self._contents_box(self.tabbed)

    def _catalogue_widgets(self, lists: Any) -> list[Any]:
        """Draw every source independently; one failed read remains one visible message."""
        toga = self.toolkit.toga
        widgets: list[Any] = []
        for group in lists.groups:
            if isinstance(group, tuple):
                continue  # the installed list is drawn above from the same tuple
            widgets.append(toga.Label(text=group.title))
            if group.message:
                widgets.extend(self._message_labels(group.message))
            for entry in group.entries:
                mark = " — unverified" if not entry.verified else ""
                widgets.append(
                    toga.Label(
                        text=f"{entry.plugin_id}: {entry.summary} ({entry.source_name}){mark}"
                    )
                )
                widgets.append(
                    toga.Button(
                        text=entry.install.label,
                        enabled=entry.install.enabled,
                        on_press=lambda widget, entry=entry: self._catalogue_action(
                            lists.install_entry(entry)
                        ),
                    )
                )
                if entry.detail:
                    widgets.extend(self._message_labels(entry.detail))
            if group.auto_update is not None:
                widgets.append(
                    toga.Switch(
                        text=group.auto_update.label,
                        value=group.auto_update.on,
                        on_change=lambda widget, name=group.source_name: self._catalogue_action(
                            lists.set_auto_update(name, bool(widget.value))
                        ),
                    )
                )
            if group.remove is not None:
                widgets.append(
                    toga.Button(
                        text=group.remove.label,
                        enabled=group.remove.enabled,
                        on_press=lambda widget, name=group.source_name: self._catalogue_action(
                            lists.remove_source(name)
                        ),
                    )
                )
        widgets.append(toga.Label(text="Register a plugin source"))
        name = toga.TextInput(placeholder="Source name")
        url = toga.TextInput(placeholder="HTTPS URL")
        key = toga.TextInput(placeholder="Minisign public key (optional)")
        widgets.extend(
            [
                name,
                url,
                key,
                toga.Button(
                    text="Register source",
                    on_press=lambda widget: self._catalogue_action(
                        lists.register(
                            str(name.value),
                            str(url.value),
                            public_key=str(key.value).strip() or None,
                        )
                    ),
                ),
            ]
        )
        if self.catalogue_message:
            widgets.extend(self._message_labels(self.catalogue_message))
        return widgets

    def _catalogue_action(self, outcome: Any) -> None:
        self.catalogue_message = outcome.message
        if not outcome.accepted:
            log.error("catalogue action refused: %s", outcome.message)
        self._redraw_application()

    def _plugin_tab_box(self, tab: Any) -> Any:
        """One plugin tab, drawn from and routed back through its model."""
        toga = self.toolkit.toga
        # The old page wiring supplies these actions.  Binding them to the tab means the
        # controls below still route through PluginTab's behaviour instead of reimplementing
        # Save, Cancel, enablement, removal or update in the toolkit.
        tab.configure = tab.configure or self.on_configure
        tab.enable_action = tab.enable_action or self.on_enable
        tab.remove_action = tab.remove_action or self.on_remove
        tab.update_action = tab.update_action or self.on_update

        widgets: list[Any] = [toga.Label(text=self._plugin_text(tab.entry))]
        widgets.append(
            toga.Switch(
                text=ENABLED_LABEL,
                value=tab.enabled,
                on_change=lambda widget: tab.set_enabled(bool(widget.value)),
            )
        )
        if tab.pending_update is not None and tab.pending_update.apply is not None:
            widgets.append(
                toga.Button(
                    text=tab.pending_update.apply.label,
                    enabled=tab.pending_update.apply.enabled,
                    on_press=lambda widget: tab.apply_update(),
                )
            )
        widgets.append(
            toga.Button(
                text=tab.remove_control.label,
                enabled=tab.remove_control.enabled,
                on_press=lambda widget: tab.remove(),
            )
        )
        if tab.detail:
            widgets.extend(self._message_labels(tab.detail))
        for drawn in tab.fields:
            widgets.append(self._labelled_field(drawn))
        if tab.form is not None:
            widgets.append(
                self._row(
                    [
                        toga.Button(
                            text=tab.save_control.label,
                            enabled=tab.save_control.enabled,
                            on_press=lambda widget: self._save_tab(tab),
                        ),
                        toga.Button(
                            text=tab.cancel_control.label,
                            enabled=tab.cancel_control.enabled,
                            on_press=lambda widget: self._cancel_tab(tab),
                        ),
                    ]
                )
            )
        return self._column(widgets)

    def _fold_tab(self, tab: Any) -> None:
        """Fold every scalar and table reader into one plugin's working copy."""
        for field_id, read in list(self.readers.get(tab.plugin_id, {}).items()):
            tab.set_value(field_id, read())

    def _save_tab(self, tab: Any) -> None:
        self._fold_tab(tab)
        tab.save()
        self.tabbed.installed = replace(
            self.tabbed.installed,
            plugins=tuple(
                tab.entry if entry.plugin_id == tab.plugin_id else entry
                for entry in self.tabbed.installed.plugins
            ),
        )
        self.window.content = self._contents_box(self.tabbed)

    def _cancel_tab(self, tab: Any) -> None:
        tab.cancel()
        self.window.content = self._contents_box(self.tabbed)

    def _selecting(self, contents: TabbedContents) -> Callable[[Any], None]:
        """Fold the old pane, ask the model to select, then redraw from its answer."""

        def handle(widget: Any) -> None:
            leaving = contents.selected
            if leaving.kind is TabKind.PLUGIN:
                self._fold_tab(leaving.plugin)
            elif isinstance(contents.application, ApplicationTab):
                self._fold_helper(contents.application)
            position = int(widget.current_tab)
            contents.select(contents.ids[position])
            self.window.content = self._contents_box(contents)

        return handle

    def _column(self, children: list[Any], *, depth: int = 0) -> Any:
        """One vertical box, styled the one way this window styles anything.

        ``depth`` is how deep in a table this box sits, and the only thing it changes is how
        far in it starts: a nested table is drawn under the row that holds it, indented by
        its depth (plan 0005, D1). Everything else about the box is the same at every level,
        which is what keeps one drawing rather than one per depth.
        """
        toga = self.toolkit.toga
        return toga.Box(
            children=children,
            style=self.toolkit.pack(
                direction=self.toolkit.column,
                gap=GAP,
                margin=MARGIN,
                margin_left=MARGIN + depth * INDENT,
            ),
        )

    def _row(self, children: list[Any]) -> Any:
        """A horizontal action row for controls that belong together."""
        return self.toolkit.toga.Box(
            children=children,
            style=self.toolkit.pack(direction=self.toolkit.row, gap=GAP, margin=MARGIN),
        )

    def _message_labels(self, message: str) -> list[Any]:
        """Wrap long diagnostics so one backend error cannot widen the whole window."""
        return [
            self.toolkit.toga.Label(text=line)
            for line in textwrap.wrap(str(message), width=MESSAGE_WIDTH) or [""]
        ]

    def _labelled_field(self, drawn: DrawnField, *, depth: int = 0) -> Any:
        """Draw declaration-owned labels and muted help consistently around one field."""
        if drawn.table is not None:
            return self._field_widget(drawn)
        if drawn.widget is WidgetKind.SWITCH and not drawn.help and not drawn.error:
            return self._field_widget(drawn)
        # A switch already draws its declaration label as part of the control. Repeating it
        # immediately above would make the pane say the same thing twice.
        children = (
            [] if drawn.widget is WidgetKind.SWITCH else [self.toolkit.toga.Label(text=drawn.label)]
        )
        if drawn.help:
            children.append(
                self.toolkit.toga.Label(
                    text=drawn.help,
                    style=self.toolkit.pack(font_size=HELP_FONT_SIZE, color=HELP_COLOR),
                )
            )
        children.append(self._field_widget(drawn))
        if drawn.error:
            children.extend(self._message_labels(drawn.error))
        return self._column(children, depth=depth)

    @staticmethod
    def _process_text(row: ProcessRow) -> str:
        """One managed process, as a line: what it is, what it is doing, and why."""
        names = {
            "innytypes": "InnyTypes host",
            "innytypes.helper": "InnyTypes helper",
            "innytypes.anytype-app": "Anytype",
            "innytypes.anytype_mcp": "Anytype MCP",
        }
        line = f"{names.get(row.child_id, row.child_id)} — {row.state}"
        return f"{line} ({row.detail})" if row.detail else line

    @staticmethod
    def _update_text(row: UpdateRow) -> str:
        """One pending update, as a line. The Apply button, if any, is drawn beside it."""
        line = f"{row.subject} {row.version}"
        return f"{line} — {row.detail}" if row.detail else line

    # --- the plugin page ------------------------------------------------------------------

    def _plugins_box(self, view: PluginView) -> Any:
        """The whole page: a heading, every installed plugin, and the one **Add** control."""
        toga = self.toolkit.toga
        children: list[Any] = [toga.Label(text=PLUGIN_PAGE_TITLE)]

        for entry in view.plugins:
            children.extend(self._plugin_widgets(entry))

        # Last, and once: **Add** is the only control on this page that is not about a plugin
        # already on it, and D12 is why there is no list to browse beside it.
        children.append(toga.Button(text=ADD_LABEL, on_press=self._adding()))
        return self._column(children)

    def _plugin_widgets(self, entry: PluginEntry) -> list[Any]:
        """One installed plugin: what it is, its four controls, and its settings form."""
        toga = self.toolkit.toga
        widgets: list[Any] = [toga.Label(text=self._plugin_text(entry))]

        widgets.append(
            toga.Switch(
                text=ENABLED_LABEL,
                value=entry.enabled,
                on_change=self._enabling(entry.plugin_id),
            )
        )

        pending = entry.pending_update
        if pending is not None and pending.apply is not None:
            widgets.append(
                toga.Button(
                    text=pending.apply.label,
                    enabled=pending.apply.enabled,
                    on_press=self._updating(entry.plugin_id),
                )
            )

        # Drawn whether or not it may be pressed, with the reason under it: a control that
        # refuses when pressed is worse than one that says in advance why it is disabled.
        widgets.append(
            toga.Button(
                text=REMOVE_LABEL,
                enabled=entry.removable,
                on_press=self._removing(entry.plugin_id),
            )
        )
        if entry.removal_refusal:
            widgets.append(toga.Label(text=entry.removal_refusal))

        drawn = draw_fields(entry, tables=self.tables.setdefault(entry.plugin_id, {}))
        for published in drawn:
            # A table draws its own error itself, above the whole table (plan 0005): a reason
            # about twenty rows put under the last of them is not beside what it is about.
            widgets.append(self._labelled_field(published))

        if drawn:
            widgets.append(toga.Button(text=SAVE_LABEL, on_press=self._saving(entry.plugin_id)))

        return widgets

    @staticmethod
    def _plugin_text(entry: PluginEntry) -> str:
        """One plugin's line: what it is, where it came from, and what it is doing."""
        name = entry.plugin_id if entry.version is None else f"{entry.plugin_id} {entry.version}"
        source = "" if entry.source is None else f" ({entry.source})"
        line = f"{name}{source} — {entry.run_state}"
        return f"{line}: {entry.detail}" if entry.detail else line

    # --- the ten drawings ------------------------------------------------------------------

    def _field_widget(self, drawn: DrawnField) -> Any:
        """The widget for one field, or a refusal naming the type that has none.

        Looked up in :data:`_WIDGETS` rather than decided by a chain of comparisons, so that
        "every one of the vocabulary's ten types has a drawing" is one table a test can hold
        the vocabulary to — and so a type whose drawing is removed fails loudly here instead
        of quietly vanishing from the form.
        """
        builder = self._WIDGETS.get(drawn.widget)
        if builder is None:
            raise WindowError(
                f"{drawn.field_id} is declared {drawn.type!r} and this toolkit has no "
                f"{drawn.widget} to draw it with"
            )
        return getattr(self, builder)(drawn)

    def _text_input(self, drawn: DrawnField) -> Any:
        """`text`: one line to type in."""
        return self._reading(
            drawn,
            self.toolkit.toga.TextInput(
                value=_as_text(drawn.value),
                placeholder=drawn.label,
                readonly=not drawn.editable,
            ),
            lambda widget: widget.value,
        )

    def _multiline_text_input(self, drawn: DrawnField) -> Any:
        """`paragraph`: many lines, which is a different thing to type into than one."""
        return self._reading(
            drawn,
            self.toolkit.toga.MultilineTextInput(
                value=_as_text(drawn.value),
                placeholder=drawn.label,
                readonly=not drawn.editable,
            ),
            lambda widget: widget.value,
        )

    def _number_input(self, drawn: DrawnField) -> Any:
        """`number`: a spinner carrying the declaration's own bounds and step."""
        # Toga rejects ``step=None`` while the declaration vocabulary deliberately uses
        # ``None`` for an unconstrained number.  A small numeric fallback keeps fractional
        # helper values typeable without weakening the declaration/store validation.
        step = drawn.step if drawn.step is not None else 0.001
        return self._reading(
            drawn,
            self.toolkit.toga.NumberInput(
                value=drawn.value,
                min=drawn.min,
                max=drawn.max,
                step=step,
                readonly=not drawn.editable,
            ),
            lambda widget: widget.value,
        )

    def _switch(self, drawn: DrawnField) -> Any:
        """`switch`: on or off, labelled with the field rather than with a value."""
        return self._reading(
            drawn,
            self.toolkit.toga.Switch(
                text=drawn.label,
                value=bool(drawn.value),
                enabled=drawn.editable,
            ),
            lambda widget: bool(widget.value),
        )

    def _selection(self, drawn: DrawnField) -> Any:
        """`choice`: one of the declared options, and never anything else."""
        return self._reading(
            drawn,
            self.toolkit.toga.Selection(
                items=list(drawn.options or ()),
                value=drawn.value,
                enabled=drawn.editable,
            ),
            lambda widget: widget.value,
        )

    def _checkbox_group(self, drawn: DrawnField) -> Any:
        """`multiple-choice`: one box per option, because any number of them may be on.

        A multi-select list would hide the options that do not fit; a column of switches shows
        every option the plugin declared, which is what the declaration is for.
        """
        toga = self.toolkit.toga
        chosen = set(_as_values(drawn.value))
        boxes = [
            toga.Switch(text=option, value=option in chosen, enabled=drawn.editable)
            for option in drawn.options or ()
        ]
        return self._reading(
            drawn,
            self._column(boxes),
            lambda widget: tuple(box.text for box in boxes if box.value),
        )

    def _path_picker(self, drawn: DrawnField) -> Any:
        """`path`: what is chosen, and the picker the declaration's `kind` decides.

        A file picker or a folder picker, never "either" — which is why `kind` is a
        constraint a `path` must declare (plan 0004, *What the declaration says exactly*).
        """
        toga = self.toolkit.toga
        chosen = toga.Label(text=_as_text(drawn.value))
        picker = toga.Button(
            text=f"Choose a {drawn.path_kind}…",
            enabled=drawn.editable,
            on_press=self._choosing(drawn, chosen),
        )
        return self._reading(drawn, self._column([chosen, picker]), lambda widget: chosen.text)

    def _password_input(self, drawn: DrawnField) -> Any:
        """`secret`: a box that shows nothing back, and one sentence about whether it is set.

        **The value is never here** (D6). Not in the box, not in the placeholder, not in the
        sentence: the form does not publish it, and this drawing could not show it if it did.
        An empty box means "leave it as it is", so a person who opens the page and saves does
        not wipe a credential they never touched.
        """
        toga = self.toolkit.toga
        box = toga.PasswordInput(
            value=None,
            placeholder=drawn.label,
            readonly=not drawn.editable,
        )
        told = toga.Label(text=SECRET_SET if drawn.secret_is_set else SECRET_NOT_SET)
        return self._reading(drawn, self._column([box, told]), lambda widget: box.value)

    def _repeating_list(self, drawn: DrawnField) -> Any:
        """`list of <type>`: the element type's own widget, once per value, and an **Add**.

        The one composed drawing. A list is not a widget of its own — it is however many of
        the element's widget there are values, which is why the element type has to be
        drawable before the list is.
        """
        toga = self.toolkit.toga
        if drawn.element is None:
            raise WindowError(f"{drawn.field_id} is a list with no element type to draw")

        if drawn.element is WidgetKind.NUMBER:
            box = toga.TextInput(
                value=", ".join(str(value) for value in _as_values(drawn.value)),
                placeholder=drawn.label,
                readonly=not drawn.editable,
            )

            def comma_separated(widget: Any) -> tuple[object, ...]:
                values: list[object] = []
                for token in str(widget.value).split(","):
                    token = token.strip()
                    if not token:
                        continue
                    try:
                        values.append(float(token))
                    except ValueError:
                        values.append(token)
                return tuple(values)

            return self._reading(drawn, box, comma_separated)

        readers: list[Callable[[], object]] = []
        elements: list[Any] = []
        for value in _as_values(drawn.value):
            element = replace(drawn, widget=drawn.element, element=None, value=value)
            widget, read = self._aside(element)
            elements.append(widget)
            readers.append(read)

        elements.append(toga.Button(text=f"Add {drawn.label}", enabled=drawn.editable))
        return self._reading(
            drawn,
            self._column(elements),
            lambda widget: tuple(read() for read in readers),
        )

    def _row_outline(self, drawn: DrawnField) -> Any:
        """`table`: an outline of rows that expand, drawn cell by cell (plan 0005, D1).

        The one drawing that is not a control. A table nests, so it is a tree of boxes: one
        per row, one per nested group under a row, and each cell inside them drawn by the
        widget its own column's type already has. What a control does to it is
        :class:`~innytypes.helper.window.TableDrawing`'s, and reading it back is one call to
        that same object — so the widgets are a view of the rows and never a second copy.
        """
        toga = self.toolkit.toga
        table = drawn.table
        if table is None:
            raise WindowError(f"{drawn.field_id} is a table with no rows to draw")

        # Every cell on the screen, by the row it belongs to, flattened across the whole
        # tree: reading the table is putting all of them back into the rows and then asking
        # the rows what they hold, which is what makes a cell behind a **more** survive a
        # save it was not on the screen for (D7).
        cells: list[tuple[TableDrawing, int, dict[str, Callable[[], object]]]] = []

        children: list[Any] = []
        if table.error:
            # Once, above the table — never repeated per row, and never merged into a cell's
            # own reason (plan 0005, "Drawing it").
            children.append(toga.Label(text=table.error))
        children.extend(self._table_widgets(table, cells))

        return self._reading(
            drawn,
            self._column(children),
            lambda widget: self._table_values(table, cells),
        )

    def _table_widgets(
        self,
        table: TableDrawing,
        cells: list[tuple[TableDrawing, int, dict[str, Callable[[], object]]]],
    ) -> list[Any]:
        """One table's rows and its **Add**, at whatever depth this table is."""
        toga = self.toolkit.toga
        widgets: list[Any] = [self._row_widget(table, row, cells) for row in table.drawn]
        widgets.append(
            toga.Button(
                text=table.add.label,
                enabled=table.add.enabled,
                on_press=self._adding_row(table),
            )
        )
        return widgets

    def _row_widget(
        self,
        table: TableDrawing,
        row: DrawnRow,
        cells: list[tuple[TableDrawing, int, dict[str, Callable[[], object]]]],
    ) -> Any:
        """One row: its handle, its cells and their reasons, its controls, and what is under it."""
        toga = self.toolkit.toga
        children: list[Any] = []
        readers: dict[str, Callable[[], object]] = {}
        cells.append((table, row.position, readers))

        # A collapsed group shows each of its rows by its first column alone, so a deep
        # declaration stays readable (plan 0005, "Drawing it").
        if table.collapsed:
            children.extend(self._cell_widget(cell, readers) for cell in row.cells)
            return self._column(children, depth=row.depth)

        # One arrow per direction, on the row itself (D6). The arrow at a table's end is
        # drawn disabled rather than left out, so a row's controls stay in the same places as
        # it travels.
        children.append(
            toga.Button(
                text=row.up.label,
                enabled=row.up.enabled,
                on_press=self._moving(table, row.position, up=True),
            )
        )
        children.append(
            toga.Button(
                text=row.down.label,
                enabled=row.down.enabled,
                on_press=self._moving(table, row.position, up=False),
            )
        )
        for cell in row.cells:
            children.append(self._cell_widget(cell, readers))
            if cell.error:
                # Immediately beside the cell it is about, which is the whole of where a
                # cell's reason goes.
                children.append(toga.Label(text=cell.error))

        if row.more is not None:
            children.append(
                toga.Button(text=row.more.label, on_press=self._more(table, row.position))
            )
        children.append(
            toga.Button(
                text=row.remove.label,
                enabled=row.remove.enabled,
                on_press=self._removing_row(table, row.position),
            )
        )
        if row.question is not None and row.confirm is not None and row.keep is not None:
            # D5: the row is still there, and it stays there until this is answered.
            children.append(toga.Label(text=row.question))
            children.append(
                toga.Button(
                    text=row.confirm.label,
                    on_press=self._confirming_removal(table, row.position),
                )
            )
            children.append(
                toga.Button(text=row.keep.label, on_press=self._keeping_row(table, row.position))
            )
        if row.error:
            children.append(toga.Label(text=row.error))

        for nested in row.tables:
            children.append(self._group_widget(nested, cells))

        return self._column(children, depth=row.depth)

    def _group_widget(
        self,
        table: TableDrawing,
        cells: list[tuple[TableDrawing, int, dict[str, Callable[[], object]]]],
    ) -> Any:
        """One nested table: a collapsible group under the row that holds it, indented by depth."""
        toga = self.toolkit.toga
        children: list[Any] = [toga.Label(text=table.label)]

        group = table.group
        if group is not None:
            children.append(
                toga.Button(
                    text=group.label,
                    enabled=group.enabled,
                    on_press=self._grouping(table),
                )
            )

        children.extend(self._table_widgets(table, cells))
        return self._column(children, depth=table.depth)

    def _cell_widget(self, cell: DrawnField, readers: dict[str, Callable[[], object]]) -> Any:
        """One cell, drawn by its column's own widget and read back under its column id."""
        widget, read = self._aside(cell)
        readers[cell.field_id] = read
        return widget

    @staticmethod
    def _table_values(
        table: TableDrawing,
        cells: list[tuple[TableDrawing, int, dict[str, Callable[[], object]]]],
    ) -> tuple[Mapping[str, object], ...]:
        """Put every cell on the screen back into its row, then answer with what the rows hold.

        Two steps rather than one, and the order is the point. The widgets know what was
        typed and the rows know everything else — the cells behind a **more**, the order a
        drag left them in, the rows that were added — so the screen is folded into the rows
        and the rows are what a save carries.
        """
        for owner, position, readers in cells:
            owner.take_row(position, {column: read() for column, read in readers.items()})
        return table.values()

    # Every :class:`~innytypes.helper.window.WidgetKind` and the method that draws it. The
    # table is the assertion: `tests/test_plugin_page.py` holds it to the whole vocabulary, so
    # a field type whose drawing is deleted fails the gate rather than disappearing from a
    # form nobody noticed was short.
    _WIDGETS: ClassVar[Mapping[WidgetKind, str]] = {
        WidgetKind.TEXT: "_text_input",
        WidgetKind.PARAGRAPH: "_multiline_text_input",
        WidgetKind.NUMBER: "_number_input",
        WidgetKind.SWITCH: "_switch",
        WidgetKind.CHOICE: "_selection",
        WidgetKind.MULTIPLE_CHOICE: "_checkbox_group",
        WidgetKind.PATH: "_path_picker",
        WidgetKind.SECRET: "_password_input",
        WidgetKind.LIST: "_repeating_list",
        WidgetKind.TABLE: "_row_outline",
    }

    # --- what the controls do -------------------------------------------------------------

    def _quit(self, widget: Any = None) -> None:
        """**Quit InnyTypes**: the whole application off, and this process with it.

        Asked of the toolkit rather than done here, so that the button, ⌘Q and the Dock's Quit
        are one path and not three: the toolkit runs :meth:`_exiting`, which runs the quit, and
        then ends the process. Pressing this while there is no toolkit — which only happens in
        a test — runs the same quit directly.
        """
        if self.app is None:
            self._exiting()
            return
        self.app.request_exit()

    def _switched(self, effect: Callable[[bool], object] | None) -> Callable[[Any], None]:
        """A toolkit change handler for one switch, reading the value off the widget."""

        def handle(widget: Any) -> None:
            if effect is None:
                log.warning("a switch was moved but this window was built without its effect")
                return
            effect(bool(widget.value))

        return handle

    def _apply(self, row: UpdateRow) -> Callable[[Any], None]:
        """A press handler for one update's Apply button."""

        def handle(widget: Any) -> None:
            if self.on_apply is None:
                raise WindowError(
                    f"this window has no way to {APPLY_LABEL.lower()} {row.subject}: it was "
                    "built without one"
                )
            self.on_apply(row)

        return handle

    # --- the plugin page's controls ---------------------------------------------------------

    def _reading(
        self,
        drawn: DrawnField,
        widget: Any,
        read: Callable[[Any], object],
    ) -> Any:
        """Register how to read one field back off its widget, and return the widget.

        The Save button needs the values that are on screen, and the only thing that knows
        where a value sits is the builder that put it there — so each of the ten records its
        own way of reading it rather than the Save handler having an eleventh opinion.
        """
        self.readers.setdefault(drawn.plugin_id, {})[drawn.field_id] = lambda: read(widget)
        return widget

    def _aside(self, drawn: DrawnField) -> tuple[Any, Callable[[], object]]:
        """Build one widget whose reader belongs to its container rather than to the form.

        Two things are drawn this way: every element of a `list of <type>`, which carries its
        field's own id, and every cell of a table row, which carries its column's id. Both
        would otherwise overwrite one another — and a table column named like a field of the
        form would overwrite *that* — so the reader is taken straight back, whatever it
        displaced is put back, and the container registers the one reader that collects them.
        """
        readers = self.readers.setdefault(drawn.plugin_id, {})
        displaced = readers.get(drawn.field_id)

        widget = self._field_widget(drawn)
        read = readers.pop(drawn.field_id)
        if displaced is not None:
            readers[drawn.field_id] = displaced
        return widget, read

    # --- what a table's own controls do ------------------------------------------------------

    def _commit(self, plugin_id: str) -> None:
        """Fold what is on the screen back into the rows, before the page is drawn again.

        Every reader of a table writes its cells back as it reads them, so asking for the
        values is how what somebody typed survives an **Add** pressed a moment later.
        """
        for read in list(self.readers.get(plugin_id, {}).values()):
            read()

    def _adding_row(self, table: TableDrawing) -> Callable[[Any], None]:
        """A press handler for one table's **Add**, at whatever depth that table is."""

        def handle(widget: Any) -> None:
            self._commit(table.plugin_id)
            table.add_row()
            self._redraw()

        return handle

    def _removing_row(self, table: TableDrawing, position: int) -> Callable[[Any], None]:
        """A press handler for one row's **Remove**, which asks first when it has to (D5)."""

        def handle(widget: Any) -> None:
            self._commit(table.plugin_id)
            table.remove_row(position)
            self._redraw()

        return handle

    def _confirming_removal(self, table: TableDrawing, position: int) -> Callable[[Any], None]:
        """A press handler for the answer that takes a row out after all."""

        def handle(widget: Any) -> None:
            self._commit(table.plugin_id)
            table.confirm_removal(position)
            self._redraw()

        return handle

    def _keeping_row(self, table: TableDrawing, position: int) -> Callable[[Any], None]:
        """A press handler for the other answer: the row stays exactly as it was."""

        def handle(widget: Any) -> None:
            self._commit(table.plugin_id)
            table.keep_row(position)
            self._redraw()

        return handle

    def _moving(self, table: TableDrawing, position: int, *, up: bool) -> Callable[[Any], None]:
        """A press handler for one of a row's two arrows (D6).

        The cells on screen are folded back into their rows first, as every other control
        does: a row that moves must take what the user had just typed into it with it.
        """

        def handle(widget: Any) -> None:
            self._commit(table.plugin_id)
            if up:
                table.move_up(position)
            else:
                table.move_down(position)
            self._redraw()

        return handle

    def _more(self, table: TableDrawing, position: int) -> Callable[[Any], None]:
        """A press handler for one row's **more**, and for the way back from it (D7)."""

        def handle(widget: Any) -> None:
            self._commit(table.plugin_id)
            table.toggle_more(position)
            self._redraw()

        return handle

    def _grouping(self, table: TableDrawing) -> Callable[[Any], None]:
        """A press handler for a nested group's collapse and expand (D1)."""

        def handle(widget: Any) -> None:
            self._commit(table.plugin_id)
            table.toggle_group()
            self._redraw()

        return handle

    def _values_of(self, plugin_id: str) -> dict[str, object]:
        """Everything on this plugin's form right now, by field id.

        A `secret` whose box is empty is **left out** rather than saved as an empty string:
        the box starts empty on every draw because a secret is never shown back, and saving
        what was not typed would clear a credential nobody touched.
        """
        values: dict[str, object] = {}
        for field_id, read in self.readers.get(plugin_id, {}).items():
            value = read()
            if value is None or value == "":
                continue
            values[field_id] = value
        return values

    def _adding(self) -> Callable[[Any], None]:
        """A press handler for the page's one **Add** control."""

        def handle(widget: Any) -> None:
            if self.on_add is None:
                raise WindowError("this page has no way to add a plugin: it was built without one")
            self.on_add()

        return handle

    def _removing(self, plugin_id: str) -> Callable[[Any], None]:
        """A press handler for one plugin's **Remove** control."""

        def handle(widget: Any) -> None:
            if self.on_remove is None:
                raise WindowError(
                    f"this page has no way to remove {plugin_id}: it was built without one"
                )
            self.on_remove(plugin_id)

        return handle

    def _updating(self, plugin_id: str) -> Callable[[Any], None]:
        """A press handler for one plugin's **Apply <version>** control."""

        def handle(widget: Any) -> None:
            if self.on_update is None:
                raise WindowError(
                    f"this page has no way to {APPLY_LABEL.lower()} an update to {plugin_id}: "
                    "it was built without one"
                )
            self.on_update(plugin_id)

        return handle

    def _enabling(self, plugin_id: str) -> Callable[[Any], None]:
        """A change handler for one plugin's enable switch, reading it off the widget."""

        def handle(widget: Any) -> None:
            if self.on_enable is None:
                log.warning("a plugin switch was moved but this page was built without its effect")
                return
            self.on_enable(plugin_id, bool(widget.value))

        return handle

    def _saving(self, plugin_id: str) -> Callable[[Any], None]:
        """A press handler for one plugin's **Save settings** control."""

        def handle(widget: Any) -> None:
            if self.on_configure is None:
                raise WindowError(
                    f"this page has no way to save {plugin_id}'s settings: it was built without one"
                )
            self.on_configure(plugin_id, self._values_of(plugin_id))

        return handle

    def _choosing(self, drawn: DrawnField, chosen: Any) -> Callable[[Any], None]:
        """A press handler for one `path` field's picker, which writes what was chosen."""

        def handle(widget: Any) -> None:
            if self.on_choose_path is None:
                log.warning("a path picker was pressed but this page was built without a dialog")
                return
            answer = self.on_choose_path(drawn.plugin_id, drawn.field_id, drawn.path_kind)
            if answer is not None:
                chosen.text = answer

        return handle

    def _answered(self, enabled: bool) -> Callable[[Any], None]:
        """A press handler for one of the first-launch question's two answers."""

        def handle(widget: Any) -> None:
            if self.question_window is not None:
                self.question_window.close()
                self.question_window = None
            if self.on_answer is None:
                log.warning("the first-launch question was answered with nowhere to put it")
                return
            self.on_answer(enabled)

        return handle


def _as_text(value: object | None) -> str:
    """One value as the string a text-shaped widget is filled with. Nothing is ``""``."""
    return "" if value is None else str(value)


def _as_values(value: object | None) -> tuple[object, ...]:
    """One value as the sequence a repeating widget draws, and ``()`` for nothing.

    A `list of <type>` is recorded as a list and a `multiple-choice` as the options that are
    on, but a value that was **refused** is published as it was recorded (plan 0004) — so a
    list field can hold whatever a person put in the file by hand, and the drawing has to be
    able to put that on the screen for them to correct rather than fall over reading it.
    """
    if value is None:
        return ()
    if isinstance(value, (list, tuple)):
        return tuple(value)
    return (value,)
