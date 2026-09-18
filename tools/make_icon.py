#!/usr/bin/env python3
"""Draw the InnyTypes application icon, and write every file the bundles ask for.

The owner's instruction, verbatim: **"I want the InnyTypes icon to look like a white arrow
pointing downwards on a black background."** That is the whole specification, and this script
is the only place the shape is decided. Everything under ``src/innytypes/resources/`` is its
output and is committed, so the gate never runs this script and never needs an image library.

**Standard library only, on purpose.** A PNG is a header plus zlib-compressed scanlines, an
`.ico` is a small directory in front of PNG payloads, and an `.icns` is a length-prefixed list
of them. All three are written here with ``zlib`` and ``struct``. Adding Pillow would put a
compiled dependency into the gate's environment for a picture that changes approximately never.

**How it is drawn, and why it survives being 16 pixels wide.** The arrow is a shaft and a head,
both described as percentages of the square, with a wide margin. Each row of pixels is filled
by computing the exact horizontal span the shape covers at four sub-rows and blending the
coverage — analytic antialiasing rather than supersampling the whole square, which keeps a
1024x1024 render instant and keeps the 16x16 one legible instead of ragged.

Run it from the repository root::

    python tools/make_icon.py

It rewrites every file it owns and prints what it wrote.
"""

from __future__ import annotations

import struct
import sys
import zlib
from pathlib import Path

# Where the icon lives, as `pyproject.toml`'s `[tool.briefcase]` icon key names it: a path with
# no extension, to which Briefcase appends the one each platform wants.
RESOURCES = Path("src/innytypes/resources")
STEM = "innytypes"

# The source render. Everything else is drawn at its own size rather than downsampled from
# this, so no size is ever a blurred copy of another.
SOURCE_SIZE = 1024

# The sizes a Linux package installs, as `<stem>-<size>.png`.
LINUX_SIZES = (16, 32, 48, 64, 128, 256, 512)

# The sizes inside the Windows `.ico`. 256 is the largest an ICO directory entry can name.
ICO_SIZES = (16, 32, 48, 64, 128, 256)

# The `.icns` members, as (four-character type, pixel size). Every one of these types takes a
# PNG payload on any macOS that can run this application.
ICNS_MEMBERS = (
    ("icp4", 16),
    ("icp5", 32),
    ("icp6", 64),
    ("ic07", 128),
    ("ic08", 256),
    ("ic09", 512),
    ("ic10", 1024),
    ("ic11", 32),
    ("ic12", 64),
    ("ic13", 256),
    ("ic14", 512),
)

# The arrow, in percentages of the square's side. The margin is what makes it readable small:
# nothing is drawn in the outer 16%, so the shape still has air around it at 16 pixels.
SHAFT_LEFT, SHAFT_RIGHT = 41.0, 59.0
SHAFT_TOP, SHAFT_BOTTOM = 16.0, 56.0
HEAD_LEFT, HEAD_RIGHT = 23.0, 77.0
HEAD_TOP, HEAD_POINT = 50.0, 84.0

# Black background, white arrow. Opaque throughout: a transparent icon is one that disappears
# on a dark Dock, and the point of this one is the contrast.
BLACK = (0, 0, 0, 255)
WHITE = (255, 255, 255, 255)

# Sub-rows sampled per pixel row when computing coverage. Four is enough to make the diagonals
# of the head smooth at every size this script writes.
SUB_ROWS = 4


def spans(y: float) -> list[tuple[float, float]]:
    """The horizontal spans the arrow covers at height ``y``, in percentage coordinates.

    Up to two: the shaft, and the head's triangle, whose width shrinks linearly from its base
    to its point. They overlap where the two meet, and :func:`coverage` unions them.
    """
    found: list[tuple[float, float]] = []

    if SHAFT_TOP <= y <= SHAFT_BOTTOM:
        found.append((SHAFT_LEFT, SHAFT_RIGHT))

    if HEAD_TOP <= y <= HEAD_POINT:
        # 1.0 at the base, 0.0 at the point.
        remaining = (HEAD_POINT - y) / (HEAD_POINT - HEAD_TOP)
        centre = (HEAD_LEFT + HEAD_RIGHT) / 2
        half = (HEAD_RIGHT - HEAD_LEFT) / 2 * remaining
        found.append((centre - half, centre + half))

    return found


def coverage(size: int) -> list[list[float]]:
    """How much of each pixel of a ``size``-square the arrow covers, from 0.0 to 1.0."""
    scale = size / 100.0
    rows: list[list[float]] = []

    for row in range(size):
        covered = [0.0] * size
        for sub in range(SUB_ROWS):
            y = (row + (sub + 0.5) / SUB_ROWS) / scale
            for left, right in spans(y):
                _add_span(covered, left * scale, right * scale, 1.0 / SUB_ROWS)
        # Two spans overlapping must not make a pixel more than full.
        rows.append([min(1.0, value) for value in covered])

    return rows


def _add_span(covered: list[float], left: float, right: float, weight: float) -> None:
    """Add one sub-row's horizontal span to a row's coverage, pixel by pixel.

    The two end pixels are partially covered and get the fraction of themselves the span
    actually crosses, which is where the smooth edges come from.
    """
    size = len(covered)
    first = max(0, int(left))
    last = min(size - 1, int(right))

    for column in range(first, last + 1):
        overlap = min(right, column + 1.0) - max(left, float(column))
        if overlap > 0:
            covered[column] += overlap * weight


def render(size: int) -> bytes:
    """One square of RGBA pixels: white arrow, black background, no transparency."""
    pixels = bytearray()

    for row in coverage(size):
        for value in row:
            pixels.extend(
                bytes(
                    round(dark + (light - dark) * value)
                    for dark, light in zip(BLACK, WHITE, strict=True)
                )
            )

    return bytes(pixels)


# --- the three file formats, written by hand ------------------------------------------------


def _chunk(kind: bytes, payload: bytes) -> bytes:
    """One PNG chunk: length, type, payload, CRC of the type and payload together."""
    return (
        struct.pack(">I", len(payload))
        + kind
        + payload
        + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
    )


def png(size: int, pixels: bytes) -> bytes:
    """A non-interlaced 8-bit RGBA PNG, which is the simplest thing every reader accepts."""
    stride = size * 4
    # Filter type 0 (none) in front of every scanline. The image is flat colour and a filter
    # would buy nothing but a reader that has to undo it.
    raw = b"".join(b"\x00" + pixels[row * stride : (row + 1) * stride] for row in range(size))

    header = struct.pack(
        ">IIBBBBB",
        size,
        size,
        8,  # bit depth
        6,  # colour type: RGBA
        0,  # compression: deflate
        0,  # filter method: adaptive
        0,  # interlace: none
    )

    return (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", header)
        + _chunk(b"IDAT", zlib.compress(raw, 9))
        + _chunk(b"IEND", b"")
    )


def ico(images: dict[int, bytes]) -> bytes:
    """A Windows `.ico` holding PNG payloads, which Vista and later read directly."""
    # Reserved, type 1 (icon), image count.
    header = struct.pack("<HHH", 0, 1, len(images))
    offset = len(header) + 16 * len(images)

    directory = b""
    payloads = b""
    for size, data in sorted(images.items()):
        directory += struct.pack(
            "<BBBBHHII",
            0 if size >= 256 else size,  # 0 means 256
            0 if size >= 256 else size,
            0,  # colours in the palette: none, it is a true-colour image
            0,  # reserved
            1,  # colour planes
            32,  # bits per pixel
            len(data),
            offset,
        )
        payloads += data
        offset += len(data)

    return header + directory + payloads


def icns(members: list[tuple[str, bytes]]) -> bytes:
    """A macOS `.icns`: the magic, the total length, then one length-prefixed member each."""
    body = b"".join(
        kind.encode("ascii") + struct.pack(">I", len(data) + 8) + data for kind, data in members
    )
    return b"icns" + struct.pack(">I", len(body) + 8) + body


# --- writing them out -----------------------------------------------------------------------


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    resources = root / RESOURCES
    resources.mkdir(parents=True, exist_ok=True)

    # Rendered once per size and reused by every format that wants that size.
    wanted = sorted({SOURCE_SIZE, *LINUX_SIZES, *ICO_SIZES, *(size for _, size in ICNS_MEMBERS)})
    images = {size: png(size, render(size)) for size in wanted}

    written: list[Path] = []

    source = resources / f"{STEM}.png"
    source.write_bytes(images[SOURCE_SIZE])
    written.append(source)

    for size in LINUX_SIZES:
        sized = resources / f"{STEM}-{size}.png"
        sized.write_bytes(images[size])
        written.append(sized)

    windows = resources / f"{STEM}.ico"
    windows.write_bytes(ico({size: images[size] for size in ICO_SIZES}))
    written.append(windows)

    apple = resources / f"{STEM}.icns"
    apple.write_bytes(icns([(kind, images[size]) for kind, size in ICNS_MEMBERS]))
    written.append(apple)

    for path in written:
        print(f"wrote {path.relative_to(root)} ({path.stat().st_size} bytes)")  # noqa: T201

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
