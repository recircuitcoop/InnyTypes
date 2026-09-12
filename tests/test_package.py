"""The package is importable, installed, and its console script runs.

These assertions depend on nothing outside the repository: the version comes from the
installed distribution metadata rather than a parsed file path, and the CLI is exercised
in-process. A clean clone plus `uv sync --frozen` is the whole setup.
"""

from __future__ import annotations

from importlib.metadata import version

from click.testing import CliRunner

import innytypes
from innytypes.cli import cli


def test_version_matches_installed_distribution() -> None:
    # Catches the usual drift: bumping pyproject.toml and forgetting __init__.py, or vice versa.
    assert innytypes.__version__ == version("innytypes")


def test_host_api_version_is_a_positive_integer() -> None:
    # Addon manifests target this number; a string or a zero would make comparison meaningless.
    assert isinstance(innytypes.HOST_API_VERSION, int)
    assert innytypes.HOST_API_VERSION >= 1


def test_cli_reports_its_version() -> None:
    result = CliRunner().invoke(cli, ["--version"])
    assert result.exit_code == 0
    assert innytypes.__version__ in result.output
