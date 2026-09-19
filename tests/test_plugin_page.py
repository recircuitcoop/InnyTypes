"""The plugin page: one read-only view, five actions, and a drawing for all nine field types.

Plan 0004, slice 08. Four of the things this slice builds are the kind that pass by accident
if nobody writes the test that could fail, so each of them is written to turn red when its
code is deleted:

* **One view, not three calls.** The page is driven through a host that records every call
  and hands back one object; the test asserts the desktop was given *that same object* and
  that exactly one call was made. A page that composed a line from discovery, the switch and
  the store would make more calls and hand over something else.
* **Nine drawings.** The eight scalar types and `list of <type>` are drawn once each and then
  removed one at a time — from the type-to-widget table and from the toolkit's own builder
  table — and every removal has to fail loudly. A missing drawing must never be a field that
  quietly is not on the form.
* **The real secret predicate.** A secret is planted with the real
  :class:`~innytypes.addons.secrets.SecretStore` under ``tmp_path``, and the page has to
  report the field as set and the plugin as no longer held. Leave the seam unwired and the
  store answers "no secret is set" for everything, which is exactly what those two assertions
  catch.
* **`shown_when` is the host's answer.** One test toggles a value across two form requests;
  a second hands the page a form whose ``shown`` is false while the value it names *would*
  satisfy the condition, so a drawing that re-evaluated the condition on this side would
  draw a field the host said to hide.

Nothing real is behind any of it. No GUI toolkit is imported, no process is spawned, nothing
sleeps, nothing reaches a network, and every path — the addons root, the config file, the
plugins directory and the secrets root — is under ``tmp_path``. The real per-user directories
are never read and never written.
"""

from __future__ import annotations

import json
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field, replace
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

from innytypes import HOST_API_VERSION, __version__
from innytypes.addons.discovery import (
    ENVIRONMENT_DIRNAME,
    MANIFEST_FILENAME,
    SOURCE_FILENAME,
    InstalledAddon,
)
from innytypes.addons.install import EditableInstall, host_source
from innytypes.addons.manifest import Requirement, parse_manifest
from innytypes.addons.secrets import SecretStore
from innytypes.addons.settings import PluginAvailability, SettingsStore, WriteOutcome
from innytypes.addons.settings_form import FormField, PublishedForm
from innytypes.children import ChildKind, ChildRecord, Command, CommandName, CommandResult
from innytypes.helper.config import HelperSettings
from innytypes.helper.enablement import SwitchResult
from innytypes.helper.plugins import (
    AddRequest,
    InstalledPluginHost,
    PluginPage,
    PluginPageError,
)
from innytypes.helper.rollout import AppliedUpdate
from innytypes.helper.toolkit import (
    ADD_LABEL,
    ENABLED_LABEL,
    REMOVE_LABEL,
    SAVE_LABEL,
    SECRET_NOT_SET,
    SECRET_SET,
    TogaDesktop,
    Toolkit,
)
from innytypes.helper.versions import ConsistencyRule, PluginReport
from innytypes.helper.versions import PluginState as UpdateState
from innytypes.helper.window import (
    FIELD_WIDGETS,
    HeadlessDesktop,
    PluginEntry,
    PluginRunState,
    PluginSource,
    PluginView,
    WidgetKind,
    WindowError,
    draw_fields,
)

# A credential that exists only in this file. The word "fake" is on the line for
# tests/test_no_secrets.py, which scans every tracked file for anything that looks real.
FAKE_TOKEN = "fake-plugin-token-0123456789"

# All nine of D1's field types, declared once. Every later test draws from this list, so a
# type that loses its drawing loses it in front of every assertion in the file.
NINE_TYPES: list[dict[str, object]] = [
    {"id": "title", "type": "text", "label": "Title"},
    {"id": "notes", "type": "paragraph", "label": "Notes"},
    {"id": "interval", "type": "number", "label": "Interval", "min": 1, "max": 60, "step": 5},
    {"id": "watching", "type": "switch", "label": "Watch on start", "default": False},
    {"id": "quality", "type": "choice", "label": "Quality", "options": ["low", "high"]},
    {"id": "kinds", "type": "multiple-choice", "label": "Kinds", "options": ["audio", "video"]},
    {"id": "root", "type": "path", "label": "Folder to watch", "kind": "folder"},
    {"id": "token", "type": "secret", "label": "API token"},
    {"id": "extras", "type": "list of path", "label": "Extra folders", "kind": "file"},
]

REQUIRED_TOKEN = {"id": "token", "type": "secret", "label": "API token", "required": True}


# --- the machine every test is built on -------------------------------------------------------


@dataclass(frozen=True)
class Machine:
    """One machine's plugin state, every path of it under ``tmp_path``.

    The three roots are passed explicitly to everything, which is how no test here can reach
    a real per-user directory by forgetting an argument.
    """

    addons_root: Path
    config_path: Path
    secrets_root: Path

    def install(
        self,
        addon_id: str,
        *,
        version: str = "1.0.0",
        requires: Sequence[str] = (),
        settings: Sequence[Mapping[str, object]] = (),
        update: Mapping[str, object] | None = None,
        source: tuple[Path, bool] | None = None,
    ) -> Path:
        """Put on disk exactly what `addons install` records: a manifest and an environment.

        Written directly rather than through the installer, because what the page reads is the
        **recorded layout** — the contract between install and discovery — and this suite is
        about what the page makes of it, not about how it got there.
        """
        root = self.addons_root / addon_id
        (root / ENVIRONMENT_DIRNAME).mkdir(parents=True)

        document: dict[str, object] = {
            "id": addon_id,
            "version": version,
            "host_api": HOST_API_VERSION,
            "requires": list(requires),
            "emits": [],
            "subscribes": [],
            "settings": [dict(declared) for declared in settings],
        }
        if update is not None:
            document["update"] = dict(update)
        (root / MANIFEST_FILENAME).write_text(json.dumps(document), encoding="utf-8")

        if source is not None:
            path, editable = source
            (root / SOURCE_FILENAME).write_text(
                json.dumps({"path": str(path), "editable": editable}), encoding="utf-8"
            )
        return root

    def break_plugin(self, addon_id: str) -> None:
        """Leave an environment with no recorded manifest — discovery's ``broken``."""
        (self.addons_root / addon_id / ENVIRONMENT_DIRNAME).mkdir(parents=True)

    def settings_path(self, addon_id: str) -> Path:
        """One plugin's settings file, beside this test's `config.toml` (D4)."""
        return self.config_path.parent / "plugins" / f"{addon_id}.toml"

    def store(self, addon_id: str) -> SettingsStore:
        """A store over this machine's own files, for planting values a test needs."""
        manifest = parse_manifest(
            json.loads((self.addons_root / addon_id / MANIFEST_FILENAME).read_text("utf-8"))
        )
        return SettingsStore(
            addon_id, manifest.settings, path=self.settings_path(addon_id), secret_is_set=_no_secret
        )

    def secrets(self) -> SecretStore:
        return SecretStore(root=self.secrets_root)


def _no_secret(field_id: str) -> bool:
    """A store built for planting values alone answers nothing about secrets."""
    return False


@pytest.fixture
def machine(tmp_path: Path) -> Machine:
    return Machine(
        addons_root=tmp_path / "addons",
        config_path=tmp_path / "config" / "config.toml",
        secrets_root=tmp_path / "config" / "secrets",
    )


# --- the fakes the host reaches the world through ---------------------------------------------


@dataclass
class FakeChannel:
    """The control channel: what the host is asked, and which children it says are running."""

    running: list[str] = field(default_factory=list)
    commands: list[Command] = field(default_factory=list)

    def send(self, command: Command) -> CommandResult:
        self.commands.append(command)
        if command.name is CommandName.LIST:
            return CommandResult(name=command.name, children=self._records())
        if command.name is CommandName.STOP and command.child_id in self.running:
            self.running.remove(command.child_id)
        if command.name is CommandName.START_ALL:
            return CommandResult(name=command.name, children=self._records())
        return CommandResult(name=command.name)

    def _records(self) -> tuple[ChildRecord, ...]:
        return tuple(
            ChildRecord(
                id=child_id,
                kind=ChildKind.ADDON,
                pid=1000 + index,
                started_at=1.0,
                executable="/opt/innytypes/bin/python",
                parent_pid=999,
            )
            for index, child_id in enumerate(self.running)
        )

    @property
    def names(self) -> list[CommandName]:
        return [command.name for command in self.commands]


@dataclass
class FakeInstaller:
    """An installer that records what it was asked for and installs nothing."""

    document: Mapping[str, object]
    environments: list[Path] = field(default_factory=list)
    requirements: list[tuple[str, ...]] = field(default_factory=list)
    editables: list[EditableInstall | None] = field(default_factory=list)

    def build_wheel(self, source: Path, *, into: Path) -> Path:
        name = (
            f"innytypes-{__version__}-py3-none-any.whl"
            if source == host_source()
            else f"{self.document['id']}-{self.document['version']}-py3-none-any.whl"
        )
        wheel = into / name
        wheel.write_bytes(b"a wheel, as far as this suite is concerned")
        return wheel

    def create_environment(self, environment: Path, *, python: str) -> None:
        environment.mkdir(parents=True)
        self.environments.append(environment)

    def install(
        self,
        environment: Path,
        requirements: Sequence[str],
        *,
        editable: EditableInstall | None = None,
    ) -> None:
        self.requirements.append(tuple(requirements))
        self.editables.append(editable)

    def read_manifest(
        self, environment: Path, *, addon_id: str | None = None
    ) -> Mapping[str, object]:
        return self.document


@dataclass
class RecordingHost:
    """A :class:`~innytypes.helper.plugins.PluginHost` that records and decides nothing.

    It hands back **one** view object every time, which is what makes "the page drew the view
    the host published" an identity assertion rather than a comparison of two equal values.
    """

    published: PluginView = field(default_factory=PluginView)
    calls: list[tuple[object, ...]] = field(default_factory=list)

    def view(self) -> PluginView:
        self.calls.append(("view",))
        return self.published

    def add(self, request: AddRequest) -> InstalledAddon:
        self.calls.append(("add", request))
        return _an_installed_addon("added")

    def remove(self, plugin_id: str) -> Any:
        self.calls.append(("remove", plugin_id))
        return None

    def update(self, plugin_id: str) -> AppliedUpdate:
        self.calls.append(("update", plugin_id))
        return AppliedUpdate(changed=(plugin_id,))

    def set_enabled(self, plugin_id: str, *, enabled: bool) -> SwitchResult:
        self.calls.append(("set-enabled", plugin_id, enabled))
        return SwitchResult(plugin_id=plugin_id, enabled=enabled)

    def configure(self, plugin_id: str, values: Mapping[str, object]) -> WriteOutcome:
        self.calls.append(("configure", plugin_id, dict(values)))
        return WriteOutcome(recorded=tuple(values), refused=())

    @property
    def names(self) -> list[object]:
        return [call[0] for call in self.calls]


def _an_installed_addon(addon_id: str) -> InstalledAddon:
    """One addon as discovery would report it, with nothing written to disk."""
    manifest = parse_manifest(
        {
            "id": addon_id,
            "version": "1.0.0",
            "host_api": HOST_API_VERSION,
            "requires": [],
            "emits": [],
            "subscribes": [],
        }
    )
    root = Path("/nowhere") / addon_id
    return InstalledAddon(
        id=addon_id,
        manifest=manifest,
        root=root,
        environment=root / ENVIRONMENT_DIRNAME,
        manifest_path=root / MANIFEST_FILENAME,
    )


# --- a toolkit that records instead of drawing --------------------------------------------------


@dataclass
class Widget:
    """One widget the stand-in was asked for: what kind, and everything it was given."""

    kind: str
    options: dict[str, Any] = field(default_factory=dict)

    @property
    def text(self) -> str:
        return str(self.options.get("text", ""))

    @text.setter
    def text(self, value: str) -> None:
        self.options["text"] = value

    @property
    def value(self) -> Any:
        return self.options.get("value")

    @property
    def children(self) -> list[Widget]:
        return list(self.options.get("children", []))

    def press(self) -> None:
        self.options["on_press"](self)

    def move(self, to: bool) -> None:
        self.options["value"] = to
        self.options["on_change"](self)


@dataclass
class FakeWindow:
    title: str
    content: Widget | None = None
    shown: int = 0
    hidden: int = 0

    def show(self) -> None:
        self.shown += 1

    def hide(self) -> None:
        self.hidden += 1


@dataclass
class FakeApp:
    toga: FakeToga
    options: dict[str, Any]
    main_window: FakeWindow | None = None

    def main_loop(self) -> None:
        self.main_window = self.toga.MainWindow(title=self.options["formal_name"])
        self.main_window.content = self.options["startup"](self)
        self.options["on_running"](self)


class FakeToga(ModuleType):
    """Every widget :mod:`innytypes.helper.toolkit` asks of Toga, and nothing else."""

    def __init__(self) -> None:
        super().__init__("toga")
        self.windows: list[FakeWindow] = []

    def App(self, **options: Any) -> FakeApp:  # noqa: N802 - the toolkit's own spelling
        return FakeApp(toga=self, options=options)

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

    def TextInput(self, **options: Any) -> Widget:  # noqa: N802
        return Widget(kind="text-input", options=options)

    def MultilineTextInput(self, **options: Any) -> Widget:  # noqa: N802
        return Widget(kind="multiline", options=options)

    def NumberInput(self, **options: Any) -> Widget:  # noqa: N802
        return Widget(kind="number", options=options)

    def Selection(self, **options: Any) -> Widget:  # noqa: N802
        return Widget(kind="selection", options=options)

    def PasswordInput(self, **options: Any) -> Widget:  # noqa: N802
        return Widget(kind="password", options=options)


@pytest.fixture
def toga() -> FakeToga:
    return FakeToga()


@pytest.fixture
def drawing(toga: FakeToga) -> TogaDesktop:
    """A toolkit-backed desktop with its window already open, as :meth:`run` leaves it."""
    desktop = TogaDesktop(toolkit=Toolkit(toga=toga, pack=dict, column="column"))
    desktop.run(lambda: None)
    return desktop


def shape(widget: Widget) -> str:
    """One widget as a string naming it and everything inside it.

    How two drawings are told apart: `multiple-choice` and `list of path` are both boxes, and
    what makes them different drawings is what is in them.
    """
    if widget.kind != "box":
        return widget.kind
    return "box(" + ",".join(shape(child) for child in widget.children) + ")"


def texts(widget: Widget) -> list[str]:
    """Every string anywhere in one widget tree, so an absence can be asserted over all of it."""
    found = [str(value) for value in widget.options.values() if isinstance(value, str)]
    for child in widget.children:
        found.extend(texts(child))
    return found


def field_widgets(page: Widget) -> list[Widget]:
    """The settings widgets off a drawn page, in the order the manifest declares them.

    Found by position rather than by kind, because a field's widget can be any of the nine and
    two of them (the enable switch, the Remove button) look like widgets a field could have:
    everything between the **Remove** control and **Save settings** belongs to the form, and a
    plain label in there is a field's error rather than a field.
    """
    children = page.children
    start = next(i for i, child in enumerate(children) if child.text == REMOVE_LABEL)
    end = next(i for i, child in enumerate(children) if child.text == SAVE_LABEL)
    return [child for child in children[start + 1 : end] if child.kind != "label"]


# --- building a real view ----------------------------------------------------------------------


def a_host(machine: Machine, **kwargs: Any) -> InstalledPluginHost:
    """The production host, pointed at this test's own directories and nothing else."""
    machine.config_path.parent.mkdir(parents=True, exist_ok=True)
    return InstalledPluginHost(
        settings=HelperSettings(path=machine.config_path),
        channel=kwargs.pop("channel", FakeChannel()),
        addons_root=machine.addons_root,
        config_path=machine.config_path,
        secrets_root=machine.secrets_root,
        **kwargs,
    )


def a_page(host: Any, desktop: Any | None = None) -> tuple[PluginPage, Any]:
    """A page over one host and one desktop, returning both."""
    drawn = HeadlessDesktop() if desktop is None else desktop
    return PluginPage(desktop=drawn, host=host), drawn


# --- one read-only view, and every field on it ---------------------------------------------------


def test_the_page_lists_every_installed_plugin_from_one_view(machine: Machine) -> None:
    """Several plugins in different states, every field of every line, from one call.

    The identity assertion at the end is the one that matters: the desktop was handed the
    object the host published, so nothing the page drew can have been composed from a second
    call to discovery, to the switch or to the store.
    """
    checkout = machine.addons_root.parent / "checkouts" / "whodunnit"
    machine.install("monty", version="1.2.0", settings=[NINE_TYPES[2]])
    machine.install("whodunnit", version="2.0.0", source=(checkout, True))
    machine.install("summarize", version="0.3.0", update={"source": "git+https://forge/s.git"})
    machine.break_plugin("zombie")

    channel = FakeChannel(running=["monty"])
    settings = HelperSettings(path=machine.config_path)
    machine.config_path.parent.mkdir(parents=True, exist_ok=True)
    settings.set_enabled("whodunnit", False)

    host = a_host(
        machine,
        channel=channel,
        quarantines=lambda: {"summarize": "gave up after 5 restarts"},
        reports=lambda: (
            PluginReport(
                id="monty",
                installed_version="1.2.0",
                state=UpdateState.AVAILABLE,
                target_version="1.3.0",
                newest_version="1.3.0",
            ),
        ),
    )
    view = host.view()

    assert view.ids == ("monty", "summarize", "whodunnit", "zombie")

    monty = view.plugin("monty")
    assert monty is not None
    assert (monty.version, monty.source, monty.source_detail) == ("1.2.0", PluginSource.INDEX, None)
    assert (monty.enabled, monty.run_state) == (True, PluginRunState.RUNNING)
    assert monty.pending_update is not None and monty.pending_update.version == "1.3.0"
    assert monty.form is not None and monty.form.field("interval").type == "number"
    assert monty.removable and monty.removal_refusal is None

    whodunnit = view.plugin("whodunnit")
    assert whodunnit is not None
    assert (whodunnit.source, whodunnit.source_detail) == (PluginSource.EDITABLE, str(checkout))
    assert (whodunnit.enabled, whodunnit.run_state) == (False, PluginRunState.DISABLED)
    assert whodunnit.pending_update is None

    summarize = view.plugin("summarize")
    assert summarize is not None
    assert (summarize.source, summarize.source_detail) == (PluginSource.GIT, "https://forge/s.git")
    assert summarize.run_state is PluginRunState.QUARANTINED
    assert summarize.detail == "gave up after 5 restarts"

    zombie = view.plugin("zombie")
    assert zombie is not None
    assert (zombie.version, zombie.source, zombie.form) == (None, None, None)
    assert zombie.run_state is PluginRunState.BROKEN
    assert zombie.detail is not None and "manifest" in zombie.detail

    # And now the page itself: one call, and the very object it was given is what was drawn.
    recording = RecordingHost(published=view)
    page, desktop = a_page(recording)

    drawn = page.open()

    assert recording.calls == [("view",)]
    assert drawn is view
    assert desktop.last_plugins is view
    assert desktop.plugin_views == [view]


def test_a_plugin_that_is_not_installed_is_never_listed(machine: Machine) -> None:
    """D12: the page shows what is installed, never an index to browse.

    The version check answers for a plugin that is not on this machine — which is what an
    index entry for something the user could install looks like from here. It names no line.
    """
    machine.install("monty")
    host = a_host(
        machine,
        reports=lambda: (
            PluginReport(
                id="whodunnit",
                installed_version="0.0.0",
                state=UpdateState.AVAILABLE,
                target_version="9.9.9",
                newest_version="9.9.9",
            ),
        ),
    )

    view = host.view()

    assert view.ids == ("monty",)
    assert view.plugin("whodunnit") is None


def test_a_plugin_another_one_requires_is_drawn_as_not_removable(machine: Machine) -> None:
    """The removal rule, asked before the control is drawn rather than after it is pressed."""
    machine.install("monty")
    machine.install("whodunnit", requires=["monty==1.0.0"])

    view = a_host(machine).view()

    monty = view.plugin("monty")
    assert monty is not None
    assert monty.removable is False
    assert monty.removal_refusal is not None and "whodunnit requires monty" in monty.removal_refusal
    whodunnit = view.plugin("whodunnit")
    assert whodunnit is not None and whodunnit.removable


def test_a_plugin_held_by_its_settings_says_so(machine: Machine) -> None:
    """The fourth run state, and it is the settings' own hold rather than a word chosen here."""
    machine.install("monty", settings=[dict(NINE_TYPES[0], required=True)])

    monty = a_host(machine).view().plugin("monty")

    assert monty is not None
    assert monty.run_state is PluginRunState.HELD
    assert monty.detail is not None and "title" in monty.detail
    assert monty.form is not None
    assert monty.form.availability is PluginAvailability.HELD


# --- the five actions ---------------------------------------------------------------------------


def test_add_drives_the_hosts_own_install() -> None:
    recording = RecordingHost()
    page, _ = a_page(recording)
    request = AddRequest(requirement=Requirement(addon_id="monty", version="1.0.0"))

    page.add(request)

    assert recording.calls[0] == ("add", request)


def test_remove_drives_the_hosts_own_removal() -> None:
    recording = RecordingHost()
    page, _ = a_page(recording)

    page.remove("monty")

    assert recording.calls[0] == ("remove", "monty")


def test_update_drives_the_hosts_own_apply() -> None:
    recording = RecordingHost()
    page, _ = a_page(recording)

    applied = page.update("monty")

    assert recording.calls[0] == ("update", "monty")
    assert applied.changed == ("monty",)


def test_enable_and_disable_drive_the_hosts_own_switch() -> None:
    recording = RecordingHost()
    page, _ = a_page(recording)

    page.set_enabled("monty", enabled=False)
    page.set_enabled("monty", enabled=True)

    assert recording.calls[0] == ("set-enabled", "monty", False)
    assert recording.calls[1] == ("set-enabled", "monty", True)


def test_configure_drives_the_hosts_own_form_save() -> None:
    recording = RecordingHost()
    page, _ = a_page(recording)

    page.configure("monty", {"interval": 20})

    assert recording.calls[0] == ("configure", "monty", {"interval": 20})


def test_every_action_redraws_the_page_when_it_is_open() -> None:
    """Every one of the five changes something the page shows, so every one of them redraws."""
    recording = RecordingHost()
    page, desktop = a_page(recording)
    page.open()

    page.remove("monty")
    page.set_enabled("monty", enabled=False)

    assert recording.names == ["view", "remove", "view", "set-enabled", "view"]
    assert len(desktop.plugin_views) == 3


def test_a_closed_page_is_not_drawn_behind_the_users_back() -> None:
    recording = RecordingHost()
    page, desktop = a_page(recording)

    page.remove("monty")

    assert recording.names == ["remove"]
    assert desktop.plugin_views == []


# --- the actions against the real host, not a recording one -------------------------------------


def test_the_real_host_removes_through_addons_remove(machine: Machine) -> None:
    machine.install("monty", settings=[NINE_TYPES[7]])
    machine.settings_path("monty").parent.mkdir(parents=True, exist_ok=True)
    machine.settings_path("monty").write_text("[values]\n", encoding="utf-8")
    machine.secrets().write("monty", "token", FAKE_TOKEN)

    channel = FakeChannel(running=["monty"])
    host = a_host(machine, channel=channel)
    page, _ = a_page(host)

    removed = page.remove("monty")

    assert removed.id == "monty"
    # One command, and it is a stop: the host owns its children and removal asks rather than
    # signalling anything (plan 0001, invariant 9).
    assert channel.names == [CommandName.STOP]
    assert not (machine.addons_root / "monty").exists()
    assert not machine.settings_path("monty").exists()
    assert not machine.secrets().path_for("monty", "token").exists()
    assert host.view().ids == ()


def test_the_real_host_switches_a_plugin_off_through_the_enable_switch(machine: Machine) -> None:
    machine.install("monty")
    channel = FakeChannel(running=["monty"])
    host = a_host(machine, channel=channel)
    page, _ = a_page(host)

    result = page.set_enabled("monty", enabled=False)

    assert result == SwitchResult(plugin_id="monty", enabled=False, stopped=("monty",))
    assert CommandName.STOP in channel.names
    # Read back from the file, not from the object that wrote it.
    assert HelperSettings(path=machine.config_path).is_enabled("monty") is False
    monty = host.view().plugin("monty")
    assert monty is not None and monty.run_state is PluginRunState.DISABLED


def test_the_real_host_saves_values_and_secrets_in_one_press(machine: Machine) -> None:
    """Two halves of one save (D6): the folder to the settings file, the token to its own."""
    machine.install("monty", settings=[NINE_TYPES[6], REQUIRED_TOKEN])
    host = a_host(machine)
    page, _ = a_page(host)

    outcome = page.configure("monty", {"root": "/tmp/watched", "token": FAKE_TOKEN})

    assert sorted(outcome.recorded) == ["root", "token"]
    assert outcome.refused == ()
    assert "watched" in machine.settings_path("monty").read_text(encoding="utf-8")
    # The value is in the secret store and nowhere near the settings file.
    assert FAKE_TOKEN not in machine.settings_path("monty").read_text(encoding="utf-8")
    assert machine.secrets().read("monty", "token") == FAKE_TOKEN


def test_the_real_host_installs_through_addons_install(machine: Machine, tmp_path: Path) -> None:
    checkout = tmp_path / "checkouts" / "monty"
    checkout.mkdir(parents=True)
    (checkout / "pyproject.toml").write_text('[project]\nname = "monty"\n', encoding="utf-8")
    installer = FakeInstaller(
        document={
            "id": "monty",
            "version": "1.0.0",
            "host_api": HOST_API_VERSION,
            "requires": [],
            "emits": [],
            "subscribes": [],
        }
    )
    host = a_host(machine, installer=installer)
    page, _ = a_page(host)

    installed = page.add(AddRequest(path=checkout, editable=True))

    assert installed.id == "monty"
    assert installer.editables[-1] is not None
    assert host.view().ids == ("monty",)
    monty = host.view().plugin("monty")
    assert monty is not None and monty.source is PluginSource.EDITABLE


def test_a_page_built_without_an_installer_or_an_updater_says_so(machine: Machine) -> None:
    """Two refusals rather than two silent no-ops, because both are the page failing to act."""
    machine.install("monty")
    host = a_host(machine)

    with pytest.raises(PluginPageError, match="no installer"):
        host.add(AddRequest(requirement=Requirement(addon_id="monty", version="1.0.0")))

    with pytest.raises(PluginPageError, match="no way to update monty"):
        host.update("monty")


def test_an_add_naming_both_a_requirement_and_a_path_is_refused(tmp_path: Path) -> None:
    with pytest.raises(PluginPageError, match="both"):
        AddRequest(requirement=Requirement(addon_id="monty", version="1.0.0"), path=tmp_path)

    with pytest.raises(PluginPageError, match="neither"):
        AddRequest()

    with pytest.raises(PluginPageError, match="editable"):
        AddRequest(requirement=Requirement(addon_id="monty", version="1.0.0"), editable=True)


def test_the_real_host_updates_through_the_applier_it_was_given(machine: Machine) -> None:
    machine.install("monty")
    asked: list[str] = []

    def apply(plugin_id: str) -> AppliedUpdate:
        asked.append(plugin_id)
        return AppliedUpdate(changed=(plugin_id,), versions={plugin_id: "1.1.0"})

    page, _ = a_page(a_host(machine, updater=apply))

    applied = page.update("monty")

    assert asked == ["monty"]
    assert applied.applied


# --- the nine drawings ---------------------------------------------------------------------------


def a_full_form(machine: Machine) -> InstalledPluginHost:
    """A plugin declaring all nine types, with a value in the list so it has elements to draw."""
    machine.install("monty", settings=NINE_TYPES)
    machine.store("monty").write({"extras": ["/one", "/two"]}, by="user")
    return a_host(machine)


def test_every_one_of_the_nine_field_types_has_its_own_drawing(machine: Machine) -> None:
    page, desktop = a_page(a_full_form(machine))

    page.open()

    assert [drawn.type for drawn in desktop.drawn_fields] == [
        declared["type"] for declared in NINE_TYPES
    ]
    # Nine types, nine widgets, and no two of them the same: the vocabulary is closed and
    # every member of it is drawable (D1).
    assert desktop.drawn_widgets == frozenset(WidgetKind)
    assert len({drawn.widget for drawn in desktop.drawn_fields}) == len(NINE_TYPES)
    # The list's element type is drawn too, which is the half a list cannot do without.
    extras = desktop.drawn("monty", "extras")
    assert extras is not None and extras.element is WidgetKind.PATH


def test_the_toolkit_builds_a_distinguishable_widget_for_each_of_the_nine(
    machine: Machine, drawing: TogaDesktop
) -> None:
    """The model's nine become nine widget trees, no two of which look the same."""
    page, _ = a_page(a_full_form(machine), drawing)

    page.open()

    assert drawing.window is not None
    drawn = drawing.window.content
    shapes = [shape(widget) for widget in field_widgets(drawn)]

    assert len(shapes) == len(NINE_TYPES)
    assert len(set(shapes)) == len(NINE_TYPES), shapes
    # Every one of the nine builders is reachable, and the table covers the whole vocabulary.
    assert set(TogaDesktop._WIDGETS) == set(WidgetKind)
    assert len(set(TogaDesktop._WIDGETS.values())) == len(WidgetKind)


@pytest.mark.parametrize("platform", ["darwin", "win32", "linux"])
def test_the_nine_drawings_are_the_same_on_every_platform(
    machine: Machine, toga: FakeToga, monkeypatch: pytest.MonkeyPatch, platform: str
) -> None:
    """One toolkit, no platform branch — which is what "on every platform" has to mean.

    InnyTypes ships one drawing (Toga, inside the Briefcase bundle) to macOS, Windows and
    Linux. So the way to hold the promise is to show the drawing does not consult the
    platform at all: the widget tree is identical whichever one this is.
    """
    monkeypatch.setattr(sys, "platform", platform)
    desktop = TogaDesktop(toolkit=Toolkit(toga=toga, pack=dict, column="column"))
    desktop.run(lambda: None)
    page, _ = a_page(a_full_form(machine), desktop)

    page.open()

    assert desktop.window is not None
    assert [shape(widget) for widget in field_widgets(desktop.window.content)] == [
        "text-input",
        "multiline",
        "number",
        "switch",
        "selection",
        "box(switch,switch)",
        "box(label,button)",
        "box(password,label)",
        "box(box(label,button),box(label,button),button)",
    ]


@pytest.mark.parametrize("type_name", sorted(FIELD_WIDGETS))
def test_a_scalar_type_whose_drawing_is_removed_fails_loudly(
    machine: Machine, monkeypatch: pytest.MonkeyPatch, type_name: str
) -> None:
    """The mutation, eight times: delete one type's widget and the page must refuse to draw.

    A type with no drawing must never be a field that quietly is not on the form — that is a
    setting the user cannot reach and a hold nothing on screen explains.
    """
    from innytypes.helper import window

    short = {name: kind for name, kind in FIELD_WIDGETS.items() if name != type_name}
    monkeypatch.setattr(window, "FIELD_WIDGETS", short)
    page, _ = a_page(a_full_form(machine))

    with pytest.raises(WindowError, match=type_name):
        page.open()


@pytest.mark.parametrize("kind", list(WidgetKind))
def test_a_widget_the_toolkit_cannot_build_fails_loudly(
    machine: Machine, drawing: TogaDesktop, monkeypatch: pytest.MonkeyPatch, kind: WidgetKind
) -> None:
    """The same mutation against the drawing table, nine times — the list type included."""
    short = {one: builder for one, builder in TogaDesktop._WIDGETS.items() if one is not kind}
    monkeypatch.setattr(TogaDesktop, "_WIDGETS", short)
    page, _ = a_page(a_full_form(machine), drawing)

    with pytest.raises(WindowError, match=str(kind)):
        page.open()


def test_a_list_of_an_undrawable_element_type_is_refused(
    machine: Machine, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A list is only drawable while its element type is, so that is checked rather than assumed."""
    from innytypes.helper import window

    short = {name: kind for name, kind in FIELD_WIDGETS.items() if name != "path"}
    monkeypatch.setattr(window, "FIELD_WIDGETS", short)
    machine.install("monty", settings=[NINE_TYPES[8]])
    page, _ = a_page(a_host(machine))

    with pytest.raises(WindowError, match="element type"):
        page.open()


# --- shown_when is the host's answer, drawn and never re-evaluated -------------------------------


CONDITIONAL: list[dict[str, object]] = [
    {"id": "mode", "type": "choice", "label": "Mode", "options": ["simple", "advanced"]},
    {
        "id": "depth",
        "type": "number",
        "label": "Depth",
        "min": 1,
        "max": 9,
        "shown_when": {"field": "mode", "equals": "advanced"},
    },
]


def test_a_dependent_fields_drawing_follows_the_form_across_two_requests(
    machine: Machine,
) -> None:
    """The value is toggled between two form requests and the drawing follows it both ways."""
    machine.install("monty", settings=CONDITIONAL)
    page, desktop = a_page(a_host(machine))

    page.configure("monty", {"mode": "simple"})
    page.open()
    assert [drawn.field_id for drawn in desktop.drawn_fields] == ["mode"]

    page.configure("monty", {"mode": "advanced"})
    assert [drawn.field_id for drawn in desktop.drawn_fields] == ["mode", "depth"]

    page.configure("monty", {"mode": "simple"})
    assert [drawn.field_id for drawn in desktop.drawn_fields] == ["mode"]


def test_the_drawing_never_re_evaluates_shown_when() -> None:
    """The mutation for D2: a hidden field whose named value *would* satisfy the condition.

    A drawing that judged `shown_when` for itself would put this field on the page. The host
    said to hide it, and the host is the only thing that evaluates the condition — over the
    whole form at once, against the values it published.
    """
    entry = PluginEntry(
        plugin_id="monty",
        form=PublishedForm(
            addon_id="monty",
            fields=(
                _published("mode", "choice", value="advanced"),
                _published("depth", "number", value=3, shown=False),
            ),
            availability=PluginAvailability.ENABLED,
        ),
    )

    assert [drawn.field_id for drawn in draw_fields(entry)] == ["mode"]


def _published(
    field_id: str,
    type_name: str,
    *,
    value: object | None = None,
    shown: bool = True,
    is_secret: bool = False,
    secret_is_set: bool = False,
) -> FormField:
    """One published field, built by hand so a test can state a shape the host would not."""
    return FormField(
        id=field_id,
        type=type_name,
        label=field_id.title(),
        help=None,
        group=None,
        required=False,
        written_by="user",
        element_type=None,
        min=None,
        max=None,
        step=None,
        options=("simple", "advanced") if type_name == "choice" else None,
        kind=None,
        default=None,
        value=value,
        is_secret=is_secret,
        secret_is_set=secret_is_set,
        shown=shown,
        error=None,
        written=None,
    )


# --- the secret seam, wired and proved -----------------------------------------------------------


def test_the_page_builds_the_store_with_the_real_secret_predicate(machine: Machine) -> None:
    """The criterion this slice is most able to pass by accident, so it is asserted both ways.

    With no secret stored the plugin is held disabled for a required credential; the moment
    one is written with the real store the page says it is set and the hold is gone. Unwire
    :func:`~innytypes.addons.secrets.secret_is_set_for` and the store answers "not set" for
    everything, so the second half turns red while the first still passes.
    """
    machine.install("monty", settings=[REQUIRED_TOKEN])
    host = a_host(machine)

    before = host.view().plugin("monty")
    assert before is not None and before.form is not None
    assert before.form.field("token").secret_is_set is False
    assert before.run_state is PluginRunState.HELD

    machine.secrets().write("monty", "token", FAKE_TOKEN)

    after = host.view().plugin("monty")
    assert after is not None and after.form is not None
    assert after.form.field("token").secret_is_set is True
    assert after.run_state is PluginRunState.STOPPED
    assert after.form.availability is PluginAvailability.ENABLED


def test_a_secrets_drawing_never_shows_the_stored_value(
    machine: Machine, drawing: TogaDesktop
) -> None:
    """The value is planted for real, and then looked for in every string on the page."""
    machine.install("monty", settings=[REQUIRED_TOKEN])
    machine.secrets().write("monty", "token", FAKE_TOKEN)
    page, _ = a_page(a_host(machine), drawing)

    page.open()

    assert drawing.window is not None
    everything = texts(drawing.window.content)
    assert not any(FAKE_TOKEN in text for text in everything), everything
    # It says whether one is set, which is the whole of what a secret's drawing may know.
    assert SECRET_SET in everything
    assert SECRET_NOT_SET not in everything


def test_the_model_never_carries_a_secrets_value_either(machine: Machine) -> None:
    """Belt and braces, at the layer the toolkit draws from: no value reaches a widget."""
    machine.install("monty", settings=[REQUIRED_TOKEN])
    machine.secrets().write("monty", "token", FAKE_TOKEN)
    page, desktop = a_page(a_host(machine))

    page.open()

    token = desktop.drawn("monty", "token")
    assert token is not None
    assert token.value is None
    assert token.secret_is_set is True


def test_a_form_whose_secret_leaked_a_value_is_still_drawn_without_it() -> None:
    """The rule is enforced where the widget is described, not only where the form is built."""
    entry = PluginEntry(
        plugin_id="monty",
        form=PublishedForm(
            addon_id="monty",
            fields=(_published("token", "secret", value=FAKE_TOKEN, is_secret=True),),
            availability=PluginAvailability.ENABLED,
        ),
    )

    (token,) = draw_fields(entry)

    assert token.value is None


def test_a_secret_left_empty_on_the_page_is_not_saved_over(
    machine: Machine, drawing: TogaDesktop
) -> None:
    """Opening the page and pressing Save must not wipe a credential nobody typed."""
    machine.install("monty", settings=[NINE_TYPES[6], REQUIRED_TOKEN])
    machine.secrets().write("monty", "token", FAKE_TOKEN)
    host = a_host(machine)
    page, _ = a_page(host, drawing)
    saved: list[tuple[str, dict[str, object]]] = []
    drawing.on_configure = lambda plugin_id, values: saved.append((plugin_id, dict(values)))

    page.open()
    assert drawing.window is not None
    _labelled(drawing.window.content, SAVE_LABEL).press()

    assert saved == [("monty", {})]


# --- the controls on the drawn page ------------------------------------------------------------


def _labelled(box: Widget, text: str) -> Widget:
    for child in box.children:
        if child.text == text:
            return child
    raise AssertionError(f"nothing on the page says {text!r}: {[c.text for c in box.children]}")


def test_the_drawn_page_wires_its_controls_to_the_pages_actions(
    machine: Machine, drawing: TogaDesktop
) -> None:
    """Every control the drawing puts on the page reaches the one call that owns it."""
    machine.install("monty", settings=[NINE_TYPES[2]])
    recording = RecordingHost(published=a_host(machine).view())
    page, _ = a_page(recording, drawing)
    drawing.on_add = lambda: page.add(AddRequest(path=Path("/checkout")))
    drawing.on_remove = page.remove
    drawing.on_enable = lambda plugin_id, enabled: page.set_enabled(plugin_id, enabled=enabled)
    drawing.on_configure = page.configure

    page.open()
    assert drawing.window is not None
    drawn = drawing.window.content

    _labelled(drawn, REMOVE_LABEL).press()
    _labelled(drawn, ENABLED_LABEL).move(False)
    _labelled(drawn, SAVE_LABEL).press()
    _labelled(drawn, ADD_LABEL).press()

    assert recording.names == [
        "view",
        "remove",
        "view",
        "set-enabled",
        "view",
        "configure",
        "view",
        "add",
        "view",
    ]
    assert ("remove", "monty") in recording.calls
    assert ("set-enabled", "monty", False) in recording.calls


def test_a_control_with_no_effect_behind_it_refuses(drawing: TogaDesktop) -> None:
    """A button wired to nothing raises rather than looking like it worked."""
    page, _ = a_page(RecordingHost(published=PluginView()), drawing)

    page.open()
    assert drawing.window is not None

    with pytest.raises(WindowError, match="add a plugin"):
        _labelled(drawing.window.content, ADD_LABEL).press()


def test_a_remove_control_is_drawn_disabled_with_its_reason(machine: Machine, drawing) -> None:
    machine.install("monty")
    machine.install("whodunnit", requires=["monty==1.0.0"])
    page, _ = a_page(a_host(machine), drawing)

    page.open()

    assert drawing.window is not None
    buttons = [
        child
        for child in drawing.window.content.children
        if child.kind == "button" and child.text == REMOVE_LABEL
    ]
    assert [button.options["enabled"] for button in buttons] == [False, True]


# --- the icon this page still does not add -------------------------------------------------------


def test_the_plugin_page_registers_no_status_item(machine: Machine) -> None:
    """F4, over the page and all five of its actions: the tray is never touched."""
    machine.install("monty", settings=[NINE_TYPES[2]])
    host = a_host(machine, updater=lambda plugin_id: AppliedUpdate())
    page, desktop = a_page(host)

    page.open()
    page.set_enabled("monty", enabled=False)
    page.set_enabled("monty", enabled=True)
    page.configure("monty", {"interval": 20})
    page.update("monty")
    page.remove("monty")

    assert desktop.status_items == []
    assert desktop.plugin_views  # the page really was drawn, so the absence means something


def test_the_toolkit_backed_page_still_refuses_a_status_item(drawing: TogaDesktop) -> None:
    """The implementation that *could* add one is the one where refusing is worth the most."""
    with pytest.raises(WindowError, match="system tray"):
        drawing.add_status_item("InnyTypes")


# --- the page is drawn, not invented -------------------------------------------------------------


def test_the_page_cannot_be_drawn_before_the_application_has_started(toga: FakeToga) -> None:
    desktop = TogaDesktop(toolkit=Toolkit(toga=toga, pack=dict, column="column"))

    with pytest.raises(WindowError, match="has not started"):
        desktop.present_plugins(PluginView())


def test_an_empty_page_is_still_a_page(drawing: TogaDesktop) -> None:
    """No plugins installed is a page with a heading and an Add, not an absent page."""
    page, _ = a_page(RecordingHost(published=PluginView()), drawing)

    page.open()

    assert drawing.window is not None
    assert _labelled(drawing.window.content, ADD_LABEL).kind == "button"


def test_the_form_a_plugin_page_publishes_is_the_same_one_slice_04_built(machine: Machine) -> None:
    """The page adds no second way to read a plugin's settings.

    What the view carries is a :class:`~innytypes.addons.settings_form.PublishedForm`, built
    by :class:`~innytypes.addons.settings_form.SettingsForm` over the plugin's own store — so
    a value saved through the page is the value the form publishes next time, and there is one
    validator behind both.
    """
    machine.install("monty", settings=[NINE_TYPES[2]])
    host = a_host(machine)
    page, _ = a_page(host)

    page.configure("monty", {"interval": 20})
    monty = host.view().plugin("monty")

    assert monty is not None and monty.form is not None
    assert isinstance(monty.form, PublishedForm)
    assert monty.form.field("interval").value == 20

    refused = page.configure("monty", {"interval": 999})
    assert [problem.field for problem in refused.refused] == ["interval"]
    monty = host.view().plugin("monty")
    assert monty is not None and monty.form is not None
    assert monty.form.field("interval").value == 20


def test_configuring_a_plugin_that_is_not_installed_is_refused(machine: Machine) -> None:
    machine.install("monty")
    page, _ = a_page(a_host(machine))

    with pytest.raises(PluginPageError, match="whodunnit is not installed"):
        page.configure("whodunnit", {"interval": 1})


# --- the pending update on a line, and where its Apply comes from --------------------------------


def test_a_manual_plugins_pending_update_carries_an_apply_and_an_auto_ones_does_not(
    machine: Machine,
) -> None:
    """One rule for "is this update waiting for the user", shared with the updates section."""
    machine.install("monty")
    machine.install("whodunnit")
    machine.config_path.parent.mkdir(parents=True, exist_ok=True)
    machine.config_path.write_text(
        '[plugins.monty]\nupdate_mode = "manual"\n[plugins.whodunnit]\nupdate_mode = "auto"\n',
        encoding="utf-8",
    )
    reports = (
        PluginReport(
            id="monty",
            installed_version="1.0.0",
            state=UpdateState.AVAILABLE,
            target_version="1.1.0",
            newest_version="1.1.0",
        ),
        PluginReport(
            id="whodunnit",
            installed_version="1.0.0",
            state=UpdateState.AVAILABLE,
            target_version="2.0.0",
            newest_version="2.0.0",
        ),
    )

    view = a_host(machine, reports=lambda: reports).view()

    monty = view.plugin("monty")
    whodunnit = view.plugin("whodunnit")
    assert monty is not None and monty.pending_update is not None
    assert whodunnit is not None and whodunnit.pending_update is not None
    assert monty.pending_update.waiting_for_the_user
    assert not whodunnit.pending_update.waiting_for_the_user


def test_a_blocked_update_is_shown_with_its_reason_and_no_apply(machine: Machine) -> None:
    machine.install("monty")
    reports = (
        PluginReport(
            id="monty",
            installed_version="1.0.0",
            state=UpdateState.BLOCKED,
            target_version="1.0.0",
            newest_version="2.0.0",
            rule=ConsistencyRule.HOST_API,
            reason="monty 2.0.0 needs host_api 3",
        ),
    )

    monty = a_host(machine, reports=lambda: reports).view().plugin("monty")

    assert monty is not None and monty.pending_update is not None
    assert monty.pending_update.apply is None
    assert monty.pending_update.detail == "monty 2.0.0 needs host_api 3"


def test_a_plugin_with_nothing_pending_has_no_update_on_its_line(machine: Machine) -> None:
    machine.install("monty")
    reports = (
        PluginReport(
            id="monty",
            installed_version="1.0.0",
            state=UpdateState.UP_TO_DATE,
            target_version="1.0.0",
        ),
    )

    monty = a_host(machine, reports=lambda: reports).view().plugin("monty")

    assert monty is not None and monty.pending_update is None


# --- what a field's drawing carries --------------------------------------------------------------


def test_a_drawn_field_carries_everything_its_widget_is_built_from(machine: Machine) -> None:
    """The constraints reach the widget, or the declaration was for nothing."""
    machine.install("monty", settings=NINE_TYPES)
    page, desktop = a_page(a_host(machine))

    page.open()

    interval = desktop.drawn("monty", "interval")
    assert interval is not None
    assert (interval.min, interval.max, interval.step) == (1, 60, 5)
    quality = desktop.drawn("monty", "quality")
    assert quality is not None and quality.options == ("low", "high")
    root = desktop.drawn("monty", "root")
    assert root is not None and root.path_kind == "folder"
    assert root.widget is WidgetKind.PATH


def test_a_field_only_the_plugin_writes_is_drawn_read_only(machine: Machine) -> None:
    """F2: the user sees what the plugin recorded, and cannot type over it."""
    machine.install("monty", settings=[dict(NINE_TYPES[0], written_by="plugin"), NINE_TYPES[1]])
    page, desktop = a_page(a_host(machine))

    page.open()

    title = desktop.drawn("monty", "title")
    notes = desktop.drawn("monty", "notes")
    assert title is not None and title.editable is False
    assert notes is not None and notes.editable is True


def test_a_refused_value_is_drawn_with_its_reason_beside_it(machine: Machine) -> None:
    """A person cannot correct what they cannot see, so the refusal and the value are both drawn."""
    machine.install("monty", settings=[NINE_TYPES[2]])
    page, desktop = a_page(a_host(machine))

    page.open()
    page.configure("monty", {"interval": 999})

    interval = desktop.drawn("monty", "interval")
    assert interval is not None
    assert interval.error is not None and "interval" in interval.error


def test_the_headless_page_records_only_what_is_on_it_now(machine: Machine) -> None:
    """Each draw replaces the record, because each draw replaces the page."""
    machine.install("monty", settings=[NINE_TYPES[2]])
    page, desktop = a_page(a_host(machine))

    page.open()
    assert len(desktop.drawn_fields) == 1

    page.remove("monty")

    assert desktop.drawn_fields == ()
    assert len(desktop.plugin_views) == 2


def test_a_broken_plugin_has_no_fields_to_draw(machine: Machine) -> None:
    machine.break_plugin("zombie")
    page, desktop = a_page(a_host(machine))

    page.open()

    assert desktop.drawn_fields == ()
    view = desktop.last_plugins
    assert view is not None
    zombie = view.plugin("zombie")
    assert zombie is not None and zombie.fields == ()
    assert draw_fields(zombie) == ()


def test_a_plugin_entry_knows_whether_it_is_running() -> None:
    entry = PluginEntry(plugin_id="monty", run_state=PluginRunState.RUNNING)
    stopped = replace(entry, run_state=PluginRunState.STOPPED)

    assert entry.running
    assert not stopped.running


def test_a_plugin_state_the_page_was_given_is_never_recomputed(machine: Machine) -> None:
    """The word on the page is :func:`plugin_state`'s, which is `helper status`'s word too."""
    machine.install("monty", settings=[dict(NINE_TYPES[0], required=True)])
    machine.config_path.parent.mkdir(parents=True, exist_ok=True)
    HelperSettings(path=machine.config_path).set_enabled("monty", False)

    monty = a_host(machine, quarantines=lambda: {"monty": "gave up"}).view().plugin("monty")

    # Disabled outranks quarantined outranks held, and the page says the word that names what
    # has to be done first.
    assert monty is not None
    assert monty.run_state is PluginRunState.DISABLED
    assert monty.form is not None
    assert monty.form.availability is PluginAvailability.DISABLED


def test_the_word_on_the_page_and_the_word_in_the_form_are_one_word(machine: Machine) -> None:
    """:class:`PluginState` is the injected seam, and the form is where the page reads it.

    The page never picks between enabled, disabled, quarantined and held itself: it hands the
    word :func:`~innytypes.helper.enablement.plugin_state` chose to the form, and reads the
    form's answer back. So the two cannot disagree, whatever the state.
    """
    machine.install("monty")
    machine.config_path.parent.mkdir(parents=True, exist_ok=True)

    monty = a_host(machine, quarantines=lambda: {"monty": "gave up"}).view().plugin("monty")

    assert monty is not None and monty.form is not None
    assert monty.form.availability is PluginAvailability.QUARANTINED
    assert monty.run_state is PluginRunState.QUARANTINED
    assert monty.detail == "gave up"
