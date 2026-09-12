"""No credential may ever be committed to this repository.

This addon holds an Anytype API key. The key belongs in the user's own config or in the
environment, and a test is the only thing that keeps that true after the tenth hurried
commit. Scans what git actually tracks, so a gitignored scratch file is out of scope by
construction and a staged one is not.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]

# Lines about content hashes are not credentials. Lockfiles are full of them, and a
# 64-character hex digest is indistinguishable from a token without this context.
BENIGN_HASH_MARKERS = ("sha256", "sha512", "sha1", "integrity", "resolved", "revision")

CREDENTIAL_PATTERNS = (
    # A bearer token with something real after it.
    re.compile(r"Bearer\s+[A-Za-z0-9._\-]{16,}"),
    # An api key assigned a long literal value.
    re.compile(r"(?i)api[_-]?key\s*[:=]\s*[\"']?[A-Za-z0-9._\-]{16,}"),
    # A bare long hex string, once hash lines are excluded above.
    re.compile(r"\b[A-Fa-f0-9]{40,}\b"),
)

# Documentation and configuration must be able to *show* the shape of a key.
PLACEHOLDER_MARKERS = (
    "<your",
    "your_api_key",
    "<yo",
    "xxxx",
    "example",
    "placeholder",
    "test-key",
    "fake",
)


def tracked_files() -> list[Path]:
    out = subprocess.run(
        ["git", "-C", str(REPO), "ls-files"],
        capture_output=True,
        text=True,
        check=True,
    )
    return [REPO / line for line in out.stdout.splitlines() if line]


def offending_lines(path: Path) -> list[str]:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        # Binary or unreadable: nothing to scan, and never a reason to fail the gate.
        return []

    found: list[str] = []
    for line in text.splitlines():
        lowered = line.lower()
        if any(marker in lowered for marker in BENIGN_HASH_MARKERS):
            continue
        if any(marker in lowered for marker in PLACEHOLDER_MARKERS):
            continue
        if any(pattern.search(line) for pattern in CREDENTIAL_PATTERNS):
            found.append(line.strip()[:120])
    return found


def test_no_credential_shaped_string_is_committed() -> None:
    offenders: dict[str, list[str]] = {}
    for path in tracked_files():
        if path.resolve() == Path(__file__).resolve():
            # This file defines the patterns; matching itself proves nothing.
            continue
        lines = offending_lines(path)
        if lines:
            offenders[str(path.relative_to(REPO))] = lines

    assert not offenders, f"credential-shaped strings found in tracked files: {offenders}"


def test_the_scanner_actually_catches_a_key() -> None:
    # An acceptance check that cannot fail is worthless; prove this one can.
    planted = REPO / "tests" / "__planted_for_scanner_test.txt"
    # Built by concatenation so the literal never exists in this file's own source.
    planted.write_text("Authorization: " + "Bearer " + "a1b2c3d4e5f6a7b8c9d0e1f2", encoding="utf-8")
    try:
        assert offending_lines(planted)
    finally:
        planted.unlink()


def test_dotenv_is_ignored() -> None:
    assert ".env" in (REPO / ".gitignore").read_text(encoding="utf-8")
