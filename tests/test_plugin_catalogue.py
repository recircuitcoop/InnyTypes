"""The plugin catalogue: what a listing may say, who signed it, and what is kept.

Plan 0006, F1 and F2. Nothing here opens a socket: every fetch goes through an
:class:`httpx.MockTransport` that **records every request**, which is what lets the refusal
tests assert the strong form — not "no entries came back" but "nothing was ever asked for".
The cache lives under ``tmp_path``, the clock is injected, and the signing key pair is
generated inside the test that uses it, so no private key is ever committed.

The substance of this slice is refusal, so most of what follows breaks exactly one thing and
asserts two consequences: the whole document is gone, and **nothing was cached**. A verifier
that rejects a catalogue and then serves it from disk next time has rejected nothing.
"""

from __future__ import annotations

import ast
import base64
import hashlib
import json
import secrets
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from textwrap import dedent

import httpx
import pytest
from nacl.signing import SigningKey

from innytypes.helper import catalogue as catalogue_module
from innytypes.helper.catalogue import (
    CATALOGUE_FORMAT,
    MAX_SIGNATURE_BYTES,
    MAX_SUMMARY_CHARS,
    SIGNATURE_SUFFIX,
    CatalogueCache,
    CatalogueDocumentError,
    CatalogueEntry,
    CatalogueError,
    CatalogueReader,
    CatalogueRejected,
    default_catalogue_cache_path,
    parse_catalogue,
)
from innytypes.helper.config import (
    CONFIG_FILENAME,
    OFFICIAL_SOURCE_NAME,
    CatalogueSource,
    HelperSettings,
)
from innytypes.helper.minisign import parse_public_key
from innytypes.helper.update import UpdateError

# Where this suite publishes. `.invalid` is reserved by RFC 2606, so a test that somehow
# escaped the injected transport would fail to resolve rather than reach a real server.
OFFICIAL_URL = "https://catalogues.example.invalid/official/catalogue.json"
ACME_URL = "https://acme.example.invalid/catalogue.json"

# A frozen moment, so "the cache is fresh" and "the cache is stale" are assertions rather
# than a race with the wall clock.
NOW = datetime(2026, 9, 19, 12, 0, tzinfo=UTC)

# The interval every test's `config.toml` sets, and the one a cached catalogue is judged
# against: it is `update.check_interval` and deliberately not a second number of its own.
CHECK_INTERVAL = 3600.0


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

    @property
    def public_key_line(self) -> str:
        """The bare base64 line, which is what a registered source stores in `config.toml`."""
        return self.public_key_text.splitlines()[1]

    def sign(self, content: bytes) -> str:
        """A detached, prehashed minisign signature over ``content``."""
        message = hashlib.blake2b(content, digest_size=64).digest()
        trusted_comment = "timestamp:1758280000\tfile:catalogue.json"
        signature = self.signing_key.sign(message).signature
        global_signature = self.signing_key.sign(
            signature + trusted_comment.encode("utf-8")
        ).signature
        return (
            "untrusted comment: signature from a throwaway key\n"
            + base64.b64encode(b"ED" + self.key_id + signature).decode("ascii")
            + "\n"
            + f"trusted comment: {trusted_comment}\n"
            + base64.b64encode(global_signature).decode("ascii")
            + "\n"
        )


@pytest.fixture
def signer() -> Signer:
    """A fresh key pair per test. The private half never leaves this process."""
    return Signer(signing_key=SigningKey.generate(), key_id=secrets.token_bytes(8))


@pytest.fixture
def stranger() -> Signer:
    """A second key pair, for the catalogue signed by somebody nobody registered."""
    return Signer(signing_key=SigningKey.generate(), key_id=secrets.token_bytes(8))


# --------------------------------------------------------------------------------------
# The publishing host, served in-process and recorded
# --------------------------------------------------------------------------------------


@dataclass
class PublishingHost:
    """An in-process stand-in for a catalogue server, plus the record of what was asked."""

    responses: dict[str, httpx.Response] = field(default_factory=dict)
    requests: list[httpx.Request] = field(default_factory=list)

    @property
    def transport(self) -> httpx.MockTransport:
        def handle(request: httpx.Request) -> httpx.Response:
            # Recorded before anything else, so even a 404 proves the injected transport was
            # the thing consulted — and an empty list proves nothing was.
            self.requests.append(request)
            published = self.responses.get(str(request.url))
            if published is None:
                return httpx.Response(404, text="no such object")
            # A response object is single-use once streamed, so each hit gets a fresh one.
            return httpx.Response(published.status_code, content=published.content)

        return httpx.MockTransport(handle)

    @property
    def urls(self) -> list[str]:
        return [str(request.url) for request in self.requests]

    def publish(self, url: str, document: bytes, *, signature: str | None = None) -> None:
        self.responses[url] = httpx.Response(200, content=document)
        if signature is not None:
            self.responses[f"{url}{SIGNATURE_SUFFIX}"] = httpx.Response(
                200, content=signature.encode("utf-8")
            )


@pytest.fixture
def host() -> PublishingHost:
    return PublishingHost()


# --------------------------------------------------------------------------------------
# Documents, settings and readers
# --------------------------------------------------------------------------------------


def entry(
    plugin_id: str = "monty",
    *,
    summary: str = "Watches what you do and files it in Anytype.",
    source: str = "pypi:monty",
) -> dict[str, object]:
    return {"id": plugin_id, "summary": summary, "source": source}


def document(*entries: dict[str, object], version: int = CATALOGUE_FORMAT) -> dict[str, object]:
    return {"catalogue": version, "plugins": list(entries) or [entry()]}


def serialized(*entries: dict[str, object], version: int = CATALOGUE_FORMAT) -> bytes:
    return json.dumps(document(*entries, version=version)).encode("utf-8")


def settings(tmp_path: Path, *, extra: str = "") -> HelperSettings:
    """A `config.toml` holding the one key this module reads, plus whatever a test adds."""
    path = tmp_path / CONFIG_FILENAME
    path.write_text(
        dedent(f"""
            [update]
            check_interval = {CHECK_INTERVAL}
        """).strip()
        + "\n"
        + dedent(extra),
        encoding="utf-8",
    )
    return HelperSettings(path=path)


class Clock:
    """A clock a test moves by hand, so a cache can be aged without waiting for it."""

    def __init__(self, moment: datetime = NOW) -> None:
        self.moment = moment

    def __call__(self) -> datetime:
        return self.moment

    def advance(self, seconds: float) -> None:
        self.moment = self.moment + timedelta(seconds=seconds)


def reader(
    tmp_path: Path,
    host: PublishingHost,
    *,
    clock: Clock | None = None,
    public_key: str | None = None,
    official_url: str = OFFICIAL_URL,
) -> CatalogueReader:
    """A reader with every seam filled: transport, cache directory, clock and key."""
    return CatalogueReader(
        settings=settings(tmp_path),
        cache=CatalogueCache(directory=tmp_path / "catalogues"),
        transport=host.transport,
        now=Clock() if clock is None else clock,
        official_url=official_url,
        public_key=None if public_key is None else parse_public_key(public_key),
    )


def cache_file(tmp_path: Path, name: str) -> Path:
    return tmp_path / "catalogues" / f"{name}.json"


# ======================================================================================
# Acceptance 1 — the document format, and a refusal for every way of getting it wrong
# ======================================================================================


def test_a_well_formed_catalogue_parses_into_entries() -> None:
    """The convention itself: a format version, and one entry per plugin offered."""
    entries = parse_catalogue(
        document(
            entry("monty", summary="Files what you do.", source="pypi:monty"),
            entry("whodunnit", summary="Says who changed it.", source="index:whodunnit"),
            entry("summarize", summary="Shortens a page.", source="git+https://forge/s.git"),
        ),
        catalogue="acme",
        verified=True,
    )

    assert entries == (
        CatalogueEntry(
            plugin_id="monty",
            summary="Files what you do.",
            install_source="pypi:monty",
            catalogue="acme",
            verified=True,
        ),
        CatalogueEntry(
            plugin_id="whodunnit",
            summary="Says who changed it.",
            install_source="index:whodunnit",
            catalogue="acme",
            verified=True,
        ),
        CatalogueEntry(
            plugin_id="summarize",
            summary="Shortens a page.",
            install_source="git+https://forge/s.git",
            catalogue="acme",
            verified=True,
        ),
    )


def test_an_entry_missing_a_required_field_is_refused_by_where_it_sits() -> None:
    """A catalogue of forty plugins with one bad line is unfixable without the position."""
    broken = {"id": "monty", "source": "pypi:monty"}

    with pytest.raises(CatalogueDocumentError) as error:
        parse_catalogue(document(entry("whodunnit"), broken), catalogue="acme", verified=False)

    assert "entry 1" in str(error.value)
    assert "`summary` is missing" in str(error.value)
    assert "'acme'" in str(error.value)


def test_an_entry_field_of_the_wrong_type_is_refused_by_where_it_sits() -> None:
    with pytest.raises(CatalogueDocumentError) as error:
        parse_catalogue(
            document({"id": "monty", "summary": 7, "source": "pypi:monty"}),
            catalogue="acme",
            verified=False,
        )

    assert "entry 0" in str(error.value)
    assert "`summary` must be text" in str(error.value)


def test_an_entry_offering_a_git_source_that_is_not_https_is_refused() -> None:
    """The listing decides which repository a machine would clone; plain git is not offered."""
    with pytest.raises(CatalogueDocumentError) as error:
        parse_catalogue(
            document(entry("monty", source="git+http://forge.example.invalid/monty.git")),
            catalogue="acme",
            verified=False,
        )

    assert "entry 0" in str(error.value)
    assert "HTTPS" in str(error.value)


def test_an_entry_with_an_empty_field_is_refused() -> None:
    with pytest.raises(CatalogueDocumentError) as error:
        parse_catalogue(document(entry("monty", summary="   ")), catalogue="acme", verified=False)

    assert "`summary` is empty" in str(error.value)


def test_an_entry_whose_id_is_not_an_addon_id_is_refused() -> None:
    """An id becomes a section of config.toml and an argument to an install."""
    with pytest.raises(CatalogueDocumentError) as error:
        parse_catalogue(document(entry("../../etc")), catalogue="acme", verified=False)

    assert "well-formed addon id" in str(error.value)


def test_an_entry_summary_longer_than_one_line_is_refused() -> None:
    with pytest.raises(CatalogueDocumentError) as error:
        parse_catalogue(
            document(entry("monty", summary="x" * (MAX_SUMMARY_CHARS + 1))),
            catalogue="acme",
            verified=False,
        )

    assert str(MAX_SUMMARY_CHARS) in str(error.value)


def test_an_entry_summary_holding_a_control_character_is_refused() -> None:
    """It is drawn in a list beside a button, and text that can move a cursor is not text."""
    with pytest.raises(CatalogueDocumentError) as error:
        parse_catalogue(
            document(entry("monty", summary="tidy\x1b[2Jand gone")),
            catalogue="acme",
            verified=False,
        )

    assert "control character" in str(error.value)


def test_an_entry_source_the_updater_could_not_read_is_refused() -> None:
    """The same parser the updater uses, so a catalogue cannot offer a spelling it refuses."""
    with pytest.raises(CatalogueDocumentError) as error:
        parse_catalogue(
            document(entry("monty", source="ftp://somewhere")), catalogue="acme", verified=False
        )

    assert "entry 0" in str(error.value)
    assert "names no source kind" in str(error.value)


def test_a_malformed_git_url_is_refused_as_a_catalogue_refusal() -> None:
    """A URL parser's own exception must never escape a caller catching `CatalogueError`."""
    with pytest.raises(CatalogueError):
        parse_catalogue(
            document(entry("monty", source="git+::::")), catalogue="acme", verified=False
        )


def test_an_entry_is_not_an_object() -> None:
    with pytest.raises(CatalogueDocumentError) as error:
        parse_catalogue({"catalogue": 1, "plugins": ["monty"]}, catalogue="acme", verified=False)

    assert "entry 0 is not a JSON object" in str(error.value)


def test_unknown_keys_inside_an_entry_are_ignored() -> None:
    """An entry has to be able to grow a field without every older build refusing the file."""
    entries = parse_catalogue(
        document({**entry("monty"), "homepage": "https://example.invalid", "stars": 4}),
        catalogue="acme",
        verified=False,
    )

    assert [item.plugin_id for item in entries] == ["monty"]


def test_an_unknown_top_level_key_is_refused() -> None:
    """The shape of the document is exactly what the `catalogue` version exists to change."""
    with pytest.raises(CatalogueDocumentError) as error:
        parse_catalogue(
            {**document(entry("monty")), "mirrors": []}, catalogue="acme", verified=False
        )

    assert "'mirrors'" in str(error.value)


def test_a_document_that_is_not_an_object_is_refused() -> None:
    with pytest.raises(CatalogueDocumentError) as error:
        parse_catalogue([entry("monty")], catalogue="acme", verified=False)

    assert "not a JSON object" in str(error.value)


def test_a_document_announcing_no_format_version_is_refused() -> None:
    with pytest.raises(CatalogueDocumentError) as error:
        parse_catalogue({"plugins": [entry("monty")]}, catalogue="acme", verified=False)

    assert "`catalogue` format version" in str(error.value)


def test_a_boolean_is_not_a_format_version() -> None:
    """`True` is an `int` in Python and is not a version number in anybody's convention."""
    with pytest.raises(CatalogueDocumentError):
        parse_catalogue({"catalogue": True, "plugins": []}, catalogue="acme", verified=False)


def test_a_document_announcing_a_newer_format_is_refused_rather_than_read() -> None:
    with pytest.raises(CatalogueDocumentError) as error:
        parse_catalogue(
            document(entry("monty"), version=CATALOGUE_FORMAT + 1), catalogue="acme", verified=False
        )

    assert str(CATALOGUE_FORMAT + 1) in str(error.value)


def test_a_document_with_no_plugins_list_is_refused() -> None:
    with pytest.raises(CatalogueDocumentError) as error:
        parse_catalogue({"catalogue": CATALOGUE_FORMAT}, catalogue="acme", verified=False)

    assert "no `plugins` list" in str(error.value)


def test_a_catalogue_listing_one_plugin_twice_is_refused() -> None:
    """Two entries for a name is a document that cannot say which one an install would take."""
    with pytest.raises(CatalogueDocumentError) as error:
        parse_catalogue(
            document(entry("monty"), entry("monty", source="pypi:not-monty")),
            catalogue="acme",
            verified=False,
        )

    assert "monty" in str(error.value)
    assert "more than once" in str(error.value)


def test_an_empty_catalogue_is_a_catalogue() -> None:
    """A source that currently offers nothing is not a source that is broken."""
    assert parse_catalogue({"catalogue": 1, "plugins": []}, catalogue="acme", verified=True) == ()


# ======================================================================================
# Acceptance 2 — every fetch goes through the injected transport
# ======================================================================================


def test_a_catalogue_is_fetched_through_the_injected_transport(
    tmp_path: Path, host: PublishingHost
) -> None:
    host.publish(ACME_URL, serialized(entry("monty"), entry("whodunnit")))

    catalogue = reader(tmp_path, host).registered(CatalogueSource(name="acme", url=ACME_URL))

    assert host.urls == [ACME_URL]
    assert [item.plugin_id for item in catalogue.entries] == ["monty", "whodunnit"]
    assert catalogue.name == "acme"
    assert catalogue.url == ACME_URL
    assert catalogue.fetched_at == NOW


def test_a_source_that_answers_with_an_error_is_refused_rather_than_half_read(
    tmp_path: Path, host: PublishingHost
) -> None:
    with pytest.raises(CatalogueDocumentError) as error:
        reader(tmp_path, host).registered(CatalogueSource(name="acme", url=ACME_URL))

    assert ACME_URL in str(error.value)
    assert not cache_file(tmp_path, "acme").exists()


def test_a_source_that_answers_with_something_that_is_not_json_is_refused(
    tmp_path: Path, host: PublishingHost
) -> None:
    host.publish(ACME_URL, b"<html>not a catalogue</html>")

    with pytest.raises(CatalogueDocumentError) as error:
        reader(tmp_path, host).registered(CatalogueSource(name="acme", url=ACME_URL))

    assert "not valid JSON" in str(error.value)
    assert not cache_file(tmp_path, "acme").exists()


def test_a_source_that_answers_with_bytes_that_are_not_utf8_is_refused(
    tmp_path: Path, host: PublishingHost
) -> None:
    host.publish(ACME_URL, b"\xff\xfe{}")

    with pytest.raises(CatalogueDocumentError) as error:
        reader(tmp_path, host).registered(CatalogueSource(name="acme", url=ACME_URL))

    assert "not UTF-8" in str(error.value)


def test_a_source_pointing_at_plain_http_is_refused_before_any_request(
    tmp_path: Path, host: PublishingHost
) -> None:
    """The strong form: the scheme is checked before the request reaches the transport."""
    insecure = "http://acme.example.invalid/catalogue.json"
    host.publish(insecure, serialized(entry("monty")))

    with pytest.raises(CatalogueDocumentError) as error:
        reader(tmp_path, host).registered(CatalogueSource(name="acme", url=insecure))

    assert "HTTPS" in str(error.value)
    assert host.requests == []


def test_a_transport_failure_is_reported_rather_than_raised_as_httpx(
    tmp_path: Path, host: PublishingHost
) -> None:
    def refuse(request: httpx.Request) -> httpx.Response:
        host.requests.append(request)
        raise httpx.ConnectError("connection refused", request=request)

    broken = CatalogueReader(
        settings=settings(tmp_path),
        cache=CatalogueCache(directory=tmp_path / "catalogues"),
        transport=httpx.MockTransport(refuse),
        now=Clock(),
    )

    with pytest.raises(CatalogueDocumentError):
        broken.registered(CatalogueSource(name="acme", url=ACME_URL))


def test_a_server_that_hands_back_more_than_the_ceiling_is_abandoned(
    tmp_path: Path, host: PublishingHost, signer: Signer
) -> None:
    body = serialized(entry("monty"))
    host.publish(ACME_URL, body)
    host.responses[f"{ACME_URL}{SIGNATURE_SUFFIX}"] = httpx.Response(
        200, content=b"A" * (MAX_SIGNATURE_BYTES + 1)
    )

    with pytest.raises(CatalogueRejected) as error:
        reader(tmp_path, host).registered(
            CatalogueSource(name="acme", url=ACME_URL, public_key=signer.public_key_line)
        )

    assert error.value.reason == "unsigned"
    assert not cache_file(tmp_path, "acme").exists()


# ======================================================================================
# Acceptance 3 — the official catalogue must be signed, and a bad one is never kept
# ======================================================================================


def test_the_official_catalogue_is_verified_against_the_installed_public_key(
    tmp_path: Path, host: PublishingHost, signer: Signer
) -> None:
    body = serialized(entry("monty"))
    host.publish(OFFICIAL_URL, body, signature=signer.sign(body))

    catalogue = reader(tmp_path, host, public_key=signer.public_key_text).official()

    assert catalogue.name == OFFICIAL_SOURCE_NAME
    assert catalogue.verified is True
    assert all(item.verified for item in catalogue.entries)
    # The document and its detached signature, in that order, over one client.
    assert host.urls == [OFFICIAL_URL, f"{OFFICIAL_URL}{SIGNATURE_SUFFIX}"]
    assert cache_file(tmp_path, OFFICIAL_SOURCE_NAME).exists()


def test_a_tampered_official_catalogue_is_rejected_and_nothing_is_cached(
    tmp_path: Path, host: PublishingHost, signer: Signer
) -> None:
    """A perfectly well-formed document, and a signature of the right shape for another one.

    This is the test the whole module exists for: the rejection cannot come from the parser,
    because the document parses, and it cannot come from the signature's format, because the
    signature is genuine. Only the signature *check* can produce it.
    """
    genuine = serialized(entry("monty", summary="What the publisher wrote."))
    tampered = serialized(entry("monty", summary="What somebody on the path wrote instead."))
    host.publish(OFFICIAL_URL, tampered, signature=signer.sign(genuine))

    # The tampered document is beyond reproach as a document.
    assert parse_catalogue(json.loads(tampered), catalogue="x", verified=False)

    with pytest.raises(CatalogueRejected) as error:
        reader(tmp_path, host, public_key=signer.public_key_text).official()

    assert error.value.reason == "signature"
    assert error.value.source == OFFICIAL_SOURCE_NAME
    assert not cache_file(tmp_path, OFFICIAL_SOURCE_NAME).exists()


def test_an_official_catalogue_signed_by_a_stranger_is_rejected(
    tmp_path: Path, host: PublishingHost, signer: Signer, stranger: Signer
) -> None:
    body = serialized(entry("monty"))
    host.publish(OFFICIAL_URL, body, signature=stranger.sign(body))

    with pytest.raises(CatalogueRejected) as error:
        reader(tmp_path, host, public_key=signer.public_key_text).official()

    assert error.value.reason == "signature"
    assert not cache_file(tmp_path, OFFICIAL_SOURCE_NAME).exists()


def test_an_official_catalogue_with_no_signature_published_is_rejected(
    tmp_path: Path, host: PublishingHost, signer: Signer
) -> None:
    """The official list is never read unsigned, however well formed it is."""
    host.publish(OFFICIAL_URL, serialized(entry("monty")))

    with pytest.raises(CatalogueRejected) as error:
        reader(tmp_path, host, public_key=signer.public_key_text).official()

    assert error.value.reason == "unsigned"
    assert not cache_file(tmp_path, OFFICIAL_SOURCE_NAME).exists()


def test_a_signature_that_is_not_utf8_rejects_the_official_catalogue(
    tmp_path: Path, host: PublishingHost, signer: Signer
) -> None:
    body = serialized(entry("monty"))
    host.publish(OFFICIAL_URL, body)
    host.responses[f"{OFFICIAL_URL}{SIGNATURE_SUFFIX}"] = httpx.Response(200, content=b"\xff\xfe")

    with pytest.raises(CatalogueRejected) as error:
        reader(tmp_path, host, public_key=signer.public_key_text).official()

    assert error.value.reason == "signature"


def test_a_build_with_no_release_key_cannot_read_the_official_catalogue(
    tmp_path: Path, host: PublishingHost, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The same rule a core release lives by, and the request is never even made."""

    def no_key() -> None:
        raise UpdateError("this build ships no release signing key")

    monkeypatch.setattr(catalogue_module, "load_installed_public_key", no_key)
    host.publish(OFFICIAL_URL, serialized(entry("monty")))

    with pytest.raises(CatalogueRejected) as error:
        reader(tmp_path, host).official()

    assert error.value.reason == "key"
    assert host.requests == []


# ======================================================================================
# Acceptance 4 — a registered source: keyed, keyed and lying, or keyless and unverified
# ======================================================================================


def test_a_registered_source_with_a_key_is_verified_the_same_way(
    tmp_path: Path, host: PublishingHost, signer: Signer
) -> None:
    body = serialized(entry("monty"), entry("whodunnit"))
    host.publish(ACME_URL, body, signature=signer.sign(body))

    catalogue = reader(tmp_path, host).registered(
        CatalogueSource(name="acme", url=ACME_URL, public_key=signer.public_key_line)
    )

    assert catalogue.verified is True
    assert all(item.verified for item in catalogue.entries)
    assert host.urls == [ACME_URL, f"{ACME_URL}{SIGNATURE_SUFFIX}"]


def test_a_registered_source_with_a_bad_signature_rejects_the_whole_catalogue(
    tmp_path: Path, host: PublishingHost, signer: Signer, stranger: Signer
) -> None:
    """No partial trust: not the entries that looked fine, not the ones before the tampering."""
    body = serialized(entry("monty"), entry("whodunnit"), entry("summarize"))
    host.publish(ACME_URL, body, signature=stranger.sign(body))

    with pytest.raises(CatalogueRejected) as error:
        reader(tmp_path, host).registered(
            CatalogueSource(name="acme", url=ACME_URL, public_key=signer.public_key_line)
        )

    assert error.value.reason == "signature"
    assert error.value.source == "acme"
    assert not cache_file(tmp_path, "acme").exists()


def test_a_registered_source_with_no_key_is_read_over_https_and_marked_unverified(
    tmp_path: Path, host: PublishingHost
) -> None:
    """F1's "anyone may publish", without pretending a key nobody gave exists."""
    host.publish(ACME_URL, serialized(entry("monty"), entry("whodunnit")))

    catalogue = reader(tmp_path, host).registered(CatalogueSource(name="acme", url=ACME_URL))

    assert catalogue.verified is False
    assert [item.verified for item in catalogue.entries] == [False, False]
    assert [item.catalogue for item in catalogue.entries] == ["acme", "acme"]
    # One request, not two: "no key" costs nothing and looks like nothing.
    assert host.urls == [ACME_URL]


def test_a_keyed_source_that_publishes_no_signature_is_rejected(
    tmp_path: Path, host: PublishingHost, signer: Signer
) -> None:
    """A key was given, so an absent signature is a document that cannot be checked."""
    host.publish(ACME_URL, serialized(entry("monty")))

    with pytest.raises(CatalogueRejected) as error:
        reader(tmp_path, host).registered(
            CatalogueSource(name="acme", url=ACME_URL, public_key=signer.public_key_line)
        )

    assert error.value.reason == "unsigned"


def test_a_source_whose_registered_key_will_not_parse_is_rejected_before_any_request(
    tmp_path: Path, host: PublishingHost
) -> None:
    """Quietly falling back to "unverified" is the one outcome nobody asked for."""
    host.publish(ACME_URL, serialized(entry("monty")))

    with pytest.raises(CatalogueRejected) as error:
        reader(tmp_path, host).registered(
            CatalogueSource(name="acme", url=ACME_URL, public_key="not-a-key")
        )

    assert error.value.reason == "key"
    assert host.requests == []


def test_a_catalogue_can_be_asked_for_one_entry(tmp_path: Path, host: PublishingHost) -> None:
    host.publish(
        ACME_URL,
        serialized(entry("monty"), entry("whodunnit", source="pypi:whodunnit")),
    )

    catalogue = reader(tmp_path, host).registered(CatalogueSource(name="acme", url=ACME_URL))

    found = catalogue.entry_for("whodunnit")
    assert found is not None
    assert found.install_source == "pypi:whodunnit"
    assert catalogue.entry_for("summarize") is None


# ======================================================================================
# Acceptance 7 — the cache, the interval it is judged against, and the clock
# ======================================================================================


def test_a_second_read_inside_the_check_interval_makes_no_request(
    tmp_path: Path, host: PublishingHost, signer: Signer
) -> None:
    body = serialized(entry("monty"))
    host.publish(ACME_URL, body, signature=signer.sign(body))
    clock = Clock()
    source = CatalogueSource(name="acme", url=ACME_URL, public_key=signer.public_key_line)

    first = reader(tmp_path, host, clock=clock).registered(source)
    asked_once = list(host.urls)

    clock.advance(CHECK_INTERVAL - 1)
    second = reader(tmp_path, host, clock=clock).registered(source)

    assert host.urls == asked_once, "the second read went to the network"
    assert second.entries == first.entries
    assert second.verified is True
    # The moment kept is when it was fetched, not when it was read back.
    assert second.fetched_at == NOW


def test_a_cache_older_than_the_check_interval_is_fetched_again(
    tmp_path: Path, host: PublishingHost
) -> None:
    host.publish(ACME_URL, serialized(entry("monty")))
    clock = Clock()
    source = CatalogueSource(name="acme", url=ACME_URL)

    reader(tmp_path, host, clock=clock).registered(source)
    clock.advance(CHECK_INTERVAL)
    later = reader(tmp_path, host, clock=clock).registered(source)

    assert host.urls == [ACME_URL, ACME_URL]
    assert later.fetched_at == NOW + timedelta(seconds=CHECK_INTERVAL)


def test_a_cached_catalogue_that_no_longer_verifies_is_forgotten_and_refetched(
    tmp_path: Path, host: PublishingHost, signer: Signer, stranger: Signer
) -> None:
    """A corrupt cache heals itself; a lying server is reported. That asymmetry on purpose."""
    body = serialized(entry("monty"))
    host.publish(ACME_URL, body, signature=signer.sign(body))
    keyed = CatalogueSource(name="acme", url=ACME_URL, public_key=signer.public_key_line)
    reader(tmp_path, host).registered(keyed)

    # The kept copy is now checked against a key it was never signed with.
    with_other_key = CatalogueSource(name="acme", url=ACME_URL, public_key=stranger.public_key_line)
    with pytest.raises(CatalogueRejected):
        reader(tmp_path, host).registered(with_other_key)

    # Refused and thrown away — never served, and gone from disk.
    assert not cache_file(tmp_path, "acme").exists()


def test_a_cached_unsigned_catalogue_is_refused_once_the_source_is_given_a_key(
    tmp_path: Path, host: PublishingHost, signer: Signer
) -> None:
    """Giving a source a key has to bite on what is already on disk, not only on the next GET.

    A copy kept while the source was keyless carries no signature. Serving it back because
    it happens to be fresh would mean a key that takes effect a day late — which is a key
    that does nothing on the day it is added.
    """
    body = serialized(entry("monty"))
    host.publish(ACME_URL, body, signature=signer.sign(body))
    clock = Clock()

    reader(tmp_path, host, clock=clock).registered(CatalogueSource(name="acme", url=ACME_URL))
    assert cache_file(tmp_path, "acme").exists()

    keyed = reader(tmp_path, host, clock=clock).registered(
        CatalogueSource(name="acme", url=ACME_URL, public_key=signer.public_key_line)
    )

    assert keyed.verified is True
    # The kept copy was refused, forgotten, and the source asked again — with its signature.
    assert host.urls == [ACME_URL, ACME_URL, f"{ACME_URL}{SIGNATURE_SUFFIX}"]


def test_a_cache_kept_under_the_same_name_for_another_url_is_ignored(
    tmp_path: Path, host: PublishingHost
) -> None:
    """A source removed and registered elsewhere keeps its name; its old listing is not it."""
    moved = "https://acme.example.invalid/v2/catalogue.json"
    host.publish(ACME_URL, serialized(entry("monty")))
    host.publish(moved, serialized(entry("whodunnit")))
    clock = Clock()

    reader(tmp_path, host, clock=clock).registered(CatalogueSource(name="acme", url=ACME_URL))
    after = reader(tmp_path, host, clock=clock).registered(CatalogueSource(name="acme", url=moved))

    assert [item.plugin_id for item in after.entries] == ["whodunnit"]
    assert host.urls == [ACME_URL, moved]


def test_a_cache_written_in_the_future_is_treated_as_stale(tmp_path: Path) -> None:
    """A clock that moved is not a fresh catalogue."""
    cache = CatalogueCache(directory=tmp_path / "catalogues")
    cache.write(
        "acme",
        url=ACME_URL,
        document=serialized(entry("monty")),
        signature=None,
        fetched_at=NOW + timedelta(seconds=60),
    )

    assert cache.read("acme", url=ACME_URL, max_age=CHECK_INTERVAL, now=NOW) is None


def test_a_cache_file_that_is_not_readable_is_simply_absent(tmp_path: Path) -> None:
    cache = CatalogueCache(directory=tmp_path / "catalogues")

    assert cache.read("acme", url=ACME_URL, max_age=CHECK_INTERVAL, now=NOW) is None


@pytest.mark.parametrize(
    "kept",
    [
        "not json at all",
        '["a list"]',
        '{"source": "other", "url": "' + ACME_URL + '"}',
        '{"source": "acme", "url": "somewhere else"}',
        '{"source": "acme", "url": "' + ACME_URL + '", "document": 7}',
        '{"source": "acme", "url": "' + ACME_URL + '", "document": "{}", "signature": 7}',
        '{"source": "acme", "url": "' + ACME_URL + '", "document": "{}", "signature": null}',
        '{"source": "acme", "url": "'
        + ACME_URL
        + '", "document": "{}", "signature": null, "fetched_at": 7}',
        '{"source": "acme", "url": "'
        + ACME_URL
        + '", "document": "{}", "signature": null, "fetched_at": "not a moment"}',
        '{"source": "acme", "url": "'
        + ACME_URL
        + '", "document": "{}", "signature": null, "fetched_at": "2026-09-19T12:00:00"}',
    ],
)
def test_a_cache_file_this_build_cannot_account_for_is_ignored(tmp_path: Path, kept: str) -> None:
    """Every one of these is "ask the server", because that is what the caller does anyway.

    The last is the one worth naming: a **naive** timestamp. Subtracting it from an aware one
    raises, and a cache entry is never worth an exception.
    """
    cache = CatalogueCache(directory=tmp_path / "catalogues")
    path = cache.path_for("acme")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(kept, encoding="utf-8")

    assert cache.read("acme", url=ACME_URL, max_age=CHECK_INTERVAL, now=NOW) is None


def test_a_source_name_that_is_not_a_name_never_becomes_a_path(tmp_path: Path) -> None:
    """The one place a registered name becomes a file name, so it is checked here too."""
    cache = CatalogueCache(directory=tmp_path / "catalogues")

    with pytest.raises(CatalogueDocumentError):
        cache.path_for("../../etc/passwd")

    # A read and a forget swallow it rather than raising: neither is worth an exception.
    assert cache.read("../../etc/passwd", url=ACME_URL, max_age=1.0, now=NOW) is None
    cache.forget("../../etc/passwd")


def test_forgetting_a_catalogue_that_cannot_be_removed_is_not_an_error(tmp_path: Path) -> None:
    blocker = tmp_path / "blocker"
    blocker.write_text("a file where a directory would have to be", encoding="utf-8")

    CatalogueCache(directory=blocker / "catalogues").forget("acme")


def test_the_clock_a_reader_uses_by_default_is_timezone_aware() -> None:
    """A naive default would be subtracted from an aware cache timestamp and raise."""
    moment = CatalogueReader.now()

    assert moment.tzinfo is not None
    assert moment.utcoffset() == timedelta(0)


def test_the_cache_lives_under_the_user_cache_directory() -> None:
    """A catalogue is a copy of something a server holds; losing it costs one request."""
    path = default_catalogue_cache_path()

    assert path.name == catalogue_module.CACHE_DIRNAME
    assert "innytypes" in str(path)
    # Named, never created: no import of this module may make a directory.
    assert not path.exists() or path.is_dir()


# ======================================================================================
# Acceptance 8 — this module decides what is offered, never what is installed
# ======================================================================================


def test_the_catalogue_module_never_reaches_the_install_or_lock_path() -> None:
    """Read off the module's own imports, so it cannot drift back without this going red.

    Plan 0003's D16 is the thing being protected: whether an artifact is genuine is settled
    by the lock's hashes, and a listing that could reach the installer would be a second
    answer to a question that already has one.
    """
    forbidden = (
        "innytypes.addons.install",
        "innytypes.addons.lock",
        "innytypes.addons.removal",
        "innytypes.addons.resolution",
        "innytypes.helper.environments",
        "innytypes.helper.plugins",
        "innytypes.helper.swap",
    )

    tree = ast.parse(Path(catalogue_module.__file__).read_text(encoding="utf-8"))
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module is not None:
            imported.add(node.module)
            imported.update(f"{node.module}.{alias.name}" for alias in node.names)

    assert not (imported & set(forbidden)), sorted(imported & set(forbidden))

    # And nothing calls one by name either, which an import inside a function would hide.
    text = Path(catalogue_module.__file__).read_text(encoding="utf-8")
    for module in forbidden:
        assert f"import {module}" not in text
