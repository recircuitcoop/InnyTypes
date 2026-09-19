"""The Briefcase bundles and the icon: what a person actually clicks (plan 0003, F5).

Two things are checked here, and both of them are failures that would otherwise be silent.

**The configuration.** A bundle that builds is not a bundle that works. Briefcase forms the
bundle identifier from `bundle` plus the application's name, and starts the application by
running the module that has that same name — so a rename in `pyproject.toml` can produce an
application that installs cleanly, opens, and does nothing, or one whose identifier no longer
matches the `.desktop` entry a Linux notification click depends on. Every assertion below is
computed from the file rather than from a remembered string, and each one is paired with a
synthetic configuration that breaks it, so none of them is an assertion that was true before
anybody wrote it.

**The icon.** The owner asked for "a white arrow pointing downwards on a black background", so
the committed image is opened and *looked at*: its corners are black, its centre column holds
white, nothing in it is transparent, and the arrow points **down** — the widest white row is
below the narrowest, which is the one property an upside-down arrow would fail. The PNG is read
with `zlib` and `struct` alone: the pictures are committed, so the gate needs no image library
to check them, and `tools/make_icon.py` (also standard library only) is imported to prove that
the committed files are what that script renders rather than something that drifted from it.
"""

from __future__ import annotations

import importlib.util
import inspect
import struct
import sys
import tomllib
import zlib
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType

import pytest

from innytypes.helper.config import BUNDLE_IDENTIFIER

REPO = Path(__file__).resolve().parents[1]

# What the user calls the application, and what the console script is called. Spelled here so
# a rename of either has to be a deliberate edit to this file as well.
APPLICATION = "InnyTypes"
CONSOLE_SCRIPT = "innytypes-helper"
ENTRY_POINT = "innytypes.helper.launcher:main"

# Where the icon lives, as the Briefcase `icon` key names it: no extension.
ICON = "src/innytypes/resources/innytypes"
SOURCE_ICON = REPO / f"{ICON}.png"


def pyproject() -> dict:  # type: ignore[type-arg]
    return tomllib.loads((REPO / "pyproject.toml").read_text(encoding="utf-8"))


def make_icon() -> ModuleType:
    """`tools/make_icon.py`, imported by path: it is a script, not a package."""
    spec = importlib.util.spec_from_file_location("make_icon", REPO / "tools" / "make_icon.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# --- reading the configuration --------------------------------------------------------------


@dataclass(frozen=True)
class Bundle:
    """One Briefcase application, as the three facts a bundle stands or falls on."""

    name: str
    bundle: str
    formal_name: str
    sources: tuple[str, ...]
    requires: tuple[str, ...]
    icon: str

    @property
    def identifier(self) -> str:
        """What Briefcase stamps into the bundle: the prefix and the app name, joined."""
        return f"{self.bundle}.{self.name.replace('_', '-').lower()}"

    @property
    def module(self) -> str:
        """The module Briefcase runs: ``python -m <app name, hyphens as underscores>``."""
        return self.name.replace("-", "_")


def read_bundle(document: dict) -> Bundle:  # type: ignore[type-arg]
    """The one application `[tool.briefcase]` configures, or a failure naming what is wrong."""
    briefcase = document["tool"]["briefcase"]
    apps = briefcase["app"]
    assert len(apps) == 1, f"expected exactly one Briefcase application, found {sorted(apps)}"

    name, app = next(iter(apps.items()))
    return Bundle(
        name=name,
        bundle=briefcase["bundle"],
        formal_name=app["formal_name"],
        sources=tuple(app["sources"]),
        requires=tuple(app["requires"]),
        icon=app["icon"],
    )


def entry_point_complaints(document: dict, root: Path) -> list[str]:  # type: ignore[type-arg]
    """One sentence per way this configuration points the bundle at nothing.

    Written as a function over a document so the failure-path tests can run it against a
    configuration that has been deliberately broken — which is the only way to know the checks
    below could ever go red.
    """
    bundle = read_bundle(document)
    complaints: list[str] = []

    if bundle.identifier != BUNDLE_IDENTIFIER:
        complaints.append(
            f"Briefcase would stamp {bundle.identifier!r} into the bundle, but this "
            f"application is {BUNDLE_IDENTIFIER!r} everywhere else (plan 0003, D27)"
        )

    named = [source for source in bundle.sources if Path(source).name == bundle.module]
    if not named:
        complaints.append(
            f"Briefcase starts the bundle with `python -m {bundle.module}`, and no source "
            f"in {list(bundle.sources)} is a package called {bundle.module}"
        )

    script = document["project"]["scripts"].get(CONSOLE_SCRIPT)
    if script is None:
        complaints.append(f"there is no `{CONSOLE_SCRIPT}` console script for the bundle to match")

    for source in named:
        entry = root / source / "__main__.py"
        if not entry.is_file():
            complaints.append(f"{source} has no __main__.py, so `python -m` would find nothing")
            continue
        text = entry.read_text(encoding="utf-8")
        target, _, _ = str(script).partition(":")
        if f"from {target} import " not in text:
            complaints.append(
                f"{entry} does not start {target}, so the bundle and the console script "
                "start different things"
            )

    return complaints


# --- the configuration this repository actually ships ---------------------------------------


def test_the_bundle_identifier_is_the_one_every_platform_already_uses() -> None:
    # D27's identifier is the macOS bundle id, the Linux `.desktop` name and window class, and
    # the Windows AppUserModelID. Compared against the constant, never against a copy.
    assert read_bundle(pyproject()).identifier == BUNDLE_IDENTIFIER


def test_the_bundle_names_the_application_the_user_knows() -> None:
    document = pyproject()

    assert document["tool"]["briefcase"]["project_name"] == APPLICATION
    assert read_bundle(document).formal_name == APPLICATION


def test_the_bundle_and_the_console_script_start_the_same_function() -> None:
    assert entry_point_complaints(pyproject(), REPO) == []


def test_the_entry_point_the_configuration_names_exists() -> None:
    # The other half of the same question: the configuration agreeing with itself proves
    # nothing if the function it agrees about was renamed out of the package.
    from innytypes.helper import launcher

    script = pyproject()["project"]["scripts"][CONSOLE_SCRIPT]
    target, _, function = script.partition(":")

    assert script == ENTRY_POINT
    assert target == launcher.__name__
    assert callable(getattr(launcher, function))


def test_the_bundles_launcher_starts_the_helper_the_console_script_names() -> None:
    # The bundle has one executable and two jobs, and this is the one that makes them one
    # application: the default role of `run_bundled` is the very function the console script
    # names. Not a string that looks like it — the function object itself.
    from innytypes.helper import launcher

    role = inspect.signature(launcher.run_bundled).parameters["helper"].default
    _, _, function = pyproject()["project"]["scripts"][CONSOLE_SCRIPT].partition(":")

    assert role is getattr(launcher, function)


def test_the_bundle_ships_the_same_pinned_dependencies_as_the_package() -> None:
    # A bundle that installed its own set of versions would be a second answer to "what does
    # InnyTypes run on", and the one nobody tests against.
    #
    # The `host` extra, not `[project.dependencies]`, which is empty on purpose: the bundle
    # IS the host process, so it installs everything the host runs on. An addon environment
    # is the other side of the same split and installs none of it.
    document = pyproject()
    host = document["project"]["optional-dependencies"]["host"]

    assert list(read_bundle(document).requires) == list(host)
    assert document["project"]["dependencies"] == []


def test_every_bundled_runtime_dependency_is_an_exact_pin() -> None:
    # Including the toolkit, which is a bundle-only dependency and therefore easy to forget:
    # inside a bundle it is runtime, so plan 0001's pinning rule applies to it in full.
    briefcase = pyproject()["tool"]["briefcase"]
    app = briefcase["app"][read_bundle(pyproject()).name]

    platforms = {key: value for key, value in app.items() if isinstance(value, dict)}
    assert platforms, "no per-platform table declares the window toolkit"

    toolkits = set()
    for platform, table in platforms.items():
        for spec in table["requires"]:
            assert "==" in spec, f"{platform} requires {spec!r}, which is not pinned with =="
            if spec.startswith("toga"):
                toolkits.add(spec.partition("==")[2])

    # One version across macOS, Windows and Linux: the backends are one project and a bundle
    # built from mismatched halves of it is a bundle nobody has run.
    assert len(toolkits) == 1, f"the toolkit is pinned at {sorted(toolkits)} across platforms"


def test_the_icon_key_points_at_the_committed_images() -> None:
    assert read_bundle(pyproject()).icon == ICON


# --- the same checks, against configurations that are wrong ---------------------------------


def broken(**changes: object) -> dict:  # type: ignore[type-arg]
    """This repository's configuration with one thing about the application changed."""
    document = pyproject()
    name = read_bundle(document).name
    app = dict(document["tool"]["briefcase"]["app"][name])
    app.update(changes)
    document["tool"]["briefcase"]["app"] = {changes.pop("name", name): app}  # type: ignore[dict-item]
    return document


def test_a_renamed_application_is_caught() -> None:
    # The rename that moves the bundle identifier out from under the `.desktop` entry: the
    # application still builds, and a click on a Linux notification reaches nothing.
    complaints = entry_point_complaints(broken(name="assistant"), REPO)

    assert any("D27" in complaint for complaint in complaints)


def test_a_bundle_whose_entry_module_is_not_in_its_sources_is_caught() -> None:
    complaints = entry_point_complaints(broken(sources=["src/innytypes"]), REPO)

    assert any("python -m" in complaint for complaint in complaints)


def test_an_entry_module_that_calls_something_else_is_caught(tmp_path: Path) -> None:
    # The silent failure this whole file exists for: the console script is renamed, the bundle
    # is not, everything builds, and the application opens and does nothing.
    (tmp_path / "src" / "helper").mkdir(parents=True)
    (tmp_path / "src" / "helper" / "__main__.py").write_text(
        "from innytypes.cli import main\n\nmain()\n", encoding="utf-8"
    )
    (tmp_path / "src" / "innytypes").mkdir(parents=True)

    complaints = entry_point_complaints(pyproject(), tmp_path)

    assert any("different things" in complaint for complaint in complaints)


def test_the_check_passes_only_because_the_configuration_is_right() -> None:
    # Without this, every test above would still pass with `entry_point_complaints` hard-wired
    # to complain about everything.
    assert entry_point_complaints(pyproject(), REPO) == []
    assert entry_point_complaints(broken(name="assistant"), REPO) != []


# --- reading a PNG with nothing but the standard library ------------------------------------


@dataclass(frozen=True)
class Image:
    """One decoded PNG: its size, and its pixels as (red, green, blue, alpha)."""

    width: int
    height: int
    pixels: list[list[tuple[int, int, int, int]]]

    def at(self, x: int, y: int) -> tuple[int, int, int, int]:
        return self.pixels[y][x]

    def white_columns(self, y: int) -> list[int]:
        """Which columns of row ``y`` are white. Fully white, not merely light."""
        return [x for x, pixel in enumerate(self.pixels[y]) if pixel == (255, 255, 255, 255)]


def read_png(path: Path) -> Image:
    """Decode a non-interlaced 8-bit RGBA PNG. Enough for the icons this repository writes."""
    data = path.read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", f"{path} is not a PNG"

    chunks: dict[bytes, bytes] = {}
    compressed = b""
    offset = 8
    while offset < len(data):
        (length,) = struct.unpack(">I", data[offset : offset + 4])
        kind = data[offset + 4 : offset + 8]
        payload = data[offset + 8 : offset + 8 + length]
        if kind == b"IDAT":
            compressed += payload
        else:
            chunks[kind] = payload
        offset += 12 + length

    width, height, depth, colour, _, _, interlace = struct.unpack(">IIBBBBB", chunks[b"IHDR"])
    assert (depth, colour, interlace) == (8, 6, 0), (
        f"{path} is {depth}-bit colour type {colour}, interlace {interlace}; "
        "this reader handles 8-bit RGBA without interlacing"
    )

    raw = zlib.decompress(compressed)
    return Image(width=width, height=height, pixels=_unfilter(raw, width, height))


def _unfilter(raw: bytes, width: int, height: int) -> list[list[tuple[int, int, int, int]]]:
    """Undo the per-scanline filter PNG puts in front of every row."""
    stride = width * 4
    previous = bytearray(stride)
    rows: list[list[tuple[int, int, int, int]]] = []

    for index in range(height):
        start = index * (stride + 1)
        kind = raw[start]
        line = bytearray(raw[start + 1 : start + 1 + stride])

        for position in range(stride):
            left = line[position - 4] if position >= 4 else 0
            up = previous[position]
            upper_left = previous[position - 4] if position >= 4 else 0
            if kind == 0:
                continue
            if kind == 1:
                line[position] = (line[position] + left) & 0xFF
            elif kind == 2:
                line[position] = (line[position] + up) & 0xFF
            elif kind == 3:
                line[position] = (line[position] + (left + up) // 2) & 0xFF
            elif kind == 4:
                line[position] = (line[position] + _paeth(left, up, upper_left)) & 0xFF
            else:  # pragma: no cover - a filter type PNG does not define
                raise AssertionError(f"unknown PNG filter {kind}")

        rows.append(
            [(line[x * 4], line[x * 4 + 1], line[x * 4 + 2], line[x * 4 + 3]) for x in range(width)]
        )
        previous = line

    return rows


def _paeth(left: int, up: int, upper_left: int) -> int:
    estimate = left + up - upper_left
    distances = {
        abs(estimate - left): left,
        abs(estimate - up): up,
        abs(estimate - upper_left): upper_left,
    }
    return distances[min(distances)]


# --- the icon itself ------------------------------------------------------------------------


@pytest.fixture(scope="module")
def icon() -> Image:
    return read_png(SOURCE_ICON)


def test_the_source_icon_is_committed_and_square(icon: Image) -> None:
    assert SOURCE_ICON.is_file()
    assert icon.width == icon.height
    # Large enough to be the source every other size is drawn from.
    assert icon.width >= 512


def test_the_icon_is_black_in_every_corner(icon: Image) -> None:
    last = icon.width - 1
    corners = [icon.at(0, 0), icon.at(last, 0), icon.at(0, last), icon.at(last, last)]

    assert corners == [(0, 0, 0, 255)] * 4


def test_the_icon_has_white_down_its_centre_column(icon: Image) -> None:
    centre = icon.width // 2
    white = [y for y in range(icon.height) if icon.at(centre, y) == (255, 255, 255, 255)]

    # A placeholder, an empty square or an all-black image has none of this.
    assert len(white) > icon.height // 3
    # And it is one unbroken run: the arrow is a shaft joined to its head, not two marks.
    assert white == list(range(white[0], white[-1] + 1))


def test_nothing_in_the_icon_is_transparent(icon: Image) -> None:
    # An accidentally transparent icon looks right on a white page and disappears in a Dock.
    transparent = [
        (x, y) for y in range(icon.height) for x in range(icon.width) if icon.at(x, y)[3] != 255
    ]

    assert transparent == []


def test_the_arrow_points_downwards(icon: Image) -> None:
    """The one assertion an upside-down arrow fails.

    An arrow is a narrow shaft and a wide head. Pointing *down* means the widest row is below
    the shaft, and the lowest white pixel of all is on the centre line — the point.
    """
    widths = {y: len(icon.white_columns(y)) for y in range(icon.height)}
    drawn = [y for y, width in widths.items() if width]
    widest = max(drawn, key=lambda y: widths[y])

    # The head is wider than the shaft, and it is in the lower half of what is drawn.
    assert widths[widest] > widths[drawn[0]] * 2
    assert widest >= drawn[0] + (drawn[-1] - drawn[0]) // 2

    # The bottom of the arrow is its point: far narrower than its top, which is the shaft.
    # This is the assertion an arrow drawn the other way up fails.
    assert widths[drawn[-1]] * 4 < widths[drawn[0]]

    # And the point is in the middle, not off to one side.
    tip = icon.white_columns(drawn[-1])
    assert abs(sum(tip) / len(tip) - icon.width / 2) < icon.width * 0.02


def test_the_icon_is_readable_at_sixteen_pixels() -> None:
    # The size a Dock badge, a Linux panel and a Windows title bar use. Drawn at that size
    # rather than shrunk, so what is asserted is what a user sees.
    small = read_png(REPO / f"{ICON}-16.png")
    centre = small.width // 2

    assert (small.width, small.height) == (16, 16)
    assert small.at(0, 0) == (0, 0, 0, 255)
    # A margin all round, so the arrow is not flush against the edge at the size it is
    # hardest to read.
    assert [y for y in range(16) if small.white_columns(y)][0] >= 2
    assert any(small.at(centre, y) == (255, 255, 255, 255) for y in range(16))


# --- every file the bundles ask for ---------------------------------------------------------


def test_every_size_briefcase_can_ask_for_is_committed() -> None:
    script = make_icon()
    expected = [f"{ICON}.png", f"{ICON}.icns", f"{ICON}.ico"]
    expected += [f"{ICON}-{size}.png" for size in script.LINUX_SIZES]

    missing = [name for name in expected if not (REPO / name).is_file()]

    assert missing == []


def test_each_sized_icon_really_is_that_size() -> None:
    for size in make_icon().LINUX_SIZES:
        image = read_png(REPO / f"{ICON}-{size}.png")
        assert (image.width, image.height) == (size, size)


def test_the_macos_and_windows_icons_are_what_those_platforms_read() -> None:
    apple = (REPO / f"{ICON}.icns").read_bytes()
    windows = (REPO / f"{ICON}.ico").read_bytes()

    assert apple[:4] == b"icns"
    assert struct.unpack(">I", apple[4:8])[0] == len(apple)

    reserved, kind, count = struct.unpack("<HHH", windows[:6])
    assert (reserved, kind) == (0, 1)
    assert count == len(make_icon().ICO_SIZES)


def test_the_committed_icons_are_what_the_committed_script_draws() -> None:
    # The assets and the script cannot drift: an edit to the arrow that was never re-run, or a
    # hand-edited image nothing can reproduce, fails here.
    script = make_icon()

    for size in (16, 32, 64):
        assert (REPO / f"{ICON}-{size}.png").read_bytes() == script.png(size, script.render(size))


def test_the_drawing_could_have_been_wrong(tmp_path: Path) -> None:
    # Proof the icon assertions are looking at something: the same reader, pointed at a square
    # drawn the other way up, fails the direction check.
    script = make_icon()
    size = 64
    flipped = script.render(size)
    stride = size * 4
    upside_down = b"".join(
        flipped[row * stride : (row + 1) * stride] for row in reversed(range(size))
    )
    path = tmp_path / "flipped.png"
    path.write_bytes(script.png(size, upside_down))

    image = read_png(path)
    widths = {y: len(image.white_columns(y)) for y in range(image.height)}
    drawn = [y for y, width in widths.items() if width]

    # The point is now at the top, which is precisely what the icon's own test forbids.
    assert widths[drawn[0]] * 4 < widths[drawn[-1]]


def test_the_generator_needs_nothing_that_is_not_installed() -> None:
    # The rule this slice was asked to keep: the gate opens the committed images without an
    # image library, and the script that draws them uses the standard library alone.
    source = (REPO / "tools" / "make_icon.py").read_text(encoding="utf-8")
    imported = [
        line.split()[1]
        for line in source.splitlines()
        if line.startswith("import ") or line.startswith("from ")
    ]

    assert set(imported) <= set(sys.stdlib_module_names) | {"__future__"}
