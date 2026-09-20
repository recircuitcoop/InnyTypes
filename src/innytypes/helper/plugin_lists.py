"""The catalogue lists on the application's tab (plan 0006, slice 02c).

This module deliberately knows no installation implementation.  A press is routed to the
existing install path supplied by the composition root, just as catalogue reads are routed to
``CatalogueReader``.  The values here are the complete headless drawing and its small actions.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass

from innytypes.helper.catalogue import (
    CatalogueEntry,
    CatalogueError,
    CatalogueReader,
    PluginCatalogue,
)
from innytypes.helper.config import (
    OFFICIAL_SOURCE_NAME,
    CatalogueSource,
    HelperConfigError,
    HelperSettings,
)
from innytypes.helper.window import Control, InstalledPlugin, SwitchRow, SwitchState


@dataclass(frozen=True)
class CatalogueEntryView:
    plugin_id: str
    summary: str
    requirement: str
    source_name: str
    verified: bool
    install: Control
    installed: bool = False
    detail: str | None = None

    @property
    def confirmation(self) -> str:
        trust = "" if self.verified else " (unverified source)"
        return f"Install {self.requirement} from {self.source_name}{trust}?"


@dataclass(frozen=True)
class CatalogueList:
    title: str
    source_name: str
    entries: tuple[CatalogueEntryView, ...] = ()
    auto_update: SwitchRow | None = None
    remove: Control | None = None
    message: str | None = None


@dataclass(frozen=True)
class SourceAction:
    accepted: bool
    message: str


class PluginLists:
    """Build and act on installed, official, then registered-source lists."""

    def __init__(
        self,
        *,
        settings: HelperSettings,
        reader: CatalogueReader,
        installed: Iterable[InstalledPlugin] = (),
        installer: Callable[[str], object],
        confirm: Callable[[str], bool] = lambda _question: True,
    ) -> None:
        self.settings = settings
        self.reader = reader
        self.installed = tuple(installed)
        self.installer = installer
        self.confirm = confirm

    @property
    def groups(self) -> tuple[object, ...]:
        return (self.installed, self._official(), *self._registered())

    def register(self, name: str, url: str, *, public_key: str | None = None) -> SourceAction:
        try:
            self.settings.add_source(name, url, public_key=public_key)
        except HelperConfigError as error:
            return SourceAction(False, str(error))
        return SourceAction(True, f"Plugin source {name!r} was registered.")

    def remove_source(self, name: str) -> SourceAction:
        try:
            self.settings.remove_source(name)
        except HelperConfigError as error:
            return SourceAction(False, str(error))
        return SourceAction(True, f"Plugin source {name!r} was removed.")

    def set_auto_update(self, name: str, enabled: bool) -> SourceAction:
        try:
            self.settings.set_source_auto_update(name, enabled)
        except HelperConfigError as error:
            return SourceAction(False, str(error))
        return SourceAction(
            True, f"Automatic updates for {name!r} are {'on' if enabled else 'off'}."
        )

    def install_entry(self, entry: CatalogueEntryView) -> SourceAction:
        if not entry.install.enabled:
            return SourceAction(False, entry.detail or f"{entry.plugin_id} cannot be installed")
        if not self.confirm(entry.confirmation):
            return SourceAction(False, "Installation cancelled.")
        try:
            self.installer(entry.requirement)
            self.settings.set_plugin_source(entry.plugin_id, entry.source_name)
        except (
            Exception
        ) as error:  # the page reports the existing path's refusal beside the control
            return SourceAction(False, str(error))
        return SourceAction(True, f"{entry.plugin_id} was installed from {entry.source_name}.")

    def _official(self) -> CatalogueList:
        try:
            catalogue = self.reader.official()
        except CatalogueError as error:
            return CatalogueList("Official plugins", OFFICIAL_SOURCE_NAME, message=str(error))
        return self._list(catalogue, source=None, official_ids=frozenset())

    def _registered(self) -> tuple[CatalogueList, ...]:
        official_ids: frozenset[str]
        try:
            official_ids = frozenset(entry.plugin_id for entry in self.reader.official().entries)
        except CatalogueError:
            official_ids = frozenset()
        lists: list[CatalogueList] = []
        for source in self.settings.sources:
            try:
                catalogue = self.reader.registered(source)
            except CatalogueError as error:
                lists.append(self._failed_source(source, str(error)))
            else:
                lists.append(self._list(catalogue, source=source, official_ids=official_ids))
        return tuple(lists)

    def _list(
        self,
        catalogue: PluginCatalogue,
        *,
        source: CatalogueSource | None,
        official_ids: frozenset[str],
    ) -> CatalogueList:
        installed = {plugin.plugin_id for plugin in self.installed}
        entries = tuple(
            self._entry(entry, installed=installed, official_ids=official_ids)
            for entry in catalogue.entries
        )
        return CatalogueList(
            "Official plugins" if source is None else source.name,
            catalogue.name,
            entries,
            auto_update=None
            if source is None
            else SwitchRow(
                "Update automatically",
                SwitchState.ON if source.auto_update is True else SwitchState.OFF,
            ),
            remove=None if source is None else Control("Remove source"),
        )

    def _entry(
        self,
        entry: CatalogueEntry,
        *,
        installed: set[str],
        official_ids: frozenset[str],
    ) -> CatalogueEntryView:
        already = entry.plugin_id in installed
        shadowed = entry.catalogue != OFFICIAL_SOURCE_NAME and entry.plugin_id in official_ids
        detail = (
            "already installed"
            if already
            else "the official catalogue takes precedence"
            if shadowed
            else None
        )
        return CatalogueEntryView(
            entry.plugin_id,
            entry.summary,
            entry.install_source,
            entry.catalogue,
            entry.verified,
            Control("Install", enabled=not already and not shadowed),
            installed=already,
            detail=detail,
        )

    @staticmethod
    def _failed_source(source: CatalogueSource, message: str) -> CatalogueList:
        return CatalogueList(
            source.name,
            source.name,
            auto_update=SwitchRow(
                "Update automatically",
                SwitchState.ON if source.auto_update is True else SwitchState.OFF,
            ),
            remove=Control("Remove source"),
            message=message,
        )
