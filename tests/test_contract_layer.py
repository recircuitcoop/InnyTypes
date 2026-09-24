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

A third proof was added after the first two were found to be insufficient (plan 0012, slice
01). Importing the runner is not starting one: `platformdirs` is imported *inside* the two
functions that resolve a per-user directory, so the import probe stayed green while every
attempt to run `monty` exited 1 on `ModuleNotFoundError: No module named 'platformdirs'`.
:func:`test_an_addon_starts_in_an_environment_holding_no_host_library` therefore **starts** an
addon in the blocked interpreter, and
:func:`test_an_addon_left_to_find_its_own_settings_cannot_start_in_that_environment` is the
same probe with the host saying nothing, which is what that failure looks like.
"""

from __future__ import annotations

import json
import os
import re
import socket
import subprocess
import sys
import tomllib
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from importlib.metadata import distribution, distributions, requires
from pathlib import Path

from innytypes.addons.install import HOST_DISTRIBUTION, host_requirement
from innytypes.addons.lock import EnvironmentLock, parse_lock
from innytypes.addons.manifest import parse_settings
from innytypes.addons.secrets import SECRETS_ROOT_VARIABLE
from innytypes.addons.settings import SETTINGS_PATH_VARIABLE, USER, SettingsStore

REPO = Path(__file__).resolve().parents[1]

# How long a probe may take before the gate calls it hung rather than slow. Nothing that
# passes comes close: the child starts an addon against a channel that is already closed.
PROBE_TIMEOUT = 60.0

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


# --------------------------------------------------------------------------------------
# Importing the runner is not starting one.
# --------------------------------------------------------------------------------------
#
# The probe above proves an addon environment can *import* what it runs. It cannot prove that
# the process gets anywhere, and that gap is where a real regression lived: `platformdirs` is
# imported **inside** `innytypes.addons.discovery.default_addons_root` and
# `innytypes.addons.settings.default_settings_path`, with comments explaining why, so importing
# those modules works in an addon environment and calling those functions does not. The runner
# called one at start, to resolve the addon's own settings path, and `monty` exited 1 on every
# launch with `ModuleNotFoundError: No module named 'platformdirs'` while every test here was
# green.
#
# So this probe starts an addon rather than importing a module. Same blocker, same fresh
# interpreter; the addon is defined in the probe and reaches the runner through its injected
# entry-point loader, so nothing is installed anywhere, and its channel is a socketpair whose
# other end the test holds. What the addon was handed is written to a file, because a process
# that failed to start sends nothing and would otherwise be indistinguishable from a quiet one.
_START_PROBE = """
import json, sys

BLOCKED = set(json.loads(sys.argv[1]))
MARKER = sys.argv[2]


class Blocker:
    "Refuses the blocked distributions and their submodules, ahead of every real finder."

    def find_spec(self, name, path=None, target=None):
        if name.partition(".")[0] in BLOCKED:
            raise ModuleNotFoundError(f"{name} is blocked by the contract-layer probe", name=name)
        return None


sys.meta_path.insert(0, Blocker())

# The probe's own vacuity check: a blocker that blocked nothing would make everything below
# pass while proving nothing at all about an addon environment.
try:
    import platformdirs
except ModuleNotFoundError:
    pass
else:
    raise SystemExit("the probe blocked nothing: platformdirs imported anyway")

from innytypes import HOST_API_VERSION
from innytypes.addons.manifest import ENTRY_POINT_GROUP
from innytypes.addons.run import RUNTIME_ENTRY_POINT_GROUP, main

DOCUMENT = {
    "id": "monty",
    "version": "1.0.0",
    "host_api": HOST_API_VERSION,
    "requires": [],
    "emits": [],
    "subscribes": [],
    "settings": [{"id": "root", "type": "text", "label": "Folder to watch"}],
}


class Recorder:
    "The addon. Being constructed is being started, so this runs only if the runner got here."

    def __init__(self, context):
        with open(MARKER, "w", encoding="utf-8") as marker:
            json.dump(dict(context.settings), marker)

    def handle(self, event):
        pass

    def stop(self):
        pass


def load(group, name):
    if group == ENTRY_POINT_GROUP:
        return lambda: DOCUMENT
    if group == RUNTIME_ENTRY_POINT_GROUP:
        return Recorder
    raise AssertionError(f"the runner asked for a group nobody exports: {group}")


# `main` rather than `run`: it is what `python -m innytypes.addons.run` calls, it takes the
# channel from standard input exactly as the host hands it over, and its settings opener is
# the production one — which is the thing under test.
raise SystemExit(main(["monty"], load=load))
"""


@dataclass(frozen=True)
class StartedAddon:
    """What starting an addon in a blocked interpreter produced."""

    exit_code: int
    stderr: str
    settings: dict[str, object] | None


def start_addon_without(
    blocked: Sequence[str],
    *,
    marker: Path,
    environment: Mapping[str, str],
) -> StartedAddon:
    """Run the addon probe with ``blocked`` unimportable, and report how far it got.

    The channel is a real ``AF_UNIX`` socketpair, given to the child as its standard input the
    way :func:`innytypes.children.default_spawn` gives it. This end is closed immediately, so
    the runner starts the addon, finds the host gone and shuts down — the whole start path,
    with nothing to wait for and no sleep anywhere.
    """
    host_end, child_end = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        process = subprocess.Popen(
            [sys.executable, "-c", _START_PROBE, json.dumps(list(blocked)), str(marker)],
            stdin=child_end.fileno(),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=REPO,
            env={**os.environ, **environment},
        )
    finally:
        child_end.close()

    # Nothing is sent: the addon's start is what is being asserted, and an end that closes is
    # the host stopping it.
    host_end.close()
    _stdout, stderr = process.communicate(timeout=PROBE_TIMEOUT)

    return StartedAddon(
        exit_code=process.returncode,
        stderr=stderr,
        settings=(json.loads(marker.read_text(encoding="utf-8")) if marker.exists() else None),
    )


def recorded_settings(path: Path, values: Mapping[str, object]) -> None:
    """Record one plugin's settings the way the host does, at the path it chose."""
    store = SettingsStore(
        "monty",
        parse_settings([{"id": "root", "type": "text", "label": "Folder to watch"}]),
        path=path,
    )
    assert store.write(dict(values), by=USER).accepted


def test_an_addon_starts_in_an_environment_holding_no_host_library(tmp_path: Path) -> None:
    """The invariant, guarded rather than restated: an empty environment can run an addon.

    This is what `WI-0001-08e` promised and what nothing checked. The environment here is the
    one an addon is actually installed into — the host wheel, the addon, the addon's own
    declared dependencies — with every library of ours unreachable, and the addon starts,
    is handed the values the host recorded, and exits cleanly.
    """
    settings_file = tmp_path / "plugins" / "monty.toml"
    recorded_settings(settings_file, {"root": "/tmp/boya"})

    started = start_addon_without(
        HOST_LIBRARIES,
        marker=tmp_path / "started.json",
        # What the host tells the process, because the process cannot work it out.
        environment={
            SETTINGS_PATH_VARIABLE: str(settings_file),
            SECRETS_ROOT_VARIABLE: str(tmp_path / "secrets"),
        },
    )

    assert started.exit_code == 0, started.stderr
    # Started **and** told: the values are the ones written above, read from the file the
    # host named, in a process that could not have found that file for itself.
    assert started.settings == {"root": "/tmp/boya"}


def test_an_addon_left_to_find_its_own_settings_cannot_start_in_that_environment(
    tmp_path: Path,
) -> None:
    """The other half, and the reason the test above is not vacuous.

    Told nothing, the runner falls back to resolving the path itself — today's behaviour
    exactly, kept so a host and an addon of different versions still work together — and in an
    addon environment that resolution is the `ModuleNotFoundError` the plan opens with. So
    this is both the compatibility statement and the mutation: if the runner ever goes back to
    working the location out for itself, the test above fails with this failure.
    """
    started = start_addon_without(
        HOST_LIBRARIES,
        marker=tmp_path / "started.json",
        # Nothing: these two variables are set by the host on a child it spawns and by
        # nothing else, so an empty mapping here is an addon that was told where nothing is.
        environment={},
    )

    assert SETTINGS_PATH_VARIABLE not in os.environ, (
        "this shell already carries the variable the host sets, so the fallback is not "
        "what was exercised"
    )

    assert started.exit_code != 0
    assert started.settings is None, "the addon started, so the fallback resolved a path"
    # The blocker words the refusal, but the failure is the one seen on a real machine: the
    # runner could not start the addon because `platformdirs` was not there.
    assert "addon monty did not start: ModuleNotFoundError" in started.stderr
    assert "platformdirs" in started.stderr


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
