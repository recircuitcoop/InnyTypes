"""Console entry point for the host.

Deliberately bare: the host's real commands (`up`, `addons install`, `addons list`) are
built by the slices in docs/plans/0001-innytypes-host.md. This module exists so the
console script, the packaging metadata and the gate are real from the first commit.
"""

from __future__ import annotations

import click

from innytypes import __version__


@click.group()
@click.version_option(__version__, prog_name="innytypes")
def cli() -> None:
    """innytypes — host application wrapping the Anytype desktop app."""


def main() -> None:
    """Entry point named by `[project.scripts]`."""
    cli()
