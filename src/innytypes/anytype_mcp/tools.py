"""What tools the pinned server exposes, recorded so that a version bump shows its diff.

The server turns Anytype's OpenAPI specification into MCP tools, so the pair
``(PACKAGE_VERSION, ANYTYPE_VERSION)`` **decides which tools exist**. Plan 0002 therefore
treats either pin as a dependency: changing one is an upgrade, landed with the evidence of
what it did to the tool surface. Evidence needs something to compare against, and until
this module existed nothing in the repository knew what the surface was — an upgrade could
only be reviewed by reading the npm changelog and hoping.

So the surface is recorded in :data:`FIXTURE_PATH`, a committed JSON file, and this module
is the pure half that reads it and compares two of them. It performs no I/O beyond reading
and writing that one file, spawns nothing, and imports nothing that needs Node — which is
what lets the gate assert on the surface from a clean clone with ``node_modules/`` absent.
Talking to the real server to re-record the fixture is :mod:`innytypes.anytype_mcp.refresh`.

A surface is a mapping from tool name to a **signature of that tool's input schema**,
rather than a bare list of names. A bare list answers "was a tool added or removed", and
misses the third thing plan 0002 warns about: a tool that kept its name and changed its
arguments. That one is the dangerous case, because an addon calling it keeps compiling and
starts failing.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# The committed record, inside the package rather than under tests/: plan 0002 slice 05
# hands this surface to addons through the host API, so it is shipped data, not a fixture
# that only the suite reads. It must stay tracked by git — a gate that reads an ignored
# file is a gate that passes on exactly one machine.
FIXTURE_PATH = Path(__file__).resolve().parent / "tool_surface.json"

# How a surface was obtained, recorded in the file itself. The two are not equally strong
# evidence, and a reader has to be able to tell them apart without asking anybody.
#
#   live-server    read off a running ``@anyproto/anytype-mcp`` over MCP, against a real
#                  Anytype. This is what `innytypes anytype-mcp refresh-tool-surface`
#                  writes, and the only kind that proves what the pair really exposes.
#   bundled-spec   derived from the OpenAPI specification shipped inside the pinned npm
#                  tarball. Faithful to the pinned package, but it assumes the running
#                  Anytype serves the same spec version the package was built against.
SOURCE_LIVE = "live-server"
SOURCE_BUNDLED_SPEC = "bundled-spec"
KNOWN_SOURCES = (SOURCE_LIVE, SOURCE_BUNDLED_SPEC)

# Every field a fixture must carry. Named here so a truncated or hand-edited file fails
# with a sentence instead of a KeyError from somewhere three frames down.
REQUIRED_FIELDS = ("package_version", "anytype_version", "tools", "source", "captured_at")


class ToolSurfaceError(RuntimeError):
    """A recorded tool surface could not be read — missing, malformed or truncated."""


def tool_signature(input_schema: Mapping[str, Any]) -> str:
    """A stable fingerprint of one tool's input schema.

    Canonical JSON — sorted keys, no whitespace — so two captures of the same schema
    months apart produce the same string. Without that, every refresh would report every
    tool as changed, and a diff nobody believes is a diff nobody reads.

    The ``sha256:`` prefix says what the digest is. It also keeps the line readable to
    ``tests/test_no_secrets.py``, which treats a bare 64-character hex string as a possible
    credential unless the line says it is a hash.
    """
    canonical = json.dumps(input_schema, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class ToolSurface:
    """The tools one (package version, Anytype version) pair exposes, and where that came from."""

    package_version: str
    anytype_version: str
    # tool name -> signature of its input schema.
    tools: Mapping[str, str]
    source: str
    captured_at: str
    note: str = ""

    @property
    def names(self) -> tuple[str, ...]:
        """Every tool name, sorted, so two surfaces are compared in a stable order."""
        return tuple(sorted(self.tools))

    def to_json_dict(self) -> dict[str, Any]:
        """The file's shape: metadata first, then the tools, sorted by name.

        Sorted because this file is reviewed as a diff. An unsorted mapping would reorder
        itself between captures and bury one real change in thirty spurious ones.
        """
        return {
            "package_version": self.package_version,
            "anytype_version": self.anytype_version,
            "source": self.source,
            "captured_at": self.captured_at,
            "note": self.note,
            "tools": {name: self.tools[name] for name in self.names},
        }

    @classmethod
    def from_json_dict(cls, data: Mapping[str, Any]) -> ToolSurface:
        """Build a surface from a parsed fixture, naming whatever the file is missing."""
        missing = [field for field in REQUIRED_FIELDS if field not in data]
        if missing:
            raise ToolSurfaceError(f"recorded tool surface is missing {', '.join(missing)}")

        tools = data["tools"]
        if not isinstance(tools, dict):
            raise ToolSurfaceError("recorded tool surface has a `tools` that is not an object")

        return cls(
            package_version=str(data["package_version"]),
            anytype_version=str(data["anytype_version"]),
            tools=dict(tools),
            source=str(data["source"]),
            captured_at=str(data["captured_at"]),
            note=str(data.get("note", "")),
        )


@dataclass(frozen=True)
class ToolSurfaceDiff:
    """What changed between two surfaces, as three sorted lists of tool names.

    ``changed`` is the category that justifies recording signatures at all: a tool whose
    name survived an upgrade and whose arguments did not. Added and removed tools announce
    themselves the first time an addon calls one; a reshaped tool does not.
    """

    added: tuple[str, ...]
    removed: tuple[str, ...]
    changed: tuple[str, ...]

    @property
    def is_empty(self) -> bool:
        """True when the two surfaces expose exactly the same tools with the same schemas."""
        return not (self.added or self.removed or self.changed)


def compare_surfaces(before: ToolSurface, after: ToolSurface) -> ToolSurfaceDiff:
    """Compare two surfaces. Pure: no file, no process, no network — just names in and out.

    Deliberately says nothing about the version pins the two surfaces carry. Comparing a
    surface against itself at a different version is the normal case during an upgrade,
    and refusing it would make the one tool that reviews an upgrade useless during one.
    """
    old_names = set(before.tools)
    new_names = set(after.tools)

    return ToolSurfaceDiff(
        added=tuple(sorted(new_names - old_names)),
        removed=tuple(sorted(old_names - new_names)),
        # Same name on both sides, different input schema. Compared only over the
        # intersection, so an added tool is never also reported as changed.
        changed=tuple(
            sorted(
                name for name in old_names & new_names if before.tools[name] != after.tools[name]
            )
        ),
    )


def load_tool_surface(path: Path | None = None) -> ToolSurface:
    """Read a recorded surface, defaulting to the committed one."""
    source = FIXTURE_PATH if path is None else path

    try:
        raw = source.read_text(encoding="utf-8")
    except OSError as error:
        raise ToolSurfaceError(f"could not read the tool surface at {source}: {error}") from error

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as error:
        raise ToolSurfaceError(f"{source} is not valid JSON: {error}") from error

    return ToolSurface.from_json_dict(data)


def save_tool_surface(surface: ToolSurface, path: Path | None = None) -> Path:
    """Write ``surface`` to ``path`` (default: the committed fixture) and return that path.

    Indented and newline-terminated because the file exists to be read as a diff in a
    review, which is the whole reason it is committed rather than generated.
    """
    destination = FIXTURE_PATH if path is None else path
    destination.write_text(
        json.dumps(surface.to_json_dict(), indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return destination
