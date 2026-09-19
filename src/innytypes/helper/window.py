"""The application's own window: what it shows, what its controls do, and what it never adds.

The owner was explicit about this one (plan 0003, F4): **the controls live only inside the
application, never in the system tray.** InnyTypes has a window and an entry in the Dock
(macOS) or the taskbar (Windows, Linux), like any normal application, and it adds **no** icon
to the macOS menu bar extras, the Windows notification area or the Linux system tray.

That is a rule about something *not* happening, so it is built as one. :class:`Desktop` — the
seam through which this module reaches the operating system — offers
:meth:`Desktop.add_status_item` precisely so that never calling it is a fact a test can assert
rather than a claim a reader has to take on trust. A toolkit will happily give you a status
item; declining it has to be visible, and the way to make declining visible is to have the
capability sitting there unused.

**What the window shows** (:class:`WindowContents`), assembled from state this object is
handed rather than state it goes looking for:

* every managed process and whether it is running, restarting or quarantined, from
  :class:`~innytypes.helper.breaker.ProcessStatus`;
* every installed plugin and whether it is going to run — enabled, disabled by the user, held
  disabled by its settings or quarantined by the helper (plan 0004, *The enable switch*), in
  the one word :func:`~innytypes.helper.enablement.plugin_state` chose;
* the pending core update and every pending plugin update, with an **Apply** control on the
  ones that are waiting for the user — a `manual`-mode plugin, or a core release that may not
  apply itself (:attr:`~innytypes.helper.update.StagedRelease.automatic` false);
* the **telemetry** switch, which has three states and not two, because "not answered yet" is
  not "off" (plan 0003, F2);
* the **launch at login** switch (F7);
* **Quit InnyTypes**, which is in every set of contents this module can produce. The owner's
  other hard requirement (F1) is that turning the application off is never hidden, and a
  control that is conditionally present is a control that is sometimes hidden.

**The plugin page** (plan 0004, slice 08) is the other half of this module. It lists every
*installed* plugin — never an index to browse (D12) — and it draws from exactly one thing:
:class:`PluginView`, the read-only view the host publishes, holding per plugin its identity,
where it came from, whether it is enabled, what it is doing, any pending update, whether it
can be removed, and its settings form. The window composes none of that from three modules
and reads no manifest, no lock and no environment itself. The five actions on the page — add,
remove, update, enable/disable, configure — each drive one call that already exists
(:mod:`innytypes.helper.plugins`). The drawing is :func:`draw_fields`, which turns a published
form into one widget per field: all ten of the vocabulary's field types have one — D1's nine
and plan 0005's `table`, whose drawing is an outline of rows rather than a control — and a
type with none
stops the drawing by name rather than being quietly skipped. :meth:`ApplicationWindow.open`
draws the page beside the contents when it was given one (:class:`PluginsPage`), which is how
an installed plugin reaches the screen of the application a person opens.

**Every one of those sources is optional to the code and none of them is optional to the
user.** :attr:`ApplicationWindow.unfilled` says which were left out, from this class's own
signature, because the application shipped with all of them left out: the process list, the
plugin page, the pending updates and the usage report were built, drawn and tested, and the
entry point passed none of them, so the window on screen held two switches and Quit (plan
0004, slice 11).

**Closing is not quitting.** :meth:`ApplicationWindow.close` hides the window and does
nothing else — it stops no process, it writes no quit record, and it never reaches the quit
path. Quitting is :meth:`ApplicationWindow.quit`, and that is the only method here that ends
anything. Clicking the icon while the application already runs calls :meth:`reopen`, which is
what slice 07's single-instance lock has been calling through its ``show_window`` seam since
it landed: a second launch brings this window back rather than starting a second application.

**The first-launch question** (F2) is asked from :meth:`ApplicationWindow.open`, once, with
:data:`~innytypes.helper.telemetry.PRIVACY_NOTICE` in front of it, and the answer goes into
`config.toml`. Until it is answered nothing telemetry-related happens at all: the usage
snapshot this window would report is passed to :class:`~innytypes.helper.telemetry.
TelemetryPipeline`, whose gate re-reads the switch and refuses to queue — and a question the
user dismissed without answering leaves the switch unanswered, so it is asked again next time
rather than being read as a "no".

**What is real here and what is a seam, said plainly.** Everything above is real: the
contents, the plugin view, the state that fills them, every control's effect, the question and
where its answer is stored. What this module does **not** do is put a pixel on a screen.
:class:`HeadlessDesktop` is a complete, working :class:`Desktop` that renders nothing — it
records what it was asked to show, down to the widget each settings field would get, and logs
it. The :class:`Desktop` that builds real widgets is
:class:`~innytypes.helper.toolkit.TogaDesktop`, and it lives with the BeeWare Briefcase bundle
(F5) because a Dock entry and a window belong to an installed application. So this module is
the window's model and its behaviour; the drawing reads from it and decides nothing of its own.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, MutableMapping, Sequence
from dataclasses import dataclass, field
from enum import StrEnum
from inspect import signature
from typing import Final, Protocol

from innytypes.addons.manifest import SettingsField
from innytypes.addons.settings import CellAddress, PluginAvailability, RowAt, row_name
from innytypes.addons.settings_form import FormField, FormRow, PublishedForm

# Aliased: `innytypes.helper.versions` already calls its own enum `PluginState`, and that one
# is about a plugin's *update*. This one is about whether the plugin runs at all.
from innytypes.addons.settings_form import PluginState as AvailabilityState
from innytypes.anytype_mcp.logs import get_logger
from innytypes.helper.breaker import ProcessStatus, RunState
from innytypes.helper.config import HelperSettings, Telemetry, UpdateMode
from innytypes.helper.launcher import (
    LaunchAtLogin,
    LaunchAtLoginError,
    QuitReason,
    QuitReport,
)
from innytypes.helper.telemetry import (
    FIRST_LAUNCH_QUESTION,
    PRIVACY_NOTICE,
    TelemetryPipeline,
    UsageSnapshot,
    answer_first_launch_question,
    question_is_unanswered,
)
from innytypes.helper.update import StagedRelease
from innytypes.helper.versions import PluginReport, PluginState

__all__ = [
    "APPLY_LABEL",
    "CORE_SUBJECT",
    "FIELD_WIDGETS",
    "GROUP_COLLAPSE_LABEL",
    "GROUP_EXPAND_LABEL",
    "LAUNCH_AT_LOGIN_LABEL",
    "PLUGIN_PAGE_TITLE",
    "QUIT_LABEL",
    "ROW_ADD_LABEL",
    "ROW_DOWN_LABEL",
    "ROW_FEWER_LABEL",
    "ROW_KEEP_LABEL",
    "ROW_MORE_LABEL",
    "ROW_UP_LABEL",
    "ROW_REMOVE_LABEL",
    "ROW_REMOVE_NOW_LABEL",
    "SHOWN_COLUMNS",
    "TELEMETRY_LABEL",
    "ApplicationWindow",
    "Control",
    "Declared",
    "Desktop",
    "DrawnField",
    "DrawnRow",
    "Element",
    "HeadlessDesktop",
    "PluginEntry",
    "PluginRow",
    "PluginRunState",
    "PluginSource",
    "PluginView",
    "PluginsPage",
    "ProcessRow",
    "SwitchRow",
    "SwitchState",
    "TableDrawing",
    "TableRow",
    "UpdateKind",
    "UpdateRow",
    "WidgetKind",
    "WindowContents",
    "WindowError",
    "draw_fields",
    "element_widget_for",
    "pending_update_row",
    "run_state_for",
    "table_drawing",
    "widget_for",
]

log = get_logger(__name__)


# The words on the controls, spelled once. "Quit InnyTypes" is the plan's own wording for the
# item the owner said must never be hidden, so it is a constant rather than a literal that
# could drift away from the document that requires it.
QUIT_LABEL = "Quit InnyTypes"
TELEMETRY_LABEL = "Send usage and error reports"
LAUNCH_AT_LOGIN_LABEL = "Start InnyTypes at login"
APPLY_LABEL = "Apply"

# The words on a table's own controls (plan 0005). A row is never called "row": **Add** says
# what the plugin calls a row — "Add recorder" — and so does every sentence about one, which
# is the whole reason `row_label` has no default (plan 0005, slice 01).
ROW_ADD_LABEL = "Add"
ROW_REMOVE_LABEL = "Remove"
# The two halves of D5's question, shown on the row rather than in a dialog: a toolkit's own
# dialog resolves on the event loop and could not answer a call that has to return now.
ROW_REMOVE_NOW_LABEL = "Remove it"
ROW_KEEP_LABEL = "Keep it"
# D7's per-row **more**, and the way back from it.
ROW_MORE_LABEL = "More"
ROW_FEWER_LABEL = "Fewer"
# D6's reorder, as the owner settled it: an arrow per direction, on the row itself. A drag
# gesture is what a toolkit with drag-and-drop would offer; two presses standing in for one
# drag was worse than either, so the row carries the two moves it can actually make and the
# arrow that would do nothing is disabled rather than absent.
ROW_UP_LABEL = "Move up"
ROW_DOWN_LABEL = "Move down"
# A nested table is a group that collapses, because D1 makes a declaration a tree.
GROUP_COLLAPSE_LABEL = "Collapse"
GROUP_EXPAND_LABEL = "Expand"

# How many of a row's columns are drawn before the rest go behind its **more** (D7). Named
# once, because the model that decides which cells exist and the drawing that puts them on the
# screen must not be able to disagree about it. Three rather than eight: monty's own record has
# eight columns, and eight widgets on one line is the window D7 exists to prevent.
SHOWN_COLUMNS: Final = 3

# The heading of the page slice 08 adds. Every plugin the user has, and nothing they could
# have: the page lists installations, never an index to browse (plan 0004, D12).
PLUGIN_PAGE_TITLE = "Plugins"

# What a core update is called in the window. Plugins are named by their id; the core has no
# id of its own in any of the helper's structures, and "InnyTypes" is what the user calls it.
CORE_SUBJECT = "InnyTypes"


class WindowError(RuntimeError):
    """Raised when the window is asked for something it has no control for."""


class Element(StrEnum):
    """The parts of the window, named so a test can ask which of them a set of contents has.

    The last three are in every set of contents this module produces. The first two describe
    things that may genuinely not exist — no process is being managed yet, nothing is waiting
    to be updated — and a section for nothing is a section about nothing.
    """

    PROCESSES = "processes"
    PLUGINS = "plugins"
    UPDATES = "updates"
    TELEMETRY = "telemetry"
    LAUNCH_AT_LOGIN = "launch-at-login"
    QUIT = "quit"


class SwitchState(StrEnum):
    """What a switch in the window reads.

    :data:`UNANSWERED` exists for telemetry alone and is the point of F2: before the
    first-launch question has been answered the switch is not off, it is unanswered, and the
    window has to be able to say so rather than showing a "no" the user never gave.
    """

    ON = "on"
    OFF = "off"
    UNANSWERED = "unanswered"


class UpdateKind(StrEnum):
    """Whether a pending update is the application itself or one of its plugins."""

    CORE = "core"
    PLUGIN = "plugin"


@dataclass(frozen=True)
class Control:
    """One thing the user can press, and whether pressing it would do anything."""

    label: str
    enabled: bool = True


@dataclass(frozen=True)
class ProcessRow:
    """One managed process as the window shows it: what it is, and what it is doing."""

    child_id: str
    state: RunState
    # Why the helper last had to act on it — the quarantine reason, or the last exit. `None`
    # for a process that has simply been running.
    detail: str | None = None

    @classmethod
    def of(cls, status: ProcessStatus) -> ProcessRow:
        """One row from the status the breaker already produces for `helper status`.

        Reusing that structure rather than defining a parallel one is deliberate: the window
        and the command line must never be able to disagree about whether something is
        quarantined.
        """
        return cls(child_id=status.child_id, state=status.state, detail=status.last_reason)


@dataclass(frozen=True)
class PluginRow:
    """One installed plugin as the window shows it: the one word for it, and the sentence.

    Separate from :class:`ProcessRow` because the two answer different questions. A process
    row says what a process is *doing* — running, restarting, quarantined — and only exists
    while there is a process. This row says whether the plugin is going to run at all, which
    is a question a plugin nobody has started still has an answer to, and the three ways of
    being off need three different remedies (plan 0004, *The enable switch*):
    :attr:`~innytypes.addons.settings.PluginAvailability.DISABLED` is the switch,
    :attr:`~innytypes.addons.settings.PluginAvailability.QUARANTINED` is `helper release`,
    and :attr:`~innytypes.addons.settings.PluginAvailability.HELD` is the settings form.

    The word is never computed here: it comes from
    :func:`innytypes.helper.enablement.plugin_state`, so the window and `helper status`
    cannot disagree about which of the three a plugin is in.
    """

    plugin_id: str
    availability: PluginAvailability
    # Why it is in that state, when the state has a reason worth reading: the quarantine's
    # reason, or the fields that are holding it disabled. `None` for a plugin that is simply
    # enabled.
    detail: str | None = None

    @property
    def enabled(self) -> bool:
        """Whether the user's switch is on — which is not the same as "it is running"."""
        return self.availability is not PluginAvailability.DISABLED


@dataclass(frozen=True)
class UpdateRow:
    """One update waiting to happen, and whether the user is the one who has to say so.

    ``apply`` is present exactly when this update is waiting for a decision — a `manual`-mode
    plugin, or a core release that is not allowed to apply itself. An `auto` update has no
    Apply control because there is nothing for the user to do: the helper takes it. A blocked
    one has none either, and ``detail`` carries the reason it is blocked.
    """

    kind: UpdateKind
    subject: str
    version: str
    apply: Control | None = None
    detail: str | None = None

    @property
    def waiting_for_the_user(self) -> bool:
        """Whether this update only happens if somebody presses Apply."""
        return self.apply is not None


@dataclass(frozen=True)
class SwitchRow:
    """One switch in the window: what it is called, where it stands, and any refusal."""

    label: str
    state: SwitchState
    # What the window says under the switch — the sentence explaining an unanswered telemetry
    # switch, or the reason the last attempt to move this switch did not take.
    detail: str | None = None

    @property
    def on(self) -> bool:
        """Whether the switch is on. An unanswered switch is not on."""
        return self.state is SwitchState.ON


@dataclass(frozen=True)
class WindowContents:
    """Everything the window shows at one moment.

    A plain value with no behaviour beyond describing itself, which is what lets a test drive
    the window from injected state and assert on what would be drawn without drawing it.
    """

    processes: tuple[ProcessRow, ...] = ()
    plugins: tuple[PluginRow, ...] = ()
    updates: tuple[UpdateRow, ...] = ()
    telemetry: SwitchRow = field(
        default_factory=lambda: SwitchRow(label=TELEMETRY_LABEL, state=SwitchState.UNANSWERED)
    )
    launch_at_login: SwitchRow = field(
        default_factory=lambda: SwitchRow(label=LAUNCH_AT_LOGIN_LABEL, state=SwitchState.OFF)
    )
    quit: Control = field(default_factory=lambda: Control(label=QUIT_LABEL))

    @property
    def elements(self) -> frozenset[Element]:
        """Which parts of the window this set of contents has.

        The two switches and Quit are always in it. Quit especially: F1 asks for a clear and
        easy way of turning the application off, and a Quit that disappears when there is
        nothing else to show is not that.
        """
        present = {Element.TELEMETRY, Element.LAUNCH_AT_LOGIN, Element.QUIT}
        if self.processes:
            present.add(Element.PROCESSES)
        if self.plugins:
            present.add(Element.PLUGINS)
        if self.updates:
            present.add(Element.UPDATES)
        return frozenset(present)

    @property
    def applicable_updates(self) -> tuple[UpdateRow, ...]:
        """The pending updates that have an Apply control."""
        return tuple(row for row in self.updates if row.waiting_for_the_user)

    def plugin(self, plugin_id: str) -> PluginRow | None:
        """One plugin's row, or ``None`` when the window is not showing it."""
        for row in self.plugins:
            if row.plugin_id == plugin_id:
                return row
        return None

    def process(self, child_id: str) -> ProcessRow | None:
        """One process's row, or ``None`` when the window is not showing it."""
        for row in self.processes:
            if row.child_id == child_id:
                return row
        return None

    def update(self, subject: str) -> UpdateRow | None:
        """One update's row by subject — a plugin id, or :data:`CORE_SUBJECT`."""
        for row in self.updates:
            if row.subject == subject:
                return row
        return None


def pending_update_row(report: PluginReport, *, mode: UpdateMode) -> UpdateRow | None:
    """One plugin's pending update as the window shows it, or nothing when none is pending.

    A plugin that is up to date, was not checked, is not updatable or whose source failed is
    not a pending update, and the window is a list of what is waiting rather than a list of
    everything installed — `innytypes addons outdated` is the one that prints every line.

    ``apply`` is present exactly when the update is waiting for a decision: a `manual`-mode
    plugin. An `auto` update has no Apply control because there is nothing for the user to do,
    and a blocked one has none either because pressing it would not be allowed to help.

    A module-level function rather than a method, because both readers of this rule are in
    this file and one of them is the plugin page (slice 08): the updates section and the
    page's per-plugin line must never be able to disagree about whether an update is waiting
    for the user.
    """
    if report.state is PluginState.BLOCKED:
        return UpdateRow(
            kind=UpdateKind.PLUGIN,
            subject=report.id,
            version=report.newest_version or report.target_version,
            detail=report.reason,
        )

    if report.state is not PluginState.AVAILABLE:
        return None

    version = report.target_version
    if mode is UpdateMode.MANUAL:
        return UpdateRow(
            kind=UpdateKind.PLUGIN,
            subject=report.id,
            version=version,
            apply=Control(label=f"{APPLY_LABEL} {version}"),
            detail=f"{report.id} updates manually: this one waits for you.",
        )

    return UpdateRow(
        kind=UpdateKind.PLUGIN,
        subject=report.id,
        version=version,
        detail=f"{report.id} updates automatically; the helper applies this.",
    )


# --- the plugin page: one read-only view, and a drawing for every field type ----------------


class PluginSource(StrEnum):
    """Where an installed plugin came from, in the four words plan 0004's page lists.

    Not the *update* source — that is where new versions would be fetched from
    (:mod:`innytypes.helper.versions`). This is how the installation on this machine got
    here, which is the question a person reading the page is asking: an editable checkout is
    the one whose code can change under the lock, and saying so is the point of the word.
    """

    INDEX = "index"
    PATH = "path"
    EDITABLE = "editable checkout"
    GIT = "git"


class PluginRunState(StrEnum):
    """What the page says one plugin is doing, in one word.

    The four words of :class:`~innytypes.addons.settings.PluginAvailability` answer "is it
    going to run"; these answer "what is it doing", which is the same question with two more
    answers: it is **running** right now, or it is **broken** — the record the host wrote for
    it could not be read, so there is no version, no declaration and no form to show, and
    nothing will start it (:class:`~innytypes.addons.discovery.BrokenAddon`).
    """

    RUNNING = "running"
    STOPPED = "stopped"
    DISABLED = "disabled"
    HELD = "held disabled"
    QUARANTINED = "quarantined"
    BROKEN = "broken"


# How the availability word becomes a run-state word. Spelled as a mapping rather than a
# chain of ifs so that the ranking stays :func:`~innytypes.helper.enablement.plugin_state`'s
# and this module adds nothing to it: whichever word that function chose is the word here.
_RUN_STATES: Final[Mapping[PluginAvailability, PluginRunState]] = {
    PluginAvailability.DISABLED: PluginRunState.DISABLED,
    PluginAvailability.QUARANTINED: PluginRunState.QUARANTINED,
    PluginAvailability.HELD: PluginRunState.HELD,
}


def run_state_for(
    availability: PluginAvailability | None,
    *,
    running: bool,
    broken: bool = False,
) -> PluginRunState:
    """The one word for what a plugin is doing, from what somebody else already decided.

    ``availability`` is :func:`~innytypes.helper.enablement.plugin_state`'s answer and is
    never recomputed here; ``running`` is what the host said when it was asked for its live
    children. A **broken** plugin outranks everything, because a record that could not be
    read is the reason none of the other answers exist.
    """
    if broken or availability is None:
        return PluginRunState.BROKEN

    held_by = _RUN_STATES.get(availability)
    if held_by is not None:
        return held_by

    return PluginRunState.RUNNING if running else PluginRunState.STOPPED


class WidgetKind(StrEnum):
    """The ten drawings, one per field type the vocabulary has.

    The vocabulary is closed precisely so this enum can be: an eleventh field type is a host
    release, and it arrives with the widget that draws it. Ten distinct members rather than,
    say, one "text box" shared by `text`, `paragraph` and `secret`, because the three are
    different things to type into — one line, many lines, and a credential that is never
    shown back.

    :attr:`TABLE` is plan 0005's tenth, and the one whose drawing is not a control at all: a
    table nests (D1), so it is drawn as an outline of rows that expand rather than as a grid.
    """

    TEXT = "text-input"
    PARAGRAPH = "multiline-text-input"
    NUMBER = "number-input"
    SWITCH = "switch"
    CHOICE = "selection"
    MULTIPLE_CHOICE = "checkbox-group"
    PATH = "path-picker"
    SECRET = "password-input"
    LIST = "repeating-list"
    TABLE = "row-outline"


# Every named type and its widget: D1's eight scalars, and plan 0005's `table` beside them
# rather than among them — a table is not a scalar and `list of table` is refused, which is
# why the two never meet in :func:`element_widget_for`. `list of <type>` is not in here: it is
# drawn as a repeating container around the element type's own widget, so it is the one type
# whose drawing is composed rather than named.
FIELD_WIDGETS: Final[Mapping[str, WidgetKind]] = {
    "text": WidgetKind.TEXT,
    "paragraph": WidgetKind.PARAGRAPH,
    "number": WidgetKind.NUMBER,
    "switch": WidgetKind.SWITCH,
    "choice": WidgetKind.CHOICE,
    "multiple-choice": WidgetKind.MULTIPLE_CHOICE,
    "path": WidgetKind.PATH,
    "secret": WidgetKind.SECRET,
    "table": WidgetKind.TABLE,
}


class Declared(Protocol):
    """What :func:`widget_for` needs of a thing to draw: its id, its type, its element type.

    A protocol rather than :class:`~innytypes.addons.settings_form.FormField`, because a
    table's **cells** are drawn from the column declarations the published field carries
    (:class:`~innytypes.addons.manifest.SettingsField`) and a column has to reach the same
    lookup a top-level field does — otherwise a `path` column could get a different widget
    from a `path` field, which is exactly what plan 0005 says must not happen.
    """

    @property
    def id(self) -> str: ...

    @property
    def type(self) -> str: ...

    @property
    def element_type(self) -> str | None: ...


def widget_for(published: Declared) -> WidgetKind:
    """The widget one published field is drawn with, or a refusal naming the type.

    The refusal is the load-bearing half. A field type with no drawing must not be quietly
    skipped, left blank or drawn as a text box that silently mangles it — that is a form the
    user can save and the host then refuses, for a reason nothing on screen explains. So a
    type this window cannot draw stops the drawing and says which type it was.
    """
    if published.element_type is not None:
        return WidgetKind.LIST

    drawing = FIELD_WIDGETS.get(published.type)
    if drawing is None:
        raise WindowError(
            f"{published.id} is declared {published.type!r}, and this window has no widget for "
            f"that type; the types it draws are {', '.join(FIELD_WIDGETS)} and 'list of <type>'"
        )
    return drawing


def element_widget_for(published: Declared) -> WidgetKind | None:
    """The widget each element of a `list of <type>` is drawn with, or ``None``.

    ``None`` for every field that is not a list, which is what makes the two answers together
    a complete description of the drawing: a `list of path` is a repeating container holding
    path pickers, and both halves have to be on the record for the page to be drawable.
    """
    if published.element_type is None:
        return None

    element = FIELD_WIDGETS.get(published.element_type)
    if element is None:
        raise WindowError(
            f"{published.id} is declared {published.type!r}, and this window has no widget for "
            f"its element type {published.element_type!r}"
        )
    return element


@dataclass(frozen=True)
class PluginEntry:
    """One installed plugin's whole line on the page, read from one view and composed nowhere.

    Every optional member is optional for one reason only: a **broken** plugin. Its recorded
    manifest could not be read, so there is no version, no source, no declaration and
    therefore no form — and the page still lists it, because a plugin that is on the machine
    and will not start is the one a person most needs to see.

    ``removable`` and ``removal_refusal`` are :mod:`innytypes.addons.removal`'s own answer,
    asked before the Remove control is drawn rather than after it is pressed: a plugin another
    plugin requires cannot be removed, and a control that refuses when pressed is worse than
    one that says why it is disabled.
    """

    plugin_id: str
    version: str | None = None
    source: PluginSource | None = None
    # The path an editable or local installation came from, or the git URL — the detail behind
    # the word, and ``None`` for an index installation, which has no second fact to give.
    source_detail: str | None = None
    enabled: bool = True
    run_state: PluginRunState = PluginRunState.STOPPED
    # Why it is in that state, when there is a reason worth reading: the quarantine's reason,
    # the fields holding it disabled, or what was wrong with a broken record.
    detail: str | None = None
    pending_update: UpdateRow | None = None
    form: PublishedForm | None = None
    removable: bool = True
    removal_refusal: str | None = None

    @property
    def fields(self) -> tuple[FormField, ...]:
        """The plugin's settings fields, in the manifest's order. Empty for a broken one."""
        return () if self.form is None else self.form.fields

    @property
    def running(self) -> bool:
        """Whether there is a process for this plugin right now."""
        return self.run_state is PluginRunState.RUNNING


@dataclass(frozen=True)
class PluginView:
    """Everything the plugin page draws, in one read-only value (plan 0004).

    The point of this object is what it forbids. The window never composes a plugin's line
    from three different modules and never reads a manifest, a lock or an environment itself:
    it asks for this once and draws it. So the page holds no logic about where a word came
    from, and the host is the only thing that has to be right about it.

    It lists **installed plugins only** (D12). An index entry for something that is not
    installed is not a plugin the user has, and a page that offered it would be a store.
    """

    plugins: tuple[PluginEntry, ...] = ()

    @property
    def ids(self) -> tuple[str, ...]:
        """Every listed plugin's id, in the order the page draws them."""
        return tuple(entry.plugin_id for entry in self.plugins)

    def plugin(self, plugin_id: str) -> PluginEntry | None:
        """One plugin's entry, or ``None`` when the page is not showing it."""
        for entry in self.plugins:
            if entry.plugin_id == plugin_id:
                return entry
        return None


@dataclass(frozen=True)
class DrawnField:
    """One widget the page was asked to put on the screen, as a value a test can read.

    This is what the headless desktop records and what the toolkit-backed one builds its
    widget from, so "there is a drawing for every one of the ten types" is a fact about one
    list rather than a claim about two implementations that could drift.

    ``value`` is what the widget is filled with, and is **always ``None`` for a secret**
    whatever the form says: a secret's value never reaches a widget (D6). ``secret_is_set`` is
    the whole of what a secret's drawing is allowed to know.

    Two members are about plan 0005's `table` and are ``None`` on every other field.
    ``table`` is the outline of rows the drawing puts on the screen and the thing its controls
    act on; ``cell`` is set on a drawn field that **is** a cell of such a row, and is the same
    address the store's refusal and the published form already use — so a cell, the reason
    beside it and the row it is in are one vocabulary rather than three.
    """

    plugin_id: str
    field_id: str
    type: str
    widget: WidgetKind
    element: WidgetKind | None
    label: str
    help: str | None
    group: str | None
    required: bool
    options: tuple[str, ...] | None
    path_kind: str | None
    min: float | None
    max: float | None
    step: float | None
    value: object | None
    secret_is_set: bool
    editable: bool
    error: str | None
    table: TableDrawing | None = None
    cell: CellAddress | None = None


# --- the tenth drawing: a table, which is an outline of rows rather than one widget ---------


@dataclass(frozen=True)
class DrawnRow:
    """One row of a table as it stands on the screen right now, and the controls on it.

    Everything here is derived from :class:`TableDrawing` at the moment it is read, so a row
    that has just been added, removed or moved is described by its **current** place: its
    position counted from one, the name a person sees (`recorder 2`), and the address every
    refusal about it already uses.

    ``cells`` is what is drawn now — the first columns, or every column once the row's
    **more** has been used (D7) — and ``hidden`` names the columns that are behind it. A
    column that is itself a table is in neither: it is in ``tables``, as a group of its own,
    because a table column is drawn as a table and offering it as a cell as well would be two
    drawings of one thing.
    """

    plugin_id: str
    field_id: str
    position: int
    name: str
    address: CellAddress
    depth: int
    cells: tuple[DrawnField, ...]
    hidden: tuple[str, ...]
    tables: tuple[TableDrawing, ...]
    remove: Control
    up: Control
    down: Control
    more: Control | None = None
    # The two halves of D5's question, present only while this row is the one being asked about.
    confirm: Control | None = None
    keep: Control | None = None
    question: str | None = None
    error: str | None = None


@dataclass
class TableRow:
    """One row of a table being edited, and the only mutable thing this module draws from.

    Mutable because a row is the one part of the window a person changes *before* saving:
    **Add**, **Remove** and a reorder alter what is on the screen and reach the store only
    when Save is pressed (plan 0005, D5 and D6). Everything else the window shows is rebuilt
    from the world on every draw, and a table is rebuilt from the world on every draw that
    publishes different rows.
    """

    values: dict[str, object | None] = field(default_factory=dict)
    # Nested tables by the column id that holds them, one per table column of this row.
    tables: dict[str, TableDrawing] = field(default_factory=dict)
    errors: Mapping[str, str] = field(default_factory=dict)
    error: str | None = None
    # D7's per-row **more**: false while only the first columns are drawn.
    expanded: bool = False
    # Set by a Remove that has to ask first (D5), and cleared by either answer.
    confirming: bool = False

    @property
    def empty(self) -> bool:
        """Whether this row holds nothing at all — which is what Remove takes out silently.

        A row with a nested row in it is not empty however blank its own cells are: the thing
        that would be lost is the nested row, and D5 exists so nothing is lost unasked.
        """
        if any(nested.rows for nested in self.tables.values()):
            return False
        return all(_nothing(value) for value in self.values.values())


@dataclass
class TableDrawing:
    """One `table` on the page: the rows as they stand, and everything a control does to them.

    The model of the tenth drawing. A table nests (D1), so this is a **tree**: a row's table
    column holds another :class:`TableDrawing`, indented one level deeper and collapsible on
    its own. Every rule holds at every depth because there is one class at every depth.

    Nothing here touches the store. Add, Remove, the reorder and the per-row **more** change
    what is on the screen; :meth:`values` is what a Save then submits, in the order the rows
    are in at that moment (D6). That split is the whole of why a reorder does not write: the
    page is not a second store, and a row nobody saved is not a recorded row.
    """

    plugin_id: str
    field_id: str
    # The row declaration this table draws from — the same :class:`SettingsField` objects the
    # manifest parsed, so a column's widget is chosen by the one lookup a top-level field uses.
    columns: tuple[SettingsField, ...]
    row_label: str
    label: str
    editable: bool = True
    # What is wrong with the **table**, drawn once above it and never repeated in a row.
    error: str | None = None
    # Where this table is: how deep it is drawn, which column holds it (``None`` at the top),
    # the rows to descend through to reach it, and the name of the row it hangs under. All
    # four are settled by :meth:`_settle` whenever the rows above move, so an address is never
    # left pointing at the place a row used to be.
    depth: int = 0
    column_id: str | None = None
    at: tuple[RowAt, ...] = ()
    parent: str | None = None
    rows: list[TableRow] = field(default_factory=list)
    # A nested group collapses to its rows' first column, so a deep declaration stays readable.
    collapsed: bool = False
    # The published rows this drawing was built from, kept so a redraw can tell an edit in
    # progress from a save that changed what is published (:func:`draw_fields`).
    published: tuple[FormRow, ...] = ()
    # The row a drag has picked up, if any (D6).

    # --- what is in it ---------------------------------------------------------------------

    @property
    def cell_columns(self) -> tuple[SettingsField, ...]:
        """The columns drawn as cells: every declared column that is not itself a table."""
        return tuple(column for column in self.columns if column.row is None)

    @property
    def table_columns(self) -> tuple[SettingsField, ...]:
        """The columns drawn as nested groups under their row (D1)."""
        return tuple(column for column in self.columns if column.row is not None)

    @property
    def add(self) -> Control:
        """The **Add** control, which says what this plugin calls a row rather than "row"."""
        return Control(label=f"{ROW_ADD_LABEL} {self.row_label}", enabled=self.editable)

    @property
    def group(self) -> Control | None:
        """The control that collapses or expands this group, or ``None`` at the top level.

        The top-level table is the field itself and has nothing to collapse into: hiding it
        would hide a setting, which is what `shown_when` is for and this is not.
        """
        if self.column_id is None:
            return None
        return Control(
            label=GROUP_EXPAND_LABEL if self.collapsed else GROUP_COLLAPSE_LABEL,
            enabled=self.editable,
        )

    @property
    def drawn(self) -> tuple[DrawnRow, ...]:
        """Every row as it is drawn right now, in the order it is on the screen."""
        return tuple(self._drawn(position) for position in range(1, len(self.rows) + 1))

    def name_of(self, position: int) -> str:
        """What the row at this position is called, from the store's own naming and not a
        second spelling of it: `recorder 2`, or `(recorder 1).takes (take 2)` inside one."""
        return row_name(self.row_label, position, parent=self.parent, column_id=self.column_id)

    def address_of(self, position: int) -> CellAddress:
        """Where the row at this position is, in the vocabulary a refusal already uses."""
        return CellAddress(path=self.at + (RowAt(self.column_id or self.field_id, position),))

    def question(self, position: int) -> str:
        """What D5 asks before a row that holds something is taken away."""
        return f"{self.name_of(position)} holds values. Remove it?"

    # --- what its controls do --------------------------------------------------------------

    def add_row(self) -> int:
        """Append a row filled with each column's own declared default, and answer where.

        The defaults are the declaration's, judged by slice 01 when the manifest was parsed,
        so **Add** puts the same values in a new row that the store would fill a cell with.
        """
        self.rows.extend(_table_rows(self, (self._blank(),)))
        self._settle()
        return len(self.rows)

    def remove_row(self, position: int) -> bool:
        """Take one row out, or ask first when it is not empty (D5).

        Answers whether the row is gone. A row holding anything is **not** removed by this
        call: it is marked as the one being asked about, and :meth:`confirm_removal` is the
        only thing that takes it out. That is the whole of D5, and it is here rather than in
        a dialog so that both desktops ask it the same way.
        """
        row = self._row(position)
        if row.empty:
            self._take_out(position)
            return True

        row.confirming = True
        return False

    def confirm_removal(self, position: int) -> bool:
        """Remove the row :meth:`remove_row` asked about, and refuse any other."""
        row = self._row(position)
        if not row.confirming:
            raise WindowError(
                f"{self.name_of(position)} was never asked about, so there is nothing to confirm"
            )
        self._take_out(position)
        return True

    def keep_row(self, position: int) -> None:
        """The other answer to D5's question: the row stays exactly as it was."""
        self._row(position).confirming = False

    def move_row(self, frm: int, to: int) -> None:
        """Put the row at ``frm`` where ``to`` is: what each of the two arrows asks for (D6).

        Both places are judged against the table as it stands **now**, before anything moves:
        a row taken out first would make the last position one nobody could drop onto, which
        is the one move a person is most likely to make.
        """
        landing = self._index(to)
        row = self.rows.pop(self._index(frm))
        self.rows.insert(landing, row)
        self._settle()

    def move_up(self, position: int) -> None:
        """Move one row one place towards the top. The top row's arrow does nothing."""
        if self._index(position) == 0:
            return
        self.move_row(position, position - 1)

    def move_down(self, position: int) -> None:
        """Move one row one place towards the bottom. The last row's arrow does nothing."""
        if self._index(position) == len(self.rows) - 1:
            return
        self.move_row(position, position + 1)

    def toggle_more(self, position: int) -> None:
        """Show every column of one row, or go back to the first ones alone (D7)."""
        row = self._row(position)
        row.expanded = not row.expanded

    def toggle_group(self) -> None:
        """Collapse this nested group, or expand it again (D1)."""
        self.collapsed = not self.collapsed

    # --- what a Save carries -----------------------------------------------------------------

    def take_row(self, position: int, values: Mapping[str, object | None]) -> None:
        """Put what is on the screen back into one row, leaving untouched what is not on it.

        A row wider than :data:`SHOWN_COLUMNS` has cells behind its **more** (D7), and those
        are not on the screen to read. They are still in here, so a save carries every column
        of a row rather than only the ones that fitted — and an **Add** keeps whatever the
        person had already typed into the rows above it.
        """
        self._row(position).values.update(values)

    def values(self) -> tuple[Mapping[str, object], ...]:
        """The rows as a save submits them, in the order they are on the screen right now.

        A cell holding nothing is left out rather than submitted empty, exactly as a scalar
        field is: an omitted cell is what the column's own default fills (plan 0005, slice
        02), and an empty string is not a value anybody typed.
        """
        return tuple(self.row_values(position) for position in range(1, len(self.rows) + 1))

    def row_values(self, position: int) -> Mapping[str, object]:
        """One row as a save submits it, with its nested tables submitted inside it."""
        row = self._row(position)
        values: dict[str, object] = {}
        for column in self.columns:
            if column.row is not None:
                nested = row.tables.get(column.id)
                values[column.id] = () if nested is None else nested.values()
                continue
            value = row.values.get(column.id)
            if _nothing(value):
                continue
            values[column.id] = value
        return values

    # --- keeping the tree consistent ----------------------------------------------------------

    def _blank(self) -> Mapping[str, object]:
        """What **Add** starts a row with: every column's own declared default, and nothing else."""
        return {column.id: column.default for column in self.columns if column.default is not None}

    def _drawn(self, position: int) -> DrawnRow:
        """One row, described as it is on the screen at this moment."""
        row = self._row(position)
        address = self.address_of(position)
        shown, hidden = self._columns_of(row)
        asking = row.confirming
        return DrawnRow(
            plugin_id=self.plugin_id,
            field_id=self.field_id,
            position=position,
            name=self.name_of(position),
            address=address,
            depth=self.depth,
            cells=tuple(self._cell(row, column, address) for column in shown),
            hidden=tuple(column.id for column in hidden),
            # A collapsed group shows its rows by their first column alone, so what is under
            # them stays out of the way until somebody expands it again.
            tables=(
                ()
                if self.collapsed
                else tuple(
                    row.tables[column.id]
                    for column in self.table_columns
                    if column.id in row.tables
                )
            ),
            remove=Control(label=ROW_REMOVE_LABEL, enabled=self.editable),
            # Disabled at the ends rather than missing: a row whose arrows move about as it
            # travels up a table is a row a person has to re-find between presses.
            up=Control(label=ROW_UP_LABEL, enabled=self.editable and position > 1),
            down=Control(label=ROW_DOWN_LABEL, enabled=self.editable and position < len(self.rows)),
            more=self._more_control(row, hidden),
            confirm=Control(label=ROW_REMOVE_NOW_LABEL) if asking else None,
            keep=Control(label=ROW_KEEP_LABEL) if asking else None,
            question=self.question(position) if asking else None,
            error=row.error,
        )

    def _more_control(self, row: TableRow, hidden: tuple[SettingsField, ...]) -> Control | None:
        """D7's control, present only on a row that has something to show or to put back."""
        if row.expanded:
            return Control(label=ROW_FEWER_LABEL)
        if not hidden:
            return None
        return Control(label=f"{ROW_MORE_LABEL} ({len(hidden)})")

    def _columns_of(self, row: TableRow) -> tuple[tuple[SettingsField, ...], ...]:
        """Which of this row's cells are drawn, and which sit behind its **more** (D7)."""
        columns = self.cell_columns
        if self.collapsed:
            return columns[:1], ()
        if row.expanded:
            return columns, ()
        return columns[:SHOWN_COLUMNS], columns[SHOWN_COLUMNS:]

    def _cell(self, row: TableRow, column: SettingsField, address: CellAddress) -> DrawnField:
        """One cell, drawn with the exact widget its column's own type already has.

        The same :func:`widget_for` a top-level field goes through, so a `path` column gets
        the picker a `path` field gets and a `choice` column gets that field's options. A
        table adds no widget of its own to the vocabulary; it only repeats the ones there are.
        """
        secret = column.type == "secret" or column.element_type == "secret"
        return DrawnField(
            plugin_id=self.plugin_id,
            field_id=column.id,
            type=column.type,
            widget=widget_for(column),
            element=element_widget_for(column),
            label=column.label,
            help=column.help,
            # A column has no group of its own: the table is what sits in a group of the page.
            group=None,
            required=column.required,
            options=column.options,
            path_kind=column.kind,
            min=column.min,
            max=column.max,
            step=column.step,
            # A `secret` column is refused by the store at any depth (plan 0005, slice 02),
            # and until that refusal is on screen the cell is still drawn — with no value in
            # it, because the rule that no widget is filled from a credential has no depth.
            value=None if secret else row.values.get(column.id),
            secret_is_set=False,
            editable=self.editable,
            # The cell's own reason, beside the cell and nowhere else.
            error=row.errors.get(column.id),
            cell=CellAddress(path=address.path, column=column.id),
        )

    def _index(self, position: int) -> int:
        """One position counted from one, as an index — or a refusal naming the table."""
        if not 1 <= position <= len(self.rows):
            raise WindowError(
                f"{self.field_id} is showing {len(self.rows)} {self.row_label} rows, "
                f"so there is no {self.row_label} {position} to act on"
            )
        return position - 1

    def _row(self, position: int) -> TableRow:
        return self.rows[self._index(position)]

    def _take_out(self, position: int) -> None:
        del self.rows[self._index(position)]
        self._settle()

    def _settle(self) -> None:
        """Tell every nested table where it is now, after the rows above it moved.

        A nested table's address and its row's name are what a refusal and the page both use,
        so they are settled from the one place that knows the order — here — rather than
        derived twice and left to disagree the first time a row was dragged.
        """
        for position in range(1, len(self.rows) + 1):
            row = self.rows[position - 1]
            name = self.name_of(position)
            at = self.address_of(position).path
            for column_id, nested in row.tables.items():
                nested.column_id = column_id
                nested.at = at
                nested.parent = name
                nested.depth = self.depth + 1
                nested._settle()


def table_drawing(published: FormField, *, plugin_id: str) -> TableDrawing:
    """One published `table` as the page draws it, nested as declared and to any depth.

    Built from the published field alone (plan 0005, slice 03: "the whole tree is in one
    publish"), so drawing a table of tables reads no manifest, no store and no lock, and
    needs no second read to reach the depth it is at.
    """
    if published.row is None:
        raise WindowError(
            f"{published.id} is declared {published.type!r} but carries no row declaration, "
            "so there is nothing to draw a row from"
        )

    _drawable(published.row)
    drawing = TableDrawing(
        plugin_id=plugin_id,
        field_id=published.id,
        columns=published.row,
        row_label=published.row_label or published.id,
        label=published.label,
        editable=published.user_editable,
        error=published.error,
        published=published.rows,
    )
    drawing.rows = _table_rows(drawing, published.rows)
    drawing._settle()
    return drawing


def _drawable(columns: tuple[SettingsField, ...]) -> None:
    """Refuse a row declaration this window cannot draw, before any of it is on the screen.

    Asked of the **declaration** rather than of the rows, and at every depth, because a table
    with no rows in it yet has nothing to fail on: the column with no widget would be found
    the moment somebody pressed Add, which is a page that breaks while being used rather than
    one that refuses to be drawn. Same rule as a `list of <type>` whose element type has no
    drawing, one level further down.
    """
    for column in columns:
        if column.row is not None:
            _drawable(column.row)
            continue
        widget_for(column)
        element_widget_for(column)


def _table_rows(table: TableDrawing, source: Sequence[object]) -> list[TableRow]:
    """The rows of one table, from whatever holds them.

    Two sources, one function: the published rows a form hands over
    (:class:`~innytypes.addons.settings_form.FormRow`, which carries the cell errors too),
    and the plain mappings a declared **default** is. They are the same shape read two ways,
    and one function is what keeps a defaulted row and a recorded row being drawn alike.
    """
    rows: list[TableRow] = []

    for item in source:
        if isinstance(item, FormRow):
            held: Mapping[str, object | None] = item.values
            nested: Mapping[str, object] = item.rows
            errors: Mapping[str, str] = item.errors
            error = item.error
        elif isinstance(item, Mapping):
            held = item
            nested = item
            errors = {}
            error = None
        else:
            # A row that is not a mapping is not something with cells to draw. The reason why
            # is already on the field, so nothing is lost by leaving it off the page.
            continue

        rows.append(
            TableRow(
                # Every declared cell, with the column's own default where the row has
                # nothing — which is what the store would hand the plugin for that cell.
                values={
                    column.id: held.get(column.id, column.default) for column in table.cell_columns
                },
                tables={
                    column.id: _nested_table(table, column, nested.get(column.id, ()))
                    for column in table.table_columns
                },
                errors=dict(errors),
                error=error,
            )
        )

    return rows


def _nested_table(table: TableDrawing, column: SettingsField, source: object) -> TableDrawing:
    """One table column as a group of its own, under the row that holds it (D1)."""
    nested = TableDrawing(
        plugin_id=table.plugin_id,
        field_id=table.field_id,
        columns=column.row or (),
        row_label=column.row_label or column.id,
        label=column.label,
        editable=table.editable,
        column_id=column.id,
        depth=table.depth + 1,
    )
    nested.rows = _table_rows(nested, source if isinstance(source, Sequence) else ())
    return nested


def _nothing(value: object | None) -> bool:
    """Whether a cell holds nothing: no value, an empty string, or an empty list of them."""
    return value is None or value == "" or value == () or value == []


def draw_fields(
    entry: PluginEntry, *, tables: MutableMapping[str, TableDrawing] | None = None
) -> tuple[DrawnField, ...]:
    """Everything one plugin's settings form puts on the screen, in the manifest's order.

    **Visibility is the form's answer, not this function's** (D2). A field is drawn when
    :attr:`~innytypes.addons.settings_form.FormField.shown` says so, and nothing here looks at
    the condition or at the value it names: `shown_when` is evaluated by the host, over the
    whole form at once, against the same values the form published. A second evaluation on
    this side would be a second answer, and the two would disagree the moment a value changed
    between the publish and the draw.

    ``tables`` is where a caller that draws the same page twice keeps its tables. A row that
    has been added, removed or dragged is not on disk yet (plan 0005, D5 and D6), so a redraw
    that threw it away would throw away what the person was in the middle of doing — and a
    caller with no ``tables`` of its own draws each table afresh, which is what a single draw
    is anyway.
    """
    if entry.form is None:
        return ()

    return tuple(
        DrawnField(
            plugin_id=entry.plugin_id,
            field_id=published.id,
            type=published.type,
            widget=widget_for(published),
            element=element_widget_for(published),
            label=published.label,
            help=published.help,
            group=published.group,
            required=published.required,
            options=published.options,
            path_kind=published.kind,
            min=published.min,
            max=published.max,
            step=published.step,
            # Never the form's value for a secret, even though the form already keeps one out:
            # the rule that no widget is filled from a credential is enforced where the widget
            # is described, so it holds however the form was built.
            value=None if published.is_secret else published.value,
            secret_is_set=published.secret_is_set,
            editable=published.user_editable,
            error=published.error,
            table=_table_of(entry, published, tables),
        )
        for published in entry.form.fields
        if published.shown
    )


def _table_of(
    entry: PluginEntry,
    published: FormField,
    tables: MutableMapping[str, TableDrawing] | None,
) -> TableDrawing | None:
    """The table this field is drawn as, or ``None`` on every field that is not one.

    A table already on the page is **kept** while what is published for it has not changed,
    which is what lets a person add three rows and fill them in before pressing Save. The
    moment a save records or refuses the field the published rows differ, and the table is
    built again from them — so what is on the screen after a save is what the store said,
    never an edit that survived it.
    """
    if published.row is None:
        return None

    kept = None if tables is None else tables.get(published.id)
    if kept is not None and kept.published == published.rows:
        return kept

    drawing = table_drawing(published, plugin_id=entry.plugin_id)
    if tables is not None:
        tables[published.id] = drawing
    return drawing


# --- the operating system, as this module touches it ---------------------------------------


class Desktop(Protocol):
    """The window and the application's place on the desktop, as a seam.

    Five calls, and one of them is here to be left alone. :meth:`add_status_item` is the
    macOS menu bar extra, the Windows notification area icon and the Linux system tray item —
    the thing F4 forbids. It is part of this protocol so that "InnyTypes never registers one"
    is something a test can hold a recording implementation to, instead of a sentence in a
    docstring. Nothing in :mod:`innytypes` calls it, and
    ``tests/test_application_window.py`` fails if anything starts to.
    """

    def show_application(self) -> None:
        """Put the application in the Dock (macOS) or the taskbar (Windows, Linux)."""
        ...

    def add_status_item(self, label: str) -> None:
        """Add an icon to the system tray — **never called** (plan 0003, F4)."""
        ...

    def present(self, contents: WindowContents) -> None:
        """Draw the window, or bring it forward when it is already open."""
        ...

    def present_plugins(self, view: PluginView) -> None:
        """Draw the plugin page from the one read-only view the host published.

        Handed the view itself rather than anything derived from it, so "the window draws
        from one view" is the signature rather than a convention: there is no second argument
        a drawing could reach a manifest, a lock or an environment through.
        """
        ...

    def dismiss(self) -> None:
        """Hide the window. It stops nothing: closing is not quitting."""
        ...

    def ask(self, question: str, notice: str) -> bool | None:
        """Put the first-launch question, with its privacy notice, and wait for an answer.

        ``None`` means the user closed it without answering, which is not a "no": the switch
        stays unanswered and the question is asked again next time.
        """
        ...


@dataclass
class HeadlessDesktop:
    """A complete :class:`Desktop` that draws nothing, and says so rather than pretending.

    This is what an installation with no bundle has, and what every test uses. It is not a
    mock: the window is fully exercised through it, and everything the window decides is
    decided identically behind a toolkit. What is missing is the drawing, and the drawing is
    missing because the Briefcase bundle it belongs to is not built yet (plan 0003, F5).

    ``answers`` is the queue of replies to the first-launch question, oldest first. An empty
    queue answers ``None`` — nobody was there — which is exactly what an unattended run is.
    """

    answers: list[bool | None] = field(default_factory=list)

    # Everything it was asked to do, for the tests that care that it was asked once.
    application_shown: int = 0
    status_items: list[str] = field(default_factory=list)
    presented: list[WindowContents] = field(default_factory=list)
    dismissed: int = 0
    questions: list[str] = field(default_factory=list)

    # The plugin page: every view it was handed, and the widgets the last one asked for. The
    # drawing is :func:`draw_fields`, the same call the toolkit-backed desktop builds its
    # widgets from, so what this records is what a screen would show rather than a summary of
    # it — which is what lets the gate assert that all ten field types have a drawing.
    plugin_views: list[PluginView] = field(default_factory=list)
    drawn_fields: tuple[DrawnField, ...] = ()
    # Every table on the page, by plugin and field, kept across draws exactly as the
    # toolkit-backed desktop keeps its own: a row somebody added and has not saved yet is not
    # in the view, so a redraw that rebuilt from the view alone would lose it.
    tables: dict[str, dict[str, TableDrawing]] = field(default_factory=dict)

    def show_application(self) -> None:
        self.application_shown += 1
        log.info("InnyTypes is in the Dock or taskbar")

    def add_status_item(self, label: str) -> None:
        # Recorded rather than refused, because a refusal here would be a test passing for
        # the wrong reason: the assertion that matters is that this list stays empty.
        self.status_items.append(label)

    def present(self, contents: WindowContents) -> None:
        self.presented.append(contents)

    def present_plugins(self, view: PluginView) -> None:
        self.plugin_views.append(view)
        # Replaced rather than appended: this is what is on the page now, and the page is
        # rebuilt whole from the view on every draw.
        self.drawn_fields = tuple(
            drawn
            for entry in view.plugins
            for drawn in draw_fields(entry, tables=self.tables.setdefault(entry.plugin_id, {}))
        )

    def dismiss(self) -> None:
        self.dismissed += 1

    def ask(self, question: str, notice: str) -> bool | None:
        self.questions.append(question)
        return self.answers.pop(0) if self.answers else None

    @property
    def last(self) -> WindowContents | None:
        """The contents most recently drawn, or ``None`` when the window never opened."""
        return self.presented[-1] if self.presented else None

    @property
    def last_plugins(self) -> PluginView | None:
        """The plugin view most recently drawn, or ``None`` when the page never opened."""
        return self.plugin_views[-1] if self.plugin_views else None

    @property
    def drawn_widgets(self) -> frozenset[WidgetKind]:
        """Which of the ten widgets the page currently has on it."""
        return frozenset(drawn.widget for drawn in self.drawn_fields)

    def drawn(self, plugin_id: str, field_id: str) -> DrawnField | None:
        """One drawn field, or ``None`` when the page is not showing it."""
        for drawn in self.drawn_fields:
            if drawn.plugin_id == plugin_id and drawn.field_id == field_id:
                return drawn
        return None

    def table(self, plugin_id: str, field_id: str) -> TableDrawing | None:
        """One table on the page, or ``None`` when the page is not showing it.

        The same object the drawn field carries, so pressing **Add** on it and reading the
        drawn field back are the same table and not two copies of one.
        """
        return self.tables.get(plugin_id, {}).get(field_id)


# --- where the window's state comes from ---------------------------------------------------

# Each one is a callable rather than an object so the window can be built before the thing
# behind it exists, and so a test can move the state between two reads without rebuilding
# anything. The window asks for all of them afresh every time it is drawn.
Statuses = Callable[[], Sequence[ProcessStatus]]
# Every installed plugin and the state somebody else decided it is in — the switch, the
# quarantine and the settings hold, already resolved into one word by
# `innytypes.helper.enablement.plugin_state`. A sequence of pairs rather than a mapping
# because the order the plugins are listed in is the caller's to choose, not a dict's.
Plugins = Callable[[], Sequence[tuple[str, AvailabilityState]]]
CoreUpdate = Callable[[], StagedRelease | None]
PluginUpdates = Callable[[], Sequence[PluginReport]]
Quit = Callable[[QuitReason], QuitReport]
ApplyUpdate = Callable[[UpdateRow], None]
Usage = Callable[[], UsageSnapshot]


class PluginsPage(Protocol):
    """The plugin page, as the window opens it (plan 0004, slice 08).

    A protocol with one call rather than the page class itself, because
    :mod:`innytypes.helper.plugins` imports *this* module — the page is built on the view and
    the desktop defined here — and because opening it is the whole of what the window does
    with it. The page's five actions are the drawing's to route, never the window's.
    """

    def open(self) -> PluginView:
        """Draw the page from one read of the host's view."""
        ...


class ApplicationWindow:
    """The window's contents and the effect of each of its controls.

    One object, because the five things it shows share one question — what is the application
    doing right now — and because the three things it changes all have to be readable from the
    contents immediately afterwards. Splitting the switches from the display would mean two
    objects that both believe they know whether telemetry is on.
    """

    def __init__(
        self,
        *,
        desktop: Desktop,
        settings: HelperSettings,
        launch_at_login: LaunchAtLogin,
        quit: Quit,
        statuses: Statuses | None = None,
        plugins: Plugins | None = None,
        page: PluginsPage | None = None,
        core_update: CoreUpdate | None = None,
        plugin_updates: PluginUpdates | None = None,
        apply_update: ApplyUpdate | None = None,
        telemetry: TelemetryPipeline | None = None,
        usage: Usage | None = None,
    ) -> None:
        # Every seam below is held as ``self._<parameter name>``, which is the convention
        # :attr:`unfilled` reads: a seam stored under any other name would be invisible to the
        # one assertion that says the running application filled it.
        self._desktop = desktop
        self._settings = settings
        self._launch_at_login = launch_at_login
        self._quit = quit
        self._statuses = statuses
        self._plugins = plugins
        self._page = page
        self._core_update = core_update
        self._plugin_updates = plugin_updates
        self._apply_update = apply_update
        self._telemetry = telemetry
        self._usage = usage

        self._on_the_desktop = False
        self._visible = False
        # The reason the last switch attempt did not take, shown under that switch until it
        # moves. Kept here rather than in the contents because the contents are rebuilt from
        # the world on every draw, and a refusal is not something the world remembers.
        self._launch_at_login_refusal: str | None = None

    # --- opening, reopening, closing --------------------------------------------------------

    @property
    def visible(self) -> bool:
        """Whether the window is currently on screen."""
        return self._visible

    @property
    def unfilled(self) -> frozenset[str]:
        """Every optional seam this window was built without, by the name it is given.

        Derived from :meth:`__init__`'s own signature — a parameter defaulting to ``None`` is
        a seam, and the attribute behind it is that name with a leading underscore — rather
        than from a list somebody has to remember to extend. That is the whole point of it:
        the application shipped with **every** one of these empty, showing two switches and
        Quit, because nothing anywhere could say that it had (plan 0004, slice 11). A seam
        added after this is covered by the same assertion on the day it is added.
        """
        return frozenset(
            name
            for name, parameter in signature(type(self).__init__).parameters.items()
            if parameter.default is None and getattr(self, f"_{name}", None) is None
        )

    def open(self) -> WindowContents:
        """Show the window: the Dock entry once, the first-launch question once, the contents.

        Called for the first launch and for every later one. Both halves of "once" are
        idempotent on purpose, because this is also what a second launch runs (see
        :meth:`reopen`): the Dock entry is registered by the first call in this process, and
        the question is asked only while `config.toml` says it is still unanswered.
        """
        if not self._on_the_desktop:
            self._desktop.show_application()
            self._on_the_desktop = True

        self._ask_once()
        self._report_usage()

        contents = self.contents()
        self._desktop.present(contents)
        self._visible = True
        self._draw_plugins()
        return contents

    def _draw_plugins(self) -> None:
        """Draw the plugin page beside the contents, when this window was given one.

        **A page that refuses does not take the window with it.** The page reads more of this
        machine than anything else here — every installation, every settings file, the secret
        store and the host over the control channel — so it is the one part of the window with
        several ways to fail at the moment it is drawn. F1 says turning InnyTypes off must
        always work, and a window that would not open because a plugin's settings file is
        mid-edit is a window with no Quit in it. The refusal is logged and the rest is on
        screen.
        """
        if self._page is None:
            return

        try:
            self._page.open()
        except Exception as error:  # noqa: BLE001 - the window still opens, and Quit still works
            log.error("the plugin page could not be drawn: %s", error)

    def reopen(self) -> None:
        """What clicking the application icon does while InnyTypes is already running.

        This is the callable slice 07's :class:`~innytypes.helper.launcher.Application` takes
        as ``show_window``: the second launch finds the single-instance lock held, starts
        nothing at all, and brings this window forward instead.
        """
        self.open()

    def close(self) -> None:
        """Close the window — which hides it, and does nothing else whatsoever.

        Not a quit, not a stop, not a pause. The helper keeps watching, the host keeps
        running, every plugin keeps running, and no quit is recorded. Turning InnyTypes off
        is :meth:`quit` and nothing else (plan 0003, *Turning InnyTypes off*).
        """
        self._desktop.dismiss()
        self._visible = False
        log.info("the InnyTypes window is closed; the application keeps running")

    # --- what it shows ----------------------------------------------------------------------

    def contents(self) -> WindowContents:
        """Everything the window shows, read fresh from the state it was given."""
        return WindowContents(
            processes=self._process_rows(),
            plugins=self._plugin_rows(),
            updates=self._update_rows(),
            telemetry=self._telemetry_switch(),
            launch_at_login=self._launch_at_login_switch(),
            quit=Control(label=QUIT_LABEL),
        )

    def _process_rows(self) -> tuple[ProcessRow, ...]:
        if self._statuses is None:
            return ()
        return tuple(ProcessRow.of(status) for status in self._statuses())

    def _plugin_rows(self) -> tuple[PluginRow, ...]:
        """Every installed plugin and the one word for it, asked fresh like everything else.

        Nothing is decided here. The word and its sentence come from
        :func:`innytypes.helper.enablement.plugin_state`, which is what keeps the window
        saying `disabled` where the command line says `disabled`.
        """
        if self._plugins is None:
            return ()
        return tuple(
            PluginRow(
                plugin_id=plugin_id,
                availability=state.availability,
                detail=state.reason,
            )
            for plugin_id, state in self._plugins()
        )

    def _update_rows(self) -> tuple[UpdateRow, ...]:
        rows: list[UpdateRow] = []

        core = None if self._core_update is None else self._core_update()
        if core is not None:
            rows.append(self._core_row(core))

        if self._plugin_updates is not None:
            plugins = self._settings.current.plugins
            for report in self._plugin_updates():
                row = pending_update_row(report, mode=plugins.mode_for(report.id))
                if row is not None:
                    rows.append(row)

        return tuple(rows)

    @staticmethod
    def _core_row(staged: StagedRelease) -> UpdateRow:
        """The waiting core release, and whether it needs to be asked for.

        ``automatic`` false is a release that was fetched, verified and staged like any other
        and may not apply itself (plan 0003, D13) — so it is the one the window offers an
        Apply for. An automatic one is applied at the next quit, and saying so is more use to
        the reader than a button that does what would happen anyway.
        """
        version = str(staged.version)
        if staged.automatic:
            return UpdateRow(
                kind=UpdateKind.CORE,
                subject=CORE_SUBJECT,
                version=version,
                detail="Will be applied the next time you quit InnyTypes.",
            )
        return UpdateRow(
            kind=UpdateKind.CORE,
            subject=CORE_SUBJECT,
            version=version,
            apply=Control(label=f"{APPLY_LABEL} {version}"),
            detail="Waiting for you: this release is not applied on its own.",
        )

    def _telemetry_switch(self) -> SwitchRow:
        """The telemetry switch, in three states because it has three (F2)."""
        state = self._settings.telemetry
        if state is Telemetry.UNSET:
            return SwitchRow(
                label=TELEMETRY_LABEL,
                state=SwitchState.UNANSWERED,
                detail="Not answered yet. Nothing is sent, and nothing is queued.",
            )
        if state is Telemetry.ON:
            return SwitchRow(label=TELEMETRY_LABEL, state=SwitchState.ON)
        return SwitchRow(
            label=TELEMETRY_LABEL,
            state=SwitchState.OFF,
            detail="Nothing leaves this machine.",
        )

    def _launch_at_login_switch(self) -> SwitchRow:
        """The launch-at-login switch, carrying any refusal the last attempt produced."""
        enabled = self._launch_at_login.enabled
        return SwitchRow(
            label=LAUNCH_AT_LOGIN_LABEL,
            state=SwitchState.ON if enabled else SwitchState.OFF,
            detail=self._launch_at_login_refusal,
        )

    # --- what its controls do ---------------------------------------------------------------

    def set_telemetry(self, enabled: bool) -> SwitchRow:
        """Move the telemetry switch, which also answers the first-launch question.

        There is one way to answer it and this is the same one the question uses, so a user
        who dismissed the question and then found the switch has answered it just as
        properly as one who pressed a button in the dialog.
        """
        answer_first_launch_question(self._settings, enabled=enabled)
        return self._telemetry_switch()

    def set_launch_at_login(self, enabled: bool) -> SwitchRow:
        """Move the launch-at-login switch, or show why it would not move.

        The refusal is returned rather than raised because this is a window: an unpackaged
        installation has no bundle identity to register with the operating system
        (:class:`~innytypes.helper.launcher.UnpackagedLoginItem`), and the honest result of
        pressing the switch is that it stays where it was with the reason written under it.
        A switch that moved on screen and not on the machine would be the one unacceptable
        outcome.
        """
        try:
            self._launch_at_login.set(enabled)
        except LaunchAtLoginError as error:
            self._launch_at_login_refusal = str(error)
            log.warning("launch at login did not change: %s", error)
            return self._launch_at_login_switch()

        self._launch_at_login_refusal = None
        return self._launch_at_login_switch()

    def apply_update(self, row: UpdateRow) -> None:
        """Press Apply on one pending update.

        Refuses a row that has no Apply control rather than applying it anyway. An `auto`
        update and a blocked one look the same from here — neither is the user's to trigger —
        and quietly doing it would be the window overruling the mode the user set.
        """
        if row.apply is None:
            raise WindowError(
                f"{row.subject} {row.version} has no Apply control: it is not waiting for you"
            )
        if self._apply_update is None:
            raise WindowError("this window has no way to apply an update: it was built without one")
        self._apply_update(row)

    def quit(self) -> QuitReport:
        """**Quit InnyTypes**: the whole application off, and nothing relaunched.

        The one control here that ends anything. It runs slice 07's quit sequence, which
        records the quit before it stops the first process, so nothing that exits afterwards
        is read as a crash.
        """
        self._desktop.dismiss()
        self._visible = False
        return self._quit(QuitReason.MENU)

    # --- the first-launch question ----------------------------------------------------------

    def _ask_once(self) -> None:
        """Ask the telemetry question if, and only if, it has never been answered (F2).

        The answer lives in `config.toml`, not in this object, which is what makes "once"
        mean once across launches rather than once per window. A dismissal is left unanswered
        deliberately: reading "the user closed the dialog" as "no" would be inventing a
        decision, and F2's rule already covers the interval — nothing is sent or queued while
        the question stands.
        """
        if not question_is_unanswered(self._settings):
            return

        answer = self._desktop.ask(FIRST_LAUNCH_QUESTION, PRIVACY_NOTICE)
        if answer is None:
            log.info("the telemetry question was closed without an answer; it will be asked again")
            return

        answer_first_launch_question(self._settings, enabled=answer)
        log.info("telemetry is now %s", "on" if answer else "off")

    def _report_usage(self) -> None:
        """Tell telemetry the application was opened — which, before the question, tells it nothing.

        Routed through :class:`~innytypes.helper.telemetry.TelemetryPipeline` rather than
        around it, so the F2 gate covers this window too: the pipeline re-reads the switch,
        and an unanswered one queues nothing, sends nothing and never even reads the machine
        identifier.
        """
        if self._telemetry is None or self._usage is None:
            return
        self._telemetry.record_usage(self._usage())
