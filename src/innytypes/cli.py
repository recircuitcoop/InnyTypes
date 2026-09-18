"""Console entry point for the host.

Still mostly bare: the host's real commands (`up`, `addons install`, `addons list`) are
built by the slices in docs/plans/0001-innytypes-host.md. This module exists so the
console script, the packaging metadata and the gate are real from the first commit.

The one command that lands early is `anytype-mcp get-key`, because a first run has to
obtain a credential before anything else can work — and a user doing that by hand is a
user pasting a key into a shell history.

`anytype-mcp refresh-tool-surface` lands with it, for the opposite reason: it is the one
command in this repository that needs Node and a running Anytype, so it is a command a
person types rather than anything the host or the gate ever runs by itself.

`telemetry` and `addons pin|unpin` land next (plan 0003 slice 01). They are the user's way
to change one switch in the helper's `config.toml`; the helper re-reads that file before it
acts, so neither command needs anything to be restarted.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import click

from innytypes import __version__
from innytypes.anytype_mcp.config import DEFAULT_KEY_FILE, ConfigError, load_config
from innytypes.anytype_mcp.keys import acquire_api_key
from innytypes.anytype_mcp.refresh import RefreshError, refresh_tool_surface
from innytypes.anytype_mcp.tools import FIXTURE_PATH
from innytypes.helper.config import (
    HelperConfigError,
    HelperSettings,
    Telemetry,
    default_config_path,
)


@click.group()
@click.version_option(__version__, prog_name="innytypes")
def cli() -> None:
    """innytypes — host application wrapping the Anytype desktop app."""


@cli.group("anytype-mcp")
def anytype_mcp() -> None:
    """The bundled Anytype MCP server."""


@anytype_mcp.command("get-key")
@click.option(
    "--key-file",
    type=click.Path(dir_okay=False, path_type=Path),
    default=None,
    help=f"Where to store the key. Default: {DEFAULT_KEY_FILE}",
)
@click.option(
    "--force",
    is_flag=True,
    default=False,
    help="Replace an existing key file instead of refusing.",
)
def get_key(key_file: Path | None, force: bool) -> None:
    """Obtain an Anytype API key and store it, readable by nobody but you.

    Explicit on purpose (plan 0001, invariant 6): nothing acquires a key at startup.
    """
    click.echo("Anytype Desktop will show a four-digit code — type it here and press Enter.")
    click.echo("The key itself is never printed; it goes straight into the key file.")

    try:
        path = acquire_api_key(key_file=key_file, force=force)
    except ConfigError as error:
        # ClickException prints the message and exits 1, with no traceback. None of these
        # messages contains the credential, which is what makes printing them safe.
        raise click.ClickException(str(error)) from error

    click.echo(f"Stored an Anytype API key in {path} (mode 0600).")


@anytype_mcp.command("refresh-tool-surface")
@click.option(
    "--key-file",
    type=click.Path(dir_okay=False, path_type=Path),
    default=None,
    help=f"Where to read the key from. Default: $ANYTYPE_API_KEY, then {DEFAULT_KEY_FILE}",
)
@click.option(
    "--output",
    type=click.Path(dir_okay=False, path_type=Path),
    default=None,
    help=f"Where to write the surface. Default: {FIXTURE_PATH}",
)
def refresh_tool_surface_command(key_file: Path | None, output: Path | None) -> None:
    """Re-record which tools the pinned server exposes, by asking the real server.

    Needs Node (`npm ci` first) and a running Anytype; nothing else in this repository
    does, and the gate never runs this. Run it when either pin moves: the diff it prints
    is the evidence plan 0002 asks an upgrade to land with.
    """
    try:
        surface, diff = refresh_tool_surface(
            config=load_config(key_file=key_file),
            path=output,
        )
    except (ConfigError, RefreshError) as error:
        # No message from either family contains the credential, which is what makes
        # printing them safe; ClickException prints one and exits 1 with no traceback.
        raise click.ClickException(str(error)) from error

    click.echo(
        f"Recorded {len(surface.tools)} tools for @anyproto/anytype-mcp@"
        f"{surface.package_version} / Anytype-Version {surface.anytype_version}."
    )

    if diff.is_empty:
        click.echo("The tool surface is unchanged.")
        return

    # Printed, not just returned: an upgrade is reviewed by a person reading this list
    # next to the committed fixture's diff.
    for name in diff.added:
        click.echo(f"  added   {name}")
    for name in diff.removed:
        click.echo(f"  removed {name}")
    for name in diff.changed:
        click.echo(f"  changed {name}")


def _config_option(command: click.decorators.FC) -> click.decorators.FC:
    """The `--config` option both helper-facing groups take, spelled once."""
    return click.option(
        "--config",
        "config_file",
        type=click.Path(dir_okay=False, path_type=Path),
        default=None,
        help=f"The helper's config file. Default: {default_config_path()}",
    )(command)


@contextmanager
def _refusing_loudly() -> Iterator[None]:
    """Print a config refusal and exit 1, rather than showing the user a traceback.

    One handler for every command in this file that touches `config.toml`: the loader names
    the file, the section and the key, so the whole job here is to let that message be the
    thing the user sees.
    """
    try:
        yield
    except HelperConfigError as error:
        raise click.ClickException(str(error)) from error


def _describe_telemetry(state: Telemetry) -> str:
    """One line saying where the switch stands, in the words the three states deserve."""
    if state is Telemetry.UNSET:
        return (
            "Telemetry: the first-launch question has not been answered yet. "
            "Nothing is sent, and nothing is queued."
        )
    if state is Telemetry.ON:
        return "Telemetry: on. Usage and error reports are sent."
    return "Telemetry: off. Nothing leaves this machine."


@cli.group("telemetry")
@_config_option
@click.pass_context
def telemetry(ctx: click.Context, config_file: Path | None) -> None:
    """The telemetry switch: on, off, what it says now, and what would be sent."""
    ctx.obj = HelperSettings(path=config_file)


@telemetry.command("on")
@click.pass_obj
def telemetry_on(settings: HelperSettings) -> None:
    """Turn telemetry on and store the answer."""
    with _refusing_loudly():
        settings.set_telemetry(True)

    click.echo(f"Telemetry is on, saved in {settings.path}.")


@telemetry.command("off")
@click.pass_obj
def telemetry_off(settings: HelperSettings) -> None:
    """Turn telemetry off. Nothing leaves the machine, and anything queued is dropped."""
    with _refusing_loudly():
        settings.set_telemetry(False)

    click.echo(f"Telemetry is off, saved in {settings.path}.")


@telemetry.command("status")
@click.pass_obj
def telemetry_status(settings: HelperSettings) -> None:
    """Say whether the question has been answered, and what the answer was."""
    with _refusing_loudly():
        state = settings.telemetry

    click.echo(_describe_telemetry(state))
    click.echo(f"Config file: {settings.path}")


@telemetry.command("show")
@click.pass_obj
def telemetry_show(settings: HelperSettings) -> None:
    """Print the queued reports, exactly as they would be sent (plan 0003 D24)."""
    with _refusing_loudly():
        state = settings.telemetry

    click.echo(_describe_telemetry(state))

    # Said plainly rather than printed as an empty list: "nothing is queued" would claim a
    # queue was consulted, and there is no queue to consult until slice 08 builds one.
    click.echo(
        "No queued reports to show: no telemetry queue exists yet — the on-disk queue "
        "lands with the telemetry pipeline (plan 0003 slice 08)."
    )


@cli.group("addons")
@_config_option
@click.pass_context
def addons(ctx: click.Context, config_file: Path | None) -> None:
    """Installed addons. The rest of this group lands with plan 0001."""
    ctx.obj = HelperSettings(path=config_file)


@addons.command("pin")
@click.argument("addon_id")
@click.pass_obj
def addons_pin(settings: HelperSettings, addon_id: str) -> None:
    """Hold an addon at its installed version, whatever its update mode says.

    Records a setting; it does not check that the addon is installed. A pin written before an
    addon arrives is the user saying "not this one", and the file is read when nothing runs.
    """
    with _refusing_loudly():
        settings.set_pinned(addon_id, True)

    click.echo(f"Pinned {addon_id} at its installed version.")


@addons.command("unpin")
@click.argument("addon_id")
@click.pass_obj
def addons_unpin(settings: HelperSettings, addon_id: str) -> None:
    """Release an addon's pin, so its update mode decides again."""
    with _refusing_loudly():
        settings.set_pinned(addon_id, False)

    click.echo(f"Unpinned {addon_id}; its update mode decides from now on.")


def main() -> None:
    """Entry point named by `[project.scripts]`."""
    cli()
