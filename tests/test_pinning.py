"""The pinning rule, enforced rather than documented — across both ecosystems.

The owner's instruction, verbatim: *"innytype and the addons MUST pin their dependencies"*.
For this project that crosses a language boundary, so the rule is checked on both sides
and on the one place where the two must agree.
"""

from __future__ import annotations

import json
import tomllib
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]


def load_pyproject() -> dict:  # type: ignore[type-arg]
    return tomllib.loads((REPO / "pyproject.toml").read_text(encoding="utf-8"))


def load_package_json() -> dict:  # type: ignore[type-arg]
    return json.loads((REPO / "package.json").read_text(encoding="utf-8"))


def test_every_runtime_dependency_is_an_exact_pin() -> None:
    for spec in load_pyproject()["project"]["dependencies"]:
        assert "==" in spec, f"runtime dependency {spec!r} is not pinned with =="
        assert ">=" not in spec, f"runtime dependency {spec!r} has an unbounded floor"


def test_dev_tools_are_bounded_above() -> None:
    # Ranges are allowed for lint/test tooling, but never an open upper end: a major
    # release of ruff or mypy must not be able to turn the gate red on its own.
    for spec in load_pyproject()["dependency-groups"]["dev"]:
        assert "<" in spec, f"dev dependency {spec!r} has no upper bound"


def test_requires_python_is_one_minor_version() -> None:
    requires = load_pyproject()["project"]["requires-python"]

    assert requires == ">=3.13,<3.14"


def test_npm_dependency_is_an_exact_version() -> None:
    version = load_package_json()["dependencies"]["@anyproto/anytype-mcp"]

    # No caret, no tilde, no tag — npx must resolve to precisely one build.
    assert version.lstrip("0123456789.") == "", f"npm version {version!r} is not exact"


def test_the_python_pin_and_the_npm_pin_agree() -> None:
    # Two files name the same version; the supervisor launches the one in config.py, so a
    # silent divergence would run a build that package-lock.json never locked.
    from anytype_mcp.config import PACKAGE_VERSION

    locked = load_package_json()["dependencies"]["@anyproto/anytype-mcp"]
    assert locked == PACKAGE_VERSION


def test_both_lockfiles_are_committed() -> None:
    assert (REPO / "uv.lock").is_file(), "uv.lock must be committed"
    assert (REPO / "package-lock.json").is_file(), "package-lock.json must be committed"


def test_the_anytype_api_version_is_pinned() -> None:
    # The server turns Anytype's OpenAPI spec into tools, so this header decides which
    # tools exist. It is a dependency, and it is pinned like one.
    from anytype_mcp.config import ANYTYPE_VERSION

    assert ANYTYPE_VERSION == "2025-11-08"
