"""The window's tabs, as a model: what is in the strip, and what is deliberately not.

Plan 0006's slice 01. Nothing here draws anything and nothing here imports a toolkit — the
strip, the titles, the selection and the fallback are decided in
:mod:`innytypes.helper.window` so that slice 04 draws a decision rather than making it again.

Four things would pass by accident if nobody wrote the test that could fail, so each is
written to turn red when its code is deleted:

* **The strip is rebuilt from the installed set on every draw.** A view that drops one plugin
  and adds another is drawn twice, and the assertion is that the removed plugin is gone from
  the ids, the titles and every lookup — not merely that the new one arrived.
* **A selection nobody can make is refused.** The cheapest way to "pass" a requirement to
  refuse is to not refuse, and a `select` that quietly did nothing would leave somebody
  pressing a tab that never opens.
* **A removed plugin's selection lands on the application's tab**, and specifically *not* on
  the plugin that happens to be next, which is what a fallback written as "the first tab left"
  would have done when the application's tab was not first.
* **No tab carries Quit** (D7), asserted against every strip there is — including the one with
  no plugin installed at all, which is the strip where "it is on some other tab" has nowhere
  to hide.

The plugins are :class:`~innytypes.helper.window.PluginEntry` values built here, which is what
the host publishes; nothing is installed, no process is spawned, nothing sleeps and nothing
reaches a network.
"""

from __future__ import annotations

import pytest

from innytypes.helper.breaker import RunState
from innytypes.helper.window import (
    APPLICATION_TAB,
    APPLICATION_TAB_TITLE,
    QUIT_LABEL,
    Control,
    Element,
    PluginEntry,
    PluginRunState,
    PluginSource,
    PluginView,
    ProcessRow,
    Tab,
    TabbedContents,
    TabKind,
    WindowContents,
    WindowError,
)


def installed(*plugin_ids: str) -> PluginView:
    """The host's view of some ordinary installed plugins, in the order given."""
    return PluginView(
        plugins=tuple(
            PluginEntry(
                plugin_id=plugin_id,
                version="1.0.0",
                source=PluginSource.INDEX,
                run_state=PluginRunState.RUNNING,
            )
            for plugin_id in plugin_ids
        )
    )


def contents() -> WindowContents:
    """Application contents with something on them, so "carried" is worth asserting."""
    return WindowContents(processes=(ProcessRow(child_id="host", state=RunState.RUNNING),))


# --- the strip ------------------------------------------------------------------------------


def test_the_strip_is_the_application_and_one_tab_for_each_plugin() -> None:
    """A Tab has an id, a title and the contents it carries, and the strip is ordered."""
    window = TabbedContents(application=contents(), installed=installed("monty", "whodunnit"))

    assert window.ids == (APPLICATION_TAB, "monty", "whodunnit")
    assert window.titles == (APPLICATION_TAB_TITLE, "monty", "whodunnit")

    monty = window.tab("monty")
    assert monty is not None
    assert monty.kind is TabKind.PLUGIN
    assert monty.plugin.version == "1.0.0"


@pytest.mark.parametrize("plugin_ids", [(), ("monty",), ("monty", "whodunnit", "summarize")])
def test_the_application_tab_is_always_there_and_always_first(plugin_ids: tuple[str, ...]) -> None:
    """D8, whatever is installed — including nothing at all."""
    window = TabbedContents(application=contents(), installed=installed(*plugin_ids))

    first = window.tabs[0]
    assert first.id == APPLICATION_TAB
    assert first.title == APPLICATION_TAB_TITLE
    assert first.kind is TabKind.APPLICATION
    assert window.application_tab == first
    assert len(window.tabs) == len(plugin_ids) + 1


def test_plugin_tabs_are_titled_by_id_and_follow_the_view_s_order() -> None:
    """D1's title, and the host's ordering rather than a second one invented here."""
    window = TabbedContents(installed=installed("whodunnit", "monty", "summarize"))

    assert window.ids == (APPLICATION_TAB, "whodunnit", "monty", "summarize")
    assert window.titles == (APPLICATION_TAB_TITLE, "whodunnit", "monty", "summarize")


def test_a_plugin_with_no_settings_still_gets_a_tab() -> None:
    """D2: its switch, its state and its Remove are on it, so it has to exist."""
    quiet = PluginEntry(plugin_id="quiet", version="2.0.0", source=PluginSource.INDEX, form=None)
    window = TabbedContents(installed=PluginView(plugins=(quiet,)))

    tab = window.tab("quiet")
    assert tab is not None
    assert tab.title == "quiet"
    assert tab.plugin is quiet
    assert tab.plugin.fields == ()


def test_a_broken_plugin_gets_a_tab_carrying_its_reason() -> None:
    """The plugin somebody most needs to reach is the one with no readable record."""
    wrecked = PluginEntry(
        plugin_id="wrecked",
        run_state=PluginRunState.BROKEN,
        detail="its recorded manifest could not be read",
    )
    window = TabbedContents(installed=PluginView(plugins=(wrecked,)))

    tab = window.tab("wrecked")
    assert tab is not None
    assert tab.title == "wrecked"
    assert tab.plugin.run_state is PluginRunState.BROKEN
    assert tab.plugin.detail == "its recorded manifest could not be read"
    assert tab.plugin.version is None
    assert tab.plugin.source is None
    assert tab.plugin.form is None


# --- what a tab refuses ---------------------------------------------------------------------


def test_a_plugin_tab_has_no_application_contents() -> None:
    tab = Tab.for_plugin(PluginEntry(plugin_id="monty"))

    with pytest.raises(WindowError, match="monty tab is a plugin"):
        _ = tab.application


def test_the_application_tab_has_no_plugin() -> None:
    tab = Tab.for_application(contents())

    with pytest.raises(WindowError, match="carries no plugin"):
        _ = tab.plugin


# --- rebuilt on every draw --------------------------------------------------------------------


def test_the_strip_is_rebuilt_from_the_installed_set_on_every_draw() -> None:
    """One plugin goes, another arrives, and nothing of the first survives in the model."""
    window = TabbedContents()
    window.draw(contents(), installed("monty", "whodunnit"))
    assert window.ids == (APPLICATION_TAB, "monty", "whodunnit")

    window.draw(contents(), installed("monty", "summarize"))

    assert window.ids == (APPLICATION_TAB, "monty", "summarize")
    assert window.titles == (APPLICATION_TAB_TITLE, "monty", "summarize")
    assert window.tab("whodunnit") is None
    assert all(tab.id != "whodunnit" for tab in window.tabs)


def test_the_strip_is_derived_rather_than_kept() -> None:
    """Changing what is installed changes the strip without anything being redrawn."""
    window = TabbedContents(installed=installed("monty"))
    assert window.ids == (APPLICATION_TAB, "monty")

    window.installed = installed("monty", "summarize")

    assert window.ids == (APPLICATION_TAB, "monty", "summarize")


# --- selection ---------------------------------------------------------------------------------


def test_selection_starts_on_the_application_tab_and_round_trips() -> None:
    window = TabbedContents(application=contents(), installed=installed("monty", "whodunnit"))
    assert window.selected_id == APPLICATION_TAB

    chosen = window.select("whodunnit")

    assert chosen.id == "whodunnit"
    assert window.selected_id == "whodunnit"
    assert window.selected.plugin.plugin_id == "whodunnit"


def test_selecting_a_tab_that_is_not_in_the_strip_is_refused() -> None:
    window = TabbedContents(installed=installed("monty"))

    with pytest.raises(WindowError, match="no 'summarize' tab"):
        window.select("summarize")

    assert window.selected_id == APPLICATION_TAB


def test_the_selection_falls_back_to_the_application_tab_when_its_plugin_goes() -> None:
    """Not to the plugin that happens to be next, and not to nothing."""
    window = TabbedContents()
    window.draw(contents(), installed("monty", "whodunnit"))
    window.select("whodunnit")

    window.draw(contents(), installed("monty"))

    assert window.selected_id == APPLICATION_TAB
    assert window.selected.kind is TabKind.APPLICATION


def test_a_reinstalled_plugin_does_not_take_the_selection_back() -> None:
    """The fallback happened, so the window stays where the fallback put it."""
    window = TabbedContents()
    window.draw(contents(), installed("monty"))
    window.select("monty")
    window.draw(contents(), installed())

    window.draw(contents(), installed("monty"))

    assert window.selected_id == APPLICATION_TAB


def test_the_selection_survives_a_draw_that_keeps_the_tab() -> None:
    window = TabbedContents()
    window.draw(contents(), installed("monty", "whodunnit"))
    window.select("monty")

    window.draw(contents(), installed("monty", "whodunnit", "summarize"))

    assert window.selected_id == "monty"


# --- Quit is the window's, and no tab's (D7) ---------------------------------------------------


@pytest.mark.parametrize("plugin_ids", [(), ("monty",), ("monty", "whodunnit", "summarize")])
def test_quit_is_on_the_window_and_in_no_tab(plugin_ids: tuple[str, ...]) -> None:
    window = TabbedContents(application=contents(), installed=installed(*plugin_ids))

    assert window.quit == Control(label=QUIT_LABEL)
    assert Element.QUIT not in window.application_tab.elements
    # And no tab has a Quit control of its own either: the window is the only thing that has
    # one, which is what stops Quit ever being behind a tab somebody has to find first.
    assert all(not hasattr(tab, "quit") for tab in window.tabs)


def test_the_application_tab_still_carries_everything_else() -> None:
    """Quit is subtracted; nothing else is."""
    window = TabbedContents(application=contents())

    elements = window.application_tab.elements

    assert Element.PROCESSES in elements
    assert Element.TELEMETRY in elements
    assert Element.LAUNCH_AT_LOGIN in elements
