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
from collections.abc import Callable
from dataclasses import dataclass, field
from types import ModuleType
from typing import Any

from innytypes.anytype_mcp.logs import get_logger
from innytypes.helper.config import BUNDLE_IDENTIFIER
from innytypes.helper.window import (
    APPLY_LABEL,
    ProcessRow,
    UpdateRow,
    WindowContents,
    WindowError,
)

__all__ = [
    "APPLICATION_TITLE",
    "NO_LABEL",
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

# The spacing the window is built with. Small enough to be unremarkable, named so the two
# places that use it cannot drift.
GAP = 8
MARGIN = 12


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

    return Toolkit(toga=toga, pack=style.Pack, column=constants.COLUMN)


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

    # The toolkit objects this desktop owns once it is running.
    app: Any = field(default=None, init=False)
    window: Any = field(default=None, init=False)
    question_window: Any = field(default=None, init=False)

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

    def present(self, contents: WindowContents) -> None:
        """Draw the window from these contents, replacing whatever was drawn before.

        Rebuilt rather than patched, because :class:`~innytypes.helper.window.WindowContents`
        is rebuilt from the world on every draw: a widget tree updated in place would be a
        second model of the same state, and the two would eventually disagree.
        """
        if self.window is None:
            raise WindowError("there is no window to draw in yet; the application has not started")

        self.window.content = self._contents_box(contents)
        self.window.show()

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

    def _contents_box(self, contents: WindowContents) -> Any:
        """The whole window as one column of widgets, in the order the model lists them."""
        toga = self.toolkit.toga
        children: list[Any] = []

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

        # Last, and unconditional, because F1 says turning the application off is never hidden
        # and the model already guarantees a Quit control in every set of contents.
        children.append(
            toga.Button(
                text=contents.quit.label,
                enabled=contents.quit.enabled,
                on_press=self._quit,
            )
        )

        return self._column(children)

    def _column(self, children: list[Any]) -> Any:
        """One vertical box, styled the one way this window styles anything."""
        toga = self.toolkit.toga
        return toga.Box(
            children=children,
            style=self.toolkit.pack(direction=self.toolkit.column, gap=GAP, margin=MARGIN),
        )

    @staticmethod
    def _process_text(row: ProcessRow) -> str:
        """One managed process, as a line: what it is, what it is doing, and why."""
        line = f"{row.child_id} — {row.state}"
        return f"{line} ({row.detail})" if row.detail else line

    @staticmethod
    def _update_text(row: UpdateRow) -> str:
        """One pending update, as a line. The Apply button, if any, is drawn beside it."""
        line = f"{row.subject} {row.version}"
        return f"{line} — {row.detail}" if row.detail else line

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
