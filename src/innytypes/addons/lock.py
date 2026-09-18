"""The hash lock — everything an addon environment is allowed to contain, written down.

Invariant 10 of this project: *an addon environment is locked with hashes*. Plan 0003 D16
explains why that sentence carries so much weight. `auto` updates are allowed for a plugin
from **any** publisher, and the lock is the **only** check: it proves that what got installed
is exactly what was resolved, and that it cannot change afterwards. It proves nothing about
**who** published it. Remove the hashes and an auto-updating plugin installs whatever its
index serves at the moment of installation, which is a different promise entirely.

So a lock here is not a file we happen to write next to an environment. It is a document this
module **judges** before anything is installed from it, with three rules and no exceptions:

1. **Every requirement is an exact pin.** `name==version`, never a range. A range means the
   installed set depends on when you installed, which is the one thing a lock exists to deny.
2. **Every requirement carries at least one hash**, `sha256:` and 64 hex characters. A
   requirement with no hash is the hole the whole file was written to close.
3. **Every transitive dependency is in the lock.** The install runs with `--no-deps`, so a
   dependency missing from the lock is a missing package rather than a quiet resolution — and
   `uv pip compile` is what produced the list, so a gap here is a bug worth failing on.

**A git source is pinned by its commit hash**, which is the one shape rule 2 does not apply
to: `<name> @ git+<url>@<40 hex characters>`. Invariant 10 states both halves in one breath —
"an addon environment is locked with hashes, git sources by commit hash" — because a commit
hash *is* the digest of the tree it names. Nothing weaker is accepted here: a branch, a tag,
a short hash or a bare URL all mean "whatever that name points at when the install runs",
which is exactly what a lock exists to deny (plan 0003: a tag can be moved to different code
later).

**What is installed is the lock this module parsed**, not the text the resolver printed. The
recorded file is re-emitted from the parsed document, so nothing that failed a rule above can
reach `uv` by sitting in a part of the file the parser skipped.

The lock is recorded **beside the environment**, at :func:`recorded_lock_path`, in the same
directory as the manifest discovery reads. Discovery never reads it — the host does not need
to know how an environment was built to start it — but the helper does: a staged environment
and the `previous` one it replaced each carry the lock they were built from, which is what
lets plan 0003 slice 12 say what an update would change and slice 13 roll one back.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from pathlib import Path

from innytypes.addons.discovery import addon_environment

__all__ = [
    "LOCK_FILENAME",
    "EnvironmentLock",
    "LockError",
    "LockedGitRequirement",
    "LockedRequirement",
    "lock_path",
    "parse_lock",
    "recorded_lock_path",
]

# Recorded beside `manifest.json`, inside the addon's own directory.
LOCK_FILENAME = "lock.txt"

# A distribution name, as packaging spells it: letters, digits and the three separators that
# normalise to one. The version deliberately has no `>`, `<`, `~`, `!` or `*` in its
# character class — a range has no spelling here, which is how rule 1 is enforced.
_NAME = r"[A-Za-z0-9][A-Za-z0-9._-]*"
_PIN_RE = re.compile(rf"^(?P<name>{_NAME})==(?P<version>[A-Za-z0-9][A-Za-z0-9.+!-]*)$")

# The only digest this module accepts. One algorithm rather than a family: a lock that may
# carry a weaker hash is a lock whose strength is whatever the weakest entry chose.
_HASH_RE = re.compile(r"^sha256:[0-9a-f]{64}$")

# `<name> @ git+<url>@<commit>`, the direct reference a resolver writes for a git source. The
# commit is the full 40 hex characters and nothing else: a branch, a tag or an abbreviated
# hash all name something that can point elsewhere tomorrow. The URL match is greedy, so the
# `@` that separates it from the commit is the last one on the line rather than the one in a
# `user@host` address.
_GIT_REFERENCE_RE = re.compile(
    rf"^(?P<name>{_NAME}) @ git\+(?P<url>\S+)@(?P<commit>[0-9a-f]{{40}})$"
)

_HASH_OPTION = "--hash="

# The header on a recorded lock, so whoever finds the file knows what wrote it and that
# editing it by hand is not how an environment is changed.
_HEADER = (
    "# Recorded by `innytypes addons install`. Every line is an exact pin with the hashes\n"
    "# the resolver produced, and the environment beside this file was installed from it.\n"
)


class LockError(ValueError):
    """Raised when a lock is refused, naming the entry that broke a rule.

    There is no softer outcome. A lock that is accepted with complaints is a lock nobody can
    rely on, and every caller's response is the same: refuse the install and say why.
    """


def _canonical(name: str) -> str:
    """The one spelling of a distribution name (PEP 503), so `Foo_Bar` and `foo-bar` are one."""
    return re.sub(r"[-_.]+", "-", name).lower()


@dataclass(frozen=True)
class LockedRequirement:
    """One distribution, at one exact version, with the hashes of the artifacts that serve it.

    More than one hash is normal and correct: a release publishes a wheel per platform plus a
    source distribution, and any of them satisfies the pin.
    """

    name: str
    version: str
    hashes: tuple[str, ...]

    @property
    def canonical_name(self) -> str:
        """The name normalised for comparison, never for display."""
        return _canonical(self.name)

    def __str__(self) -> str:
        return f"{self.name}=={self.version}"


@dataclass(frozen=True)
class LockedGitRequirement:
    """One distribution taken from a git repository, pinned to one commit.

    A separate type from :class:`LockedRequirement` rather than a version with optional
    fields, because the two are locked by different things and a caller has to know which it
    is holding: this one has no version and no artifact digest, and its ``commit`` is what
    makes it immutable (invariant 10).
    """

    name: str
    url: str
    commit: str

    @property
    def canonical_name(self) -> str:
        """The name normalised for comparison, never for display."""
        return _canonical(self.name)

    def __str__(self) -> str:
        return f"{self.name} @ git+{self.url}@{self.commit}"


@dataclass(frozen=True)
class EnvironmentLock:
    """A judged lock: every entry pinned, every entry hashed, no entry named twice.

    ``git_requirements`` holds the entries pinned by commit hash instead of by version and
    artifact digest. They are a separate tuple so that every existing reader of
    ``requirements`` keeps seeing exactly what it always saw: a list of `name==version`
    entries, each carrying hashes.
    """

    requirements: tuple[LockedRequirement, ...]
    git_requirements: tuple[LockedGitRequirement, ...] = ()

    def find(self, name: str) -> LockedRequirement | None:
        """The locked requirement under ``name``, whatever way the caller spelled it."""
        wanted = _canonical(name)
        for requirement in self.requirements:
            if requirement.canonical_name == wanted:
                return requirement
        return None

    def find_git(self, name: str) -> LockedGitRequirement | None:
        """The git-pinned requirement under ``name``, or ``None`` when there is none."""
        wanted = _canonical(name)
        for requirement in self.git_requirements:
            if requirement.canonical_name == wanted:
                return requirement
        return None

    def must_pin(self, name: str, *, commit: str) -> None:
        """Insist the lock takes ``name`` from git at exactly ``commit``.

        The counterpart of :meth:`must_contain` for a git source: what was asked for was one
        commit, and a lock naming another one would build an environment nobody requested —
        the same failure, one source kind along.
        """
        locked = self.find_git(name)
        if locked is None:
            raise LockError(
                f"the lock does not take {name} from git, and it was asked for at commit {commit}"
            )
        if locked.commit != commit:
            raise LockError(
                f"the lock takes {locked.name} from git at commit {locked.commit}, but "
                f"{commit} was asked for"
            )

    def must_contain(self, requirements: Iterable[str]) -> None:
        """Insist the lock holds each of ``requirements`` at exactly the version asked for.

        This is what ties the lock back to the request. An addon is installed at an exact
        version with `innytypes` pinned at the running host's version (plan 0003, *Plugin
        environments*); a lock that resolved something else would install an environment
        nobody asked for, hashes and all.

        A requirement written as a git direct reference — `<name> @ git+<url>@<commit>`, what
        a git-sourced plugin is installed from — is checked by :meth:`must_pin` instead, on
        the commit rather than on a version. It is the same question asked of the one source
        kind that has no version to ask it about, and refusing the spelling outright would
        mean a git-sourced update could never be installed at all.
        """
        for text in requirements:
            reference = _GIT_REFERENCE_RE.match(text)
            if reference is not None:
                self.must_pin(reference["name"], commit=reference["commit"])
                continue

            match = _PIN_RE.match(text)
            if match is None:
                raise LockError(
                    f"{text!r} is not an exact pin, so no lock can be checked against it: "
                    "write '<name>==<version>' or '<name> @ git+<url>@<commit>'"
                )

            locked = self.find(match["name"])
            if locked is None:
                raise LockError(
                    f"the lock does not contain {match['name']}, which was asked for at "
                    f"version {match['version']}"
                )
            if locked.version != match["version"]:
                raise LockError(
                    f"the lock holds {locked.name} {locked.version}, but "
                    f"{match['version']} was asked for"
                )

    def text(self) -> str:
        """The lock as a requirements file, re-emitted from what this module accepted."""
        blocks: list[str] = []
        for requirement in self.requirements:
            hashes = (f"{_HASH_OPTION}{digest}" for digest in requirement.hashes)
            parts = [str(requirement), *hashes]
            blocks.append(" \\\n    ".join(parts))
        # After the hashed pins, so a reader finds the ordinary dependencies where they have
        # always been and the git references — at most a handful — together at the end.
        blocks.extend(str(requirement) for requirement in self.git_requirements)
        return _HEADER + "\n".join(blocks) + "\n"


def lock_path(environment: Path) -> Path:
    """The lock recorded beside one addon environment."""
    return environment.parent / LOCK_FILENAME


def recorded_lock_path(root: Path, addon_id: str) -> Path:
    """The lock recorded for ``addon_id`` under an addons root — staging roots included."""
    return lock_path(addon_environment(root, addon_id))


def parse_lock(text: str) -> EnvironmentLock:
    """Parse and judge a resolver's output, or refuse it naming the line that broke a rule."""
    requirements: list[LockedRequirement] = []
    git_requirements: list[LockedGitRequirement] = []
    seen: dict[str, int] = {}

    for number, line in _logical_lines(text):
        requirement = _parse_entry(line, number=number)

        first = seen.get(requirement.canonical_name)
        if first is not None:
            raise LockError(
                f"line {number}: {requirement.name} is locked twice (already on line "
                f"{first}); a lock names each distribution once, at one version"
            )

        seen[requirement.canonical_name] = number
        if isinstance(requirement, LockedGitRequirement):
            git_requirements.append(requirement)
        else:
            requirements.append(requirement)

    if not requirements and not git_requirements:
        raise LockError("the lock is empty: a lock with no requirements locks nothing")

    return EnvironmentLock(
        requirements=tuple(requirements), git_requirements=tuple(git_requirements)
    )


def _parse_entry(line: str, *, number: int) -> LockedRequirement | LockedGitRequirement:
    """One logical line: an exact pin followed by nothing but hashes, or a git reference."""
    reference, options = _split_reference(line.split())

    git = _GIT_REFERENCE_RE.match(reference)
    if git is not None:
        if options:
            raise LockError(
                f"line {number}: {reference} carries {options[0]!r}. A git reference is "
                "pinned by its commit hash and takes nothing else — there is no artifact to "
                "hash separately."
            )
        return LockedGitRequirement(name=git["name"], url=git["url"], commit=git["commit"])

    pin = reference
    if " @ " in pin:
        # A direct reference that is not pinned to a commit: a branch, a tag, a short hash,
        # or a URL with nothing after it. Named separately from the pin refusal below because
        # the fix is a different one — resolve the name to its commit first (plan 0003, D15).
        raise LockError(
            f"line {number}: {pin!r} is not pinned to a commit. A git source is locked as "
            "'<name> @ git+<url>@<commit>' with the full 40-character commit hash; a branch "
            "or a tag can be moved to different code later."
        )

    match = _PIN_RE.match(pin)
    if match is None:
        raise LockError(
            f"line {number}: {pin!r} is not an exact pin. A lock records every dependency at "
            "one version — a range or a bare name would make what gets installed depend on "
            "when it was installed."
        )

    hashes: list[str] = []
    for option in options:
        if not option.startswith(_HASH_OPTION):
            raise LockError(
                f"line {number}: {option!r} is not a hash. A locked requirement carries "
                "nothing but `--hash=` options, so no other setting can change what is "
                "installed."
            )

        digest = option[len(_HASH_OPTION) :]
        if _HASH_RE.match(digest) is None:
            raise LockError(
                f"line {number}: {digest!r} is not a sha256 hash: expected "
                "'sha256:' followed by 64 lowercase hex characters"
            )
        hashes.append(digest)

    if not hashes:
        raise LockError(
            f"line {number}: {pin} is locked with no hash. The hash is the whole check — "
            "without it, an install takes whatever the index serves at the time."
        )

    return LockedRequirement(
        name=match["name"],
        version=match["version"],
        # Sorted so two resolutions of the same set produce the same file, and a diff between
        # two recorded locks shows a changed dependency rather than a reordered one.
        hashes=tuple(sorted(hashes)),
    )


def _split_reference(tokens: list[str]) -> tuple[str, list[str]]:
    """Separate what is being locked from the options that follow it.

    Two shapes, and the ``@`` is what tells them apart: `name==version` is one token, and a
    direct reference — `name @ git+url@commit` — is three. Everything after is an option, so
    the rules below can still be stated about whole entries.
    """
    if tokens[1:2] == ["@"]:
        return " ".join(tokens[:3]), tokens[3:]
    return tokens[0], tokens[1:]


def _logical_lines(text: str) -> Iterator[tuple[int, str]]:
    """Yield `(line number, entry)` with comments dropped and continuations joined.

    A resolver writes one requirement across several lines, one hash per line. Rejoining them
    here is what lets every rule above be stated about a whole requirement rather than about
    whichever fragment a line happened to hold.
    """
    parts: list[str] = []
    start = 0

    for number, raw in enumerate(text.splitlines(), start=1):
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue

        if not parts:
            start = number

        if line.endswith("\\"):
            parts.append(line[:-1].strip())
            continue

        parts.append(line)
        yield start, " ".join(part for part in parts if part)
        parts = []

    if parts:
        # A file ending mid-continuation: still an entry, and still judged.
        yield start, " ".join(part for part in parts if part)
