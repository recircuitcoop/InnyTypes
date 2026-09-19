"""Where plugin versions come from, and whether the plugin set may move to them.

This module **decides and reports**. It installs nothing, stages nothing, stops no process
and writes to no environment: applying an update is plan 0003 slice 13. What it produces is a
:class:`VersionCheck` — the target plugin set, and one line per plugin saying what is
installed, what the newest version is, and, when the two differ and nothing will change, the
exact rule that blocks it.

**A plugin declares its source, or it is never checked** (plan 0003, D15). The manifest's
optional ``update`` section names one of three kinds, and each kind is spelled so that
reading it is not guesswork:

| ``source`` | kind | how candidates are listed |
|---|---|---|
| ``index``, ``index:<name>`` | the owner's plugin index | one JSON document per plugin, every |
|  |  | published version with its manifest |
| ``pypi:<project>`` | a package index | the index's JSON API for the versions, then |
|  |  | the release's own manifest URL |
| ``git+<url>`` | a git repository | ``git ls-remote --tags``, each release tag |
|  |  | resolved to the commit it names |

A plugin with **no** ``update`` section is reported as *not updatable* and no request of any
kind is made for it. Guessing a source would be the helper downloading code on behalf of an
author who never said where their code comes from.

**A git version is a tag resolved to a commit hash, and the hash is what is locked.** A tag
is a name, and a name can be moved to different code tomorrow; the commit hash is the code.
So ``git ls-remote`` is read for the commit each tag points at (the *peeled* commit for an
annotated tag, never the tag object), the manifest is read from a clone of that tag, and the
clone's own ``HEAD`` is checked against the commit the listing gave — a tag that moved
between the two commands is refused rather than silently taken. What
:meth:`Candidate.requirement_text` hands the installer contains that hash and never the tag.

**The plugin set moves as a whole.** Because ``requires`` are exact versions, no plugin is
judged alone. The helper proposes a target set — every checkable plugin at its newest
candidate — and accepts it only if all five consistency rules hold (:class:`ConsistencyRule`).
A set that breaks a rule is **never applied, in any mode**. Instead the plugin the rule names
**steps down** to its next-newest candidate and the whole set is judged again, until a set
holds or until the plugin is back at its installed version with the reason recorded. That is
what makes "the newest *compatible* version" a fact rather than a hope, and it is why a
blocked plugin is reported with the rule that blocked it rather than with silence.

**A version this host could never run is still reported.** Rule 1 — the ``host_api`` a
version declares — is the one rule that can be decided the moment a source answers, before
any set is proposed, and a version it refuses is recorded as a :class:`RejectedOffer` rather
than dropped. Dropping it would leave ``outdated`` saying "up to date" about a plugin whose
publisher has released a version that needs a newer host, which is the opposite of the truth.
:func:`evaluate_target_set` checks the same rule over a whole set as well, because a set is
judged against all five rules however it was assembled.

**Nothing is checked at all when ``auto_check_versions`` is off** (D14). Not the core, not
one plugin, not one HTTP request, not one `git` command. The switch is read from the live
config at the start of every check, so turning it off takes effect on the next one.

**Everything that reaches outside the process is injected**: the HTTP transport, the `git`
command runner, and the resolver that turns a candidate into a lock. The gate therefore
proves this module with no network, no `git` and no `uv`.
"""

from __future__ import annotations

import json
import re
import tempfile
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import cast

import httpx

from innytypes import __version__
from innytypes.addons.discovery import InstalledAddon
from innytypes.addons.install import Runner, host_python_version, run_command
from innytypes.addons.lock import LockError, parse_lock
from innytypes.addons.manifest import (
    SUPPORTED_HOST_API_VERSIONS,
    AddonManifest,
    EventKind,
    KindPrefix,
    ManifestError,
    parse_manifest,
)
from innytypes.helper.config import HelperConfig, HelperSettings, UpdateMode

__all__ = [
    "DEFAULT_PACKAGE_INDEX_URL",
    "DEFAULT_PLUGIN_INDEX_URL",
    "GIT_MANIFEST_FILENAME",
    "MANIFEST_URL_LABEL",
    "Candidate",
    "ConsistencyRule",
    "GitSource",
    "LockResolver",
    "PackageIndexSource",
    "PluginIndexSource",
    "PluginReport",
    "PluginState",
    "RejectedOffer",
    "Source",
    "TargetPlugin",
    "TargetSet",
    "UvLockResolver",
    "VersionCheck",
    "VersionCheckError",
    "VersionChecker",
    "Violation",
    "evaluate_target_set",
    "is_prerelease",
    "parse_source",
    "version_key",
]

# Endpoints are build-time settings of a release, not user config (plan 0003, *Configuration*):
# a user cannot point the updater at another server by editing a file. Both are injectable so
# the gate can answer them in process.
DEFAULT_PLUGIN_INDEX_URL = "https://plugins.innytypes.app"
DEFAULT_PACKAGE_INDEX_URL = "https://pypi.org"

# The manifest a git source keeps at the root of its repository, read at the release tag.
GIT_MANIFEST_FILENAME = "innytypes-addon.json"

# The `project_urls` label a package-index release uses to say where its manifest is. A
# package index serves metadata, not addon manifests, so the project points at one.
MANIFEST_URL_LABEL = "innytypes-addon-manifest"

# Nothing the helper does may wait on a slow server: a version check that hangs is a helper
# that is not watching anything.
REQUEST_TIMEOUT = 10.0

_SOURCE_KINDS = "'index', 'index:<name>', 'pypi:<project>' or 'git+<url>'"


class VersionCheckError(ValueError):
    """Raised when a source cannot be read, or says something the helper will not act on.

    Never escapes :meth:`VersionChecker.check`: one plugin whose index is down, whose
    document is malformed or whose manifest is refused must not stop the other nine being
    checked, so the message is carried into that plugin's report instead.
    """


# --- where versions come from ---------------------------------------------------------------


@dataclass(frozen=True)
class PluginIndexSource:
    """The owner's plugin index, which publishes a manifest per version."""

    name: str

    def __str__(self) -> str:
        return f"the plugin index entry {self.name!r}"


@dataclass(frozen=True)
class PackageIndexSource:
    """A package index such as PyPI, by project name."""

    project: str

    def __str__(self) -> str:
        return f"the package index project {self.project!r}"


@dataclass(frozen=True)
class GitSource:
    """A git repository, whose versions are its release tags."""

    url: str

    def __str__(self) -> str:
        return f"the git repository {self.url}"


Source = PluginIndexSource | PackageIndexSource | GitSource


def parse_source(text: str, *, plugin_id: str) -> Source:
    """Read one ``update.source``, or refuse it naming the spellings that exist.

    The kind is a prefix rather than something inferred from the shape of a URL. "It looks
    like a git URL" is a guess, and the helper downloading code on a guess is the thing the
    whole ``update`` section exists to prevent.
    """
    if text.startswith("git+"):
        url = text[len("git+") :]
        if not url:
            raise VersionCheckError(
                f"{plugin_id}: update.source is 'git+' with no URL after it; write "
                "'git+<url>', for example 'git+https://forge.example/monty.git'"
            )
        return GitSource(url=url)

    if text.startswith("pypi:"):
        project = text[len("pypi:") :]
        if not project:
            raise VersionCheckError(
                f"{plugin_id}: update.source is 'pypi:' with no project after it; write "
                "'pypi:<project>', for example 'pypi:monty'"
            )
        return PackageIndexSource(project=project)

    if text == "index":
        # The index entry is named after the plugin unless the plugin says otherwise, so the
        # common case needs no second name to keep in step with the first.
        return PluginIndexSource(name=plugin_id)

    if text.startswith("index:"):
        name = text[len("index:") :]
        if not name:
            raise VersionCheckError(
                f"{plugin_id}: update.source is 'index:' with no name after it; write "
                "'index:<name>', or plain 'index' to use the plugin's own id"
            )
        return PluginIndexSource(name=name)

    raise VersionCheckError(
        f"{plugin_id}: update.source {text!r} names no source kind this helper can read; "
        f"write {_SOURCE_KINDS}"
    )


# --- version ordering -------------------------------------------------------------------------


def version_key(version: str) -> tuple[tuple[int, ...], int, tuple[str, ...]]:
    """An ordering for versions: the numeric release first, then whether it is final.

    Deliberately small. Versions are compared to answer one question — which of these is
    newer — and the leading numeric segments answer it for every scheme an addon is likely to
    use. Anything after the numbers (``1.5.0rc1``, ``2.0.0-beta``) makes the version a
    **pre-release of that numeric prefix**, which sorts *before* it.
    """
    numbers, rest = _split_version(version)
    return numbers, 1 if not rest else 0, rest


def is_prerelease(version: str) -> bool:
    """Whether a version carries anything beyond its numeric segments (``1.5.0rc1``)."""
    return bool(_split_version(version)[1])


def _split_version(version: str) -> tuple[tuple[int, ...], tuple[str, ...]]:
    """The leading numeric segments, and everything from the first non-numeric one on."""
    numbers: list[int] = []
    rest: list[str] = []

    for token in re.split(r"[.\-+_]", version):
        if not rest and token.isdigit():
            numbers.append(int(token))
        else:
            rest.append(token.lower())

    return tuple(numbers), tuple(rest)


# --- one version a plugin could move to ---------------------------------------------------------


@dataclass(frozen=True)
class Candidate:
    """One version a plugin could move to, with the facts its manifest declares.

    ``reference`` is what will be **locked**: the commit hash for a git source, and the
    version itself for an index. The distinction is the whole of D15 — for git, the version is
    a tag, and a tag is a name that can be moved to different code later.
    """

    plugin_id: str
    manifest: AddonManifest
    source: Source
    reference: str

    @property
    def version(self) -> str:
        """The version this candidate would install."""
        return self.manifest.version

    def requirement_text(self) -> str:
        """What the installer is asked to install, in the resolver's own spelling.

        For a git source this carries the **commit hash**, never the tag it came from, so
        what is resolved and locked cannot change when the tag does.
        """
        if isinstance(self.source, GitSource):
            return f"{self.plugin_id} @ git+{self.source.url}@{self.reference}"
        return f"{self.plugin_id}=={self.version}"


# --- the five consistency rules ------------------------------------------------------------------


class ConsistencyRule(StrEnum):
    """The five rules a target plugin set must satisfy (plan 0003, *Consistency*).

    A set that breaks any of them is not applied **in any mode** — not automatically, and not
    when the user asks. They are numbered because that is how the plan states them and how a
    blocked plugin is reported.
    """

    HOST_API = "host_api"
    REQUIRES = "requires"
    EVENT_KINDS = "event_kinds"
    MODE_OR_PIN = "mode_or_pin"
    LOCK = "lock"

    @property
    def number(self) -> int:
        """Where this rule sits in the plan's list of five."""
        return _RULE_NUMBERS[self]

    @property
    def summary(self) -> str:
        """The rule in one short phrase, for a report a person reads.

        Not ``title``: :class:`~enum.StrEnum` is a ``str``, and ``str.title`` already means
        something else to everything that handles one.
        """
        return _RULE_SUMMARIES[self]

    def __str__(self) -> str:
        return f"rule {self.number} ({self.summary})"


_RULE_NUMBERS = {
    ConsistencyRule.HOST_API: 1,
    ConsistencyRule.REQUIRES: 2,
    ConsistencyRule.EVENT_KINDS: 3,
    ConsistencyRule.MODE_OR_PIN: 4,
    ConsistencyRule.LOCK: 5,
}

_RULE_SUMMARIES = {
    ConsistencyRule.HOST_API: "host API support",
    ConsistencyRule.REQUIRES: "exact requirements",
    ConsistencyRule.EVENT_KINDS: "no subscribed event kind disappears",
    ConsistencyRule.MODE_OR_PIN: "no pinned, manual or off plugin changes",
    ConsistencyRule.LOCK: "a fully pinned lock",
}


@dataclass(frozen=True)
class Violation:
    """One rule broken by one proposed target set, and the plugins it implicates.

    ``implicated`` is what the helper acts on: the plugins whose *change* caused the
    violation, and therefore the ones that step back down. ``reason`` is what a person reads,
    and it names the root cause even when the plugin it is attached to is only a casualty of
    it — the same choice `innytypes.addons.resolution` makes for a held-back addon.
    """

    rule: ConsistencyRule
    implicated: tuple[str, ...]
    reason: str


@dataclass(frozen=True)
class RejectedOffer:
    """One published version that can never be a candidate, and the rule that says so.

    Kept rather than discarded so a person running ``outdated`` is told the version exists.
    "Nothing newer" and "something newer that this host cannot run" are different facts, and
    only one of them is a reason to do nothing.
    """

    version: str
    rule: ConsistencyRule
    reason: str


@dataclass(frozen=True)
class TargetPlugin:
    """One plugin in a proposed set: the manifest it would run, and whether that is a change."""

    id: str
    manifest: AddonManifest
    candidate: Candidate | None

    @property
    def changed(self) -> bool:
        """Whether this plugin would move from the version it has installed."""
        return self.candidate is not None

    @property
    def version(self) -> str:
        """The version this plugin would run."""
        return self.manifest.version


@dataclass(frozen=True)
class TargetSet:
    """Every installed plugin at the version a proposal would leave it running."""

    plugins: tuple[TargetPlugin, ...]

    def get(self, plugin_id: str) -> TargetPlugin | None:
        """The plugin under ``plugin_id``, or ``None`` when it is not installed."""
        for plugin in self.plugins:
            if plugin.id == plugin_id:
                return plugin
        return None

    @property
    def changed(self) -> tuple[TargetPlugin, ...]:
        """Only the plugins that would move."""
        return tuple(plugin for plugin in self.plugins if plugin.changed)

    @property
    def versions(self) -> dict[str, str]:
        """The set as `{id: version}`, which is how a caller usually wants to read it."""
        return {plugin.id: plugin.version for plugin in self.plugins}


def evaluate_target_set(
    target: TargetSet,
    *,
    installed: Mapping[str, AddonManifest],
    config: HelperConfig,
    resolve_lock: LockResolver,
    requested: Iterable[str] = (),
) -> tuple[Violation, ...]:
    """Judge one proposed plugin set against the five rules, and return every rule it breaks.

    Pure: it reads the proposal, the installed manifests and the user's settings, and asks
    the injected resolver for a lock. It applies nothing, and a caller that ignores its
    answer is the bug this function exists to make visible.

    All five rules are asked here, rule 1 included, even though
    :meth:`VersionChecker._candidates_for` already refuses a version whose ``host_api`` this
    host does not implement. A set arriving from somewhere else — slice 13 re-judging what it
    is about to install — must be judged whole, and a rule that is only ever enforced on the
    way in is a rule with a way around it.

    ``requested`` names the plugins the **user** asked for by hand, with `innytypes addons
    update`. For those, rule 4 stops asking about the update *mode*: `manual` means "nothing
    updates this on its own" (D18), and a person typing the command is the opposite of on its
    own. It never relaxes the **pin**, because a pin holds a plugin at its installed version
    whatever its mode says, and a pinned plugin is unpinned before it moves.
    """
    violations: list[Violation] = []

    violations.extend(_check_host_api(target))
    violations.extend(_check_requires(target))
    violations.extend(_check_event_kinds(target, installed=installed))
    violations.extend(_check_modes_and_pins(target, config=config, requested=requested))

    # Last, because it is the only rule that asks anything of the outside world: a set already
    # refused by a cheaper rule is not worth resolving a lock for.
    if not violations:
        violations.extend(_check_locks(target, resolve_lock=resolve_lock))

    return tuple(violations)


def _check_host_api(target: TargetSet) -> Iterable[Violation]:
    """Rule 1: every plugin in the set declares a ``host_api`` the running host implements.

    ``implicated`` names only the plugins that are *moving*, because those are the ones that
    can step back down. A plugin already installed against an unsupported host API is not
    something an update can fix, and the set is refused whole rather than half-applied.
    """
    supported = ", ".join(str(number) for number in SUPPORTED_HOST_API_VERSIONS)

    for plugin in target.plugins:
        if plugin.manifest.host_api in SUPPORTED_HOST_API_VERSIONS:
            continue

        yield Violation(
            rule=ConsistencyRule.HOST_API,
            implicated=_movers(plugin),
            reason=(
                f"{plugin.id} {plugin.version} targets host_api {plugin.manifest.host_api}, "
                f"which this host does not implement (it implements {supported})"
            ),
        )


def _check_requires(target: TargetSet) -> Iterable[Violation]:
    """Rule 2: every ``requires`` names a plugin in the set at exactly that version."""
    for plugin in target.plugins:
        for requirement in plugin.manifest.requires:
            required = target.get(requirement.addon_id)

            if required is None:
                # Not installed at all is plan 0001's degradation, not something an update
                # caused — unless this plugin is the one moving, in which case its new
                # version is asking for something that is not there.
                if not plugin.changed:
                    continue
                yield Violation(
                    rule=ConsistencyRule.REQUIRES,
                    implicated=(plugin.id,),
                    reason=(
                        f"{plugin.id} {plugin.version} requires {requirement}, which is not "
                        "installed"
                    ),
                )
                continue

            if required.version == requirement.version:
                continue

            if not plugin.changed and not required.changed:
                # Both sides are as they already are: a requirement that is unsatisfied today
                # is the host's business (plan 0001), not this update's.
                continue

            yield Violation(
                # The **required** plugin first: the requirement names a version of it, so
                # stepping it is what can satisfy the requirement, where stepping the plugin
                # that asked would only replace this requirement with another one.
                rule=ConsistencyRule.REQUIRES,
                implicated=_movers(required, plugin),
                reason=(
                    f"{plugin.id} {plugin.version} requires {requirement}, but the set holds "
                    f"{required.id} {required.version}"
                ),
            )


def _check_event_kinds(
    target: TargetSet, *, installed: Mapping[str, AddonManifest]
) -> Iterable[Violation]:
    """Rule 3: no event kind a plugin subscribes to stops being emitted.

    Stated as a **disappearance** rather than as "every subscription is served". A
    subscription nobody publishes today is a quiet inbox and always has been (plan 0001: only
    ``requires`` is a hard dependency). A kind that is being delivered now and would stop
    being delivered is the update breaking a subscriber, and a kind is a public API.
    """
    now = _emitted_kinds(installed.values())
    after = _emitted_kinds(plugin.manifest for plugin in target.plugins)

    for plugin in target.plugins:
        for subscription in plugin.manifest.subscribes:
            if not _is_served(subscription, now) or _is_served(subscription, after):
                continue

            lost = sorted(kind for kind in now - after if _matches(subscription, kind))
            dropped = tuple(
                sorted(
                    changed.id
                    for changed in target.changed
                    if _emitted_kinds([installed[changed.id]]) & set(lost)
                )
            )

            yield Violation(
                rule=ConsistencyRule.EVENT_KINDS,
                implicated=dropped or (plugin.id,),
                reason=(
                    f"{plugin.id} subscribes to {subscription}, and the set stops emitting "
                    f"{', '.join(lost)}"
                    + (f" ({', '.join(dropped)} would no longer emit it)" if dropped else "")
                ),
            )


def _check_modes_and_pins(
    target: TargetSet, *, config: HelperConfig, requested: Iterable[str] = ()
) -> Iterable[Violation]:
    """Rule 4: a pinned plugin, or one in ``manual`` or ``off`` mode, never changes.

    "Never" means never: not to let another plugin update, and not in any mode the helper
    itself is running in. A `manual` plugin whose new version is wanted is updated by the
    user running the command, which is what `manual` means (plan 0003, D18) — and that
    command is the whole of ``requested``: the plugins named there are past the mode question
    and are judged only on the pin.
    """
    asked_for = frozenset(requested)

    for plugin in target.changed:
        if config.plugins.is_pinned(plugin.id):
            yield Violation(
                rule=ConsistencyRule.MODE_OR_PIN,
                implicated=(plugin.id,),
                reason=(
                    f"{plugin.id} is pinned, and the set would move it to {plugin.version}; a "
                    "pinned plugin is held at its installed version whatever its mode says"
                ),
            )
            continue

        if plugin.id in asked_for:
            # The user named this plugin on the command line. Its mode has already had its
            # say: it is the reason the helper did not move it on its own.
            continue

        mode = config.update_mode_for(plugin.id)
        if mode is UpdateMode.AUTO:
            continue

        yield Violation(
            rule=ConsistencyRule.MODE_OR_PIN,
            implicated=(plugin.id,),
            reason=(
                f"{plugin.id} is in {mode.value} mode, and the set would move it to "
                f"{plugin.version}; nothing updates it on its own"
                + (
                    f"; run `innytypes addons update {plugin.id}` to apply it"
                    if mode is UpdateMode.MANUAL
                    else ""
                )
            ),
        )


def _check_locks(target: TargetSet, *, resolve_lock: LockResolver) -> Iterable[Violation]:
    """Rule 5: every changed environment resolves to a fully pinned, hashed lock.

    The lock is judged by :func:`~innytypes.addons.lock.parse_lock`, the same function the
    install runs from, so "fully pinned" means here exactly what it means there: every entry
    an exact version, every entry hashed, a git source at its commit — and this host's own
    `innytypes` present, because a plugin environment holds the version of the host it runs
    against.
    """
    for plugin in target.changed:
        candidate = cast(Candidate, plugin.candidate)

        try:
            lock = parse_lock(resolve_lock(candidate))
        except (LockError, VersionCheckError) as error:
            yield Violation(
                rule=ConsistencyRule.LOCK,
                implicated=(plugin.id,),
                reason=f"{plugin.id} {plugin.version} does not resolve to a locked "
                f"environment: {error}",
            )
            continue

        try:
            lock.must_contain([f"innytypes=={__version__}"])
            if isinstance(candidate.source, GitSource):
                lock.must_pin(plugin.id, commit=candidate.reference)
            else:
                lock.must_contain([f"{plugin.id}=={plugin.version}"])
        except LockError as error:
            yield Violation(
                rule=ConsistencyRule.LOCK,
                implicated=(plugin.id,),
                reason=(
                    f"the lock resolved for {plugin.id} {plugin.version} is not a lock of "
                    f"what was asked for: {error}"
                ),
            )


def _movers(*plugins: TargetPlugin) -> tuple[str, ...]:
    """The plugins among these that are actually moving — the only ones that can step back."""
    return tuple(plugin.id for plugin in plugins if plugin.changed)


def _emitted_kinds(manifests: Iterable[AddonManifest]) -> set[str]:
    """Every event kind this collection of manifests publishes, as strings."""
    return {str(kind) for manifest in manifests for kind in manifest.emits}


def _is_served(subscription: EventKind | KindPrefix, emitted: set[str]) -> bool:
    """Whether anything in ``emitted`` satisfies this subscription."""
    return any(_matches(subscription, kind) for kind in emitted)


def _matches(subscription: EventKind | KindPrefix, kind: str) -> bool:
    """Whether one emitted kind is what this subscription asked for."""
    if isinstance(subscription, EventKind):
        return kind == str(subscription)
    return kind.startswith(f"{subscription.prefix}.")


# --- what a check reports ---------------------------------------------------------------------


class PluginState(StrEnum):
    """What the check has to say about one plugin."""

    NOT_UPDATABLE = "not updatable"
    NOT_CHECKED = "not checked"
    SOURCE_FAILED = "source failed"
    UP_TO_DATE = "up to date"
    AVAILABLE = "available"
    BLOCKED = "blocked"


@dataclass(frozen=True)
class PluginReport:
    """One plugin's line in the report: what it runs, what it could run, and what stops it.

    Three versions, and they are three different questions:

    * ``installed_version`` — what is on the machine now.
    * ``newest_version`` — the newest version the source publishes at all, ``None`` when it
      publishes nothing newer. A version refused by a rule is still counted here.
    * ``target_version`` — the newest **compatible** one: what the judged set would leave
      this plugin running, which is ``installed_version`` when nothing may move.

    ``rule`` and ``reason`` are filled whenever ``newest_version`` is not the version being
    taken, and they say which of the five rules stands in the way. Collapsing the first two
    would make a plugin held back by rule 1 indistinguishable from one that is up to date.
    """

    id: str
    installed_version: str
    state: PluginState
    target_version: str
    newest_version: str | None = None
    rule: ConsistencyRule | None = None
    reason: str | None = None


@dataclass(frozen=True)
class VersionCheck:
    """One whole check: the set that would be applied, and a line per plugin.

    ``checked`` is ``False`` when ``auto_check_versions`` is off, and that is a different
    statement from "nothing is available": it says no source was asked.
    """

    checked: bool
    target: TargetSet
    reports: tuple[PluginReport, ...]

    def report_for(self, plugin_id: str) -> PluginReport | None:
        """One plugin's line, or ``None`` when it is not installed."""
        for report in self.reports:
            if report.id == plugin_id:
                return report
        return None

    @property
    def available(self) -> tuple[PluginReport, ...]:
        """The plugins the target set moves."""
        return tuple(report for report in self.reports if report.state is PluginState.AVAILABLE)

    @property
    def blocked(self) -> tuple[PluginReport, ...]:
        """The plugins a newer version exists for that the rules will not let through."""
        return tuple(report for report in self.reports if report.state is PluginState.BLOCKED)


# --- resolving a candidate to a lock -------------------------------------------------------------

# Given a candidate, the text of a lock for the environment it would be installed into. The
# seam that keeps `uv` out of the gate; slice 13 builds the environment from the same lock.
LockResolver = Callable[[Candidate], str]


@dataclass(frozen=True)
class UvLockResolver:
    """The production resolver: `uv pip compile --generate-hashes`, and nothing else.

    The same two facts every plugin environment is built from (plan 0003, *Plugin
    environments*): the plugin at the version being considered, and `innytypes` at exactly
    the version this host is running. Resolving before anything is installed is what lets
    rule 5 refuse a version whose dependencies cannot be pinned, while the live environment
    is still untouched.
    """

    uv: str = "uv"
    run: Runner = run_command

    def __call__(self, candidate: Candidate) -> str:
        requirements = (candidate.requirement_text(), f"innytypes=={__version__}")

        with tempfile.TemporaryDirectory() as scratch:
            source = Path(scratch) / "requirements.in"
            source.write_text("\n".join(requirements) + "\n", encoding="utf-8")

            try:
                return self.run(
                    [
                        self.uv,
                        "pip",
                        "compile",
                        "--generate-hashes",
                        # No environment exists yet — nothing is being installed — so the
                        # Python to resolve for is named outright. It is the host's own, the
                        # one every plugin environment is built on (D17).
                        "--python-version",
                        host_python_version(),
                        str(source),
                    ]
                )
            except Exception as error:  # noqa: BLE001 - every failure is one refusal
                raise VersionCheckError(
                    f"{candidate.plugin_id} {candidate.version} could not be resolved: {error}"
                ) from error


# --- the check ------------------------------------------------------------------------------------


@dataclass(frozen=True)
class _Checkable:
    """One installed plugin the check will consult a source for."""

    id: str
    installed: AddonManifest
    source: Source
    channel: str


@dataclass(frozen=True)
class VersionChecker:
    """Reads every plugin's source, computes the target set, and reports what blocks it.

    Everything that leaves the process is a field: the HTTP transport, the `git` runner and
    the lock resolver. Production leaves all three at their defaults; the gate passes an
    `httpx.MockTransport`, a runner that answers from a dictionary, and a resolver that
    returns lock text — which is how "no test makes a network call or runs a real `git`" is a
    property of the design rather than a promise.
    """

    settings: HelperSettings
    resolve_lock: LockResolver
    git: Runner = run_command
    transport: httpx.BaseTransport | None = None
    plugin_index_url: str = DEFAULT_PLUGIN_INDEX_URL
    package_index_url: str = DEFAULT_PACKAGE_INDEX_URL

    def check(
        self, installed: Sequence[InstalledAddon], *, requested: Iterable[str] = ()
    ) -> VersionCheck:
        """Ask every checkable plugin's source what it publishes, and decide what may move.

        Makes **no request of any kind** when ``auto_check_versions`` is off (D14), which is
        read from the live config here rather than remembered from startup.

        ``requested`` is what `innytypes addons update` passes: the plugins the user named,
        which rule 4 stops asking about the update mode for. Left out — every check the
        helper makes on its own — nothing is exempt from anything.
        """
        # One snapshot for one check: several keys are read below and they must all come from
        # the same moment, which is what `HelperSettings.current` is for.
        config = self.settings.current
        # Read once: the set below is judged again on every round of the step-down loop, and
        # a caller handing in a generator would find it empty from the second round on.
        asked_for = frozenset(requested)
        manifests = {addon.id: addon.manifest for addon in installed}

        if not config.auto_check_versions:
            return VersionCheck(
                checked=False,
                target=_unchanged(manifests),
                reports=tuple(
                    PluginReport(
                        id=addon.id,
                        installed_version=addon.manifest.version,
                        state=PluginState.NOT_CHECKED,
                        target_version=addon.manifest.version,
                        reason=("auto_check_versions is off, so no version of anything is checked"),
                    )
                    for addon in sorted(installed, key=lambda addon: addon.id)
                ),
            )

        checkable: list[_Checkable] = []
        fixed: list[PluginReport] = []

        for addon in sorted(installed, key=lambda addon: addon.id):
            report = self._classify(addon, config=config)
            if isinstance(report, PluginReport):
                fixed.append(report)
            else:
                checkable.append(report)

        candidates, rejected, failures = self._collect(checkable)
        fixed.extend(failures)

        target, blocked = self._decide(
            manifests=manifests, candidates=candidates, config=config, requested=asked_for
        )

        reports = [*fixed]
        for entry in checkable:
            if any(report.id == entry.id for report in fixed):
                continue
            reports.append(
                _report_for(
                    entry,
                    target=target,
                    candidates=candidates.get(entry.id, ()),
                    rejected=rejected.get(entry.id, ()),
                    blocked=blocked.get(entry.id),
                )
            )

        return VersionCheck(
            checked=True,
            target=target,
            reports=tuple(sorted(reports, key=lambda report: report.id)),
        )

    # --- which plugins are consulted at all -------------------------------------------------

    def _classify(
        self, addon: InstalledAddon, *, config: HelperConfig
    ) -> _Checkable | PluginReport:
        """Either a plugin whose source will be read, or the finished line explaining why not."""
        version = addon.manifest.version

        update = addon.manifest.update
        if update is None:
            return PluginReport(
                id=addon.id,
                installed_version=version,
                state=PluginState.NOT_UPDATABLE,
                target_version=version,
                reason=(
                    "its manifest declares no `update` section, so the helper does not know "
                    "where its versions come from and never guesses one"
                ),
            )

        if config.update_mode_for(addon.id) is UpdateMode.OFF:
            return PluginReport(
                id=addon.id,
                installed_version=version,
                state=PluginState.NOT_CHECKED,
                target_version=version,
                reason="its update mode is off, so this plugin is never checked",
            )

        try:
            source = parse_source(update.source, plugin_id=addon.id)
        except VersionCheckError as error:
            return PluginReport(
                id=addon.id,
                installed_version=version,
                state=PluginState.SOURCE_FAILED,
                target_version=version,
                reason=str(error),
            )

        return _Checkable(
            id=addon.id, installed=addon.manifest, source=source, channel=update.channel
        )

    # --- listing candidates ------------------------------------------------------------------

    def _collect(
        self, checkable: Sequence[_Checkable]
    ) -> tuple[
        dict[str, tuple[Candidate, ...]],
        dict[str, tuple[RejectedOffer, ...]],
        list[PluginReport],
    ]:
        """Per plugin: what it could move to, what rule 1 refused, and the sources that failed.

        One client for the whole check, closed before it returns: a helper that leaks a
        connection per plugin per day is a helper that runs out of file descriptors.
        """
        candidates: dict[str, tuple[Candidate, ...]] = {}
        rejected: dict[str, tuple[RejectedOffer, ...]] = {}
        failures: list[PluginReport] = []

        if not checkable:
            # No client is built at all, so "nothing was asked" is true of the socket layer
            # and not only of the report.
            return candidates, rejected, failures

        with httpx.Client(transport=self.transport, timeout=REQUEST_TIMEOUT) as client:
            for entry in checkable:
                try:
                    found, refused = self._candidates_for(entry, client=client)
                except VersionCheckError as error:
                    failures.append(
                        PluginReport(
                            id=entry.id,
                            installed_version=entry.installed.version,
                            state=PluginState.SOURCE_FAILED,
                            target_version=entry.installed.version,
                            reason=str(error),
                        )
                    )
                    continue

                candidates[entry.id] = found
                rejected[entry.id] = refused

        return candidates, rejected, failures

    def _candidates_for(
        self, entry: _Checkable, *, client: httpx.Client
    ) -> tuple[tuple[Candidate, ...], tuple[RejectedOffer, ...]]:
        """The versions this plugin could move to, and those rule 1 refused — newest first.

        Only versions **newer** than the installed one are read. Going backwards is not an
        update, and a plugin whose index still serves an old release must not be dragged back
        to it by a check nobody asked to downgrade anything.
        """
        source = entry.source
        installed = version_key(entry.installed.version)

        if isinstance(source, PluginIndexSource):
            offered, refused = self._from_plugin_index(entry, source, client=client)
        elif isinstance(source, PackageIndexSource):
            offered, refused = self._from_package_index(entry, source, client=client)
        else:
            offered, refused = self._from_git(entry, source)

        newer = [candidate for candidate in offered if version_key(candidate.version) > installed]
        newer_refused = [offer for offer in refused if version_key(offer.version) > installed]

        return (
            tuple(sorted(newer, key=lambda c: version_key(c.version), reverse=True)),
            tuple(sorted(newer_refused, key=lambda o: version_key(o.version), reverse=True)),
        )

    def _from_plugin_index(
        self, entry: _Checkable, source: PluginIndexSource, *, client: httpx.Client
    ) -> tuple[list[Candidate], list[RejectedOffer]]:
        """The owner's index: one document per plugin, every version with its manifest.

        An index that exists to serve this helper serves the facts this helper needs, so a
        whole check of one plugin is one request.
        """
        url = f"{self.plugin_index_url.rstrip('/')}/{source.name}.json"
        document = _json_object(self._get(client, url, plugin_id=entry.id), where=url)

        entries = document.get("versions")
        if not isinstance(entries, list):
            raise VersionCheckError(
                f"{entry.id}: {url} has no `versions` list; the plugin index publishes one "
                "entry per released version"
            )

        candidates: list[Candidate] = []
        rejected: list[RejectedOffer] = []

        for index, published in enumerate(entries):
            published_object = _json_object(published, where=f"{url} versions[{index}]")
            channel = published_object.get("channel", "stable")

            if channel != entry.channel:
                continue

            read = self._manifest_from(
                published_object.get("manifest"),
                plugin_id=entry.id,
                where=f"{url} versions[{index}]",
            )
            if isinstance(read, RejectedOffer):
                rejected.append(read)
                continue

            candidates.append(
                Candidate(
                    plugin_id=entry.id,
                    manifest=read,
                    source=source,
                    reference=read.version,
                )
            )

        return candidates, rejected

    def _from_package_index(
        self, entry: _Checkable, source: PackageIndexSource, *, client: httpx.Client
    ) -> tuple[list[Candidate], list[RejectedOffer]]:
        """A package index: its JSON API for the versions, the release's own URL for the manifest.

        A package index serves distributions, not addon manifests, and the helper downloads
        **nothing** during a check. So the release points at its manifest through a
        `project_urls` label, and the helper follows that link. A release that names no
        manifest cannot be judged against the five rules, so it is not a candidate.
        """
        project = source.project
        base = self.package_index_url.rstrip("/")
        url = f"{base}/pypi/{project}/json"
        document = _json_object(self._get(client, url, plugin_id=entry.id), where=url)

        releases = document.get("releases")
        if not isinstance(releases, dict):
            raise VersionCheckError(
                f"{entry.id}: {url} has no `releases` object; that is not a package index's "
                "JSON API"
            )

        installed = version_key(entry.installed.version)
        candidates: list[Candidate] = []
        rejected: list[RejectedOffer] = []

        for version, files in sorted(releases.items(), key=lambda item: version_key(item[0])):
            if version_key(version) <= installed:
                continue
            # A release whose files are all gone, or all yanked, is not something to install.
            if not _has_usable_file(files):
                continue
            # `stable` means final releases; any other channel is the plugin asking for its
            # pre-releases as well.
            if entry.channel == "stable" and is_prerelease(version):
                continue

            release_url = f"{base}/pypi/{project}/{version}/json"
            release = _json_object(
                self._get(client, release_url, plugin_id=entry.id), where=release_url
            )

            manifest_url = _manifest_url(release)
            if manifest_url is None:
                continue

            read = self._manifest_from(
                _json_object(
                    self._get(client, manifest_url, plugin_id=entry.id), where=manifest_url
                ),
                plugin_id=entry.id,
                where=manifest_url,
            )
            if isinstance(read, RejectedOffer):
                rejected.append(read)
                continue
            if read.version != version:
                # The index says one version and the manifest says another. Neither can be
                # trusted to name what would be installed, so this release is not offered.
                continue

            candidates.append(
                Candidate(plugin_id=entry.id, manifest=read, source=source, reference=version)
            )

        return candidates, rejected

    def _from_git(
        self, entry: _Checkable, source: GitSource
    ) -> tuple[list[Candidate], list[RejectedOffer]]:
        """A git repository: release tags, each resolved to the commit it names.

        Two things make this safe to lock. The **peeled** commit is taken for an annotated
        tag, so what is recorded is the commit and never the tag object; and the clone the
        manifest is read from is checked against that commit, so a tag that moves between the
        listing and the read is refused instead of quietly taken.
        """
        tags = _parse_tags(self._git(["git", "ls-remote", "--tags", source.url], entry.id))

        installed = version_key(entry.installed.version)
        candidates: list[Candidate] = []
        rejected: list[RejectedOffer] = []

        for tag, commit in sorted(tags.items(), key=lambda item: version_key(_version_of(item[0]))):
            version = _version_of(tag)
            if version_key(version) <= installed:
                continue
            if entry.channel == "stable" and is_prerelease(version):
                continue

            where = f"{source.url} at {tag}"
            read = self._manifest_from(
                _json_object(
                    self._read_at_tag(source, tag=tag, commit=commit, plugin_id=entry.id),
                    where=where,
                ),
                plugin_id=entry.id,
                where=where,
            )
            if isinstance(read, RejectedOffer):
                rejected.append(read)
                continue
            if read.version != version:
                # The tag says one version and the manifest at it says another. A release
                # that cannot agree with itself is not offered.
                continue

            candidates.append(
                # The commit, not the tag: this is the reference that gets locked (D15).
                Candidate(plugin_id=entry.id, manifest=read, source=source, reference=commit)
            )

        return candidates, rejected

    def _read_at_tag(self, source: GitSource, *, tag: str, commit: str, plugin_id: str) -> str:
        """The manifest a git source keeps at one release tag, read from a shallow clone."""
        with tempfile.TemporaryDirectory() as scratch:
            self._git(
                [
                    "git",
                    "clone",
                    "--quiet",
                    "--depth",
                    "1",
                    "--branch",
                    tag,
                    source.url,
                    scratch,
                ],
                plugin_id,
            )

            cloned = self._git(["git", "-C", scratch, "rev-parse", "HEAD^{commit}"], plugin_id)
            if cloned.strip() != commit:
                raise VersionCheckError(
                    f"{plugin_id}: the tag {tag} in {source.url} pointed at {commit} when it "
                    f"was listed and at {cloned.strip()} when it was read. A moving tag is "
                    "refused rather than taken; nothing is locked to a tag name."
                )

            return self._git(
                ["git", "-C", scratch, "show", f"HEAD:{GIT_MANIFEST_FILENAME}"], plugin_id
            )

    # --- deciding ------------------------------------------------------------------------------

    def _decide(
        self,
        *,
        manifests: Mapping[str, AddonManifest],
        candidates: Mapping[str, tuple[Candidate, ...]],
        config: HelperConfig,
        requested: Iterable[str] = (),
    ) -> tuple[TargetSet, dict[str, Violation]]:
        """Propose the newest of everything, and step back until every rule holds.

        **One plugin steps down per round**, the first one a broken rule names that is
        actually moving, and the set is judged again from scratch. One at a time on purpose:
        a rule-2 violation names two plugins and moving *either* of them can satisfy it, so
        stepping both would walk past the set that holds. Each violation lists the plugin
        most likely to resolve it first — for rule 2 that is the plugin the requirement names.

        A plugin out of candidates stays at its installed version. Positions only ever grow,
        so the loop ends, and what comes back is the newest set satisfying all five rules
        together, plus the reason each plugin that could not keep its newest version was
        pushed off it.
        """
        # How far down each plugin's candidate list the proposal currently is. The length of
        # the list means "not moving at all".
        position = {plugin_id: 0 for plugin_id in candidates}
        blocked: dict[str, Violation] = {}

        while True:
            target = _propose(manifests, candidates, position)
            violations = evaluate_target_set(
                target,
                installed=manifests,
                config=config,
                resolve_lock=self.resolve_lock,
                requested=requested,
            )

            if not violations or not target.changed:
                return target, blocked

            stepped = _step_one(target, violations, position=position, blocked=blocked)

            if not stepped:
                # Nothing the rules named can move, and yet a rule is broken. Every plugin
                # that is moving goes back to where it started rather than applying a set
                # nobody judged acceptable.
                for plugin in target.changed:
                    position[plugin.id] = len(candidates[plugin.id])
                    blocked.setdefault(plugin.id, violations[0])

    # --- the two seams to the outside world -------------------------------------------------

    def _get(self, client: httpx.Client, url: str, *, plugin_id: str) -> str:
        """One GET, with every way it can fail turned into one refusal naming the plugin."""
        try:
            response = client.get(url)
            response.raise_for_status()
        except httpx.HTTPError as error:
            raise VersionCheckError(f"{plugin_id}: {url} could not be read: {error}") from error
        return response.text

    def _git(self, argv: Sequence[str], plugin_id: str) -> str:
        """One `git` command, through the injected runner, refusing by name when it fails."""
        try:
            return self.git(argv)
        except Exception as error:  # noqa: BLE001 - every failure is one refusal
            raise VersionCheckError(f"{plugin_id}: `{' '.join(argv)}` failed: {error}") from error

    # --- reading a candidate's manifest ------------------------------------------------------

    def _manifest_from(
        self, document: object, *, plugin_id: str, where: str
    ) -> AddonManifest | RejectedOffer:
        """Validate one offered version's manifest, or say which rule refuses it.

        **Rule 1 is decided here as well as in :func:`evaluate_target_set`.** A version
        declaring a ``host_api`` this host does not implement is recognised before the
        document is parsed, because :func:`~innytypes.addons.manifest.parse_manifest` refuses
        such a manifest outright and that refusal carries no rule with it. Reading the number
        first is what turns "this version wants a newer host" into a reported rule-1 block
        instead of a broken document or, worse, silence.

        Anything else wrong with the document is a :class:`VersionCheckError`: a manifest the
        helper cannot read is a source that failed, not a version it decided against.
        """
        if not isinstance(document, Mapping):
            raise VersionCheckError(f"{plugin_id}: {where} does not carry a manifest object")

        # `bool` is an `int` in Python, and `host_api: true` is a broken document rather than
        # a version this host is too old for — so it falls through to the parser, which says so.
        declared = document.get("host_api")
        if (
            isinstance(declared, int)
            and not isinstance(declared, bool)
            and declared not in SUPPORTED_HOST_API_VERSIONS
        ):
            supported = ", ".join(str(number) for number in SUPPORTED_HOST_API_VERSIONS)
            version = document.get("version")
            return RejectedOffer(
                version=version if isinstance(version, str) else "?",
                rule=ConsistencyRule.HOST_API,
                reason=(
                    f"{plugin_id} {version} targets host_api {declared}, which this host does "
                    f"not implement (it implements {supported}); a newer `innytypes` is what "
                    "unblocks it"
                ),
            )

        try:
            manifest = parse_manifest(document)
        except ManifestError as error:
            raise VersionCheckError(
                f"{plugin_id}: the manifest published at {where} was refused: {error}"
            ) from error

        if manifest.id != plugin_id:
            raise VersionCheckError(
                f"{plugin_id}: the manifest published at {where} claims id {manifest.id!r}; a "
                "plugin has one identity, and it is the one it is installed under"
            )

        return manifest


# --- building and reporting -------------------------------------------------------------------


def _step_one(
    target: TargetSet,
    violations: Sequence[Violation],
    *,
    position: dict[str, int],
    blocked: dict[str, Violation],
) -> bool:
    """Push one moving plugin back to its next-oldest candidate, and say whether one moved.

    The first violation's first moving plugin, because every violation lists the plugin whose
    stepping down is most likely to resolve it first. The reason a plugin is first pushed off
    is the one kept: later rounds are consequences of this one, and the person reading
    ``outdated`` wants the cause.
    """
    for violation in violations:
        for plugin_id in violation.implicated:
            entry = target.get(plugin_id)
            if entry is None or not entry.changed:
                # Every rule above lists only plugins that are moving, so this restates that
                # invariant rather than handling a case that happens. It stays because
                # stepping a plugin that is **not** moving would raise its position without
                # changing the proposal, and this loop would never end.
                continue

            position[plugin_id] += 1
            blocked.setdefault(plugin_id, violation)
            return True

    return False


def _propose(
    manifests: Mapping[str, AddonManifest],
    candidates: Mapping[str, tuple[Candidate, ...]],
    position: Mapping[str, int],
) -> TargetSet:
    """The set implied by how far down each plugin's candidate list the proposal has stepped."""
    plugins: list[TargetPlugin] = []

    for plugin_id, installed in sorted(manifests.items()):
        offered = candidates.get(plugin_id, ())
        index = position.get(plugin_id, len(offered))

        if index >= len(offered):
            plugins.append(TargetPlugin(id=plugin_id, manifest=installed, candidate=None))
            continue

        candidate = offered[index]
        plugins.append(TargetPlugin(id=plugin_id, manifest=candidate.manifest, candidate=candidate))

    return TargetSet(plugins=tuple(plugins))


def _unchanged(manifests: Mapping[str, AddonManifest]) -> TargetSet:
    """The set as it already is: what a check that asked nothing can honestly report."""
    return TargetSet(
        plugins=tuple(
            TargetPlugin(id=plugin_id, manifest=manifest, candidate=None)
            for plugin_id, manifest in sorted(manifests.items())
        )
    )


def _report_for(
    entry: _Checkable,
    *,
    target: TargetSet,
    candidates: Sequence[Candidate],
    rejected: Sequence[RejectedOffer],
    blocked: Violation | None,
) -> PluginReport:
    """One checked plugin's line, from what the source offered and what the rules allowed.

    The newest thing the source published is the yardstick, whether or not it could ever be a
    candidate. When the set takes something older, this line says which rule is why — the
    rule-1 refusal recorded while reading, or the violation that pushed the plugin down the
    list. Without that, ``outdated`` would print a number and no account of it.
    """
    installed = entry.installed.version
    chosen = target.get(entry.id)
    target_version = installed if chosen is None else chosen.version

    if not candidates and not rejected:
        return PluginReport(
            id=entry.id,
            installed_version=installed,
            state=PluginState.UP_TO_DATE,
            target_version=target_version,
            newest_version=None,
        )

    # Both lists are newest first, so the head of each is all that has to be compared.
    newest_candidate = candidates[0].version if candidates else None
    newest_rejected = rejected[0].version if rejected else None

    if newest_candidate is None:
        newest, refusal = cast(str, newest_rejected), rejected[0]
    elif newest_rejected is not None and version_key(newest_rejected) > version_key(
        newest_candidate
    ):
        newest, refusal = newest_rejected, rejected[0]
    else:
        newest, refusal = newest_candidate, None

    state = PluginState.AVAILABLE if target_version != installed else PluginState.BLOCKED

    if newest == target_version:
        # The newest published version is the one being taken: there is nothing to explain.
        return PluginReport(
            id=entry.id,
            installed_version=installed,
            state=state,
            target_version=target_version,
            newest_version=newest,
        )

    reason = refusal if refusal is not None else blocked
    return PluginReport(
        id=entry.id,
        installed_version=installed,
        state=state,
        target_version=target_version,
        newest_version=newest,
        rule=None if reason is None else reason.rule,
        reason=None if reason is None else reason.reason,
    )


# --- reading what a source answered ---------------------------------------------------------------


def _json_object(payload: object, *, where: str) -> Mapping[str, object]:
    """One JSON object, or a refusal naming where it came from."""
    document = payload
    if isinstance(document, str):
        try:
            document = json.loads(document)
        except ValueError as error:
            raise VersionCheckError(f"{where} is not valid JSON: {error}") from error

    if not isinstance(document, Mapping):
        raise VersionCheckError(f"{where} is not a JSON object")
    return cast(Mapping[str, object], document)


def _has_usable_file(files: object) -> bool:
    """Whether a package-index release still has a file that may be installed.

    A release with no files left, or with every file yanked, is one the index is telling us
    not to install. Taking it anyway would be the helper arguing with the publisher.
    """
    if not isinstance(files, list) or not files:
        return False
    return any(isinstance(entry, Mapping) and not entry.get("yanked", False) for entry in files)


def _manifest_url(release: Mapping[str, object]) -> str | None:
    """Where a package-index release says its addon manifest is, or ``None`` if it says nothing."""
    info = release.get("info")
    if not isinstance(info, Mapping):
        return None

    urls = info.get("project_urls")
    if not isinstance(urls, Mapping):
        return None

    for label, url in urls.items():
        if str(label).strip().lower().replace(" ", "-") == MANIFEST_URL_LABEL and isinstance(
            url, str
        ):
            return url
    return None


def _parse_tags(output: str) -> dict[str, str]:
    """`git ls-remote --tags` output as `{tag: commit}`, preferring the peeled commit.

    An **annotated** tag is an object of its own, and the sha beside `refs/tags/v1.5.0` is
    that object rather than the commit it points at; git prints the commit on a second line
    ending in `^{}`. Taking the peeled line when there is one is the difference between
    locking a commit and locking a tag object.
    """
    tags: dict[str, str] = {}
    peeled: dict[str, str] = {}

    for line in output.splitlines():
        parts = line.split()
        if len(parts) != 2:
            continue

        commit, reference = parts
        if not reference.startswith("refs/tags/"):
            continue

        name = reference[len("refs/tags/") :]
        if name.endswith("^{}"):
            peeled[name[: -len("^{}")]] = commit
        else:
            tags[name] = commit

    tags.update(peeled)
    return {tag: commit for tag, commit in tags.items() if _is_version_tag(tag)}


def _is_version_tag(tag: str) -> bool:
    """Whether a tag names a release. A tag that is not a version is not a new version."""
    return bool(_split_version(_version_of(tag))[0])


def _version_of(tag: str) -> str:
    """The version a release tag names: `v1.5.0` and `1.5.0` are the same release."""
    return tag[1:] if tag.startswith("v") else tag
