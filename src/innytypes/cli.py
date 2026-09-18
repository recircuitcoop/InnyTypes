"""Console entry point for the host.

Still mostly bare: the host's real commands (`up`, `addons install`, `addons list`) are
built by the slices in docs/plans/0001-innytypes-host.md. This module exists so the
console script, the packaging metadata and the gate are real from the first commit.

The one command that lands early is `anytype-mcp get-key`, because a first run has to
obtain a credential before anything else can work — and a user doing that by hand is a
user pasting a key into a shell history.
"""

from __future__ import annotations

from pathlib import Path

import click

from innytypes import __version__
from innytypes.anytype_mcp.config import DEFAULT_KEY_FILE, ConfigError
from innytypes.anytype_mcp.keys import acquire_api_key


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


def main() -> None:
    """Entry point named by `[project.scripts]`."""
    cli()
