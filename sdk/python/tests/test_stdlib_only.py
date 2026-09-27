"""innytypes-node ships on the standard library alone (spec 2.3.3; plan 0018 §3): an addon
environment holds the addon and its own hash-locked requirements.lock, and nothing an addon
depends on may collide with what another addon, or the host, also depends on. That contract
starts with the SDK every addon is built on declaring no third-party dependency of its own.

This is the new-stack home of the invariant docs/parity/ledger.csv's WI-0018-01 rows point at:
"the new app installs no host code into a package environment ... WI-0018-26 makes the Python
node SDK pure standard library; those items own the new tests of that invariant."
"""

from __future__ import annotations

import tomllib
from pathlib import Path

PYPROJECT = Path(__file__).resolve().parent.parent / "pyproject.toml"


def _project_table() -> dict[str, object]:
    with PYPROJECT.open("rb") as handle:
        document = tomllib.load(handle)
    project = document["project"]
    assert isinstance(project, dict)
    return project


def test_the_pyproject_declares_no_runtime_dependency() -> None:
    """The whole of the contract, as an installable fact rather than a description in a
    docstring: `uv pip install innytypes-node` pulls in nothing else."""
    assert _project_table()["dependencies"] == []


def test_the_module_imports_with_every_third_party_library_blocked() -> None:
    """The other half: not just an empty dependency list, but a module that does not reach
    for one anyway. Every import in innytypes_node is inspected, not merely the declared
    dependencies, in case a stray `import requests` was added without adding it to pyproject.
    """
    import ast

    source = (PYPROJECT.parent / "src" / "innytypes_node" / "__init__.py").read_text()
    tree = ast.parse(source)
    stdlib = {
        "__future__",
        "collections",
        "json",
        "sys",
        "threading",
        "typing",
    }
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                top = alias.name.split(".")[0]
                assert top in stdlib, f"innytypes_node imports {top!r}, not the standard library"
        elif isinstance(node, ast.ImportFrom) and node.module is not None:
            top = node.module.split(".")[0]
            assert top in stdlib, f"innytypes_node imports {top!r}, not the standard library"


def test_the_distribution_requires_the_one_python_innytypes_bundles() -> None:
    """Every node process runs inside the exact Python InnyTypes bundles (spec 2.3.3,
    BUNDLED_PYTHON); a lock built against another minor version would not match what
    `uv pip sync --require-hashes` installs it into."""
    assert _project_table()["requires-python"] == "==3.13.*"
