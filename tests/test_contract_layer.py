"""The contract layer has no third-party dependencies, and an addon environment proves it.

The defect these tests were written against was a real one. Reinstalling the `monty` plugin
failed with::

    Because only monty==0.1.0 is available and monty==0.1.0 depends on psutil==7.1.0 ...
    And because innytypes==0.1.0 depends on psutil==7.2.2 ...
    all versions of innytypes and all versions of monty are incompatible.

Every addon environment holds the addon **and** `innytypes` at the host's exact version
(plan 0004, D17), and both pin with `==` (plan 0001). So a library named by both has to be
pinned to one version by both, and every bump on the host's side breaks every plugin that
names it. Bumping `monty` made that message go away; it did not make the next one go away.

The fix is structural: what an addon environment installs must depend on nothing. So the
layer an addon actually imports — the manifest, the settings store and form, the events, the
runner and its context — reaches no third-party library, and the libraries the host process
runs on live in an optional `host` extra an addon environment never asks for.

Two proofs, one per half:

* :func:`test_the_runner_imports_with_every_third_party_library_blocked` runs a fresh
  interpreter in which `click`, `httpx`, `psutil`, `nacl` and `platformdirs` cannot be
  imported at all, and imports what an addon process runs. Before the split it failed on
  `platformdirs`, imported at the top of `innytypes.addons.settings`, and on `httpx`,
  reached through `innytypes.anytype_mcp`'s package import for a logger.
* :func:`test_an_addon_environments_lock_names_no_host_library` resolves an addon
  environment from the metadata this distribution actually declares, and asserts none of
  those five libraries is in the lock it would be installed from.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import tomllib
from collections.abc import Sequence
from importlib.metadata import distribution, distributions, requires
from pathlib import Path

from innytypes.addons.install import HOST_DISTRIBUTION, host_requirement
from innytypes.addons.lock import EnvironmentLock, parse_lock

REPO = Path(__file__).resolve().parents[1]

# The libraries the host process runs on: `pyproject.toml`'s `host` extra. A plugin may name
# any of them, at any version, and must never have to agree with us about which one.
HOST_LIBRARIES = ("click", "httpx", "nacl", "platformdirs", "psutil")

# What an addon process is started as (`innytypes.children.ADDON_RUNNER_MODULE`). Everything
# this module imports is, by definition, in every addon environment.
RUNNER_MODULE = "innytypes.addons.run"

# `Requires-Dist` markers, as `importlib.metadata` hands them back: the quoting around the
# extra's name is the packaging tool's choice, so neither spelling is assumed.
EXTRA_MARKER = re.compile(r";.*\bextra\s*==")
HOST_EXTRA_MARKER = re.compile(r";.*\bextra\s*==\s*[\"\']host[\"\']")

# The distribution name a requirement starts with, whatever follows it: a pin, a range, a
# marker, an extra or a ` @ ` reference.
_NAME_RE = re.compile(r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)")

# Packages of this distribution that are the **host's** and must stay out of the runner's
# import graph. Each one is a doorway to a pinned library: the installer builds wheels, the
# MCP package speaks HTTP, the CLI is `click`, and the helper reads the process table.
HOST_PACKAGES = (
    "innytypes.addons.install",
    "innytypes.anytype_mcp",
    "innytypes.children",
    "innytypes.cli",
    "innytypes.helper",
    "innytypes.host",
)

# Imports the runner inside an interpreter where the five libraries above cannot be found,
# and reports which modules of this distribution that took. A separate process rather than a
# `sys.modules` fixture: by the time this test runs, the rest of the suite has imported the
# host, so blocking anything in-process would only prove that the imports already happened.
_PROBE = """
import json, sys

BLOCKED = set(json.loads(sys.argv[1]))


class Blocker:
    "Refuses the blocked distributions and their submodules, ahead of every real finder."

    def find_spec(self, name, path=None, target=None):
        if name.partition(".")[0] in BLOCKED:
            raise ModuleNotFoundError(f"{name} is blocked by the contract-layer probe", name=name)
        return None


sys.meta_path.insert(0, Blocker())

import importlib

importlib.import_module(sys.argv[2])

print(json.dumps(sorted(m for m in sys.modules if m.startswith("innytypes"))))
"""


def requirement_name(spec: str) -> str:
    """The distribution ``spec`` names, normalised the way a resolver compares names."""
    match = _NAME_RE.match(spec)
    assert match is not None, f"{spec!r} does not start with a distribution name"
    return match.group(1).lower().replace("_", "-")


def import_graph_without(blocked: Sequence[str], module: str) -> list[str]:
    """Import ``module`` with ``blocked`` unimportable; return the innytypes modules it took.

    The child's own failure is what this test is for, so a non-zero exit is re-raised with
    its traceback attached rather than swallowed into a bare "it did not work".
    """
    probe = subprocess.run(
        [sys.executable, "-c", _PROBE, json.dumps(list(blocked)), module],
        capture_output=True,
        text=True,
        cwd=REPO,
    )
    assert probe.returncode == 0, (
        f"importing {module} with {', '.join(blocked)} blocked failed:\n{probe.stderr}"
    )
    return list(json.loads(probe.stdout))


def test_the_runner_imports_with_every_third_party_library_blocked() -> None:
    # The assertion the whole slice exists for. An addon environment installs `innytypes`
    # with no dependency at all, so this is not a tidiness check: it is what the addon's
    # interpreter can actually do.
    imported = import_graph_without(HOST_LIBRARIES, RUNNER_MODULE)

    assert RUNNER_MODULE in imported


def test_the_runner_reaches_no_host_package() -> None:
    # Blocking the libraries would not catch a host package that happens to import nothing
    # pinned *today*; it would catch it on the afternoon somebody adds an import. Naming the
    # packages makes the direction the rule rather than the symptom.
    imported = import_graph_without(HOST_LIBRARIES, RUNNER_MODULE)

    reached = [
        module
        for module in imported
        if any(module == package or module.startswith(f"{package}.") for package in HOST_PACKAGES)
    ]

    assert reached == [], (
        f"{RUNNER_MODULE} reaches {', '.join(reached)}, which is the host's side of the "
        "boundary; import from the module that defines the name, or move the name down"
    )


def test_the_distribution_declares_no_mandatory_dependency() -> None:
    # Read from the **installed metadata**, which is what a resolver reads: this is the
    # sentence `uv` was reciting when it refused to install the plugin.
    mandatory = [spec for spec in requires(HOST_DISTRIBUTION) or () if "extra ==" not in spec]

    assert mandatory == [], (
        f"{HOST_DISTRIBUTION} requires {', '.join(mandatory)} unconditionally, so every addon "
        "environment installs it and every plugin naming the same library must agree with us"
    )


def test_the_host_libraries_are_all_reachable_from_the_extra() -> None:
    # The other half of the same split, so the test above cannot pass by the libraries having
    # quietly stopped being dependencies at all. Every one is still declared — under the
    # extra — and still installed here, because the gate runs the host.
    declared = {
        requirement_name(spec)
        for spec in requires(HOST_DISTRIBUTION) or ()
        if HOST_EXTRA_MARKER.search(spec)
    }

    assert {"click", "httpx", "platformdirs", "psutil", "pynacl"} <= declared
    for library in HOST_LIBRARIES:
        __import__(library)


# --------------------------------------------------------------------------------------
# What the lock of a freshly built addon environment contains.
# --------------------------------------------------------------------------------------


def installed() -> set[str]:
    """Every distribution present in the environment this gate is running in."""
    return {requirement_name(found.name) for found in distributions() if found.name}


def metadata_requirements(name: str) -> list[str]:
    """``name``'s mandatory dependencies, as distribution names, from the installed metadata.

    Two kinds of requirement are left out, and for the same reason: neither is in the
    environment a resolver would build here.

    * **Extras**, because nothing in an addon environment asks for one. The addon is
      installed as its own artifact and the host as `innytypes @ file://<wheel>`, and neither
      spelling carries a `[...]`.
    * **Anything not installed beside us**, which is how an environment marker is answered
      without re-implementing one: a requirement guarded by `python_version < "3.11"` is
      absent from this environment precisely because that marker is false here.
    """
    here = installed()
    names = [
        requirement_name(spec) for spec in requires(name) or () if not EXTRA_MARKER.search(spec)
    ]
    return [dependency for dependency in names if dependency in here]


def resolve(requirements: Sequence[str]) -> list[str]:
    """Every distribution ``requirements`` pulls in, transitively, from installed metadata.

    A resolver's job, done against the one source of truth a real resolver uses: the
    `Requires-Dist` metadata of the distributions themselves. `uv` would consult an index for
    versions and hashes, which this gate has neither of — but *which* distributions end up in
    the environment is decided by this metadata, and that is the question here.
    """
    seen: list[str] = []
    pending = [requirement_name(requirement) for requirement in requirements]
    while pending:
        name = pending.pop()
        if name in seen:
            continue
        seen.append(name)
        pending.extend(metadata_requirements(name))
    return seen


def compiled_lock(requirements: Sequence[str]) -> EnvironmentLock:
    """The lock `uv pip compile` would produce for ``requirements``, resolved as above.

    Fed to the real :class:`~innytypes.addons.install.UvInstaller` through its injected
    runner, so this goes through the parser and the rules :mod:`innytypes.addons.lock`
    applies rather than around them.
    """
    lines = []
    for name in resolve(requirements):
        version = distribution(name).version
        lines.append(f"{name}=={version} \\")
        lines.append(f"    --hash=sha256:{'0' * 64}")
    return parse_lock("\n".join(lines) + "\n")


class StubInstaller:
    """Builds the host's wheel by creating the file `uv build --wheel` would leave behind.

    Only :meth:`build_wheel` is ever called here, and only by
    :func:`~innytypes.addons.install.host_requirement`; the rest of the protocol is not part
    of the question this file asks.
    """

    def build_wheel(self, source: Path, *, into: Path) -> Path:
        wheel = (
            into / f"{HOST_DISTRIBUTION}-{distribution(HOST_DISTRIBUTION).version}-py3-none-any.whl"
        )
        wheel.write_bytes(b"")
        return wheel


def test_an_addon_environments_lock_names_no_host_library(tmp_path: Path) -> None:
    # The install the defect report came from, from the requirement the host itself supplies:
    # `innytypes @ file://<the wheel the host built of itself>`, resolved against the
    # metadata that wheel declares — which is the sentence `uv` was reciting when it refused.
    host = host_requirement(installer=StubInstaller(), into=tmp_path / "host")

    assert "[" not in host, f"{host} asks for an extra, so the addon environment installs it"

    lock = compiled_lock((host,))
    names = {requirement.name for requirement in lock.requirements}

    assert HOST_DISTRIBUTION in names, "the host is what every addon environment holds"
    for library in ("click", "httpx", "platformdirs", "psutil", "pynacl"):
        assert library not in names, (
            f"an addon environment would install {library} because `innytypes` names it; a "
            f"plugin pinning another version of {library} could then never be installed"
        )


def test_the_resolution_would_notice_a_dependency_coming_back() -> None:
    # Proof the check above can fail rather than passing because it resolves nothing.
    # `briefcase` is a real, installed distribution with real dependencies, standing in for
    # an `innytypes` that declared some again.
    resolved = resolve(("briefcase",))

    assert len(resolved) > 1, "resolving from metadata found no transitive dependency at all"


def test_the_pyproject_puts_every_host_library_in_the_extra() -> None:
    # The declaration itself, so a library added to the wrong list is a red gate rather than
    # a plugin that fails to install on somebody else's machine.
    project = tomllib.loads((REPO / "pyproject.toml").read_text(encoding="utf-8"))["project"]

    assert project["dependencies"] == []
    assert project["optional-dependencies"]["host"]
