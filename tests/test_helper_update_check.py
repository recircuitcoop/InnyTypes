"""The core update check and the verified download: what is proposed, and what is destroyed.

Nothing here opens a socket, sleeps, or runs anything it downloaded. The release index and
every artifact are served by an :class:`httpx.MockTransport` that also **records every
request**, which is what lets the switch-off test assert the strongest form of its claim —
not "no update was proposed" but "no request was made". Staging is always under ``tmp_path``,
the clock is injected, and the signing key pair is generated inside the test that uses it, so
no private key is ever committed (docs/plans/0003-innytypes-helper.md).

The substance of this slice is refusal, so most of what follows breaks exactly one thing and
asserts three consequences: the artifact is **gone**, the failure is **reported**, and the
staging directory is left holding nothing that was not verified. Two failures are covered
separately and deliberately — a bad checksum, and a **good** checksum with a bad signature —
because a verifier that only checks the checksum passes the first test and is worthless.
"""

from __future__ import annotations

import base64
import hashlib
import json
import secrets
from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from textwrap import dedent

import httpx
import pytest
from nacl.signing import SigningKey

from innytypes.helper.config import HelperSettings
from innytypes.helper.minisign import (
    MinisignError,
    parse_public_key,
    parse_signature,
    verify_file,
)
from innytypes.helper.update import (
    READY_MARKER,
    ReleaseIndexError,
    ReleaseRejected,
    UpdateError,
    Version,
    check_and_stage,
    check_for_update,
    choose_candidate,
    current_platform,
    download_and_verify,
    fetch_release_index,
    load_installed_public_key,
    parse_release_index,
    parse_version,
)

# The index this suite serves, and the OS name every entry publishes. Fixed rather than
# derived from `sys.platform`, so the same assertions hold on every machine that runs the gate.
INDEX_URL = "https://releases.example.invalid/{channel}/index.json"
PLATFORM = "macos"

# What the installed release claims to be. Every "newer / same / older" assertion is relative
# to this, and it is a parameter rather than `innytypes.__version__` so bumping the package
# version can never quietly change what these tests mean.
INSTALLED = "1.2.3"
INSTALLED_HOST_API = 1

# A frozen moment, so the staged marker's timestamp is an assertion rather than a wildcard.
STAGED_AT = datetime(2026, 9, 18, 10, 30, tzinfo=UTC)


# --------------------------------------------------------------------------------------
# A throwaway minisign signer, generated per test. Never a committed private key.
# --------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Signer:
    """A minisign key pair that exists only for the duration of one test."""

    signing_key: SigningKey
    key_id: bytes

    @property
    def public_key_text(self) -> str:
        """The key as a `.pub` file: an untrusted comment line and the base64 line."""
        blob = b"Ed" + self.key_id + bytes(self.signing_key.verify_key)
        return (
            "untrusted comment: minisign public key (throwaway, generated in the test)\n"
            + base64.b64encode(blob).decode("ascii")
            + "\n"
        )

    def sign(
        self,
        content: bytes,
        *,
        prehashed: bool = True,
        trusted_comment: str = "timestamp:1758190000\tfile:innytypes.tar.gz",
        key_id: bytes | None = None,
        tampered_comment: str | None = None,
    ) -> str:
        """A detached minisign signature over ``content``, in either of minisign's two forms.

        ``key_id`` and ``tampered_comment`` exist so a test can produce a signature that is
        genuine in every respect except the one under test.
        """
        message = hashlib.blake2b(content, digest_size=64).digest() if prehashed else content
        algorithm = b"ED" if prehashed else b"Ed"
        signature = self.signing_key.sign(message).signature
        global_signature = self.signing_key.sign(
            signature + trusted_comment.encode("utf-8")
        ).signature

        announced = self.key_id if key_id is None else key_id
        shown = trusted_comment if tampered_comment is None else tampered_comment
        return (
            "untrusted comment: signature from a throwaway key\n"
            + base64.b64encode(algorithm + announced + signature).decode("ascii")
            + "\n"
            + f"trusted comment: {shown}\n"
            + base64.b64encode(global_signature).decode("ascii")
            + "\n"
        )


@pytest.fixture
def signer() -> Signer:
    """A fresh key pair per test. The private half never leaves this process."""
    return Signer(signing_key=SigningKey.generate(), key_id=secrets.token_bytes(8))


# --------------------------------------------------------------------------------------
# The release host, served in-process and recorded
# --------------------------------------------------------------------------------------


@dataclass
class ReleaseHost:
    """An in-process stand-in for a release server, plus the record of what was asked of it."""

    responses: dict[str, httpx.Response] = field(default_factory=dict)
    requests: list[httpx.Request] = field(default_factory=list)

    def client(self) -> httpx.Client:
        def handle(request: httpx.Request) -> httpx.Response:
            # Recorded before anything else, so even a 404 proves the injected transport was
            # the thing consulted — and an empty list proves nothing was.
            self.requests.append(request)
            response = self.responses.get(str(request.url))
            return httpx.Response(404, text="no such object") if response is None else response

        return httpx.Client(transport=httpx.MockTransport(handle))

    @property
    def urls(self) -> list[str]:
        return [str(request.url) for request in self.requests]


@pytest.fixture
def host() -> Iterator[ReleaseHost]:
    yield ReleaseHost()


def artifact_url(version: str) -> str:
    return f"https://downloads.example.invalid/innytypes-{version}-{PLATFORM}.tar.gz"


def index_entry(
    version: str,
    *,
    content: bytes,
    signature: str,
    host_api: int = INSTALLED_HOST_API,
    sha256: str | None = None,
    size: int | None = None,
) -> dict[str, object]:
    """One `releases` entry, with the checksum computed from the bytes unless overridden."""
    artifact: dict[str, object] = {
        "url": artifact_url(version),
        "sha256": hashlib.sha256(content).hexdigest() if sha256 is None else sha256,
        "signature": signature,
    }
    if size is not None:
        artifact["size"] = size
    return {"version": version, "host_api": host_api, "artifacts": {PLATFORM: artifact}}


def publish(
    host: ReleaseHost,
    entries: list[dict[str, object]],
    *,
    channel: str = "stable",
    downloads: Mapping[str, bytes] | None = None,
) -> None:
    """Put an index and its artifacts where the client will look for them."""
    host.responses[INDEX_URL.format(channel=channel)] = httpx.Response(
        200, json={"channel": channel, "releases": entries}
    )
    for version, content in (downloads or {}).items():
        host.responses[artifact_url(version)] = httpx.Response(200, content=content)


def settings_file(tmp_path: Path, *, auto_check_versions: bool, channel: str = "stable") -> Path:
    """A `config.toml` holding just the two keys this slice reads."""
    path = tmp_path / "config.toml"
    path.write_text(
        dedent(f"""
            auto_check_versions = {str(auto_check_versions).lower()}

            [update]
            channel = "{channel}"
        """).strip()
        + "\n",
        encoding="utf-8",
    )
    return path


def clock() -> Callable[[], datetime]:
    return lambda: STAGED_AT


def staged_versions(staging: Path) -> list[str]:
    return sorted(child.name for child in staging.iterdir())


# --------------------------------------------------------------------------------------
# Acceptance 1 — forward only, never the same version and never an older one
# --------------------------------------------------------------------------------------


def test_only_a_strictly_newer_version_is_proposed(host: ReleaseHost, tmp_path: Path) -> None:
    """An index holding older, equal and newer entries proposes exactly the newer one."""
    signature = "unused: nothing is downloaded by a check"
    publish(
        host,
        [
            index_entry("1.0.0", content=b"old", signature=signature),
            index_entry(INSTALLED, content=b"same", signature=signature),
            index_entry("1.3.0", content=b"new", signature=signature),
            index_entry("1.2.4", content=b"also new but smaller", signature=signature),
        ],
    )

    with host.client() as client:
        candidate = check_for_update(
            settings=HelperSettings(settings_file(tmp_path, auto_check_versions=True)),
            client=client,
            url_template=INDEX_URL,
            current_version=INSTALLED,
            host_api_version=INSTALLED_HOST_API,
            platform="darwin",
        )

    assert candidate is not None
    # The newest of the newer ones, and never 1.2.3 itself: a "same version update" would
    # re-download and re-apply the running release on every tick.
    assert candidate.release.version == Version(1, 3, 0)
    assert candidate.automatic is True
    assert candidate.blocked_reason == ""


def test_an_index_with_nothing_newer_proposes_nothing(host: ReleaseHost, tmp_path: Path) -> None:
    """Including what an unsigned index invites: a genuine, older release offered as an update."""
    publish(
        host,
        [
            index_entry("1.0.0", content=b"old", signature="unused"),
            index_entry(INSTALLED, content=b"same", signature="unused"),
        ],
    )

    with host.client() as client:
        candidate = check_for_update(
            settings=HelperSettings(settings_file(tmp_path, auto_check_versions=True)),
            client=client,
            url_template=INDEX_URL,
            current_version=INSTALLED,
            platform="darwin",
        )

    assert candidate is None
    # The check did happen — this is a "nothing newer", not a "never looked".
    assert host.urls == [INDEX_URL.format(channel="stable")]


def test_a_release_without_this_platform_is_not_proposed(host: ReleaseHost) -> None:
    """A release that ships no artifact for this OS is skipped rather than half-proposed."""
    entry = index_entry("2.0.0", content=b"new", signature="unused")
    artifacts = entry["artifacts"]
    assert isinstance(artifacts, dict)
    entry["artifacts"] = {"windows": artifacts[PLATFORM]}
    index = parse_release_index({"channel": "stable", "releases": [entry]}, channel="stable")

    assert (
        choose_candidate(
            index, current_version=parse_version(INSTALLED, where="test"), platform="darwin"
        )
        is None
    )


# --------------------------------------------------------------------------------------
# Acceptance 2 — a new host API major is never applied automatically (D13)
# --------------------------------------------------------------------------------------


def test_a_new_host_api_major_is_never_automatic(
    host: ReleaseHost, tmp_path: Path, signer: Signer
) -> None:
    """It is still checked, downloaded and verified — it just may not apply itself."""
    content = b"a release built against host API 2"
    publish(
        host,
        [index_entry("2.0.0", content=content, signature=signer.sign(content), host_api=2)],
        downloads={"2.0.0": content},
    )
    staging = tmp_path / "staging"
    staging.mkdir()

    with host.client() as client:
        staged = check_and_stage(
            settings=HelperSettings(settings_file(tmp_path, auto_check_versions=True)),
            client=client,
            staging=staging,
            public_key=parse_public_key(signer.public_key_text),
            url_template=INDEX_URL,
            current_version=INSTALLED,
            host_api_version=INSTALLED_HOST_API,
            platform="darwin",
            now=clock(),
        )

    assert staged is not None
    assert staged.automatic is False

    marker = json.loads(staged.marker_path.read_text(encoding="utf-8"))
    # The flag slice 10 reads. Without it, an apply step has no way to tell this release from
    # one it may install on its own.
    assert marker["automatic"] is False
    assert "innytypes update apply" in marker["blocked_reason"]


def test_a_release_on_the_running_host_api_is_automatic(signer: Signer) -> None:
    """The same code path, with the API major unchanged, proposes an automatic update."""
    content = b"a release built against host API 1"
    index = parse_release_index(
        {
            "channel": "stable",
            "releases": [index_entry("1.3.0", content=content, signature=signer.sign(content))],
        },
        channel="stable",
    )

    candidate = choose_candidate(
        index,
        current_version=parse_version(INSTALLED, where="test"),
        host_api_version=INSTALLED_HOST_API,
        platform="darwin",
    )

    assert candidate is not None
    assert candidate.automatic is True


# --------------------------------------------------------------------------------------
# Acceptance 3 — the switch is re-read before every check, and off means no request at all
# --------------------------------------------------------------------------------------


def test_the_switch_off_makes_no_request_of_any_kind(
    host: ReleaseHost, tmp_path: Path, signer: Signer
) -> None:
    """The strong form: zero calls on the injected transport, not merely no update proposed."""
    content = b"a release that must never be asked for"
    publish(
        host,
        [index_entry("9.9.9", content=content, signature=signer.sign(content))],
        downloads={"9.9.9": content},
    )
    staging = tmp_path / "staging"
    staging.mkdir()

    with host.client() as client:
        staged = check_and_stage(
            settings=HelperSettings(settings_file(tmp_path, auto_check_versions=False)),
            client=client,
            staging=staging,
            public_key=parse_public_key(signer.public_key_text),
            url_template=INDEX_URL,
            current_version=INSTALLED,
            platform="darwin",
            now=clock(),
        )

    assert staged is None
    assert host.requests == []
    assert staged_versions(staging) == []


def test_the_switch_is_re_read_before_every_check(
    host: ReleaseHost, tmp_path: Path, signer: Signer
) -> None:
    """One `HelperSettings`, built once, obeys a switch flipped after it was built."""
    content = b"a release"
    publish(host, [index_entry("1.3.0", content=content, signature=signer.sign(content))])

    config = settings_file(tmp_path, auto_check_versions=True)
    settings = HelperSettings(config)

    with host.client() as client:
        first = check_for_update(
            settings=settings,
            client=client,
            url_template=INDEX_URL,
            current_version=INSTALLED,
            platform="darwin",
        )
        assert first is not None
        assert len(host.requests) == 1

        # The user turns it off while the helper is running. No restart, no invalidation.
        settings_file(tmp_path, auto_check_versions=False)

        second = check_for_update(
            settings=settings,
            client=client,
            url_template=INDEX_URL,
            current_version=INSTALLED,
            platform="darwin",
        )

    assert second is None
    assert len(host.requests) == 1


def test_the_channel_comes_from_the_config(
    host: ReleaseHost, tmp_path: Path, signer: Signer
) -> None:
    """A different channel is a different index, so the URL a check fetches has to follow it."""
    content = b"a beta release"
    publish(
        host,
        [index_entry("1.4.0", content=content, signature=signer.sign(content))],
        channel="beta",
    )

    with host.client() as client:
        candidate = check_for_update(
            settings=HelperSettings(
                settings_file(tmp_path, auto_check_versions=True, channel="beta")
            ),
            client=client,
            url_template=INDEX_URL,
            current_version=INSTALLED,
            platform="darwin",
        )

    assert candidate is not None
    assert host.urls == [INDEX_URL.format(channel="beta")]


# --------------------------------------------------------------------------------------
# Acceptance 4 — a bad checksum is deleted and reported
# --------------------------------------------------------------------------------------


def test_a_bad_checksum_is_deleted_and_reported(
    host: ReleaseHost, tmp_path: Path, signer: Signer, caplog: pytest.LogCaptureFixture
) -> None:
    """The bytes that arrived are not the bytes the index named: nothing survives."""
    content = b"the bytes that actually arrive"
    publish(
        host,
        [
            index_entry(
                "1.3.0",
                content=content,
                signature=signer.sign(content),
                sha256=hashlib.sha256(b"the bytes the index claims").hexdigest(),
            )
        ],
        downloads={"1.3.0": content},
    )
    staging = tmp_path / "staging"
    staging.mkdir()

    with (
        host.client() as client,
        caplog.at_level("ERROR"),
        pytest.raises(ReleaseRejected) as raised,
    ):
        check_and_stage(
            settings=HelperSettings(settings_file(tmp_path, auto_check_versions=True)),
            client=client,
            staging=staging,
            public_key=parse_public_key(signer.public_key_text),
            url_template=INDEX_URL,
            current_version=INSTALLED,
            platform="darwin",
            now=clock(),
        )

    assert raised.value.reason == "checksum"
    assert raised.value.version == "1.3.0"
    # Never kept: not the artifact, not the directory it was downloading into.
    assert staged_versions(staging) == []
    # Reported: the failure reached the log, not only the caller.
    assert "failed its checksum check and was deleted" in caplog.text


# --------------------------------------------------------------------------------------
# Acceptance 5 — a GOOD checksum with a bad signature is deleted and reported
# --------------------------------------------------------------------------------------


def test_a_good_checksum_with_a_bad_signature_is_deleted_and_reported(
    host: ReleaseHost, tmp_path: Path, signer: Signer, caplog: pytest.LogCaptureFixture
) -> None:
    """The case a checksum-only verifier passes, and the reason this slice exists.

    The checksum is computed from the bytes that are actually served, so it matches perfectly.
    The signature is a real signature made by the real key — over different content. Only the
    signature check can tell the difference, and it has to.
    """
    content = b"an artifact the release key never signed"
    publish(
        host,
        [
            index_entry(
                "1.3.0",
                content=content,
                signature=signer.sign(b"some other artifact entirely"),
            )
        ],
        downloads={"1.3.0": content},
    )
    staging = tmp_path / "staging"
    staging.mkdir()

    with (
        host.client() as client,
        caplog.at_level("ERROR"),
        pytest.raises(ReleaseRejected) as raised,
    ):
        check_and_stage(
            settings=HelperSettings(settings_file(tmp_path, auto_check_versions=True)),
            client=client,
            staging=staging,
            public_key=parse_public_key(signer.public_key_text),
            url_template=INDEX_URL,
            current_version=INSTALLED,
            platform="darwin",
            now=clock(),
        )

    assert raised.value.reason == "signature"
    assert "does not verify" in raised.value.detail
    assert staged_versions(staging) == []
    assert "failed its signature check and was deleted" in caplog.text


def test_a_signature_from_another_key_is_rejected(
    host: ReleaseHost, tmp_path: Path, signer: Signer
) -> None:
    """A perfectly valid signature is still worthless when this release does not ship that key."""
    content = b"signed by somebody else"
    impostor = Signer(signing_key=SigningKey.generate(), key_id=secrets.token_bytes(8))
    publish(
        host,
        [index_entry("1.3.0", content=content, signature=impostor.sign(content))],
        downloads={"1.3.0": content},
    )
    staging = tmp_path / "staging"
    staging.mkdir()

    with host.client() as client, pytest.raises(ReleaseRejected) as raised:
        check_and_stage(
            settings=HelperSettings(settings_file(tmp_path, auto_check_versions=True)),
            client=client,
            staging=staging,
            public_key=parse_public_key(signer.public_key_text),
            url_template=INDEX_URL,
            current_version=INSTALLED,
            platform="darwin",
            now=clock(),
        )

    assert raised.value.reason == "signature"
    assert staged_versions(staging) == []


# --------------------------------------------------------------------------------------
# Acceptance 6 — a verified release is left in staging, marked ready, and alone
# --------------------------------------------------------------------------------------


def test_a_verified_release_is_staged_ready_and_is_all_that_is_left(
    host: ReleaseHost, tmp_path: Path, signer: Signer
) -> None:
    """Both checks pass: the artifact and its marker, and nothing else on disk."""
    content = b"a genuine, correctly signed release bundle"
    signature = signer.sign(content)
    publish(
        host,
        [index_entry("1.3.0", content=content, signature=signature)],
        downloads={"1.3.0": content},
    )
    staging = tmp_path / "staging"
    staging.mkdir()
    # Left over from an earlier cycle. A staging directory holding two candidates is a
    # staging directory that cannot say what is waiting to be applied.
    (staging / "1.2.9").mkdir()
    (staging / "1.2.9" / "innytypes-1.2.9-macos.tar.gz").write_bytes(b"stale")

    with host.client() as client:
        staged = check_and_stage(
            settings=HelperSettings(settings_file(tmp_path, auto_check_versions=True)),
            client=client,
            staging=staging,
            public_key=parse_public_key(signer.public_key_text),
            url_template=INDEX_URL,
            current_version=INSTALLED,
            platform="darwin",
            now=clock(),
        )

    assert staged is not None
    assert staged_versions(staging) == ["1.3.0"]
    assert sorted(child.name for child in staged.directory.iterdir()) == [
        "innytypes-1.3.0-macos.tar.gz",
        READY_MARKER,
    ]
    assert staged.artifact_path.read_bytes() == content

    marker = json.loads(staged.marker_path.read_text(encoding="utf-8"))
    assert marker == {
        "artifact": "innytypes-1.3.0-macos.tar.gz",
        "automatic": True,
        "blocked_reason": "",
        "host_api": INSTALLED_HOST_API,
        "platform": PLATFORM,
        "ready": True,
        "sha256": hashlib.sha256(content).hexdigest(),
        # The signature is carried so the **apply** (slice 10) can verify it again against the
        # same installed key, at the moment the bytes are about to become the running
        # application. Without it, everything standing between staging and execution would be
        # a checksum in this same file, and whatever could rewrite one could rewrite both.
        "signature": signature,
        "staged_at": STAGED_AT.isoformat(),
        "version": "1.3.0",
    }


def test_an_earlier_failed_attempt_at_the_same_version_is_cleared(
    host: ReleaseHost, tmp_path: Path, signer: Signer
) -> None:
    """Verifying into a directory that already holds something is how a rejected file survives."""
    content = b"a genuine release"
    publish(
        host,
        [index_entry("1.3.0", content=content, signature=signer.sign(content))],
        downloads={"1.3.0": content},
    )
    staging = tmp_path / "staging"
    (staging / "1.3.0").mkdir(parents=True)
    (staging / "1.3.0" / "leftover.bin").write_bytes(b"from a previous, failed attempt")

    with host.client() as client:
        candidate = check_for_update(
            settings=HelperSettings(settings_file(tmp_path, auto_check_versions=True)),
            client=client,
            url_template=INDEX_URL,
            current_version=INSTALLED,
            platform="darwin",
        )
        assert candidate is not None
        staged = download_and_verify(
            candidate,
            client=client,
            staging=staging,
            public_key=parse_public_key(signer.public_key_text),
            now=clock(),
        )

    assert sorted(child.name for child in staged.directory.iterdir()) == [
        "innytypes-1.3.0-macos.tar.gz",
        READY_MARKER,
    ]


# --------------------------------------------------------------------------------------
# The download itself: size, transport failures, redirects
# --------------------------------------------------------------------------------------


def test_a_download_that_outgrows_its_limit_is_abandoned(
    host: ReleaseHost, tmp_path: Path, signer: Signer
) -> None:
    """A server that streams forever fills a log line, not a disk."""
    content = b"x" * 4096
    publish(
        host,
        [index_entry("1.3.0", content=content, signature=signer.sign(content))],
        downloads={"1.3.0": content},
    )
    staging = tmp_path / "staging"
    staging.mkdir()

    with host.client() as client:
        candidate = check_for_update(
            settings=HelperSettings(settings_file(tmp_path, auto_check_versions=True)),
            client=client,
            url_template=INDEX_URL,
            current_version=INSTALLED,
            platform="darwin",
        )
        assert candidate is not None
        with pytest.raises(ReleaseRejected) as raised:
            download_and_verify(
                candidate,
                client=client,
                staging=staging,
                public_key=parse_public_key(signer.public_key_text),
                now=clock(),
                max_bytes=1024,
            )

    assert raised.value.reason == "oversized"
    assert staged_versions(staging) == []


def test_a_short_download_against_a_declared_size_is_rejected(
    host: ReleaseHost, tmp_path: Path, signer: Signer
) -> None:
    """The index said how big it is; a truncated stream is caught before anything else."""
    content = b"a truncated release"
    publish(
        host,
        [
            index_entry(
                "1.3.0",
                content=content,
                signature=signer.sign(content),
                size=len(content) + 100,
            )
        ],
        downloads={"1.3.0": content},
    )
    staging = tmp_path / "staging"
    staging.mkdir()

    with host.client() as client:
        candidate = check_for_update(
            settings=HelperSettings(settings_file(tmp_path, auto_check_versions=True)),
            client=client,
            url_template=INDEX_URL,
            current_version=INSTALLED,
            platform="darwin",
        )
        assert candidate is not None
        with pytest.raises(ReleaseRejected) as raised:
            download_and_verify(
                candidate,
                client=client,
                staging=staging,
                public_key=parse_public_key(signer.public_key_text),
                now=clock(),
            )

    assert raised.value.reason == "checksum"
    assert staged_versions(staging) == []


def test_a_failed_download_leaves_nothing_behind(
    host: ReleaseHost, tmp_path: Path, signer: Signer
) -> None:
    """The artifact URL 404s. Half a download is still an unverified file."""
    content = b"a release nobody will receive"
    publish(host, [index_entry("1.3.0", content=content, signature=signer.sign(content))])
    staging = tmp_path / "staging"
    staging.mkdir()

    with host.client() as client:
        candidate = check_for_update(
            settings=HelperSettings(settings_file(tmp_path, auto_check_versions=True)),
            client=client,
            url_template=INDEX_URL,
            current_version=INSTALLED,
            platform="darwin",
        )
        assert candidate is not None
        with pytest.raises(UpdateError, match="could not download release 1.3.0"):
            download_and_verify(
                candidate,
                client=client,
                staging=staging,
                public_key=parse_public_key(signer.public_key_text),
                now=clock(),
            )

    assert staged_versions(staging) == []


def test_a_redirect_to_another_https_url_is_followed(
    host: ReleaseHost, tmp_path: Path, signer: Signer
) -> None:
    """GitHub Releases redirects to object storage, and D10 says that host must work."""
    content = b"a release behind a redirect"
    final = "https://objects.example.invalid/innytypes-1.3.0-macos.tar.gz"
    publish(host, [index_entry("1.3.0", content=content, signature=signer.sign(content))])
    host.responses[artifact_url("1.3.0")] = httpx.Response(302, headers={"location": final})
    host.responses[final] = httpx.Response(200, content=content)
    staging = tmp_path / "staging"
    staging.mkdir()

    with host.client() as client:
        staged = check_and_stage(
            settings=HelperSettings(settings_file(tmp_path, auto_check_versions=True)),
            client=client,
            staging=staging,
            public_key=parse_public_key(signer.public_key_text),
            url_template=INDEX_URL,
            current_version=INSTALLED,
            platform="darwin",
            now=clock(),
        )

    assert staged is not None
    assert final in host.urls


def test_a_redirect_that_drops_to_plain_http_is_refused(
    host: ReleaseHost, tmp_path: Path, signer: Signer
) -> None:
    """The request for the insecure hop is never sent, not merely distrusted afterwards."""
    content = b"a release behind a downgrade"
    downgraded = "http://objects.example.invalid/innytypes-1.3.0-macos.tar.gz"
    publish(host, [index_entry("1.3.0", content=content, signature=signer.sign(content))])
    host.responses[artifact_url("1.3.0")] = httpx.Response(302, headers={"location": downgraded})
    staging = tmp_path / "staging"
    staging.mkdir()

    with host.client() as client:
        candidate = check_for_update(
            settings=HelperSettings(settings_file(tmp_path, auto_check_versions=True)),
            client=client,
            url_template=INDEX_URL,
            current_version=INSTALLED,
            platform="darwin",
        )
        assert candidate is not None
        with pytest.raises(UpdateError, match="must use HTTPS"):
            download_and_verify(
                candidate,
                client=client,
                staging=staging,
                public_key=parse_public_key(signer.public_key_text),
                now=clock(),
            )

    assert downgraded not in host.urls
    assert staged_versions(staging) == []


def test_a_redirect_with_no_destination_is_refused(host: ReleaseHost) -> None:
    url = INDEX_URL.format(channel="stable")
    host.responses[url] = httpx.Response(302, headers={"location": ""})

    with host.client() as client, pytest.raises(UpdateError, match="redirect and no destination"):
        fetch_release_index(client, channel="stable", url_template=INDEX_URL)


def test_an_endless_redirect_chain_is_refused(host: ReleaseHost) -> None:
    url = INDEX_URL.format(channel="stable")
    host.responses[url] = httpx.Response(302, headers={"location": url})

    with host.client() as client, pytest.raises(UpdateError, match="redirected more than"):
        fetch_release_index(client, channel="stable", url_template=INDEX_URL)


def test_a_plain_http_index_url_is_refused(host: ReleaseHost) -> None:
    with host.client() as client, pytest.raises(UpdateError, match="must use HTTPS"):
        fetch_release_index(
            client, channel="stable", url_template="http://releases.example.invalid/{channel}.json"
        )

    assert host.requests == []


# --------------------------------------------------------------------------------------
# The index parser: strict, and never steerable by something it cannot read
# --------------------------------------------------------------------------------------


def test_an_index_that_is_not_json_is_refused(host: ReleaseHost) -> None:
    host.responses[INDEX_URL.format(channel="stable")] = httpx.Response(200, text="<html>")

    with host.client() as client, pytest.raises(ReleaseIndexError, match="not valid JSON"):
        fetch_release_index(client, channel="stable", url_template=INDEX_URL)


def test_an_index_that_cannot_be_fetched_is_refused(host: ReleaseHost) -> None:
    with host.client() as client, pytest.raises(ReleaseIndexError, match="could not fetch"):
        fetch_release_index(client, channel="stable", url_template=INDEX_URL)


@pytest.mark.parametrize(
    ("document", "message"),
    [
        ([], "not a JSON object"),
        ({"channel": "beta", "releases": []}, "names channel"),
        ({"channel": "stable"}, "no `releases` list"),
        ({"channel": "stable", "releases": ["nope"]}, "entry 0 is not a JSON object"),
        (
            {"channel": "stable", "releases": [{"host_api": 1, "artifacts": {}}]},
            "`version` must be a non-empty string",
        ),
        (
            {"channel": "stable", "releases": [{"version": "1.0", "host_api": 1, "artifacts": {}}]},
            "not a MAJOR.MINOR.PATCH version",
        ),
        (
            {
                "channel": "stable",
                "releases": [{"version": "1.0.0", "host_api": True, "artifacts": {}}],
            },
            "`host_api` must be a positive whole number",
        ),
        (
            {
                "channel": "stable",
                "releases": [{"version": "1.0.0", "host_api": 1, "artifacts": {}}],
            },
            "at least one operating system",
        ),
        (
            {
                "channel": "stable",
                "releases": [{"version": "1.0.0", "host_api": 1, "artifacts": {"macos": 3}}],
            },
            "not a JSON object",
        ),
    ],
)
def test_a_malformed_index_is_refused_by_name(document: object, message: str) -> None:
    """Strict, and specific: the refusal names the field, so the publisher can fix it."""
    with pytest.raises(UpdateError, match=message):
        parse_release_index(document, channel="stable")


def test_the_same_version_listed_twice_is_refused() -> None:
    entry = index_entry("2.0.0", content=b"x", signature="unused")
    with pytest.raises(ReleaseIndexError, match="same version twice"):
        parse_release_index({"channel": "stable", "releases": [entry, entry]}, channel="stable")


@pytest.mark.parametrize(
    ("artifact", "message"),
    [
        ({"url": "ftp://x/y.tar.gz", "sha256": "0" * 64, "signature": "s"}, "must be an HTTPS URL"),
        ({"url": "https://x/y.tar.gz", "sha256": "nope", "signature": "s"}, "64 lowercase hex"),
        (
            {"url": "https://x/y.tar.gz", "sha256": "0" * 64, "signature": "s", "size": 0},
            "`size`, when present",
        ),
        (
            {"url": "https://x/downloads/", "sha256": "0" * 64, "signature": "s"},
            "not a usable file name",
        ),
        (
            {"url": "https://x/.hidden", "sha256": "0" * 64, "signature": "s"},
            "not a usable file name",
        ),
        (
            {"url": "https://x/a%00b.tar.gz", "sha256": "0" * 64, "signature": "s"},
            "not a usable file name",
        ),
    ],
)
def test_a_malformed_artifact_is_refused(artifact: dict[str, object], message: str) -> None:
    """The download URL is untrusted input that becomes a path, so its file name is checked."""
    document = {
        "channel": "stable",
        "releases": [{"version": "2.0.0", "host_api": 1, "artifacts": {PLATFORM: artifact}}],
    }
    with pytest.raises(ReleaseIndexError, match=message):
        parse_release_index(document, channel="stable")


def test_a_traversing_download_url_still_lands_inside_staging() -> None:
    """The property, not the rule: whatever the URL spells, the name stays one path segment.

    A URL is not a path. Its last segment can never hold a separator, so an index reaching for
    ``../../bin`` gets the file written into staging like every other artifact — where the
    failure path can find it again and delete it.
    """
    document = {
        "channel": "stable",
        "releases": [
            {
                "version": "2.0.0",
                "host_api": 1,
                "artifacts": {
                    PLATFORM: {
                        "url": "https://x/%2e%2e%2f%2e%2e%2fbin%2finnytypes.tar.gz",
                        "sha256": "0" * 64,
                        "signature": "s",
                    }
                },
            }
        ],
    }

    index = parse_release_index(document, channel="stable")
    artifact = index.releases[0].artifacts[PLATFORM]

    assert artifact.filename == "innytypes.tar.gz"
    assert "/" not in artifact.filename


# --------------------------------------------------------------------------------------
# Versions, platforms and the shipped public key
# --------------------------------------------------------------------------------------


def test_versions_order_by_number_and_not_by_text() -> None:
    assert parse_version("1.10.0", where="test") > parse_version("1.9.0", where="test")
    assert str(parse_version(" 2.0.1 ", where="test")) == "2.0.1"


def test_an_unusable_version_is_refused_by_name() -> None:
    with pytest.raises(UpdateError, match="the running version"):
        parse_version("2.0.0rc1", where="the running version")


def test_the_platform_name_comes_from_the_interpreter() -> None:
    assert current_platform("darwin") == "macos"
    assert current_platform("win32") == "windows"
    assert current_platform("linux") == "linux"


def test_an_unknown_platform_is_refused_rather_than_guessed() -> None:
    with pytest.raises(UpdateError, match="no release artifacts are published"):
        current_platform("sunos5")


def test_a_build_with_no_signing_key_refuses_to_update(tmp_path: Path) -> None:
    """Fail closed: no key means no verifiable update, which means no update."""
    with pytest.raises(UpdateError, match="ships no release signing key"):
        load_installed_public_key(tmp_path / "release-key.pub")


def test_the_shipped_key_is_read_from_its_file(tmp_path: Path, signer: Signer) -> None:
    key_file = tmp_path / "release-key.pub"
    key_file.write_text(signer.public_key_text, encoding="utf-8")

    assert load_installed_public_key(key_file).key_id == signer.key_id


# --------------------------------------------------------------------------------------
# The minisign layer on its own
# --------------------------------------------------------------------------------------


def test_both_minisign_forms_verify(tmp_path: Path, signer: Signer) -> None:
    """Prehashed (`ED`) and legacy (`Ed`), because a signer should not have to guess."""
    content = b"a release bundle"
    artifact = tmp_path / "artifact.tar.gz"
    artifact.write_bytes(content)
    key = parse_public_key(signer.public_key_text)

    for prehashed in (True, False):
        signature = parse_signature(signer.sign(content, prehashed=prehashed))
        verify_file(artifact, signature, key)


def test_a_tampered_trusted_comment_is_refused(tmp_path: Path, signer: Signer) -> None:
    """The global signature is what makes the trusted comment trusted, so it is checked."""
    content = b"a release bundle"
    artifact = tmp_path / "artifact.tar.gz"
    artifact.write_bytes(content)

    signature = parse_signature(signer.sign(content, tampered_comment="file:something-else.tar.gz"))

    with pytest.raises(MinisignError, match="global signature does not verify"):
        verify_file(artifact, signature, parse_public_key(signer.public_key_text))


def test_an_unknown_signature_algorithm_is_refused(tmp_path: Path, signer: Signer) -> None:
    content = b"a release bundle"
    artifact = tmp_path / "artifact.tar.gz"
    artifact.write_bytes(content)

    signature = parse_signature(signer.sign(content))
    unknown = type(signature)(
        algorithm=b"XX",
        key_id=signature.key_id,
        signature=signature.signature,
        trusted_comment=signature.trusted_comment,
        global_signature=signature.global_signature,
    )

    with pytest.raises(MinisignError, match="does not understand"):
        verify_file(artifact, unknown, parse_public_key(signer.public_key_text))


def test_a_real_world_minisign_public_key_parses() -> None:
    """jedisct1/minisign's own published example key: the layout is not this repo's invention."""
    key = parse_public_key("RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3")

    assert key.key_id.hex() == "1fe8b442180f62e7"
    assert len(key.public_key) == 32


@pytest.mark.parametrize(
    ("text", "message"),
    [
        ("untrusted comment: only a comment\n", "holds no key line"),
        ("not base64 at all !!", "not valid base64"),
        (base64.b64encode(b"Ed" + b"x" * 8).decode(), "expected 42"),
        (base64.b64encode(b"XX" + b"x" * 40).decode(), "announces algorithm"),
    ],
)
def test_a_malformed_public_key_is_refused(text: str, message: str) -> None:
    with pytest.raises(MinisignError, match=message):
        parse_public_key(text)


@pytest.mark.parametrize(
    ("text", "message"),
    [
        ("one line only", "expected 4"),
        (
            "untrusted comment: c\n"
            + base64.b64encode(b"Ed" + b"k" * 8 + b"s" * 64).decode()
            + "\nnot a trusted comment\n"
            + base64.b64encode(b"g" * 64).decode(),
            "does not start with",
        ),
        (
            "untrusted comment: c\nnot base64 !!\ntrusted comment: t\n"
            + base64.b64encode(b"g" * 64).decode(),
            "not valid base64",
        ),
        (
            "untrusted comment: c\n"
            + base64.b64encode(b"Ed" + b"k" * 8).decode()
            + "\ntrusted comment: t\n"
            + base64.b64encode(b"g" * 64).decode(),
            "expected 74",
        ),
        (
            "untrusted comment: c\n"
            + base64.b64encode(b"Ed" + b"k" * 8 + b"s" * 64).decode()
            + "\ntrusted comment: t\n"
            + base64.b64encode(b"g" * 8).decode(),
            "global signature is 8 bytes",
        ),
    ],
)
def test_a_malformed_signature_is_refused(text: str, message: str) -> None:
    with pytest.raises(MinisignError, match=message):
        parse_signature(text)


def test_a_public_key_that_is_not_an_ed25519_point_is_refused(
    tmp_path: Path, signer: Signer
) -> None:
    """libsodium rejects it; this turns that into the same refusal as every other failure."""
    content = b"a release bundle"
    artifact = tmp_path / "artifact.tar.gz"
    artifact.write_bytes(content)

    key = parse_public_key(signer.public_key_text)
    broken = type(key)(key_id=key.key_id, public_key=b"too short")

    with pytest.raises(MinisignError, match="not a usable Ed25519 key"):
        verify_file(artifact, parse_signature(signer.sign(content)), broken)
