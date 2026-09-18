"""The core update check and the verified download — everything before anything is applied.

This is step 1 and step 2 of plan 0003's *update flow*: fetch the release index, work out
whether there is anything newer, download it to staging, and **verify it**. Step 3 is the
last line of this module — a verified release sitting in staging with a ready marker next to
it. Applying that release, and rolling it back when the new host does not come up healthy, is
slice 10 and is deliberately not here.

**What this module will not do, stated first.** It downloads code that the machine will later
execute, so the interesting property is not what it accomplishes but what it refuses:

* An artifact whose SHA-256 does not match the index is **deleted** and reported.
* An artifact whose minisign signature does not verify against the public key shipped inside
  the **currently installed** release is **deleted** and reported, even when its checksum was
  perfect.
* An artifact that keeps arriving past its declared size is **deleted** and reported.
* Anything that fails for any other reason — a dropped connection, a disk error — takes its
  whole staging directory with it.

There is exactly one way for bytes to survive this module, and it runs after both checks pass.
Plan 0003 says it in five words: *"It is never run and never kept."*

**The signature is the trust anchor; the checksum is not.** D10 makes the hosting
interchangeable — Hetzner, Scaleway, a self-hosted Forgejo, GitHub Releases, any of them
behind a CDN — because *the signature* is what is trusted, never the server. The release index
is fetched over HTTPS but is **not** signed, so every number in it, the checksum included, is
attacker-controlled in the threat model this module is written against. The checksum is
therefore a cheap early stop for a corrupted download and nothing more; substituting an
artifact means producing a signature for it, and that needs the private key.

**Why forward-only is a security rule and not a convenience.** An unsigned index invites the
other classic attack: serve a *genuine, correctly signed* older release with a known hole in
it. Comparing against the running version and moving only forward (plan 0003, step 1) is what
makes that useless, which is why :func:`choose_candidate` refuses an equal or older version
rather than treating it as a no-op.

**Why a new host API major version never applies itself.** D13. Addons target the host API, so
a host that moves the API major can stop an installed addon from starting. Such a release is
still checked, still downloaded and still verified — it is only ever *staged* with
``automatic`` false, and the marker slice 10 reads carries that flag, so the explicit
``innytypes update apply`` stays the only way in.

**Every seam is injected, so the gate never touches the network.** The HTTP client, the
staging directory, the public key, the clock and the platform name are all parameters. The
tests drive the whole flow through :class:`httpx.MockTransport` with a key pair generated
inside the test, which is the same arrangement
:mod:`innytypes.anytype_mcp.health` and :mod:`innytypes.anytype_mcp.refresh` already use
(docs/loop/SKILL.md, "the gate is hermetic").
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import shutil
import sys
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import httpx

from innytypes import HOST_API_VERSION, __version__
from innytypes.anytype_mcp.logs import get_logger
from innytypes.helper.config import HelperSettings
from innytypes.helper.minisign import (
    MinisignError,
    MinisignPublicKey,
    parse_public_key,
    parse_signature,
    verify_file,
)

log = get_logger(__name__)

__all__ = [
    "MAX_ARTIFACT_BYTES",
    "PUBLIC_KEY_FILENAME",
    "READY_MARKER",
    "RELEASE_INDEX_URL",
    "Release",
    "ReleaseArtifact",
    "ReleaseIndex",
    "ReleaseIndexError",
    "ReleaseRejected",
    "StagedRelease",
    "UpdateCandidate",
    "UpdateError",
    "Version",
    "check_and_stage",
    "check_for_update",
    "choose_candidate",
    "current_platform",
    "download_and_verify",
    "fetch_release_index",
    "load_installed_public_key",
    "parse_release_index",
    "parse_version",
]

# Where the release index for a channel lives. This is a **build-time setting of each
# release** (D10): a bundle is built pointing at whatever host that bundle's releases are
# published from, and moving hosts is a rebuild, never a runtime surprise. It is a default
# argument everywhere below rather than a module-level read, so a test never has to patch it.
RELEASE_INDEX_URL = "https://releases.innytypes.app/{channel}/index.json"

# The minisign public key shipped **inside the currently installed release**, next to this
# module. Plan 0003 step 2 is precise about which key is trusted: the one that came with the
# software already running, never one fetched alongside the update it is meant to check.
PUBLIC_KEY_FILENAME = "release-key.pub"

# The marker that makes a staged release ready. It is written last, after both checks pass,
# so its presence — and nothing else — is what slice 10 may act on.
READY_MARKER = "ready.json"

# The ceiling on a download that does not declare its own size. A release bundle is tens of
# megabytes; this is large enough never to be hit by a real one and small enough that a server
# streaming forever fills a log line instead of a disk.
MAX_ARTIFACT_BYTES = 512 * 1024 * 1024

# How much of the response is held in memory at a time while it is hashed and written.
_DOWNLOAD_CHUNK_BYTES = 1024 * 1024

# How many redirects a release host may use before this is treated as a loop. GitHub Releases
# redirects to object storage, so redirects must work; an unbounded chain must not.
_MAX_REDIRECTS = 5

# A release version, exactly three numbers. Deliberately narrower than PEP 440: this string
# becomes a directory name and an ordering, and both want a total order with no surprises.
_VERSION = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")

# What an artifact file may be called. The name is taken from the download URL, which comes
# from an unsigned index, so it is **untrusted input used to build a path**: anything outside
# this pattern — a slash, a leading dot, `..` — is refused before it can point at a file
# outside the staging directory.
_ARTIFACT_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")

# A SHA-256 checksum as the index must spell it.
_SHA256 = re.compile(r"^[0-9a-f]{64}$")

# The OS names an index uses for its per-OS download URLs, and how this interpreter maps onto
# them. An unknown platform is an error rather than a guess: downloading the wrong OS's bundle
# would pass every check in this module and fail only once it was running.
_PLATFORMS = {"darwin": "macos", "win32": "windows", "linux": "linux"}


class UpdateError(RuntimeError):
    """The base of everything this module refuses. Catch this to report and carry on."""


class ReleaseIndexError(UpdateError):
    """The release index could not be fetched, or could not be understood.

    Strict on purpose. An index this build cannot parse is a fact worth reporting, not a
    reason to fall back on the entries it happened to understand — a parser that skips what
    it dislikes is a parser an attacker can steer by feeding it something unparseable.
    """


class ReleaseRejected(UpdateError):
    """A downloaded artifact failed verification, was deleted, and is reported here.

    ``reason`` is one of ``checksum``, ``signature`` or ``oversized``. It exists for the
    report the user sees, never for a decision: every reason has already had the same
    consequence by the time this is raised, which is that the staging directory is gone.
    """

    def __init__(self, *, version: str, reason: str, detail: str) -> None:
        super().__init__(f"release {version} failed its {reason} check and was deleted: {detail}")
        self.version = version
        self.reason = reason
        self.detail = detail


@dataclass(frozen=True, order=True)
class Version:
    """A release version: three numbers, ordered the obvious way."""

    major: int
    minor: int
    patch: int

    def __str__(self) -> str:
        return f"{self.major}.{self.minor}.{self.patch}"


@dataclass(frozen=True)
class ReleaseArtifact:
    """One OS's download for one release: where it is, what it hashes to, and who signed it."""

    url: str
    filename: str
    sha256: str
    signature: str
    size: int | None = None


@dataclass(frozen=True)
class Release:
    """One entry of the release index."""

    version: Version
    host_api: int
    artifacts: Mapping[str, ReleaseArtifact]


@dataclass(frozen=True)
class ReleaseIndex:
    """One channel's index, as fetched."""

    channel: str
    releases: tuple[Release, ...]


@dataclass(frozen=True)
class UpdateCandidate:
    """A release worth downloading, and whether it may ever be applied without being asked.

    ``automatic`` false is **not** a refusal to download. The release is fetched, verified and
    staged like any other; what it may not do is apply itself (D13). ``blocked_reason`` is the
    sentence the user is shown next to the waiting update.
    """

    release: Release
    artifact: ReleaseArtifact
    platform: str
    automatic: bool
    blocked_reason: str


@dataclass(frozen=True)
class StagedRelease:
    """A release that passed both checks and is sitting in staging, marked ready."""

    version: Version
    directory: Path
    artifact_path: Path
    marker_path: Path
    automatic: bool


def current_platform(platform: str | None = None) -> str:
    """The index's OS name for this interpreter, refusing an OS this build has no name for."""
    key = sys.platform if platform is None else platform
    try:
        return _PLATFORMS[key]
    except KeyError:
        raise UpdateError(
            f"no release artifacts are published for platform {key!r}; expected one of "
            f"{', '.join(sorted(_PLATFORMS))}"
        ) from None


def parse_version(text: str, *, where: str) -> Version:
    """``MAJOR.MINOR.PATCH`` and nothing else, so two versions always compare."""
    match = _VERSION.match(text.strip())
    if match is None:
        raise UpdateError(f"{where}: {text!r} is not a MAJOR.MINOR.PATCH version")
    major, minor, patch = (int(part) for part in match.groups())
    return Version(major, minor, patch)


def load_installed_public_key(path: Path | None = None) -> MinisignPublicKey:
    """The release signing key shipped inside the running release.

    A build with no key file **cannot update itself**, and that is the intended behaviour
    rather than a gap to paper over: the alternative to "refuse every update" is "accept an
    update nobody signed". Shipping a placeholder key would be worse still, because it would
    look like a trust anchor while anchoring nothing.
    """
    file = Path(__file__).parent / PUBLIC_KEY_FILENAME if path is None else path
    try:
        text = file.read_text(encoding="utf-8")
    except OSError as error:
        raise UpdateError(
            f"this build ships no release signing key at {file}, so no update can be verified "
            "and none will be installed"
        ) from error
    return parse_public_key(text)


def parse_release_index(document: object, *, channel: str) -> ReleaseIndex:
    """Validate one channel's index, refusing anything it cannot account for."""
    if not isinstance(document, Mapping):
        raise ReleaseIndexError("the release index is not a JSON object")

    named = document.get("channel")
    if named != channel:
        raise ReleaseIndexError(
            f"the release index names channel {named!r}, but it was fetched as {channel!r}"
        )

    entries = document.get("releases")
    if not isinstance(entries, list):
        raise ReleaseIndexError("the release index has no `releases` list")

    releases = tuple(_release(entry, position=position) for position, entry in enumerate(entries))

    versions = [release.version for release in releases]
    if len(set(versions)) != len(versions):
        raise ReleaseIndexError("the release index lists the same version twice")

    return ReleaseIndex(channel=channel, releases=releases)


def fetch_release_index(
    client: httpx.Client,
    *,
    channel: str,
    url_template: str = RELEASE_INDEX_URL,
) -> ReleaseIndex:
    """Fetch and validate one channel's index over HTTPS.

    This is the unconditional fetch, used by the manual ``innytypes update check``, which plan
    0003 says keeps working when ``auto_check_versions`` is off. The **scheduled** check is
    :func:`check_for_update`, and it is the one that consults the switch.
    """
    url = url_template.format(channel=channel)
    try:
        with _get(client, url) as response:
            document = json.loads(response.read())
    except httpx.HTTPError as error:
        raise ReleaseIndexError(f"could not fetch the release index at {url}: {error}") from error
    except json.JSONDecodeError as error:
        raise ReleaseIndexError(f"the release index at {url} is not valid JSON: {error}") from error

    return parse_release_index(document, channel=channel)


def choose_candidate(
    index: ReleaseIndex,
    *,
    current_version: Version,
    host_api_version: int = HOST_API_VERSION,
    platform: str | None = None,
    is_blocked: Callable[[str], bool] | None = None,
) -> UpdateCandidate | None:
    """The newest release worth downloading, or ``None`` when the running version is current.

    Forward-only (plan 0003, step 1): an entry equal to or older than what is running is never
    proposed, so an index that offers a genuine, correctly signed older build gets nowhere.

    ``is_blocked`` is the record of versions a rollback took away (slice 10,
    :class:`~innytypes.helper.swap.BlockedReleases`). A blocked version is dropped **before**
    the newest is chosen rather than after, so a bad newest release does not hide the good one
    underneath it: the user gets the best release that has not already failed on their machine,
    not nothing at all until the publisher ships another.
    """
    os_name = current_platform(platform)
    blocked = (lambda _version: False) if is_blocked is None else is_blocked

    newer = [
        release
        for release in index.releases
        if release.version > current_version
        and os_name in release.artifacts
        and not blocked(str(release.version))
    ]
    if not newer:
        return None

    release = max(newer, key=lambda candidate: candidate.version)

    # D13. The running host API is what installed addons were built against, so a release that
    # moves it waits for a person. Any difference counts, not only an increase: a release that
    # went *back* an API major would break an addon just as thoroughly.
    automatic = release.host_api == host_api_version
    blocked_reason = (
        ""
        if automatic
        else (
            f"release {release.version} targets host API {release.host_api} and this "
            f"installation runs host API {host_api_version}; run `innytypes update apply` to "
            "install it once every addon supports the new host API"
        )
    )

    return UpdateCandidate(
        release=release,
        artifact=release.artifacts[os_name],
        platform=os_name,
        automatic=automatic,
        blocked_reason=blocked_reason,
    )


def check_for_update(
    *,
    settings: HelperSettings,
    client: httpx.Client,
    url_template: str = RELEASE_INDEX_URL,
    current_version: str = __version__,
    host_api_version: int = HOST_API_VERSION,
    platform: str | None = None,
    is_blocked: Callable[[str], bool] | None = None,
) -> UpdateCandidate | None:
    """The scheduled check: read the switch, and only then touch the network.

    The switch is read **here**, immediately before the request, because
    :class:`~innytypes.helper.config.HelperSettings` re-reads `config.toml` on every access and
    plan 0003 wants a user who turns it off to be obeyed on the next tick, with no restart. When
    it is off the function returns ``None`` having made **no** request of any kind — D14 makes
    that true for plugin checks as well, which is why the switch is consulted before the URL is
    even formatted.
    """
    if not settings.auto_check_versions:
        log.debug("auto_check_versions is off: no version check will be made")
        return None

    channel = settings.current.update.channel
    index = fetch_release_index(client, channel=channel, url_template=url_template)
    return choose_candidate(
        index,
        current_version=parse_version(current_version, where="the running version"),
        host_api_version=host_api_version,
        platform=platform,
        is_blocked=is_blocked,
    )


def download_and_verify(
    candidate: UpdateCandidate,
    *,
    client: httpx.Client,
    staging: Path,
    public_key: MinisignPublicKey,
    now: Callable[[], datetime] = lambda: datetime.now(UTC),
    max_bytes: int = MAX_ARTIFACT_BYTES,
) -> StagedRelease:
    """Download one candidate into staging and verify it, or delete it and say why.

    On success the staging directory holds the artifact and :data:`READY_MARKER`, and **every
    other release in staging is removed**, so what is waiting to be applied is never ambiguous.
    On any failure the whole directory for this version is removed before the error is raised.
    """
    version = str(candidate.release.version)
    directory = staging / version

    # A previous attempt at this same version — failed, or superseded by a re-publish — is
    # cleared first. Verifying into a directory that already has something in it is how a
    # rejected artifact survives an update.
    _remove(directory)
    directory.mkdir(parents=True, exist_ok=True)

    staged = False
    try:
        artifact_path = directory / candidate.artifact.filename
        digest = _download(
            client,
            candidate.artifact,
            destination=artifact_path,
            version=version,
            max_bytes=max_bytes,
        )
        _check_sha256(candidate, digest=digest, version=version)
        _check_signature(
            candidate,
            artifact_path=artifact_path,
            public_key=public_key,
            version=version,
        )

        marker_path = directory / READY_MARKER
        marker_path.write_text(
            json.dumps(
                {
                    "version": version,
                    "host_api": candidate.release.host_api,
                    "platform": candidate.platform,
                    "artifact": candidate.artifact.filename,
                    "sha256": candidate.artifact.sha256,
                    # Carried so the **apply** can verify the signature again, against the
                    # same installed key, at the moment the bytes are about to be unpacked
                    # into the application directory (slice 10). Without it the only thing
                    # standing between staging and execution would be a checksum sitting in
                    # this same file, and anything able to rewrite one could rewrite both.
                    "signature": candidate.artifact.signature,
                    "automatic": candidate.automatic,
                    "blocked_reason": candidate.blocked_reason,
                    "staged_at": now().isoformat(),
                    "ready": True,
                },
                indent=2,
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )
        staged = True
    finally:
        # One place, so no failure path can forget it. An artifact that did not finish
        # verification is not allowed to outlive the attempt, whatever went wrong.
        if not staged:
            _remove(directory)

    _clear_staging(staging, keep=directory)
    log.info("release %s verified and staged in %s", version, directory)

    return StagedRelease(
        version=candidate.release.version,
        directory=directory,
        artifact_path=artifact_path,
        marker_path=marker_path,
        automatic=candidate.automatic,
    )


def check_and_stage(
    *,
    settings: HelperSettings,
    client: httpx.Client,
    staging: Path,
    public_key: MinisignPublicKey,
    url_template: str = RELEASE_INDEX_URL,
    current_version: str = __version__,
    host_api_version: int = HOST_API_VERSION,
    platform: str | None = None,
    is_blocked: Callable[[str], bool] | None = None,
    now: Callable[[], datetime] = lambda: datetime.now(UTC),
) -> StagedRelease | None:
    """One scheduled tick: check, and stage a verified release if there is one.

    Steps 1 to 3 of plan 0003's update flow and no further. Returns ``None`` when the switch is
    off or nothing newer exists; raises :class:`ReleaseRejected` when something newer existed
    and did not survive verification.
    """
    candidate = check_for_update(
        settings=settings,
        client=client,
        url_template=url_template,
        current_version=current_version,
        host_api_version=host_api_version,
        platform=platform,
        is_blocked=is_blocked,
    )
    if candidate is None:
        return None

    return download_and_verify(
        candidate,
        client=client,
        staging=staging,
        public_key=public_key,
        now=now,
    )


def _download(
    client: httpx.Client,
    artifact: ReleaseArtifact,
    *,
    destination: Path,
    version: str,
    max_bytes: int,
) -> str:
    """Stream the artifact to disk, hashing as it goes, and stop if it outgrows its size."""
    limit = max_bytes if artifact.size is None else min(artifact.size, max_bytes)
    digest = hashlib.sha256()
    written = 0

    try:
        with _get(client, artifact.url) as response, destination.open("wb") as handle:
            for chunk in response.iter_bytes(_DOWNLOAD_CHUNK_BYTES):
                written += len(chunk)
                if written > limit:
                    raise _reject(
                        version,
                        reason="oversized",
                        detail=f"the download passed {limit} bytes and was abandoned",
                    )
                digest.update(chunk)
                handle.write(chunk)
    except httpx.HTTPError as error:
        raise UpdateError(f"could not download release {version}: {error}") from error

    if artifact.size is not None and written != artifact.size:
        raise _reject(
            version,
            reason="checksum",
            detail=f"the download is {written} bytes, but the index declares {artifact.size}",
        )

    return digest.hexdigest()


def _check_sha256(candidate: UpdateCandidate, *, digest: str, version: str) -> None:
    """The cheap check: does the download match the number the index gave for it.

    ``compare_digest`` rather than ``==`` although a checksum is public. It costs nothing, and
    "this comparison is not on a secret" is the kind of judgement that stops being true when
    the code is copied somewhere else.
    """
    if not hmac.compare_digest(digest, candidate.artifact.sha256):
        raise _reject(
            version,
            reason="checksum",
            detail=f"expected SHA-256 {candidate.artifact.sha256}, got {digest}",
        )


def _check_signature(
    candidate: UpdateCandidate,
    *,
    artifact_path: Path,
    public_key: MinisignPublicKey,
    version: str,
) -> None:
    """The check that actually decides: is this artifact signed by the key this release ships."""
    try:
        signature = parse_signature(candidate.artifact.signature)
        verify_file(artifact_path, signature, public_key)
    except MinisignError as error:
        raise _reject(version, reason="signature", detail=str(error)) from error


def _reject(version: str, *, reason: str, detail: str) -> ReleaseRejected:
    """Build the rejection and report it. The deletion is the caller's ``finally``."""
    rejected = ReleaseRejected(version=version, reason=reason, detail=detail)
    log.error("%s", rejected)
    return rejected


@contextmanager
def _get(client: httpx.Client, url: str) -> Iterator[httpx.Response]:
    """GET over HTTPS, following redirects **only** to other HTTPS URLs.

    Redirects have to work — GitHub Releases answers with one, and D10 says GitHub Releases is
    a supported host. They are followed here rather than by httpx so that each hop's scheme is
    checked **before** the request is sent: letting the client follow a ``Location`` that drops
    to plain HTTP would put the request on the wire in the clear before anything could object.
    """
    target = _require_https(url)
    for _ in range(_MAX_REDIRECTS + 1):
        with client.stream("GET", target, follow_redirects=False) as response:
            if response.is_redirect:
                location = response.headers.get("location")
                if not location:
                    raise UpdateError(f"{target} answered with a redirect and no destination")
                target = _require_https(str(response.url.join(location)))
                continue

            response.raise_for_status()
            yield response
            return

    raise UpdateError(f"{url} redirected more than {_MAX_REDIRECTS} times")


def _require_https(url: str) -> str:
    """Refuse any URL that is not HTTPS, wherever it came from."""
    if httpx.URL(url).scheme != "https":
        raise UpdateError(f"refusing to fetch {url}: release downloads must use HTTPS")
    return url


def _release(entry: object, *, position: int) -> Release:
    """One `releases` entry, with every field it must carry."""
    where = f"release index entry {position}"
    if not isinstance(entry, Mapping):
        raise ReleaseIndexError(f"{where} is not a JSON object")

    version = parse_version(_string(entry, "version", where=where), where=where)
    host_api = entry.get("host_api")
    if not isinstance(host_api, int) or isinstance(host_api, bool) or host_api < 1:
        raise ReleaseIndexError(f"{where}: `host_api` must be a positive whole number")

    artifacts = entry.get("artifacts")
    if not isinstance(artifacts, Mapping) or not artifacts:
        raise ReleaseIndexError(f"{where}: `artifacts` must name at least one operating system")

    return Release(
        version=version,
        host_api=host_api,
        artifacts={
            str(os_name): _artifact(artifact, where=f"{where} ({os_name})")
            for os_name, artifact in artifacts.items()
        },
    )


def _artifact(entry: object, *, where: str) -> ReleaseArtifact:
    """One operating system's artifact, with the URL, checksum and signature all validated."""
    if not isinstance(entry, Mapping):
        raise ReleaseIndexError(f"{where} is not a JSON object")

    url = _require_https_in_index(_string(entry, "url", where=where), where=where)

    sha256 = _string(entry, "sha256", where=where)
    if _SHA256.match(sha256) is None:
        raise ReleaseIndexError(f"{where}: `sha256` is not 64 lowercase hexadecimal characters")

    size = entry.get("size")
    if size is not None and (not isinstance(size, int) or isinstance(size, bool) or size < 1):
        raise ReleaseIndexError(f"{where}: `size`, when present, must be a positive whole number")

    return ReleaseArtifact(
        url=url,
        filename=_filename(url, where=where),
        sha256=sha256,
        signature=_string(entry, "signature", where=where),
        size=size,
    )


def _filename(url: str, *, where: str) -> str:
    """The artifact's name on disk, taken from an untrusted URL and therefore checked.

    This name is joined onto the staging directory, so it is the one place index content
    becomes a filesystem path. Two things keep that safe, and both are deliberate:

    * The name is the URL's **last path segment**, so it can never contain a separator — a URL
      spelling ``../../bin/innytypes``, percent-encoded or not, yields ``innytypes`` and writes
      inside staging like everything else.
    * The pattern then refuses what is left: an empty name (a URL ending in ``/``), a name
      starting with ``.`` (``..``, or a hidden file a later listing would miss), a backslash,
      and control characters such as an embedded NUL.

    A download this module could not later find is a download it could not later delete, and
    "deleted on failure" is the whole contract of this file.
    """
    name = httpx.URL(url).path.rsplit("/", 1)[-1]
    if _ARTIFACT_NAME.match(name) is None:
        raise ReleaseIndexError(
            f"{where}: the download URL ends in {name!r}, which is not a usable file name"
        )
    return name


def _require_https_in_index(url: str, *, where: str) -> str:
    """The HTTPS rule again, phrased as an index defect because that is what it is here."""
    if httpx.URL(url).scheme != "https":
        raise ReleaseIndexError(f"{where}: `url` must be an HTTPS URL, got {url!r}")
    return url


def _string(entry: Mapping[str, object], key: str, *, where: str) -> str:
    """One required text field, refusing an absent or empty one by name."""
    value = entry.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ReleaseIndexError(f"{where}: `{key}` must be a non-empty string")
    return value


def _clear_staging(staging: Path, *, keep: Path) -> None:
    """Leave exactly one release in staging: the one just verified."""
    for child in staging.iterdir():
        if child != keep:
            _remove(child)


def _remove(path: Path) -> None:
    """Delete a file or a whole directory, saying nothing when it was not there."""
    if path.is_dir():
        shutil.rmtree(path)
    else:
        path.unlink(missing_ok=True)
