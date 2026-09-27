"""The pinning rule, enforced rather than documented — across both ecosystems.

The owner's instruction, verbatim: *"innytype and the addons MUST pin their dependencies"*.
The host supervises a Node MCP server (plan 0002), so the rule crosses a language
boundary: it is checked on both sides and on the one place where the two must agree.

The second half of this file is the other side of the same rule: **a pin that has to move
moves everywhere at once**. Plan 0002's *Bumping a pin* section is the procedure, and the
tests below are what stop it from being prose. They read the pins out of the four files a
machine reads them from, so the same check can be run against a scratch copy of those files
with one of them deliberately left behind — which is how a procedure gets a test that could
have failed, instead of four assertions that were green before anybody wrote them.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import tomllib
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]

# The npm package both ecosystems name.
NPM_PACKAGE = "@anyproto/anytype-mcp"

# The four files a pinned version is read out of by something other than a human. Plan 0002
# names the same four in its `Where a version lives` table, and
# `test_the_procedure_names_every_place_a_version_lives` is what keeps the two lists equal.
PACKAGE_JSON = "package.json"
PACKAGE_LOCK = "package-lock.json"
CONFIG_MODULE = "src/innytypes/anytype_mcp/config.py"
TOOL_SURFACE = "src/innytypes/anytype_mcp/tool_surface.json"
# The new application's copies (plan 0018, WI-0018-18): its pins module and the surface it
# holds the MCP child to. app/test/unit/anytype-pins.test.ts keeps them equal to the four above.
APP_PINS_MODULE = "app/src/domain/anytype/pins.ts"
APP_TOOL_SURFACE = "app/src/adapters/anytype/tool_surface.json"
# The app workspace's own manifest (WI-0018-23): electron-builder collects a packaged app's
# dependencies from the `app` workspace's own package.json, not the root's, so the pin is
# declared there too, not only inherited by npm workspace hoisting.
APP_PACKAGE_JSON = "app/package.json"
PIN_FILES = (
    PACKAGE_JSON,
    PACKAGE_LOCK,
    CONFIG_MODULE,
    TOOL_SURFACE,
    APP_PINS_MODULE,
    APP_TOOL_SURFACE,
    APP_PACKAGE_JSON,
)

# Where the procedure lives, and the heading above the table this file checks.
PROCEDURE = "docs/plans/0002-anytype-mcp-server.md"
PIN_TABLE_HEADING = "### Where a version lives"

# Trees that are allowed to spell a pinned version without being a pin location: prose
# *about* the pins, and tests that assert them. Neither can go stale in silence — bump a pin
# and every test naming the old value fails by name, which is a step of the procedure.
NOT_PIN_LOCATIONS = ("docs/", "tests/")


def load_pyproject() -> dict:  # type: ignore[type-arg]
    return tomllib.loads((REPO / "pyproject.toml").read_text(encoding="utf-8"))


def load_package_json() -> dict:  # type: ignore[type-arg]
    return json.loads((REPO / "package.json").read_text(encoding="utf-8"))


def runtime_dependencies() -> list[str]:
    """Every library the host installs at run time, mandatory or optional.

    Both lists, because the split between them is about *where* a library is installed and
    never about how tightly it is pinned: `[project.dependencies]` is empty so that an addon
    environment carries no pin of ours (plan 0001), and the `host` extra holds what the host
    process runs on. A rule that read only the first list would have quietly stopped checking
    anything the moment that list emptied.
    """
    project = load_pyproject()["project"]
    optional: dict[str, list[str]] = project.get("optional-dependencies", {})
    return [*project["dependencies"], *(spec for group in optional.values() for spec in group)]


def test_every_runtime_dependency_is_an_exact_pin() -> None:
    specs = runtime_dependencies()
    assert specs, "no runtime dependency is declared anywhere, so this rule checks nothing"

    for spec in specs:
        assert "==" in spec, f"runtime dependency {spec!r} is not pinned with =="
        assert ">=" not in spec, f"runtime dependency {spec!r} has an unbounded floor"


def test_the_contract_an_addon_environment_installs_names_no_library() -> None:
    # The defect this list being empty exists to prevent: an addon environment holds the
    # addon and `innytypes`, both pinned with `==`, so a library named here is one every
    # plugin naming it must pin identically — and one that breaks every such plugin on the
    # next bump. `tests/test_contract_layer.py` proves the code holds up its end.
    assert load_pyproject()["project"]["dependencies"] == []


def test_dev_tools_are_bounded_above() -> None:
    # Ranges are allowed for lint/test tooling, but never an open upper end: a major
    # release of ruff or mypy must not be able to turn the gate red on its own.
    #
    # `innytypes[host]` is exempt and is the only exemption: it is this project asking for
    # its own extra, so what it resolves to is the checkout the gate is running in — there is
    # no release of it that could arrive and change anything.
    for spec in load_pyproject()["dependency-groups"]["dev"]:
        if spec.startswith("innytypes"):
            assert spec == "innytypes[host]", f"dev dependency {spec!r} is not the host extra"
            continue
        assert "<" in spec, f"dev dependency {spec!r} has no upper bound"


def test_requires_python_is_one_minor_version() -> None:
    # The whole family shares this interpreter; a repo drifting to another is the failure
    # this asserts against, so the exact string is the contract.
    requires = load_pyproject()["project"]["requires-python"]

    assert requires == "==3.13.*"


def test_the_python_version_file_matches_requires_python() -> None:
    # uv reads .python-version when creating the venv. If it and requires-python disagree,
    # the gate runs on one interpreter while the manifest claims another.
    pinned = (REPO / ".python-version").read_text(encoding="utf-8").strip()

    assert pinned == "3.13"


def test_npm_dependency_is_an_exact_version() -> None:
    version = load_package_json()["dependencies"]["@anyproto/anytype-mcp"]

    # No caret, no tilde, no tag — npx must resolve to precisely one build.
    assert version.lstrip("0123456789.") == "", f"npm version {version!r} is not exact"


def test_both_lockfiles_are_committed() -> None:
    assert (REPO / "uv.lock").is_file(), "uv.lock must be committed"
    assert (REPO / "package-lock.json").is_file(), "package-lock.json must be committed"


def test_the_anytype_api_version_is_pinned() -> None:
    # The server turns Anytype's OpenAPI spec into tools, so this header decides which
    # tools exist. It is a dependency, and it is pinned like one.
    from innytypes.anytype_mcp.config import ANYTYPE_VERSION

    assert ANYTYPE_VERSION == "2025-11-08"


# --------------------------------------------------------------------------------------
# Reading every pin out of the tree.
#
# By parsing, never by importing: the failure-path tests below run these functions against
# a scratch copy of the four files, and a scratch copy is not something Python can import.
# --------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Pins:
    """Every pinned version in the tree, as the file it lives in actually spells it."""

    package_json: str
    package_lock: str
    config_package: str
    config_anytype: str
    surface_package: str
    surface_anytype: str


def _constant(source: str, name: str) -> str:
    """The string a module-level ``NAME = "value"`` assignment binds."""
    match = re.search(rf'^{name} = "([^"]+)"$', source, re.MULTILINE)
    assert match is not None, f"{CONFIG_MODULE} no longer assigns {name} a literal string"
    return match.group(1)


def read_pins(root: Path) -> Pins:
    """Read all six pinned values out of the four files of ``root``."""
    package = json.loads((root / PACKAGE_JSON).read_text(encoding="utf-8"))
    lock = json.loads((root / PACKAGE_LOCK).read_text(encoding="utf-8"))
    config = (root / CONFIG_MODULE).read_text(encoding="utf-8")
    surface = json.loads((root / TOOL_SURFACE).read_text(encoding="utf-8"))

    return Pins(
        package_json=package["dependencies"][NPM_PACKAGE],
        # The resolved version, not the range the root entry restates: this is the build
        # `npm ci` would actually install, and the one the supervisor ends up launching.
        package_lock=lock["packages"][f"node_modules/{NPM_PACKAGE}"]["version"],
        config_package=_constant(config, "PACKAGE_VERSION"),
        config_anytype=_constant(config, "ANYTYPE_VERSION"),
        surface_package=str(surface["package_version"]),
        surface_anytype=str(surface["anytype_version"]),
    )


def pin_complaints(root: Path) -> list[str]:
    """One sentence per place ``root`` was left behind by a half-done bump.

    The sentences are the ones plan 0002's procedure table maps back to the step that was
    skipped, so a person reading a red gate is told what to do rather than what is wrong.
    """
    pins = read_pins(root)
    complaints: list[str] = []

    if pins.package_json != pins.config_package:
        complaints.append(
            f"package.json pins {pins.package_json} but "
            f"config.PACKAGE_VERSION is {pins.config_package}"
        )

    if pins.package_lock != pins.package_json:
        complaints.append(
            f"package-lock.json locks {pins.package_lock} but "
            f"package.json pins {pins.package_json}; run `npm install`"
        )

    if pins.surface_package != pins.config_package:
        complaints.append(
            f"tool_surface.json was captured at package {pins.surface_package}, but "
            f"config.PACKAGE_VERSION is now {pins.config_package}; run "
            "`innytypes anytype-mcp refresh-tool-surface`"
        )

    if pins.surface_anytype != pins.config_anytype:
        complaints.append(
            f"tool_surface.json was captured at Anytype-Version {pins.surface_anytype}, but "
            f"config.ANYTYPE_VERSION is now {pins.config_anytype}; run "
            "`innytypes anytype-mcp refresh-tool-surface`"
        )

    return complaints


def pin_tree(tmp_path: Path) -> Path:
    """A scratch copy of just the pin files, for a test to break one of them in."""
    for relative in PIN_FILES:
        destination = tmp_path / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(REPO / relative, destination)
    return tmp_path


def rewrite(path: Path, old: str, new: str) -> None:
    """Replace ``old`` with ``new`` in ``path``, refusing a substitution that does nothing.

    A simulated half-done bump that silently changed no byte would leave a test asserting a
    red gate against a tree that is still perfectly green.
    """
    text = path.read_text(encoding="utf-8")
    assert old in text, f"{path} does not contain {old!r}, so this mutation proves nothing"
    path.write_text(text.replace(old, new), encoding="utf-8")


def bump_npm(root: Path, old: str, new: str, *, skip: Sequence[str] = ()) -> None:
    """Move the npm pin everywhere it lives in ``root``, except in the files of ``skip``."""
    for relative in PIN_FILES:
        if relative not in skip:
            rewrite(root / relative, old, new)


# --------------------------------------------------------------------------------------
# The pins of this repository.
# --------------------------------------------------------------------------------------


def test_the_parsed_pins_are_the_values_the_package_imports() -> None:
    # The failure-path tests all run on parsed values, so the parser is only worth
    # anything while it reads what `import` reads. This is that check.
    from innytypes.anytype_mcp.config import ANYTYPE_VERSION, PACKAGE_VERSION

    pins = read_pins(REPO)

    assert pins.config_package == PACKAGE_VERSION
    assert pins.config_anytype == ANYTYPE_VERSION
    # Two files name the same version; the supervisor launches the one in config.py, so a
    # silent divergence would run a build that package-lock.json never locked.
    assert pins.package_json == PACKAGE_VERSION


def test_this_repository_moves_every_pin_together() -> None:
    assert pin_complaints(REPO) == []


# --------------------------------------------------------------------------------------
# A half-done bump, simulated. Each of these is a step of plan 0002's procedure, skipped.
# --------------------------------------------------------------------------------------


def test_bumping_package_json_alone_is_caught(tmp_path: Path) -> None:
    root = pin_tree(tmp_path)
    pins = read_pins(root)
    rewrite(root / PACKAGE_JSON, pins.package_json, "9.9.9")

    complaints = pin_complaints(root)

    assert any("config.PACKAGE_VERSION" in complaint for complaint in complaints)


def test_bumping_the_python_constant_alone_is_caught(tmp_path: Path) -> None:
    root = pin_tree(tmp_path)
    pins = read_pins(root)
    rewrite(
        root / CONFIG_MODULE,
        f'PACKAGE_VERSION = "{pins.config_package}"',
        'PACKAGE_VERSION = "9.9.9"',
    )

    complaints = pin_complaints(root)

    assert any("package.json pins" in complaint for complaint in complaints)


def test_a_lockfile_left_at_the_old_version_is_caught(tmp_path: Path) -> None:
    # Everything moved except the one file a person does not edit by hand, which is
    # exactly what forgetting `npm install` looks like.
    root = pin_tree(tmp_path)
    bump_npm(root, read_pins(root).package_json, "9.9.9", skip=[PACKAGE_LOCK])

    complaints = pin_complaints(root)

    assert any("npm install" in complaint for complaint in complaints)


def test_a_fixture_not_re_recorded_after_an_npm_bump_is_caught(tmp_path: Path) -> None:
    root = pin_tree(tmp_path)
    bump_npm(root, read_pins(root).package_json, "9.9.9", skip=[TOOL_SURFACE])

    complaints = pin_complaints(root)

    assert any("refresh-tool-surface" in complaint for complaint in complaints)


def test_moving_the_anytype_header_without_re_recording_is_caught(tmp_path: Path) -> None:
    # The header bump touches neither npm file, so this is the case where nothing but the
    # fixture can notice — and the reason the fixture records both versions, not one.
    root = pin_tree(tmp_path)
    pins = read_pins(root)
    rewrite(
        root / CONFIG_MODULE,
        f'ANYTYPE_VERSION = "{pins.config_anytype}"',
        'ANYTYPE_VERSION = "2099-01-01"',
    )

    complaints = pin_complaints(root)

    assert any("Anytype-Version" in complaint for complaint in complaints)


def test_a_bump_that_moves_every_location_is_clean(tmp_path: Path) -> None:
    # Without this one, every test above would still pass with `pin_complaints` hard-wired
    # to complain, and the procedure would be unfollowable rather than enforced.
    root = pin_tree(tmp_path)
    bump_npm(root, read_pins(root).package_json, "9.9.9")

    assert pin_complaints(root) == []


def test_a_partial_revert_is_caught(tmp_path: Path) -> None:
    # The rollback path: `git revert` the whole bump commit. Restoring the npm files while
    # leaving the Python side bumped is the state plan 0002 warns about — the host would
    # launch a build the lockfile never locked.
    root = pin_tree(tmp_path)
    old = read_pins(root).package_json
    bump_npm(root, old, "9.9.9")
    for relative in (PACKAGE_JSON, PACKAGE_LOCK):
        rewrite(root / relative, "9.9.9", old)

    complaints = pin_complaints(root)

    assert any("package.json pins" in complaint for complaint in complaints)


# --------------------------------------------------------------------------------------
# The procedure cannot go stale: its list of locations is checked against the tree.
# --------------------------------------------------------------------------------------


def tracked_files(root: Path) -> list[str]:
    """Every file git tracks in ``root``, as repository-relative paths."""
    listed = subprocess.run(
        ["git", "-C", str(root), "ls-files"],
        capture_output=True,
        text=True,
        check=True,
    )
    return listed.stdout.split()


def files_naming_a_pin(root: Path, files: Iterable[str], versions: Sequence[str]) -> set[str]:
    """Which of ``files`` spell one of ``versions``, ignoring prose and tests.

    A plain substring search, because that is what a stale version is: the old string, still
    sitting somewhere, read by something. Anything cleverer would start deciding which
    occurrences count, which is the judgement this check exists to take away from people.
    """
    found: set[str] = set()
    for name in files:
        if name.startswith(NOT_PIN_LOCATIONS):
            continue
        text = (root / name).read_text(encoding="utf-8", errors="ignore")
        if any(version in text for version in versions):
            found.add(name)
    return found


def declared_pin_locations(root: Path) -> set[str]:
    """The paths named in the first column of the procedure's `Where a version lives` table."""
    text = (root / PROCEDURE).read_text(encoding="utf-8")
    assert PIN_TABLE_HEADING in text, f"{PROCEDURE} no longer has a `{PIN_TABLE_HEADING}` section"

    declared: set[str] = set()
    started = False
    for line in text.split(PIN_TABLE_HEADING, 1)[1].splitlines():
        row = line.strip()
        if not row.startswith("|"):
            if started:
                break  # the table ended; a later one is a different subject
            continue
        started = True
        first = row.strip("|").split("|")[0].strip()
        # The header row and the `|---|` separator carry no path, and say so by not being
        # written in backticks.
        if first.startswith("`"):
            declared.add(first.strip("`"))
    return declared


def test_the_procedure_names_every_place_a_version_lives() -> None:
    # The acceptance criterion of this slice, and the one that keeps the doc honest as the
    # code moves under it: the table is compared to a search, not to a memory.
    pins = read_pins(REPO)
    versions = (pins.config_package, pins.config_anytype)

    found = files_naming_a_pin(REPO, tracked_files(REPO), versions)

    assert found == declared_pin_locations(REPO), (
        "plan 0002's `Where a version lives` table and the tree disagree; "
        "either add the row, or stop spelling the version there"
    )
    assert found == set(PIN_FILES)


def test_the_search_finds_a_version_spelled_somewhere_new(tmp_path: Path) -> None:
    # Proof that the check above could fail. A new module that hard-codes the pinned
    # version is precisely the fifth location the procedure would not know about.
    root = pin_tree(tmp_path)
    versions = (read_pins(root).config_package,)
    planted = "src/innytypes/anytype_mcp/extra.py"
    (root / planted).write_text(f'VERSION = "{versions[0]}"\n', encoding="utf-8")

    found = files_naming_a_pin(root, [*PIN_FILES, planted], versions)

    assert planted in found
    assert found - declared_pin_locations(REPO) == {planted}


def test_the_search_leaves_documentation_and_tests_to_the_gate(tmp_path: Path) -> None:
    # The stated scope, asserted rather than assumed: a version named in a test is a
    # version some assertion is already watching.
    root = pin_tree(tmp_path)
    versions = (read_pins(root).config_package,)
    elsewhere = ("tests/test_example.py", "docs/note.md")
    for named in elsewhere:
        (root / named).parent.mkdir(parents=True, exist_ok=True)
        (root / named).write_text(f"the pinned version is {versions[0]}\n", encoding="utf-8")

    found = files_naming_a_pin(root, [*PIN_FILES, *elsewhere], versions)

    assert found == set(PIN_FILES)


# --------------------------------------------------------------------------------------
# The evidence a bump lands with.
# --------------------------------------------------------------------------------------


def test_the_evidence_a_bump_lands_with_is_a_non_empty_diff() -> None:
    # What step 4 of the procedure produces, against the record this repository actually
    # ships: a tool gained, a tool lost, and a tool that kept its name and changed its
    # arguments — the third being the one an addon would otherwise discover in production.
    from innytypes.anytype_mcp.tools import ToolSurface, compare_surfaces, load_tool_surface

    before = load_tool_surface()
    names = sorted(before.tools)
    reshaped, dropped = names[0], names[1]

    tools = {name: signature for name, signature in before.tools.items() if name != dropped}
    tools[reshaped] = "sha256:" + "0" * 64
    tools["API-brand-new"] = "sha256:" + "1" * 64
    after = ToolSurface(
        package_version="9.9.9",
        anytype_version=before.anytype_version,
        tools=tools,
        source=before.source,
        captured_at="2099-01-01",
    )

    diff = compare_surfaces(before, after)

    assert not diff.is_empty
    assert diff.added == ("API-brand-new",)
    assert diff.removed == (dropped,)
    assert diff.changed == (reshaped,)
