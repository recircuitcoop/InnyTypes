"""Where plugin versions come from, and which of the five rules refuses a set that moves.

Nothing here opens a socket, runs `git`, runs `uv` or sleeps. The three seams
`innytypes.helper.versions` leaves open are all filled in process: an
:class:`httpx.MockTransport` that **records every request**, a `git` runner that answers from
a dictionary and **records every argv**, and a lock resolver that returns lock text. That is
what lets the switch-off test assert the strongest form of its claim — not "no update was
proposed" but "nothing was asked of anything".

The substance of this slice is refusal, so each of the five consistency rules gets a test
that constructs exactly that violation and asserts the set is rejected **and named**. They
call :func:`evaluate_target_set` directly, on sets built by hand, because that is the
function a rule can be deleted from: remove one `_check_*` call and exactly one of these
turns red.

Installed plugins are directories under ``tmp_path`` in the layout
`innytypes.addons.discovery` reads, so the whole path from "what is installed" to "what the
CLI prints" is exercised with no real addon and no real environment anywhere.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
import pytest
from click.testing import CliRunner, Result

from innytypes import HOST_API_VERSION, __version__
from innytypes.addons.discovery import (
    addon_environment,
    discover_addons,
    recorded_manifest_path,
)
from innytypes.addons.lock import LockedGitRequirement, LockError, parse_lock
from innytypes.addons.manifest import (
    AddonManifest,
    EventKind,
    KindPrefix,
    Requirement,
    parse_manifest,
)
from innytypes.cli import CliContext, cli
from innytypes.helper.config import (
    HelperConfig,
    HelperSettings,
    PluginOverride,
    PluginSettings,
    UpdateMode,
)
from innytypes.helper.versions import (
    GIT_MANIFEST_FILENAME,
    Candidate,
    ConsistencyRule,
    GitSource,
    PackageIndexSource,
    PluginIndexSource,
    PluginState,
    RejectedOffer,
    TargetPlugin,
    TargetSet,
    UvLockResolver,
    VersionChecker,
    VersionCheckError,
    evaluate_target_set,
    is_prerelease,
    parse_source,
    version_key,
)

# The two endpoints every test serves from. `.invalid` is reserved by RFC 2606, so a request
# that somehow escaped the mock transport would fail to resolve rather than reach a server.
INDEX_URL = "https://plugins.example.invalid"
PACKAGE_INDEX_URL = "https://packages.example.invalid"
REPOSITORY_URL = "https://forge.example.invalid/monty.git"

# Two commits that are obviously not the same, and obviously 40 hex characters.
COMMIT_ONE = "a" * 40
COMMIT_TWO = "b" * 40


# --------------------------------------------------------------------------------------
# Documents, environments and locks
# --------------------------------------------------------------------------------------


def manifest_document(
    addon_id: str,
    version: str,
    *,
    host_api: int = HOST_API_VERSION,
    requires: Sequence[str] = (),
    emits: Sequence[str] = (),
    subscribes: Sequence[str] = (),
    source: str | None = None,
    channel: str | None = None,
) -> dict[str, Any]:
    """One manifest as a source publishes it, or as install records it."""
    document: dict[str, Any] = {
        "id": addon_id,
        "version": version,
        "host_api": host_api,
        "requires": list(requires),
        "emits": list(emits),
        "subscribes": list(subscribes),
    }

    if source is not None:
        update: dict[str, str] = {"source": source}
        if channel is not None:
            update["channel"] = channel
        document["update"] = update

    return document


def install(root: Path, document: Mapping[str, Any]) -> None:
    """Put one addon on disk exactly where discovery looks for it."""
    addon_id = str(document["id"])
    addon_environment(root, addon_id).mkdir(parents=True, exist_ok=True)
    recorded_manifest_path(root, addon_id).write_text(json.dumps(document), encoding="utf-8")


def digest(seed: str) -> str:
    """A syntactically valid sha256 hash, derived from a seed so it is stable per entry."""
    return f"sha256:{hashlib.sha256(seed.encode('utf-8')).hexdigest()}"


def pin(name: str, version: str) -> str:
    """One hashed pin, the shape `uv pip compile --generate-hashes` writes."""
    return f"{name}=={version} --hash={digest(name + version)}"


def good_lock(candidate: Candidate) -> str:
    """A lock that satisfies rule 5: this host's `innytypes`, the plugin, and a dependency.

    The plugin's own entry is a commit reference for a git source and a hashed pin for
    everything else, which is the distinction rule 5 asks :func:`parse_lock` about.
    """
    if isinstance(candidate.source, GitSource):
        own = f"{candidate.plugin_id} @ git+{candidate.source.url}@{candidate.reference}"
    else:
        own = pin(candidate.plugin_id, candidate.version)

    return "\n".join([pin("innytypes", __version__), own, pin("httpx", "0.28.1")]) + "\n"


@dataclass
class FakeLocks:
    """The lock resolver, recording what it was asked for and answering from a dictionary."""

    # Keyed by the requirement text the candidate hands the installer, so a test can make
    # exactly one candidate resolve badly.
    texts: dict[str, str] = field(default_factory=dict)
    asked: list[str] = field(default_factory=list)

    def __call__(self, candidate: Candidate) -> str:
        requirement = candidate.requirement_text()
        self.asked.append(requirement)
        return self.texts.get(requirement, good_lock(candidate))


# --------------------------------------------------------------------------------------
# The two seams that reach outside the process
# --------------------------------------------------------------------------------------


@dataclass
class FakeWeb:
    """Every HTTP document this check may read, and every URL it actually asked for."""

    pages: dict[str, str] = field(default_factory=dict)
    requests: list[str] = field(default_factory=list)

    def serve(self, url: str, document: object) -> None:
        self.pages[url] = document if isinstance(document, str) else json.dumps(document)

    @property
    def transport(self) -> httpx.MockTransport:
        def handle(request: httpx.Request) -> httpx.Response:
            # Recorded before the answer, so even a 404 proves the checker consulted the
            # injected transport rather than the network.
            url = str(request.url)
            self.requests.append(url)
            if url not in self.pages:
                return httpx.Response(404, text=f"no document at {url}")
            return httpx.Response(200, text=self.pages[url])

        return httpx.MockTransport(handle)


@dataclass
class FakeGit:
    """A `git` runner with no `git` behind it: tags, what each commit holds, and a log.

    ``clone_lands_on`` is how a **moving tag** is expressed: the commit `ls-remote` reported
    and the commit the clone actually lands on are two separate facts here, exactly as they
    are on a server where someone re-pointed a tag between the two commands.
    """

    tags: dict[str, str] = field(default_factory=dict)
    annotated: set[str] = field(default_factory=set)
    manifests: dict[str, Any] = field(default_factory=dict)
    clone_lands_on: dict[str, str] = field(default_factory=dict)
    calls: list[list[str]] = field(default_factory=list)
    missing: set[str] = field(default_factory=set)
    # Lines `ls-remote` prints that are not release tags at all, verbatim.
    extra_lines: tuple[str, ...] = ()
    _cloned_tag: str = ""

    def __call__(self, argv: Sequence[str]) -> str:
        self.calls.append(list(argv))
        arguments = list(argv)

        if "ls-remote" in arguments:
            return self._ls_remote()

        if "clone" in arguments:
            self._cloned_tag = arguments[arguments.index("--branch") + 1]
            if self._cloned_tag in self.missing:
                raise RuntimeError(f"remote branch {self._cloned_tag} not found")
            return ""

        if "rev-parse" in arguments:
            return self._head() + "\n"

        if "show" in arguments:
            document = self.manifests[self._head()]
            return document if isinstance(document, str) else json.dumps(document)

        raise AssertionError(f"unexpected git command: {arguments}")

    def _head(self) -> str:
        """The commit the clone of the current tag is sitting on."""
        return self.clone_lands_on.get(self._cloned_tag, self.tags[self._cloned_tag])

    def _ls_remote(self) -> str:
        lines: list[str] = list(self.extra_lines)
        for tag, commit in self.tags.items():
            if tag in self.annotated:
                # An annotated tag is an object of its own; git prints the commit it points
                # at on a second, peeled line.
                lines.append(f"{'f' * 40} refs/tags/{tag}")
                lines.append(f"{commit} refs/tags/{tag}^{{}}")
            else:
                lines.append(f"{commit} refs/tags/{tag}")
        return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------------------
# Settings
# --------------------------------------------------------------------------------------


def settings_file(
    path: Path,
    *,
    auto_check_versions: bool = True,
    default_mode: str = "auto",
    modes: Mapping[str, str] | None = None,
    pinned: Iterable[str] = (),
) -> HelperSettings:
    """Write a `config.toml` and return the live view of it."""
    tables: dict[str, dict[str, str]] = {}
    for plugin_id, mode in (modes or {}).items():
        tables.setdefault(plugin_id, {})["update_mode"] = f'"{mode}"'
    for plugin_id in pinned:
        tables.setdefault(plugin_id, {})["pinned"] = "true"

    lines = [
        f"auto_check_versions = {str(auto_check_versions).lower()}",
        "",
        "[plugins]",
        f'update_mode = "{default_mode}"',
    ]
    for plugin_id, keys in tables.items():
        lines.append("")
        lines.append(f"[plugins.{plugin_id}]")
        lines.extend(f"{key} = {value}" for key, value in keys.items())

    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return HelperSettings(path=path)


def config_with(
    *, default_mode: UpdateMode = UpdateMode.AUTO, overrides: Sequence[PluginOverride] = ()
) -> HelperConfig:
    """A settings snapshot built in memory, for the tests that judge a set directly."""
    return HelperConfig(
        plugins=PluginSettings(update_mode=default_mode, overrides=tuple(overrides))
    )


# --------------------------------------------------------------------------------------
# Target sets built by hand, for the five rule tests
# --------------------------------------------------------------------------------------


def manifest(document: Mapping[str, Any]) -> AddonManifest:
    """A validated manifest from a document."""
    return parse_manifest(document)


def target_set(*plugins: TargetPlugin) -> TargetSet:
    return TargetSet(plugins=tuple(plugins))


def moving(
    installed_document: Mapping[str, Any], to: Mapping[str, Any], *, source: str = "index"
) -> TargetPlugin:
    """One plugin the proposal moves, with a candidate that says where the version came from."""
    new = manifest(to)
    return TargetPlugin(
        id=new.id,
        manifest=new,
        candidate=Candidate(
            plugin_id=new.id,
            manifest=new,
            source=PluginIndexSource(name=new.id)
            if source == "index"
            else GitSource(url=REPOSITORY_URL),
            reference=new.version,
        ),
    )


def staying(document: Mapping[str, Any]) -> TargetPlugin:
    """One plugin the proposal leaves exactly as it is."""
    held = manifest(document)
    return TargetPlugin(id=held.id, manifest=held, candidate=None)


def rules_broken(violations: Sequence[Any]) -> list[ConsistencyRule]:
    return [violation.rule for violation in violations]


# --------------------------------------------------------------------------------------
# Reading a source: which plugins are consulted at all
# --------------------------------------------------------------------------------------


def test_a_plugin_that_declares_an_index_source_is_checked_against_it(tmp_path: Path) -> None:
    install(tmp_path, manifest_document("monty", "1.4.0", source="index"))

    web = FakeWeb()
    web.serve(
        f"{INDEX_URL}/monty.json",
        {"versions": [{"manifest": manifest_document("monty", "2.0.0", source="index")}]},
    )
    checker = VersionChecker(
        settings=settings_file(tmp_path / "config.toml"),
        resolve_lock=FakeLocks(),
        transport=web.transport,
        plugin_index_url=INDEX_URL,
    )

    check = checker.check(discover_addons(tmp_path).installed)
    report = check.report_for("monty")

    assert web.requests == [f"{INDEX_URL}/monty.json"]
    assert report is not None
    assert report.state is PluginState.AVAILABLE
    assert (report.installed_version, report.newest_version, report.target_version) == (
        "1.4.0",
        "2.0.0",
        "2.0.0",
    )
    assert check.target.versions == {"monty": "2.0.0"}


def test_a_plugin_with_no_update_section_is_never_checked_and_is_reported(
    tmp_path: Path,
) -> None:
    install(tmp_path, manifest_document("monty", "1.4.0", source="index"))
    # No `update` section at all: the helper has nowhere to ask, and must not invent one.
    install(tmp_path, manifest_document("whodunnit", "1.0.0"))

    web = FakeWeb()
    web.serve(f"{INDEX_URL}/monty.json", {"versions": []})
    git = FakeGit()
    checker = VersionChecker(
        settings=settings_file(tmp_path / "config.toml"),
        resolve_lock=FakeLocks(),
        git=git,
        transport=web.transport,
        plugin_index_url=INDEX_URL,
    )

    check = checker.check(discover_addons(tmp_path).installed)
    report = check.report_for("whodunnit")

    assert report is not None
    assert report.state is PluginState.NOT_UPDATABLE
    assert "declares no `update` section" in str(report.reason)
    assert report.newest_version is None
    # Not one request names it, and `monty` proves the check ran at all.
    assert web.requests == [f"{INDEX_URL}/monty.json"]
    assert git.calls == []


def test_a_plugin_in_off_mode_is_never_checked(tmp_path: Path) -> None:
    install(tmp_path, manifest_document("monty", "1.4.0", source="index"))

    web = FakeWeb()
    checker = VersionChecker(
        settings=settings_file(tmp_path / "config.toml", modes={"monty": "off"}),
        resolve_lock=FakeLocks(),
        transport=web.transport,
        plugin_index_url=INDEX_URL,
    )

    check = checker.check(discover_addons(tmp_path).installed)
    report = check.report_for("monty")

    assert report is not None
    assert report.state is PluginState.NOT_CHECKED
    assert "off" in str(report.reason)
    assert web.requests == []


def test_nothing_is_requested_at_all_when_auto_check_versions_is_off(tmp_path: Path) -> None:
    install(tmp_path, manifest_document("monty", "1.4.0", source="index"))
    install(tmp_path, manifest_document("whodunnit", "1.0.0", source=f"git+{REPOSITORY_URL}"))

    web = FakeWeb()
    web.serve(
        f"{INDEX_URL}/monty.json",
        {"versions": [{"manifest": manifest_document("monty", "9.9.9", source="index")}]},
    )
    git = FakeGit(tags={"v9.9.9": COMMIT_ONE}, manifests={COMMIT_ONE: {}})
    locks = FakeLocks()
    checker = VersionChecker(
        settings=settings_file(tmp_path / "config.toml", auto_check_versions=False),
        resolve_lock=locks,
        git=git,
        transport=web.transport,
        plugin_index_url=INDEX_URL,
    )

    check = checker.check(discover_addons(tmp_path).installed)

    # The strong form: not "no update was proposed" but "nothing was asked of anything".
    assert web.requests == []
    assert git.calls == []
    assert locks.asked == []
    assert check.checked is False
    assert check.target.versions == {"monty": "1.4.0", "whodunnit": "1.0.0"}
    assert [report.state for report in check.reports] == [
        PluginState.NOT_CHECKED,
        PluginState.NOT_CHECKED,
    ]
    assert all("auto_check_versions is off" in str(r.reason) for r in check.reports)


def test_a_source_that_cannot_be_read_fails_that_plugin_and_no_other(tmp_path: Path) -> None:
    install(tmp_path, manifest_document("monty", "1.4.0", source="index"))
    install(tmp_path, manifest_document("whodunnit", "1.0.0", source="index"))

    web = FakeWeb()
    # `monty.json` is deliberately not served: the transport answers 404.
    web.serve(
        f"{INDEX_URL}/whodunnit.json",
        {"versions": [{"manifest": manifest_document("whodunnit", "1.1.0", source="index")}]},
    )
    checker = VersionChecker(
        settings=settings_file(tmp_path / "config.toml"),
        resolve_lock=FakeLocks(),
        transport=web.transport,
        plugin_index_url=INDEX_URL,
    )

    check = checker.check(discover_addons(tmp_path).installed)
    failed = check.report_for("monty")
    other = check.report_for("whodunnit")

    assert failed is not None and failed.state is PluginState.SOURCE_FAILED
    assert "could not be read" in str(failed.reason)
    assert other is not None and other.state is PluginState.AVAILABLE


def test_a_manifest_claiming_another_id_is_refused(tmp_path: Path) -> None:
    install(tmp_path, manifest_document("monty", "1.4.0", source="index"))

    web = FakeWeb()
    web.serve(
        f"{INDEX_URL}/monty.json",
        {"versions": [{"manifest": manifest_document("whodunnit", "2.0.0", source="index")}]},
    )
    checker = VersionChecker(
        settings=settings_file(tmp_path / "config.toml"),
        resolve_lock=FakeLocks(),
        transport=web.transport,
        plugin_index_url=INDEX_URL,
    )

    report = checker.check(discover_addons(tmp_path).installed).report_for("monty")

    assert report is not None and report.state is PluginState.SOURCE_FAILED
    assert "has one identity" in str(report.reason)


@pytest.mark.parametrize(
    ("document", "refusal"),
    [
        ({"versions": "all of them"}, "has no `versions` list"),
        ("not json at all", "is not valid JSON"),
        ("[1, 2, 3]", "is not a JSON object"),
        ({"versions": [{"manifest": {"id": "monty"}}]}, "was refused"),
        ({"versions": [{"manifest": "a string"}]}, "does not carry a manifest object"),
    ],
)
def test_a_plugin_index_that_answers_nonsense_fails_that_plugin(
    tmp_path: Path, document: object, refusal: str
) -> None:
    install(tmp_path, manifest_document("monty", "1.4.0", source="index"))

    web = FakeWeb()
    web.serve(f"{INDEX_URL}/monty.json", document)
    checker = VersionChecker(
        settings=settings_file(tmp_path / "config.toml"),
        resolve_lock=FakeLocks(),
        transport=web.transport,
        plugin_index_url=INDEX_URL,
    )

    report = checker.check(discover_addons(tmp_path).installed).report_for("monty")

    assert report is not None and report.state is PluginState.SOURCE_FAILED
    assert refusal in str(report.reason)


def test_a_named_index_entry_and_a_channel_are_both_honoured(tmp_path: Path) -> None:
    install(
        tmp_path,
        manifest_document("monty", "1.4.0", source="index:monty-nightly", channel="beta"),
    )

    web = FakeWeb()
    web.serve(
        f"{INDEX_URL}/monty-nightly.json",
        {
            "versions": [
                # Default channel is `stable`, so this entry is not in the beta channel.
                {"manifest": manifest_document("monty", "3.0.0", source="index")},
                {
                    "channel": "beta",
                    "manifest": manifest_document("monty", "2.0.0", source="index"),
                },
            ]
        },
    )
    checker = VersionChecker(
        settings=settings_file(tmp_path / "config.toml"),
        resolve_lock=FakeLocks(),
        transport=web.transport,
        plugin_index_url=INDEX_URL,
    )

    report = checker.check(discover_addons(tmp_path).installed).report_for("monty")

    assert web.requests == [f"{INDEX_URL}/monty-nightly.json"]
    assert report is not None and report.target_version == "2.0.0"


def test_an_older_published_version_is_never_a_candidate(tmp_path: Path) -> None:
    install(tmp_path, manifest_document("monty", "1.4.0", source="index"))

    web = FakeWeb()
    web.serve(
        f"{INDEX_URL}/monty.json",
        {
            "versions": [
                {"manifest": manifest_document("monty", "1.0.0", source="index")},
                {"manifest": manifest_document("monty", "1.4.0", source="index")},
            ]
        },
    )
    checker = VersionChecker(
        settings=settings_file(tmp_path / "config.toml"),
        resolve_lock=FakeLocks(),
        transport=web.transport,
        plugin_index_url=INDEX_URL,
    )

    report = checker.check(discover_addons(tmp_path).installed).report_for("monty")

    assert report is not None and report.state is PluginState.UP_TO_DATE
    assert report.newest_version is None


# --------------------------------------------------------------------------------------
# A package index
# --------------------------------------------------------------------------------------


def package_index(web: FakeWeb, *, releases: Mapping[str, object]) -> None:
    """Serve one project's JSON API, plus a per-release document and manifest for each."""
    web.serve(f"{PACKAGE_INDEX_URL}/pypi/monty/json", {"releases": dict(releases)})


def test_a_package_index_source_is_read_through_its_json_api(tmp_path: Path) -> None:
    install(tmp_path, manifest_document("monty", "1.4.0", source="pypi:monty"))

    web = FakeWeb()
    package_index(
        web,
        releases={
            "1.4.0": [{"filename": "monty-1.4.0.whl"}],
            "2.0.0": [{"filename": "monty-2.0.0.whl"}],
        },
    )
    web.serve(
        f"{PACKAGE_INDEX_URL}/pypi/monty/2.0.0/json",
        {"info": {"project_urls": {"innytypes-addon-manifest": f"{INDEX_URL}/monty-2.json"}}},
    )
    web.serve(f"{INDEX_URL}/monty-2.json", manifest_document("monty", "2.0.0", source="pypi:monty"))

    checker = VersionChecker(
        settings=settings_file(tmp_path / "config.toml"),
        resolve_lock=FakeLocks(),
        transport=web.transport,
        package_index_url=PACKAGE_INDEX_URL,
    )
    report = checker.check(discover_addons(tmp_path).installed).report_for("monty")

    assert report is not None and report.target_version == "2.0.0"
    # The already-installed release is never asked about: only versions newer than it are.
    assert f"{PACKAGE_INDEX_URL}/pypi/monty/1.4.0/json" not in web.requests


@pytest.mark.parametrize(
    ("release_files", "release_document", "why"),
    [
        ([], {}, "a release with no files left"),
        ([{"yanked": True}], {}, "a release whose only file is yanked"),
        ([{"filename": "monty.whl"}], {"info": {}}, "a release naming no manifest"),
        (
            [{"filename": "monty.whl"}],
            {"info": {"project_urls": {"Homepage": "https://example.invalid"}}},
            "a release whose links do not include the manifest label",
        ),
    ],
)
def test_a_package_release_that_cannot_be_judged_is_not_offered(
    tmp_path: Path,
    release_files: object,
    release_document: object,
    why: str,
) -> None:
    install(tmp_path, manifest_document("monty", "1.4.0", source="pypi:monty"))

    web = FakeWeb()
    package_index(web, releases={"2.0.0": release_files})
    web.serve(f"{PACKAGE_INDEX_URL}/pypi/monty/2.0.0/json", release_document)

    checker = VersionChecker(
        settings=settings_file(tmp_path / "config.toml"),
        resolve_lock=FakeLocks(),
        transport=web.transport,
        package_index_url=PACKAGE_INDEX_URL,
    )
    report = checker.check(discover_addons(tmp_path).installed).report_for("monty")

    assert report is not None, why
    assert report.state is PluginState.UP_TO_DATE, why


def test_a_package_index_prerelease_is_skipped_on_the_stable_channel(tmp_path: Path) -> None:
    install(tmp_path, manifest_document("monty", "1.4.0", source="pypi:monty"))

    web = FakeWeb()
    package_index(web, releases={"2.0.0rc1": [{"filename": "monty.whl"}]})

    checker = VersionChecker(
        settings=settings_file(tmp_path / "config.toml"),
        resolve_lock=FakeLocks(),
        transport=web.transport,
        package_index_url=PACKAGE_INDEX_URL,
    )
    report = checker.check(discover_addons(tmp_path).installed).report_for("monty")

    assert report is not None and report.state is PluginState.UP_TO_DATE
    # The release document is never fetched: the version was ruled out before that.
    assert f"{PACKAGE_INDEX_URL}/pypi/monty/2.0.0rc1/json" not in web.requests


def test_a_release_whose_manifest_disagrees_about_its_version_is_not_offered(
    tmp_path: Path,
) -> None:
    install(tmp_path, manifest_document("monty", "1.4.0", source="pypi:monty"))

    web = FakeWeb()
    package_index(web, releases={"2.0.0": [{"filename": "monty.whl"}]})
    web.serve(
        f"{PACKAGE_INDEX_URL}/pypi/monty/2.0.0/json",
        {"info": {"project_urls": {"InnyTypes Addon Manifest": f"{INDEX_URL}/m.json"}}},
    )
    # The index says 2.0.0 and the manifest says 2.0.1; neither can be trusted to name what
    # would be installed.
    web.serve(f"{INDEX_URL}/m.json", manifest_document("monty", "2.0.1", source="pypi:monty"))

    checker = VersionChecker(
        settings=settings_file(tmp_path / "config.toml"),
        resolve_lock=FakeLocks(),
        transport=web.transport,
        package_index_url=PACKAGE_INDEX_URL,
    )
    report = checker.check(discover_addons(tmp_path).installed).report_for("monty")

    assert report is not None and report.state is PluginState.UP_TO_DATE


def test_a_package_index_that_answers_nonsense_fails_that_plugin(tmp_path: Path) -> None:
    install(tmp_path, manifest_document("monty", "1.4.0", source="pypi:monty"))

    web = FakeWeb()
    web.serve(f"{PACKAGE_INDEX_URL}/pypi/monty/json", {"not-releases": {}})

    checker = VersionChecker(
        settings=settings_file(tmp_path / "config.toml"),
        resolve_lock=FakeLocks(),
        transport=web.transport,
        package_index_url=PACKAGE_INDEX_URL,
    )
    report = checker.check(discover_addons(tmp_path).installed).report_for("monty")

    assert report is not None and report.state is PluginState.SOURCE_FAILED
    assert "has no `releases` object" in str(report.reason)


# --------------------------------------------------------------------------------------
# A git source: the tag is resolved to a commit, and the commit is what is locked
# --------------------------------------------------------------------------------------


def git_checker(
    tmp_path: Path, git: FakeGit, *, locks: FakeLocks | None = None, **settings: Any
) -> VersionChecker:
    return VersionChecker(
        settings=settings_file(tmp_path / "config.toml", **settings),
        resolve_lock=FakeLocks() if locks is None else locks,
        git=git,
        transport=FakeWeb().transport,
    )


def test_a_git_release_tag_is_locked_as_its_commit_hash_and_never_as_the_tag(
    tmp_path: Path,
) -> None:
    install(tmp_path, manifest_document("monty", "1.4.0", source=f"git+{REPOSITORY_URL}"))

    git = FakeGit(
        tags={"v2.0.0": COMMIT_ONE},
        manifests={COMMIT_ONE: manifest_document("monty", "2.0.0", source=f"git+{REPOSITORY_URL}")},
    )
    locks = FakeLocks()
    check = git_checker(tmp_path, git, locks=locks).check(discover_addons(tmp_path).installed)

    report = check.report_for("monty")
    assert report is not None and report.target_version == "2.0.0"

    # What the installer is asked for carries the commit, and the tag name appears nowhere
    # in it. That is the whole of D15.
    assert locks.asked == [f"monty @ git+{REPOSITORY_URL}@{COMMIT_ONE}"]
    assert "v2.0.0" not in locks.asked[0]

    # And what a lock of that requirement records is the same commit.
    locked = parse_lock(good_lock(_only_candidate(check, git))).find_git("monty")
    assert locked == LockedGitRequirement(name="monty", url=REPOSITORY_URL, commit=COMMIT_ONE)


def _only_candidate(check: Any, git: FakeGit) -> Candidate:
    """The candidate behind the one plugin the check decided to move."""
    del git
    moved = check.target.changed
    assert len(moved) == 1
    candidate = moved[0].candidate
    assert candidate is not None
    return candidate


def test_a_tag_moved_after_the_check_does_not_change_what_was_locked(tmp_path: Path) -> None:
    install(tmp_path, manifest_document("monty", "1.4.0", source=f"git+{REPOSITORY_URL}"))
    published = manifest_document("monty", "2.0.0", source=f"git+{REPOSITORY_URL}")

    git = FakeGit(tags={"v2.0.0": COMMIT_ONE}, manifests={COMMIT_ONE: published})
    checker = git_checker(tmp_path, git)
    first = checker.check(discover_addons(tmp_path).installed)
    locked_before = _only_candidate(first, git).requirement_text()

    # Someone re-points the release tag at different code. The tag name has not changed.
    git.tags["v2.0.0"] = COMMIT_TWO
    git.manifests[COMMIT_TWO] = published
    second = checker.check(discover_addons(tmp_path).installed)

    assert locked_before == f"monty @ git+{REPOSITORY_URL}@{COMMIT_ONE}"
    # The reference the first check produced still names the code it judged; the second
    # check sees the new commit as a different thing to judge, not as the same version.
    assert _only_candidate(second, git).requirement_text() == (
        f"monty @ git+{REPOSITORY_URL}@{COMMIT_TWO}"
    )
    assert locked_before != _only_candidate(second, git).requirement_text()


def test_an_annotated_tag_resolves_to_its_peeled_commit(tmp_path: Path) -> None:
    install(tmp_path, manifest_document("monty", "1.4.0", source=f"git+{REPOSITORY_URL}"))

    git = FakeGit(
        tags={"v2.0.0": COMMIT_ONE},
        annotated={"v2.0.0"},
        manifests={COMMIT_ONE: manifest_document("monty", "2.0.0", source=f"git+{REPOSITORY_URL}")},
    )
    check = git_checker(tmp_path, git).check(discover_addons(tmp_path).installed)

    # `f` * 40 is the tag object `ls-remote` prints first. Locking that would lock a name.
    assert _only_candidate(check, git).reference == COMMIT_ONE


def test_a_tag_that_moves_between_the_listing_and_the_read_is_refused(tmp_path: Path) -> None:
    install(tmp_path, manifest_document("monty", "1.4.0", source=f"git+{REPOSITORY_URL}"))

    git = FakeGit(
        tags={"v2.0.0": COMMIT_ONE},
        clone_lands_on={"v2.0.0": COMMIT_TWO},
        manifests={COMMIT_TWO: manifest_document("monty", "2.0.0", source=f"git+{REPOSITORY_URL}")},
    )
    report = (
        git_checker(tmp_path, git).check(discover_addons(tmp_path).installed).report_for("monty")
    )

    assert report is not None and report.state is PluginState.SOURCE_FAILED
    assert "A moving tag is refused" in str(report.reason)


def test_a_tag_that_is_not_a_version_is_not_a_new_version(tmp_path: Path) -> None:
    install(tmp_path, manifest_document("monty", "1.4.0", source=f"git+{REPOSITORY_URL}"))

    git = FakeGit(tags={"latest": COMMIT_ONE, "release-candidate": COMMIT_TWO})
    report = (
        git_checker(tmp_path, git).check(discover_addons(tmp_path).installed).report_for("monty")
    )

    assert report is not None and report.state is PluginState.UP_TO_DATE
    # Only the listing ran: nothing was cloned, because nothing looked like a release.
    assert [call[1] for call in git.calls] == ["ls-remote"]


def test_only_release_tags_newer_than_what_is_installed_are_read(tmp_path: Path) -> None:
    install(tmp_path, manifest_document("monty", "1.4.0", source=f"git+{REPOSITORY_URL}"))

    git = FakeGit(
        tags={
            "v1.0.0": COMMIT_TWO,  # older than what is installed
            "v2.0.0rc1": COMMIT_TWO,  # a pre-release, and the channel is `stable`
            "v2.0.0": COMMIT_ONE,
        },
        manifests={COMMIT_ONE: manifest_document("monty", "2.0.0", source=f"git+{REPOSITORY_URL}")},
        extra_lines=(
            f"{COMMIT_TWO} refs/heads/main",  # a branch is not a version
            "not a ref line at all",
        ),
    )
    check = git_checker(tmp_path, git).check(discover_addons(tmp_path).installed)

    assert check.target.versions == {"monty": "2.0.0"}
    # Exactly one tag was worth reading, so exactly one clone happened. A branch, a
    # pre-release on the stable channel, an older release and a line that is not a ref at
    # all all cost nothing.
    cloned = [call[call.index("--branch") + 1] for call in git.calls if "clone" in call]
    assert cloned == ["v2.0.0"]


def test_a_git_version_needing_a_newer_host_is_reported_with_rule_1(tmp_path: Path) -> None:
    install(tmp_path, manifest_document("monty", "1.4.0", source=f"git+{REPOSITORY_URL}"))

    git = FakeGit(
        tags={"v3.0.0": COMMIT_ONE},
        manifests={
            COMMIT_ONE: manifest_document(
                "monty", "3.0.0", host_api=HOST_API_VERSION + 1, source=f"git+{REPOSITORY_URL}"
            )
        },
    )
    report = (
        git_checker(tmp_path, git).check(discover_addons(tmp_path).installed).report_for("monty")
    )

    assert report is not None
    assert report.state is PluginState.BLOCKED
    assert report.newest_version == "3.0.0"
    assert report.rule is ConsistencyRule.HOST_API


def test_a_git_manifest_that_disagrees_with_its_tag_is_not_offered(tmp_path: Path) -> None:
    install(tmp_path, manifest_document("monty", "1.4.0", source=f"git+{REPOSITORY_URL}"))

    git = FakeGit(
        tags={"v2.0.0": COMMIT_ONE},
        manifests={
            # The tag says 2.0.0 and the manifest at it says 2.0.1.
            COMMIT_ONE: manifest_document("monty", "2.0.1", source=f"git+{REPOSITORY_URL}")
        },
    )
    report = (
        git_checker(tmp_path, git).check(discover_addons(tmp_path).installed).report_for("monty")
    )

    assert report is not None and report.state is PluginState.UP_TO_DATE


def test_a_package_release_needing_a_newer_host_is_reported_with_rule_1(tmp_path: Path) -> None:
    install(tmp_path, manifest_document("monty", "1.4.0", source="pypi:monty"))

    web = FakeWeb()
    package_index(web, releases={"3.0.0": [{"filename": "monty.whl"}]})
    web.serve(
        f"{PACKAGE_INDEX_URL}/pypi/monty/3.0.0/json",
        # `info` that is not an object at all, on a second release, exercises the other way
        # a release can name no manifest.
        {"info": {"project_urls": {"innytypes-addon-manifest": f"{INDEX_URL}/m3.json"}}},
    )
    web.serve(
        f"{INDEX_URL}/m3.json",
        manifest_document("monty", "3.0.0", host_api=HOST_API_VERSION + 1, source="pypi:monty"),
    )

    checker = VersionChecker(
        settings=settings_file(tmp_path / "config.toml"),
        resolve_lock=FakeLocks(),
        transport=web.transport,
        package_index_url=PACKAGE_INDEX_URL,
    )
    report = checker.check(discover_addons(tmp_path).installed).report_for("monty")

    assert report is not None
    assert report.newest_version == "3.0.0"
    assert report.rule is ConsistencyRule.HOST_API


def test_a_release_whose_info_is_not_an_object_names_no_manifest(tmp_path: Path) -> None:
    install(tmp_path, manifest_document("monty", "1.4.0", source="pypi:monty"))

    web = FakeWeb()
    package_index(web, releases={"2.0.0": [{"filename": "monty.whl"}]})
    web.serve(f"{PACKAGE_INDEX_URL}/pypi/monty/2.0.0/json", {"info": "unavailable"})

    checker = VersionChecker(
        settings=settings_file(tmp_path / "config.toml"),
        resolve_lock=FakeLocks(),
        transport=web.transport,
        package_index_url=PACKAGE_INDEX_URL,
    )
    report = checker.check(discover_addons(tmp_path).installed).report_for("monty")

    assert report is not None and report.state is PluginState.UP_TO_DATE


def test_a_git_command_that_fails_fails_that_plugin(tmp_path: Path) -> None:
    install(tmp_path, manifest_document("monty", "1.4.0", source=f"git+{REPOSITORY_URL}"))

    git = FakeGit(tags={"v2.0.0": COMMIT_ONE}, missing={"v2.0.0"})
    report = (
        git_checker(tmp_path, git).check(discover_addons(tmp_path).installed).report_for("monty")
    )

    assert report is not None and report.state is PluginState.SOURCE_FAILED
    assert "git clone" in str(report.reason)


def test_the_manifest_is_read_from_the_repository_root_at_the_tag(tmp_path: Path) -> None:
    install(tmp_path, manifest_document("monty", "1.4.0", source=f"git+{REPOSITORY_URL}"))

    git = FakeGit(
        tags={"v2.0.0": COMMIT_ONE},
        manifests={COMMIT_ONE: manifest_document("monty", "2.0.0", source=f"git+{REPOSITORY_URL}")},
    )
    git_checker(tmp_path, git).check(discover_addons(tmp_path).installed)

    shows = [call for call in git.calls if "show" in call]
    assert shows and shows[0][-1] == f"HEAD:{GIT_MANIFEST_FILENAME}"


# --------------------------------------------------------------------------------------
# Rule 1 — every plugin declares a host_api the running host supports
# --------------------------------------------------------------------------------------


def test_rule_1_rejects_a_set_holding_a_version_this_host_cannot_run() -> None:
    # Built by hand: `parse_manifest` refuses an unsupported `host_api` outright, so this is
    # the only way a set can be made to hold one — and a set is judged whole however it was
    # assembled.
    future = AddonManifest(
        id="monty",
        version="2.0.0",
        host_api=HOST_API_VERSION + 1,
        requires=(),
        emits=(),
        subscribes=(),
    )
    proposal = target_set(
        TargetPlugin(
            id="monty",
            manifest=future,
            candidate=Candidate(
                plugin_id="monty",
                manifest=future,
                source=PluginIndexSource(name="monty"),
                reference="2.0.0",
            ),
        )
    )

    violations = evaluate_target_set(
        proposal,
        installed={"monty": manifest(manifest_document("monty", "1.4.0"))},
        config=config_with(),
        resolve_lock=FakeLocks(),
    )

    assert rules_broken(violations) == [ConsistencyRule.HOST_API]
    assert violations[0].implicated == ("monty",)
    assert f"host_api {HOST_API_VERSION + 1}" in violations[0].reason


def test_a_published_version_needing_a_newer_host_is_reported_not_hidden(
    tmp_path: Path,
) -> None:
    install(tmp_path, manifest_document("monty", "1.4.0", source="index"))

    web = FakeWeb()
    web.serve(
        f"{INDEX_URL}/monty.json",
        {
            "versions": [
                {
                    "manifest": manifest_document(
                        "monty", "3.0.0", host_api=HOST_API_VERSION + 1, source="index"
                    )
                },
                {"manifest": manifest_document("monty", "2.0.0", source="index")},
            ]
        },
    )
    checker = VersionChecker(
        settings=settings_file(tmp_path / "config.toml"),
        resolve_lock=FakeLocks(),
        transport=web.transport,
        plugin_index_url=INDEX_URL,
    )

    report = checker.check(discover_addons(tmp_path).installed).report_for("monty")

    assert report is not None
    # 2.0.0 is taken, and 3.0.0 is still named with the rule that keeps it out. "Up to date"
    # here would be a lie about a version the publisher has released.
    assert report.target_version == "2.0.0"
    assert report.newest_version == "3.0.0"
    assert report.rule is ConsistencyRule.HOST_API
    assert "does not implement" in str(report.reason)


# --------------------------------------------------------------------------------------
# Rule 2 — every `requires` names a plugin in the set at exactly that version
# --------------------------------------------------------------------------------------


def test_rule_2_rejects_a_set_that_leaves_an_exact_requirement_unsatisfied() -> None:
    installed_monty = manifest_document("monty", "1.4.0", requires=["whodunnit==1.0.0"])
    installed_who = manifest_document("whodunnit", "1.0.0")

    proposal = target_set(
        staying(installed_monty),
        # whodunnit moves to 2.0.0 while monty still demands exactly 1.0.0.
        moving(installed_who, manifest_document("whodunnit", "2.0.0")),
    )

    violations = evaluate_target_set(
        proposal,
        installed={
            "monty": manifest(installed_monty),
            "whodunnit": manifest(installed_who),
        },
        config=config_with(),
        resolve_lock=FakeLocks(),
    )

    assert rules_broken(violations) == [ConsistencyRule.REQUIRES]
    assert violations[0].implicated == ("whodunnit",)
    assert "requires whodunnit==1.0.0" in violations[0].reason
    assert "holds whodunnit 2.0.0" in violations[0].reason


def test_rule_2_rejects_a_new_version_that_requires_something_not_installed() -> None:
    installed_monty = manifest_document("monty", "1.4.0")
    proposal = target_set(
        moving(installed_monty, manifest_document("monty", "2.0.0", requires=["ghost==1.0.0"]))
    )

    violations = evaluate_target_set(
        proposal,
        installed={"monty": manifest(installed_monty)},
        config=config_with(),
        resolve_lock=FakeLocks(),
    )

    assert rules_broken(violations) == [ConsistencyRule.REQUIRES]
    assert "which is not installed" in violations[0].reason


def test_rule_2_leaves_a_missing_requirement_of_an_unchanged_plugin_to_the_host() -> None:
    # `monty` already asks for something that is not installed. That is plan 0001's
    # degradation and has nothing to do with the update `whodunnit` is taking.
    monty = manifest_document("monty", "1.4.0", requires=["ghost==1.0.0"])
    who = manifest_document("whodunnit", "1.0.0")

    violations = evaluate_target_set(
        target_set(staying(monty), moving(who, manifest_document("whodunnit", "2.0.0"))),
        installed={"monty": manifest(monty), "whodunnit": manifest(who)},
        config=config_with(),
        resolve_lock=FakeLocks(),
    )

    assert violations == ()


def test_rule_2_leaves_a_requirement_that_was_already_unsatisfied_to_the_host() -> None:
    # Nothing moves. An unsatisfied `requires` here is plan 0001's degradation, and calling
    # it an update failure would block every future update on a pre-existing condition.
    monty = manifest_document("monty", "1.4.0", requires=["whodunnit==9.9.9"])
    who = manifest_document("whodunnit", "1.0.0")

    violations = evaluate_target_set(
        target_set(staying(monty), staying(who)),
        installed={"monty": manifest(monty), "whodunnit": manifest(who)},
        config=config_with(),
        resolve_lock=FakeLocks(),
    )

    assert violations == ()


def test_a_group_steps_down_until_every_requirement_is_satisfied(tmp_path: Path) -> None:
    install(
        tmp_path,
        manifest_document("monty", "1.4.0", requires=["whodunnit==1.0.0"], source="index"),
    )
    install(tmp_path, manifest_document("whodunnit", "1.0.0", source="index"))

    web = FakeWeb()
    web.serve(
        f"{INDEX_URL}/monty.json",
        {
            "versions": [
                {
                    "manifest": manifest_document(
                        "monty", "2.0.0", requires=["whodunnit==1.5.0"], source="index"
                    )
                }
            ]
        },
    )
    web.serve(
        f"{INDEX_URL}/whodunnit.json",
        {
            "versions": [
                {"manifest": manifest_document("whodunnit", "2.0.0", source="index")},
                {"manifest": manifest_document("whodunnit", "1.5.0", source="index")},
            ]
        },
    )
    checker = VersionChecker(
        settings=settings_file(tmp_path / "config.toml"),
        resolve_lock=FakeLocks(),
        transport=web.transport,
        plugin_index_url=INDEX_URL,
    )

    check = checker.check(discover_addons(tmp_path).installed)

    # The newest whodunnit (2.0.0) breaks monty 2.0.0's exact requirement, so the set that
    # holds is monty 2.0.0 with whodunnit 1.5.0 — both moving, together.
    assert check.target.versions == {"monty": "2.0.0", "whodunnit": "1.5.0"}
    who = check.report_for("whodunnit")
    assert who is not None
    assert who.newest_version == "2.0.0"
    assert who.target_version == "1.5.0"
    assert who.rule is ConsistencyRule.REQUIRES


# --------------------------------------------------------------------------------------
# Rule 3 — no subscribed event kind disappears
# --------------------------------------------------------------------------------------


def test_rule_3_rejects_a_set_that_stops_emitting_a_subscribed_kind() -> None:
    installed_monty = manifest_document("monty", "1.4.0", emits=["monty.recorded.v1"])
    installed_who = manifest_document("whodunnit", "1.0.0", subscribes=["monty.recorded.v1"])

    proposal = target_set(
        # The new monty stops emitting the kind whodunnit listens for.
        moving(installed_monty, manifest_document("monty", "2.0.0", emits=["monty.saved.v1"])),
        staying(installed_who),
    )

    violations = evaluate_target_set(
        proposal,
        installed={
            "monty": manifest(installed_monty),
            "whodunnit": manifest(installed_who),
        },
        config=config_with(),
        resolve_lock=FakeLocks(),
    )

    assert rules_broken(violations) == [ConsistencyRule.EVENT_KINDS]
    assert violations[0].implicated == ("monty",)
    assert "stops emitting monty.recorded.v1" in violations[0].reason


def test_rule_3_covers_a_prefix_subscription() -> None:
    installed_monty = manifest_document("monty", "1.4.0", emits=["monty.recorded.v1"])
    installed_who = manifest_document("whodunnit", "1.0.0", subscribes=["monty.*"])

    proposal = target_set(
        moving(installed_monty, manifest_document("monty", "2.0.0")),
        staying(installed_who),
    )

    violations = evaluate_target_set(
        proposal,
        installed={
            "monty": manifest(installed_monty),
            "whodunnit": manifest(installed_who),
        },
        config=config_with(),
        resolve_lock=FakeLocks(),
    )

    assert rules_broken(violations) == [ConsistencyRule.EVENT_KINDS]


def test_rule_3_is_silent_about_a_subscription_nobody_ever_served() -> None:
    # A quiet inbox is not something an update broke. Only `requires` is a hard dependency.
    who = manifest_document("whodunnit", "1.0.0", subscribes=["monty.recorded.v1"])
    installed_who = manifest_document("whodunnit", "0.9.0", subscribes=["monty.recorded.v1"])

    violations = evaluate_target_set(
        target_set(moving(installed_who, who)),
        installed={"whodunnit": manifest(installed_who)},
        config=config_with(),
        resolve_lock=FakeLocks(),
    )

    assert violations == ()


def test_rule_3_accepts_a_kind_another_plugin_still_emits() -> None:
    monty = manifest_document("monty", "1.4.0", emits=["monty.recorded.v1"])
    who = manifest_document("whodunnit", "1.0.0", subscribes=["monty.recorded.v1"])

    proposal = target_set(
        # A new monty that keeps emitting the kind is no disappearance at all.
        moving(monty, manifest_document("monty", "2.0.0", emits=["monty.recorded.v1"])),
        staying(who),
    )

    violations = evaluate_target_set(
        proposal,
        installed={"monty": manifest(monty), "whodunnit": manifest(who)},
        config=config_with(),
        resolve_lock=FakeLocks(),
    )

    assert violations == ()


# --------------------------------------------------------------------------------------
# Rule 4 — no pinned, manual or off plugin changes
# --------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("config", "expected"),
    [
        (
            config_with(overrides=[PluginOverride(id="monty", pinned=True)]),
            "monty is pinned",
        ),
        (
            config_with(overrides=[PluginOverride(id="monty", update_mode=UpdateMode.MANUAL)]),
            "monty is in manual mode",
        ),
        (
            config_with(overrides=[PluginOverride(id="monty", update_mode=UpdateMode.OFF)]),
            "monty is in off mode",
        ),
    ],
    ids=["pinned", "manual", "off"],
)
def test_rule_4_rejects_a_set_that_moves_a_held_plugin(config: HelperConfig, expected: str) -> None:
    installed_monty = manifest_document("monty", "1.4.0")
    proposal = target_set(moving(installed_monty, manifest_document("monty", "2.0.0")))

    violations = evaluate_target_set(
        proposal,
        installed={"monty": manifest(installed_monty)},
        config=config,
        resolve_lock=FakeLocks(),
    )

    assert rules_broken(violations) == [ConsistencyRule.MODE_OR_PIN]
    assert violations[0].implicated == ("monty",)
    assert expected in violations[0].reason


def test_rule_4_holds_a_pinned_plugin_even_when_its_mode_is_auto() -> None:
    # A pin is stronger than a mode: "whatever its update mode says" (plan 0003).
    installed_monty = manifest_document("monty", "1.4.0")
    config = config_with(
        overrides=[PluginOverride(id="monty", update_mode=UpdateMode.AUTO, pinned=True)]
    )

    violations = evaluate_target_set(
        target_set(moving(installed_monty, manifest_document("monty", "2.0.0"))),
        installed={"monty": manifest(installed_monty)},
        config=config,
        resolve_lock=FakeLocks(),
    )

    assert rules_broken(violations) == [ConsistencyRule.MODE_OR_PIN]
    assert "pinned" in violations[0].reason


def test_a_whole_group_is_blocked_when_one_of_it_is_manual(tmp_path: Path) -> None:
    install(
        tmp_path,
        manifest_document("monty", "1.4.0", requires=["whodunnit==1.0.0"], source="index"),
    )
    install(tmp_path, manifest_document("whodunnit", "1.0.0", source="index"))

    web = FakeWeb()
    web.serve(
        f"{INDEX_URL}/monty.json",
        {
            "versions": [
                {
                    "manifest": manifest_document(
                        "monty", "2.0.0", requires=["whodunnit==2.0.0"], source="index"
                    )
                }
            ]
        },
    )
    web.serve(
        f"{INDEX_URL}/whodunnit.json",
        {"versions": [{"manifest": manifest_document("whodunnit", "2.0.0", source="index")}]},
    )

    checker = VersionChecker(
        settings=settings_file(
            tmp_path / "config.toml", default_mode="auto", modes={"whodunnit": "manual"}
        ),
        resolve_lock=FakeLocks(),
        transport=web.transport,
        plugin_index_url=INDEX_URL,
    )
    check = checker.check(discover_addons(tmp_path).installed)

    # monty 2.0.0 needs whodunnit 2.0.0, and whodunnit is the user's to move. So nothing
    # moves — and both lines say so, with the rule.
    assert check.target.versions == {"monty": "1.4.0", "whodunnit": "1.0.0"}
    assert check.available == ()

    who = check.report_for("whodunnit")
    assert who is not None
    assert who.state is PluginState.BLOCKED
    assert who.newest_version == "2.0.0"
    assert who.rule is ConsistencyRule.MODE_OR_PIN
    assert "innytypes addons update whodunnit" in str(who.reason)

    monty = check.report_for("monty")
    assert monty is not None
    assert monty.state is PluginState.BLOCKED
    assert monty.rule is ConsistencyRule.REQUIRES


# --------------------------------------------------------------------------------------
# Rule 5 — every changed environment resolves to a fully pinned, hashed lock
# --------------------------------------------------------------------------------------


def test_rule_5_rejects_a_lock_with_an_unpinned_transitive_dependency() -> None:
    installed_monty = manifest_document("monty", "1.4.0")
    locks = FakeLocks(
        texts={
            "monty==2.0.0": "\n".join(
                [
                    pin("innytypes", __version__),
                    pin("monty", "2.0.0"),
                    # The deliberate defect: a transitive dependency at a range.
                    "httpx>=0.28 --hash=" + digest("httpx"),
                ]
            )
            + "\n"
        }
    )

    violations = evaluate_target_set(
        target_set(moving(installed_monty, manifest_document("monty", "2.0.0"))),
        installed={"monty": manifest(installed_monty)},
        config=config_with(),
        resolve_lock=locks,
    )

    assert rules_broken(violations) == [ConsistencyRule.LOCK]
    assert "is not an exact pin" in violations[0].reason


def test_rule_5_rejects_a_lock_with_an_unhashed_dependency() -> None:
    installed_monty = manifest_document("monty", "1.4.0")
    locks = FakeLocks(
        texts={
            "monty==2.0.0": "\n".join(
                [pin("innytypes", __version__), pin("monty", "2.0.0"), "httpx==0.28.1"]
            )
            + "\n"
        }
    )

    violations = evaluate_target_set(
        target_set(moving(installed_monty, manifest_document("monty", "2.0.0"))),
        installed={"monty": manifest(installed_monty)},
        config=config_with(),
        resolve_lock=locks,
    )

    assert rules_broken(violations) == [ConsistencyRule.LOCK]
    assert "locked with no hash" in violations[0].reason


def test_rule_5_rejects_a_lock_without_this_hosts_own_innytypes() -> None:
    installed_monty = manifest_document("monty", "1.4.0")
    locks = FakeLocks(
        texts={"monty==2.0.0": "\n".join([pin("innytypes", "0.0.1"), pin("monty", "2.0.0")]) + "\n"}
    )

    violations = evaluate_target_set(
        target_set(moving(installed_monty, manifest_document("monty", "2.0.0"))),
        installed={"monty": manifest(installed_monty)},
        config=config_with(),
        resolve_lock=locks,
    )

    assert rules_broken(violations) == [ConsistencyRule.LOCK]
    assert "not a lock of what was asked for" in violations[0].reason


def test_rule_5_rejects_a_git_lock_pinned_to_a_different_commit() -> None:
    installed_monty = manifest_document("monty", "1.4.0")
    new = manifest(manifest_document("monty", "2.0.0"))
    candidate = Candidate(
        plugin_id="monty",
        manifest=new,
        source=GitSource(url=REPOSITORY_URL),
        reference=COMMIT_ONE,
    )
    proposal = target_set(TargetPlugin(id="monty", manifest=new, candidate=candidate))

    locks = FakeLocks(
        texts={
            candidate.requirement_text(): "\n".join(
                [
                    pin("innytypes", __version__),
                    # A lock of the same repository at the wrong commit is a lock of
                    # something nobody asked for.
                    f"monty @ git+{REPOSITORY_URL}@{COMMIT_TWO}",
                ]
            )
            + "\n"
        }
    )

    violations = evaluate_target_set(
        proposal,
        installed={"monty": manifest(installed_monty)},
        config=config_with(),
        resolve_lock=locks,
    )

    assert rules_broken(violations) == [ConsistencyRule.LOCK]
    assert COMMIT_TWO in violations[0].reason


def test_rule_5_is_not_asked_when_a_cheaper_rule_already_refused() -> None:
    installed_monty = manifest_document("monty", "1.4.0")
    locks = FakeLocks()

    evaluate_target_set(
        target_set(moving(installed_monty, manifest_document("monty", "2.0.0"))),
        installed={"monty": manifest(installed_monty)},
        config=config_with(default_mode=UpdateMode.MANUAL),
        resolve_lock=locks,
    )

    # Resolving a lock is the only thing here that shells out. A set already refused by rule
    # 4 must not pay for it.
    assert locks.asked == []


def test_a_resolver_that_fails_is_a_rule_5_refusal() -> None:
    installed_monty = manifest_document("monty", "1.4.0")

    def explode(candidate: Candidate) -> str:
        raise VersionCheckError(f"{candidate.plugin_id} could not be resolved: uv said no")

    violations = evaluate_target_set(
        target_set(moving(installed_monty, manifest_document("monty", "2.0.0"))),
        installed={"monty": manifest(installed_monty)},
        config=config_with(),
        resolve_lock=explode,
    )

    assert rules_broken(violations) == [ConsistencyRule.LOCK]
    assert "uv said no" in violations[0].reason


def test_a_set_nothing_can_step_out_of_moves_nothing(tmp_path: Path) -> None:
    # The only candidate breaks rule 5, and stepping down leaves no candidate at all, so the
    # check ends with the installed version and the reason recorded.
    install(tmp_path, manifest_document("monty", "1.4.0", source="index"))

    web = FakeWeb()
    web.serve(
        f"{INDEX_URL}/monty.json",
        {"versions": [{"manifest": manifest_document("monty", "2.0.0", source="index")}]},
    )
    locks = FakeLocks(texts={"monty==2.0.0": "monty>=2\n"})
    checker = VersionChecker(
        settings=settings_file(tmp_path / "config.toml"),
        resolve_lock=locks,
        transport=web.transport,
        plugin_index_url=INDEX_URL,
    )

    check = checker.check(discover_addons(tmp_path).installed)
    report = check.report_for("monty")

    assert check.target.versions == {"monty": "1.4.0"}
    assert report is not None
    assert report.state is PluginState.BLOCKED
    assert report.rule is ConsistencyRule.LOCK
    assert check.blocked == (report,)


# --------------------------------------------------------------------------------------
# `innytypes addons outdated`
# --------------------------------------------------------------------------------------


def run_outdated(root: Path, checker: VersionChecker, config: Path) -> Result:
    """Invoke the real command, with the checker injected and no network behind it."""
    return CliRunner().invoke(
        cli,
        ["addons", "--config", str(config), "outdated"],
        obj=CliContext(addons_root=root, make_checker=lambda _settings: checker),
    )


def test_outdated_prints_installed_newest_and_the_rule_that_blocks_it(tmp_path: Path) -> None:
    root = tmp_path / "addons"
    install(root, manifest_document("monty", "1.4.0", source="index"))
    install(root, manifest_document("whodunnit", "1.0.0"))

    web = FakeWeb()
    web.serve(
        f"{INDEX_URL}/monty.json",
        {
            "versions": [
                {
                    "manifest": manifest_document(
                        "monty", "3.0.0", host_api=HOST_API_VERSION + 1, source="index"
                    )
                }
            ]
        },
    )
    config = tmp_path / "config.toml"
    checker = VersionChecker(
        settings=settings_file(config),
        resolve_lock=FakeLocks(),
        transport=web.transport,
        plugin_index_url=INDEX_URL,
    )

    result = run_outdated(root, checker, config)

    assert result.exit_code == 0, result.output
    assert "monty  1.4.0" in result.output
    assert "newest published: 3.0.0" in result.output
    assert "blocked by rule 1 (host API support)" in result.output
    assert "does not implement" in result.output
    assert "whodunnit  1.0.0  not updatable" in result.output


def test_outdated_prints_the_move_it_would_make(tmp_path: Path) -> None:
    root = tmp_path / "addons"
    install(root, manifest_document("monty", "1.4.0", source="index"))

    web = FakeWeb()
    web.serve(
        f"{INDEX_URL}/monty.json",
        {"versions": [{"manifest": manifest_document("monty", "2.0.0", source="index")}]},
    )
    config = tmp_path / "config.toml"
    checker = VersionChecker(
        settings=settings_file(config),
        resolve_lock=FakeLocks(),
        transport=web.transport,
        plugin_index_url=INDEX_URL,
    )

    result = run_outdated(root, checker, config)

    assert "monty  1.4.0 -> 2.0.0" in result.output
    assert "blocked by" not in result.output


def test_outdated_says_when_the_switch_is_off(tmp_path: Path) -> None:
    root = tmp_path / "addons"
    install(root, manifest_document("monty", "1.4.0", source="index"))

    config = tmp_path / "config.toml"
    web = FakeWeb()
    checker = VersionChecker(
        settings=settings_file(config, auto_check_versions=False),
        resolve_lock=FakeLocks(),
        transport=web.transport,
        plugin_index_url=INDEX_URL,
    )

    result = run_outdated(root, checker, config)

    assert "auto_check_versions is off: no source was asked" in result.output
    assert web.requests == []


def test_outdated_lists_a_broken_addon_and_says_nothing_when_none_are_installed(
    tmp_path: Path,
) -> None:
    root = tmp_path / "addons"
    (root / "wrecked").mkdir(parents=True)
    recorded_manifest_path(root, "wrecked").write_text("{ not json", encoding="utf-8")

    config = tmp_path / "config.toml"
    checker = VersionChecker(
        settings=settings_file(config), resolve_lock=FakeLocks(), transport=FakeWeb().transport
    )

    assert "wrecked  -  broken:" in run_outdated(root, checker, config).output
    assert "No addons installed." in run_outdated(tmp_path / "empty", checker, config).output


def test_outdated_reports_a_broken_config_file_without_a_traceback(tmp_path: Path) -> None:
    root = tmp_path / "addons"
    install(root, manifest_document("monty", "1.4.0", source="index"))

    config = tmp_path / "config.toml"
    config.write_text("auto_check_versions = 'yes please'\n", encoding="utf-8")
    checker = VersionChecker(
        settings=HelperSettings(path=config),
        resolve_lock=FakeLocks(),
        transport=FakeWeb().transport,
    )

    result = run_outdated(root, checker, config)

    assert result.exit_code == 1
    assert "auto_check_versions" in result.output


# --------------------------------------------------------------------------------------
# Small pieces: sources, ordering, the production lock resolver
# --------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("index", PluginIndexSource(name="monty")),
        ("index:monty-nightly", PluginIndexSource(name="monty-nightly")),
        ("pypi:monty-addon", PackageIndexSource(project="monty-addon")),
        (f"git+{REPOSITORY_URL}", GitSource(url=REPOSITORY_URL)),
    ],
)
def test_every_source_spelling_reads_as_itself(text: str, expected: object) -> None:
    assert parse_source(text, plugin_id="monty") == expected
    # Every source says what it is in words, because a refusal quotes it back at a person.
    assert str(parse_source(text, plugin_id="monty"))


@pytest.mark.parametrize(
    ("text", "refusal"),
    [
        ("git+", "with no URL after it"),
        ("pypi:", "with no project after it"),
        ("index:", "with no name after it"),
        ("https://forge.example.invalid/monty.git", "names no source kind"),
        ("", "names no source kind"),
    ],
)
def test_a_source_the_helper_cannot_read_is_refused_by_name(text: str, refusal: str) -> None:
    with pytest.raises(VersionCheckError, match=refusal):
        parse_source(text, plugin_id="monty")


def test_a_source_that_is_not_a_known_kind_fails_only_that_plugin(tmp_path: Path) -> None:
    install(tmp_path, manifest_document("monty", "1.4.0", source="carrier-pigeon"))

    web = FakeWeb()
    checker = VersionChecker(
        settings=settings_file(tmp_path / "config.toml"),
        resolve_lock=FakeLocks(),
        transport=web.transport,
    )
    report = checker.check(discover_addons(tmp_path).installed).report_for("monty")

    assert report is not None and report.state is PluginState.SOURCE_FAILED
    assert web.requests == []


def test_versions_order_by_their_numbers_and_prereleases_sort_first() -> None:
    ordered = sorted(["2.0.0", "1.10.0", "1.9.0", "2.0.0rc1", "1.9.0-beta.1"], key=version_key)

    assert ordered == ["1.9.0-beta.1", "1.9.0", "1.10.0", "2.0.0rc1", "2.0.0"]
    assert is_prerelease("2.0.0rc1")
    assert not is_prerelease("2.0.0")


def test_the_production_lock_resolver_asks_uv_for_a_hashed_lock() -> None:
    argvs: list[list[str]] = []

    def runner(argv: Sequence[str]) -> str:
        argvs.append(list(argv))
        return "locked"

    candidate = Candidate(
        plugin_id="monty",
        manifest=manifest(manifest_document("monty", "2.0.0")),
        source=GitSource(url=REPOSITORY_URL),
        reference=COMMIT_ONE,
    )

    assert UvLockResolver(run=runner)(candidate) == "locked"

    argv = argvs[0]
    assert argv[:4] == ["uv", "pip", "compile", "--generate-hashes"]
    written = Path(argv[-1])
    # The temporary requirements file is gone by now; what it held is what matters, and it
    # is asserted through the one thing that outlives it — nothing was left behind.
    assert not written.exists()


def test_the_production_lock_resolver_turns_a_uv_failure_into_one_refusal() -> None:
    def runner(argv: Sequence[str]) -> str:
        raise RuntimeError("uv is not installed")

    candidate = Candidate(
        plugin_id="monty",
        manifest=manifest(manifest_document("monty", "2.0.0")),
        source=PluginIndexSource(name="monty"),
        reference="2.0.0",
    )

    with pytest.raises(VersionCheckError, match="could not be resolved"):
        UvLockResolver(run=runner)(candidate)


def test_a_candidate_names_what_the_installer_is_asked_for() -> None:
    from_index = Candidate(
        plugin_id="monty",
        manifest=manifest(manifest_document("monty", "2.0.0")),
        source=PluginIndexSource(name="monty"),
        reference="2.0.0",
    )
    from_git = Candidate(
        plugin_id="monty",
        manifest=manifest(manifest_document("monty", "2.0.0")),
        source=GitSource(url=REPOSITORY_URL),
        reference=COMMIT_ONE,
    )

    assert from_index.requirement_text() == "monty==2.0.0"
    assert from_index.version == "2.0.0"
    assert from_git.requirement_text() == f"monty @ git+{REPOSITORY_URL}@{COMMIT_ONE}"


def test_a_rejected_offer_carries_the_rule_that_rejected_it() -> None:
    offer = RejectedOffer(
        version="3.0.0", rule=ConsistencyRule.HOST_API, reason="needs a newer host"
    )

    assert offer.rule.number == 1
    assert offer.rule.summary == "host API support"
    assert str(offer.rule) == "rule 1 (host API support)"


def test_nothing_moves_when_a_broken_rule_names_nothing_that_can_step_back(
    tmp_path: Path,
) -> None:
    """A set nobody can repair by stepping down is reverted whole, not applied in part.

    Built by handing the checker an :class:`InstalledAddon` directly, because this is the
    shape of an installed set that only a *host downgrade* can produce: a plugin already on
    disk that this host no longer supports. Rule 1 then names a plugin that is not moving, so
    there is nothing to step down and the only honest answer is to move nothing at all.
    """
    from innytypes.addons.discovery import InstalledAddon

    root = tmp_path / "addons"
    install(root, manifest_document("monty", "1.4.0", source="index"))

    stranded = InstalledAddon(
        id="ghost",
        manifest=AddonManifest(
            id="ghost",
            version="1.0.0",
            host_api=HOST_API_VERSION + 1,
            requires=(),
            emits=(),
            subscribes=(),
        ),
        root=root / "ghost",
        environment=root / "ghost" / "env",
        manifest_path=root / "ghost" / "manifest.json",
    )

    web = FakeWeb()
    web.serve(
        f"{INDEX_URL}/monty.json",
        {"versions": [{"manifest": manifest_document("monty", "2.0.0", source="index")}]},
    )
    checker = VersionChecker(
        settings=settings_file(tmp_path / "config.toml"),
        resolve_lock=FakeLocks(),
        transport=web.transport,
        plugin_index_url=INDEX_URL,
    )

    check = checker.check([*discover_addons(root).installed, stranded])

    assert check.target.versions == {"ghost": "1.0.0", "monty": "1.4.0"}
    monty = check.report_for("monty")
    assert monty is not None
    assert monty.state is PluginState.BLOCKED
    assert monty.rule is ConsistencyRule.HOST_API
    assert "ghost 1.0.0" in str(monty.reason)
    # A plugin the check never heard of gets no line invented for it.
    assert check.report_for("nobody") is None


def test_a_target_set_answers_about_a_plugin_it_does_not_hold() -> None:
    held = staying(manifest_document("monty", "1.4.0"))
    proposal = target_set(held)

    assert proposal.get("monty") is held
    assert proposal.get("ghost") is None
    assert proposal.changed == ()


# --------------------------------------------------------------------------------------
# The lock's git reference (`innytypes.addons.lock`)
# --------------------------------------------------------------------------------------


def test_a_git_reference_is_locked_by_its_commit_hash() -> None:
    lock = parse_lock(
        f"{pin('innytypes', __version__)}\nmonty @ git+{REPOSITORY_URL}@{COMMIT_ONE}\n"
    )

    assert lock.git_requirements == (
        LockedGitRequirement(name="monty", url=REPOSITORY_URL, commit=COMMIT_ONE),
    )
    assert lock.find_git("Monty") is not None
    assert lock.find_git("ghost") is None
    # Re-emitting and re-parsing is the same lock: what gets installed is what was judged.
    assert parse_lock(lock.text()) == lock


@pytest.mark.parametrize(
    "reference",
    [
        f"monty @ git+{REPOSITORY_URL}@main",
        f"monty @ git+{REPOSITORY_URL}@v2.0.0",
        f"monty @ git+{REPOSITORY_URL}@{COMMIT_ONE[:7]}",
        f"monty @ git+{REPOSITORY_URL}",
    ],
)
def test_a_git_reference_that_is_not_a_commit_is_refused(reference: str) -> None:
    with pytest.raises(LockError, match="not pinned to a commit"):
        parse_lock(reference + "\n")


def test_a_git_reference_carrying_a_hash_option_is_refused() -> None:
    with pytest.raises(LockError, match="there is no artifact to hash separately"):
        parse_lock(f"monty @ git+{REPOSITORY_URL}@{COMMIT_ONE} --hash={digest('x')}\n")


def test_must_pin_insists_on_the_commit_that_was_asked_for() -> None:
    lock = parse_lock(f"monty @ git+{REPOSITORY_URL}@{COMMIT_ONE}\n")

    lock.must_pin("monty", commit=COMMIT_ONE)

    with pytest.raises(LockError, match="but " + COMMIT_TWO):
        lock.must_pin("monty", commit=COMMIT_TWO)
    with pytest.raises(LockError, match="does not take ghost from git"):
        lock.must_pin("ghost", commit=COMMIT_ONE)


# --------------------------------------------------------------------------------------
# Manifest pieces these tests lean on, asserted once so a change to them is not silent
# --------------------------------------------------------------------------------------


def test_the_manifests_these_tests_build_say_what_they_look_like() -> None:
    parsed = manifest(
        manifest_document(
            "monty",
            "1.4.0",
            requires=["whodunnit==1.0.0"],
            emits=["monty.recorded.v1"],
            subscribes=["whodunnit.*"],
            source="index",
            channel="beta",
        )
    )

    assert parsed.requires == (Requirement(addon_id="whodunnit", version="1.0.0"),)
    assert parsed.emits == (EventKind(addon_id="monty", name="recorded", version=1),)
    assert parsed.subscribes == (KindPrefix(prefix="whodunnit"),)
    assert parsed.update is not None
    assert (parsed.update.source, parsed.update.channel) == ("index", "beta")


def test_a_lock_resolver_is_only_ever_a_callable() -> None:
    # The seam is a plain callable, which is what lets the gate replace it with a dictionary.
    resolver: Callable[[Candidate], str] = FakeLocks()
    candidate = Candidate(
        plugin_id="monty",
        manifest=manifest(manifest_document("monty", "2.0.0")),
        source=PluginIndexSource(name="monty"),
        reference="2.0.0",
    )

    assert pin("monty", "2.0.0") in resolver(candidate)
