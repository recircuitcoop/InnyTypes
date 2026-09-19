"""The plugin catalogue — a signed listing of which plugins exist, and who says so.

Plan 0006, F1. The owner's answer is short and it settles more than it looks like it does:
the official list of plugins is **a signed JSON file published in a repository**, and *"any
plugin developper who follows this convention can become a plugin source"*. So the format
below is a **published convention**, not this project's private arrangement with itself.
There is no registry, nothing admits a developer and nobody can refuse one: publishing the
file at an HTTPS URL *is* becoming a source, and the official catalogue is simply the one this
application ships pointed at.

**Verification is not consent.** This is the sentence to keep, because it is the one that will
be mistaken later. Plan 0003's D16 is untouched by everything here: **the lock's hashes decide
whether an artifact is genuine**, for every publisher alike, and a catalogue cannot vouch for
a single byte of any plugin. What a catalogue signature settles is narrower and it is worth
saying out loud — that *this listing* came from that publisher and was not rewritten on the
way. Whether this machine then acts on its own is a third question again, and it is answered
by the source's own switch in `config.toml` (F2), never by the signature. A source you trust
completely may still be one you would rather update by hand.

**What is checked, in full.**

* The **official** catalogue MUST be signed, and its signature is verified against the public
  key shipped inside the **currently installed** release — the same key, loaded by the same
  :func:`~innytypes.helper.update.load_installed_public_key`, that a core release is verified
  against. A build with no key cannot read the official catalogue, exactly as it cannot update
  itself, and for the same reason: the alternative is trusting a listing nobody signed.
* A **registered** source MAY carry a public key, given when it is registered. When it does, a
  signature is **required** and a failure rejects the document outright.
* A registered source with **no** key is fetched over HTTPS and every entry it yields is marked
  ``verified=False``, so the window can say so beside each one.

**No partial trust.** A rejected catalogue is rejected whole — not the entries that looked
fine, not the ones from before the tampering. The same goes for a document this build cannot
parse: a parser that skips what it dislikes is a parser an attacker steers by feeding it
something unparseable, which is the argument
:class:`~innytypes.helper.update.ReleaseIndexError` already makes about the release index.

**Nothing rejected is ever cached.** The cache is written after verification *and* parsing
have both passed, so a document that failed either cannot be read back as if it had not.
What is cached is the bytes and the signature, never the parsed result, and a cache read runs
the identical verification — one verifier, used twice, so a tampered cache file is refused in
the same words a tampered response is. The one asymmetry is deliberate: a **cached** document
that fails is forgotten and the source is fetched again, where a **fetched** one that fails
raises. A corrupt cache should heal itself; a lying server should be reported.

**The document format — the convention itself.** A catalogue is one JSON object::

    {
      "catalogue": 1,
      "plugins": [
        {
          "id": "monty",
          "summary": "Watches what you do and files it in Anytype.",
          "source": "pypi:monty"
        }
      ]
    }

and the detached minisign signature is published beside it at the same URL with ``.minisig``
appended, which is what ``minisign -Sm catalogue.json`` writes with no arguments to remember.

* ``catalogue`` is the format version, and it is how this convention is allowed to change
  later. A document announcing a version this build does not know is refused rather than read
  optimistically.
* Each entry carries a plugin ``id`` (a well-formed addon id, because it becomes a section
  name in `config.toml` and an argument to an install), a one-line ``summary``, and a
  ``source`` — the very string a manifest's ``update.source`` uses, validated by
  :func:`~innytypes.helper.versions.parse_source` and by nothing new. That reuse is the point:
  a catalogue cannot offer a source the updater could not later read.
* **Unknown keys in an entry are ignored**, and unknown top-level keys are not. An entry has
  to be able to grow a field without every older build refusing the whole file, while the
  shape of the document itself is what ``catalogue`` exists to version.

**This module installs nothing.** It does not import the installer, the lock or the removal
path, it resolves no version and it writes to no environment. It decides which plugins a
person is *offered*; everything about how one is actually installed and verified is unchanged
and lives where it already did. ``tests/test_plugin_catalogue.py`` holds that by reading this
file's own imports.

**Every seam is injected**, so the gate never touches the network: the HTTP transport, the
cache directory and the clock are all fields, exactly as
:class:`~innytypes.helper.versions.VersionChecker` already does it.
"""

from __future__ import annotations

import json
import tempfile
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import httpx
from platformdirs import user_cache_path

from innytypes.addons.manifest import is_addon_id
from innytypes.helper.config import (
    APPLICATION_NAME,
    OFFICIAL_SOURCE_NAME,
    CatalogueSource,
    HelperSettings,
)
from innytypes.helper.minisign import (
    MinisignError,
    MinisignPublicKey,
    parse_public_key,
    parse_signature,
    verify_file,
)
from innytypes.helper.update import (
    UpdateError,
    load_installed_public_key,
    stream_https,
)
from innytypes.helper.versions import (
    DEFAULT_PLUGIN_INDEX_URL,
    REQUEST_TIMEOUT,
    GitSource,
    VersionCheckError,
    parse_source,
)
from innytypes.logs import get_logger

log = get_logger(__name__)

__all__ = [
    "CACHE_DIRNAME",
    "CATALOGUE_FILENAME",
    "CATALOGUE_FORMAT",
    "DEFAULT_CATALOGUE_URL",
    "MAX_CATALOGUE_BYTES",
    "MAX_SIGNATURE_BYTES",
    "MAX_SUMMARY_CHARS",
    "SIGNATURE_SUFFIX",
    "CachedCatalogue",
    "CatalogueCache",
    "CatalogueDocumentError",
    "CatalogueEntry",
    "CatalogueError",
    "CatalogueReader",
    "CatalogueRejected",
    "PluginCatalogue",
    "default_catalogue_cache_path",
    "parse_catalogue",
]

# The version of the published convention this build speaks. It is in the document rather
# than only in this file so that a catalogue can say what it is; a breaking change to the
# shape is a new number here and a refusal of everything else.
CATALOGUE_FORMAT = 1

# What a catalogue is called where it is published, and what the detached signature beside it
# is called. `.minisig` is minisign's own default suffix, so a publisher runs
# `minisign -Sm catalogue.json` and uploads both files with nothing to rename.
CATALOGUE_FILENAME = "catalogue.json"
SIGNATURE_SUFFIX = ".minisig"

# Where the catalogue this application ships pointed at is published. Like every other
# endpoint in the helper this is a **build-time setting of a release** (plan 0003,
# *Configuration*) rather than something `config.toml` can move: a user cannot repoint the
# official list, they register a source of their own beside it. It sits next to the per-plugin
# version documents `innytypes.helper.versions` already reads at the same base URL — a
# different document answering a different question, published in the same place.
DEFAULT_CATALOGUE_URL = f"{DEFAULT_PLUGIN_INDEX_URL}/{CATALOGUE_FILENAME}"

# The directory, inside the per-user cache directory, that fetched catalogues are kept in.
CACHE_DIRNAME = "catalogues"

# Ceilings on what a server may hand back. A catalogue of a thousand plugins is around two
# hundred kilobytes, and a minisign signature is four short lines; both of these are far past
# any real document and far short of a disk. A server streaming forever fills a log line.
MAX_CATALOGUE_BYTES = 1024 * 1024
MAX_SIGNATURE_BYTES = 4096

# How long an entry's one-line summary may be. It is drawn in a list beside a button, so a
# summary that is a novel is a listing a person cannot read — and the refusal says which entry
# it came from, which is more useful than a truncation nobody sees happen.
MAX_SUMMARY_CHARS = 200

# How much of a response is held at a time while it is counted against the ceilings above.
_DOWNLOAD_CHUNK_BYTES = 64 * 1024

# The whole of the top level of a version-1 catalogue. Anything else is refused rather than
# skipped: an entry may grow a field, but the shape of the document is exactly what the
# `catalogue` version number exists to change.
_KNOWN_TOP_LEVEL_KEYS = frozenset({"catalogue", "plugins"})


def _utc_now() -> datetime:
    """The clock, named so it can be replaced by a field default rather than by patching."""
    return datetime.now(UTC)


class CatalogueError(RuntimeError):
    """The base of everything this module refuses. Catch this to report and carry on.

    One base type because the caller's response is the same for all of them: the source is
    listed with what went wrong instead of with its plugins, and every **other** source is
    still read. One bad catalogue must not empty the window.
    """


class CatalogueDocumentError(CatalogueError):
    """The catalogue could not be fetched, or could not be understood.

    Strict on purpose, and for the reason
    :class:`~innytypes.helper.update.ReleaseIndexError` already gives: a document this build
    cannot account for is a fact worth reporting, never a reason to keep the entries that
    happened to parse.
    """


class CatalogueRejected(CatalogueError):
    """A catalogue was fetched and refused on its signature; nothing of it is used or kept.

    ``reason`` is one of ``unsigned``, ``signature`` or ``key``. It exists for the report a
    person reads, never for a decision: by the time this is raised every reason has had the
    same consequence, which is that the whole document is gone and nothing was cached.
    """

    def __init__(self, *, source: str, reason: str, detail: str) -> None:
        super().__init__(
            f"the plugin catalogue from {source!r} failed its {reason} check and was "
            f"discarded: {detail}"
        )
        self.source = source
        self.reason = reason
        self.detail = detail


@dataclass(frozen=True)
class CatalogueEntry:
    """One plugin a catalogue says exists, and what installing it would ask for.

    ``verified`` is a property of the **listing**, not of the plugin: it says the catalogue
    this entry came from carried a signature that checked out against a key this machine
    holds. It says nothing whatever about the artifact an install would fetch — that is
    settled by the lock's hashes (plan 0003, D16) for a verified and an unverified listing
    alike. The flag exists so the window can be honest about where a name came from, and a
    reader that treats it as a safety rating has read it backwards.
    """

    plugin_id: str
    summary: str
    install_source: str
    catalogue: str
    verified: bool


@dataclass(frozen=True)
class PluginCatalogue:
    """One source's whole listing, as read: where from, when, and whether it was signed."""

    name: str
    url: str
    verified: bool
    fetched_at: datetime
    entries: tuple[CatalogueEntry, ...]

    def entry_for(self, plugin_id: str) -> CatalogueEntry | None:
        """The entry for one plugin, or ``None`` when this catalogue does not list it."""
        for entry in self.entries:
            if entry.plugin_id == plugin_id:
                return entry
        return None


@dataclass(frozen=True)
class CachedCatalogue:
    """One catalogue as it was kept on disk: the bytes, the signature and the moment."""

    document: bytes
    signature: str | None
    fetched_at: datetime


def default_catalogue_cache_path() -> Path:
    """Where fetched catalogues are kept for this user, creating nothing.

    The **cache** directory, not the config one: a catalogue is a copy of something a server
    holds, and losing it costs one request. `appauthor=False` keeps the Windows vendor folder
    out of the path, as everywhere else in this application.
    """
    return user_cache_path(APPLICATION_NAME, appauthor=False) / CACHE_DIRNAME


def parse_catalogue(
    document: object, *, catalogue: str, verified: bool
) -> tuple[CatalogueEntry, ...]:
    """Validate one catalogue document, refusing anything it cannot account for.

    Pure, and separate from the fetch on purpose: this is the half of the convention another
    implementation would have to match, and it is the half a test can drive with a dictionary.
    Every refusal names the entry it came from, because a catalogue of forty plugins with one
    bad line is useless to fix otherwise.
    """
    if not isinstance(document, Mapping):
        raise CatalogueDocumentError(f"the catalogue from {catalogue!r} is not a JSON object")

    announced = document.get("catalogue")
    if not isinstance(announced, int) or isinstance(announced, bool):
        raise CatalogueDocumentError(
            f"the catalogue from {catalogue!r} does not announce a `catalogue` format version; "
            f"this build reads version {CATALOGUE_FORMAT}"
        )
    if announced != CATALOGUE_FORMAT:
        raise CatalogueDocumentError(
            f"the catalogue from {catalogue!r} announces format version {announced}, and this "
            f"build reads version {CATALOGUE_FORMAT}. A newer `innytypes` is what reads it"
        )

    unknown = sorted(key for key in document if key not in _KNOWN_TOP_LEVEL_KEYS)
    if unknown:
        raise CatalogueDocumentError(
            f"the catalogue from {catalogue!r} holds {', '.join(repr(key) for key in unknown)} "
            f"at the top level, which version {CATALOGUE_FORMAT} of this convention does not "
            "define. The shape of the document is what `catalogue` exists to version, so a "
            "build that read past it would be guessing at what it was told"
        )

    listed = document.get("plugins")
    if not isinstance(listed, list):
        raise CatalogueDocumentError(
            f"the catalogue from {catalogue!r} has no `plugins` list; a catalogue publishes "
            "one entry per plugin it offers"
        )

    entries = tuple(
        _entry(published, position=position, catalogue=catalogue, verified=verified)
        for position, published in enumerate(listed)
    )

    seen: set[str] = set()
    repeated: set[str] = set()
    for entry in entries:
        if entry.plugin_id in seen:
            repeated.add(entry.plugin_id)
        seen.add(entry.plugin_id)

    duplicates = sorted(repeated)
    if duplicates:
        raise CatalogueDocumentError(
            f"the catalogue from {catalogue!r} lists {', '.join(duplicates)} more than once; "
            "one plugin has one entry, and two entries for a name is a document that cannot "
            "say which one an install would take"
        )

    return entries


@dataclass(frozen=True)
class CatalogueCache:
    """Fetched catalogues, kept on disk with the moment each one arrived.

    The file name is the source's own name, which is why a source name must be a well-formed
    addon id: this is the one place a registered name becomes a path, and a name with a
    separator or a ``..`` in it would be a path somewhere else. The check is repeated here
    rather than trusted from `config.toml`, because a :class:`CatalogueSource` can be
    constructed by anything and this is where the consequence lands.
    """

    directory: Path

    def path_for(self, name: str) -> Path:
        """Where this source's catalogue is kept, refusing a name that is not a name."""
        if not is_addon_id(name):
            raise CatalogueDocumentError(
                f"{name!r} is not a well-formed source name, so it names no cache file: "
                "expected lowercase letters and digits joined by single hyphens"
            )
        return self.directory / f"{name}.json"

    def read(self, name: str, *, url: str, max_age: float, now: datetime) -> CachedCatalogue | None:
        """The kept copy, or ``None`` when there is none, it is stale, or it is unreadable.

        ``None`` for every one of those, because the caller does exactly the same thing in
        all three cases: ask the server. A cache is never a reason to report a failure.

        The **URL is part of the match**. A source that has been removed and registered again
        somewhere else keeps its name, and serving the old server's listing under the new
        one's name would be this module lying about where an entry came from.
        """
        try:
            raw = self.path_for(name).read_bytes()
        except (OSError, CatalogueDocumentError):
            return None

        try:
            kept = json.loads(raw)
        except ValueError:
            return None
        if not isinstance(kept, Mapping):
            return None

        if kept.get("source") != name or kept.get("url") != url:
            return None

        document = kept.get("document")
        signature = kept.get("signature")
        if not isinstance(document, str) or not isinstance(signature, str | None):
            return None

        fetched_at = _moment(kept.get("fetched_at"))
        if fetched_at is None:
            return None

        age = (now - fetched_at).total_seconds()
        # A negative age is a clock that moved, not a fresh catalogue. Treated as stale so a
        # machine whose time jumped forward and back does not sit on one listing for ever.
        if age < 0 or age >= max_age:
            return None

        return CachedCatalogue(
            document=document.encode("utf-8"), signature=signature, fetched_at=fetched_at
        )

    def write(
        self,
        name: str,
        *,
        url: str,
        document: bytes,
        signature: str | None,
        fetched_at: datetime,
    ) -> None:
        """Keep one catalogue that has already been verified **and** parsed.

        Called from exactly one place, after both checks, so "nothing rejected is cached" is a
        property of where this is called from rather than of anybody remembering it.
        """
        path = self.path_for(name)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(
                {
                    "source": name,
                    "url": url,
                    "fetched_at": fetched_at.isoformat(),
                    "document": document.decode("utf-8"),
                    "signature": signature,
                },
                indent=2,
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )

    def forget(self, name: str) -> None:
        """Throw one kept catalogue away, saying nothing when there was none."""
        try:
            self.path_for(name).unlink(missing_ok=True)
        except (OSError, CatalogueDocumentError):
            # A cache that cannot be cleared is not a reason to fail a read: the caller is
            # already on its way to the server, and the stale file is refused again next time.
            log.debug("could not clear the cached catalogue for %s", name)


@dataclass(frozen=True)
class CatalogueReader:
    """Reads the official catalogue and any registered source, cache first, network second.

    Everything that leaves the process is a field. ``transport`` is what the gate fills with
    an :class:`httpx.MockTransport`; ``now`` is what lets a test age a cache entry without
    waiting; ``public_key`` is what lets a test verify against a key pair it generated rather
    than against the one a real release ships. Production leaves all three alone.

    **How long a cached catalogue counts as fresh is the update check interval**
    (``update.check_interval``), read live from `config.toml` like every other switch. It is
    the same number that decides how often the helper looks for a new release, and there is no
    second interval to keep in step with it.
    """

    settings: HelperSettings
    cache: CatalogueCache
    transport: httpx.BaseTransport | None = None
    now: Callable[[], datetime] = _utc_now
    official_url: str = DEFAULT_CATALOGUE_URL
    public_key: MinisignPublicKey | None = None

    def official(self) -> PluginCatalogue:
        """The catalogue this application ships pointed at. It must be signed."""
        return self._read(
            name=OFFICIAL_SOURCE_NAME, url=self.official_url, key=self._official_key()
        )

    def registered(self, source: CatalogueSource) -> PluginCatalogue:
        """One source the user has registered, verified only if it was given a key.

        A source with a key gets the same treatment the official one does — a signature is
        required and a failure rejects the document. A source without one is fetched over
        HTTPS and its entries are marked unverified, which is what keeps F1's "anyone may
        publish" true without pretending a key nobody gave exists.
        """
        return self._read(name=source.name, url=source.url, key=self._source_key(source))

    # --- the one read path, used by both ----------------------------------------------------

    def _read(self, *, name: str, url: str, key: MinisignPublicKey | None) -> PluginCatalogue:
        """Cache first, then the server — and only one rule about keys, applied to both.

        **A key means a signature is required; no key means every entry is unverified.** There
        is no third case and no per-source policy to get wrong: the presence of a key *is* the
        policy, which is why the official catalogue is simply the read that always has one.
        """
        cached = self.cache.read(name, url=url, max_age=self._max_age(), now=self.now())
        if cached is not None:
            try:
                return self._build(
                    name=name,
                    url=url,
                    document=cached.document,
                    signature=cached.signature,
                    key=key,
                    fetched_at=cached.fetched_at,
                )
            except CatalogueError as error:
                # See the module docstring: a kept copy that no longer passes is thrown away
                # and the source is asked again. It is never used, and it is never the answer.
                log.warning("the cached catalogue for %s was refused (%s); refetching", name, error)
                self.cache.forget(name)

        document, signature = self._fetch(name=name, url=url, signed=key is not None)
        fetched_at = self.now()

        # Verified and parsed BEFORE anything is written. Everything after this line is a
        # catalogue that passed; everything that did not has already raised.
        catalogue = self._build(
            name=name,
            url=url,
            document=document,
            signature=signature,
            key=key,
            fetched_at=fetched_at,
        )

        self.cache.write(
            name, url=url, document=document, signature=signature, fetched_at=fetched_at
        )
        return catalogue

    def _build(
        self,
        *,
        name: str,
        url: str,
        document: bytes,
        signature: str | None,
        key: MinisignPublicKey | None,
        fetched_at: datetime,
    ) -> PluginCatalogue:
        """Verify, then parse, then hand back — in that order, and never the other way.

        The signature is checked over the **bytes as they arrived**, before anything is
        decoded or interpreted, so what was signed and what is verified cannot drift apart.
        """
        verified = _verify(document=document, signature=signature, key=key, source=name)

        try:
            parsed = json.loads(document.decode("utf-8"))
        except UnicodeDecodeError as error:
            raise CatalogueDocumentError(
                f"the catalogue at {url} is not UTF-8 text: {error}"
            ) from error
        except ValueError as error:
            raise CatalogueDocumentError(
                f"the catalogue at {url} is not valid JSON: {error}"
            ) from error

        return PluginCatalogue(
            name=name,
            url=url,
            verified=verified,
            fetched_at=fetched_at,
            entries=parse_catalogue(parsed, catalogue=name, verified=verified),
        )

    def _fetch(self, *, name: str, url: str, signed: bool) -> tuple[bytes, str | None]:
        """The document, and its signature when one is required — over one client.

        The signature is only asked for when a key exists to check it against. A source with
        no key is one request, not two, so "no key" costs nothing and looks like nothing.
        """
        with httpx.Client(transport=self.transport, timeout=REQUEST_TIMEOUT) as client:
            document = _get(client, url, limit=MAX_CATALOGUE_BYTES, what="a plugin catalogue")

            if not signed:
                return document, None

            signature_url = f"{url}{SIGNATURE_SUFFIX}"
            try:
                raw = _get(
                    client,
                    signature_url,
                    limit=MAX_SIGNATURE_BYTES,
                    what="a plugin catalogue signature",
                )
            except CatalogueDocumentError as error:
                # A key was given for this source, so an absent or unreachable signature is
                # not a document without one — it is a document that cannot be checked, and
                # those are refused rather than read.
                raise CatalogueRejected(
                    source=name,
                    reason="unsigned",
                    detail=f"no signature could be read at {signature_url}: {error}",
                ) from error

            try:
                return document, raw.decode("utf-8")
            except UnicodeDecodeError as error:
                raise CatalogueRejected(
                    source=name,
                    reason="signature",
                    detail=f"the signature at {signature_url} is not UTF-8 text: {error}",
                ) from error

    # --- which key, if any, a read is verified against --------------------------------------

    def _official_key(self) -> MinisignPublicKey:
        """The key the official catalogue is verified against: the installed release's own.

        Never a key fetched beside the catalogue, and never one from `config.toml`. It is the
        key that came with the software already running, which is the same rule plan 0003 step
        2 applies to a release — and for the same reason, stated there: the alternative to
        "refuse" is "accept a listing nobody signed".
        """
        if self.public_key is not None:
            return self.public_key

        try:
            return load_installed_public_key()
        except UpdateError as error:
            raise CatalogueRejected(
                source=OFFICIAL_SOURCE_NAME,
                reason="key",
                detail=str(error),
            ) from error

    def _source_key(self, source: CatalogueSource) -> MinisignPublicKey | None:
        """The key a registered source was given, or ``None`` when it was given none.

        A key that will not parse rejects the source outright rather than falling back to
        "unverified". The user asked for this source to be checked; quietly stopping checking
        it because the key was mistyped is the one outcome nobody asked for.
        """
        if source.public_key is None:
            return None

        try:
            return parse_public_key(source.public_key)
        except MinisignError as error:
            raise CatalogueRejected(
                source=source.name,
                reason="key",
                detail=f"the public key registered for this source is unusable: {error}",
            ) from error

    def _max_age(self) -> float:
        """How old a cached catalogue may be: the update check interval, read live."""
        return self.settings.current.update.check_interval


# --- verification ---------------------------------------------------------------------------


def _verify(
    *, document: bytes, signature: str | None, key: MinisignPublicKey | None, source: str
) -> bool:
    """Whether this document is verified — raising when it was supposed to be and is not.

    The crypto is :mod:`innytypes.helper.minisign` and nothing else, down to the file it
    verifies: the bytes are written to a scratch file this function makes and
    :func:`~innytypes.helper.minisign.verify_file` is called on it, rather than a second entry
    point being carved into the most security-sensitive module in the helper. The scratch name
    is this module's own and never comes from the document, and the directory is removed
    whatever happens.
    """
    if key is None:
        # No key was ever given for this source. The document is used, and every entry it
        # yields says so (F1: anyone may publish, and the window says who did).
        return False

    if signature is None:
        raise CatalogueRejected(
            source=source,
            reason="unsigned",
            detail="a public key is registered for this source, so an unsigned catalogue is "
            "not read",
        )

    with tempfile.TemporaryDirectory() as scratch:
        path = Path(scratch) / CATALOGUE_FILENAME
        path.write_bytes(document)

        try:
            verify_file(path, parse_signature(signature), key)
        except MinisignError as error:
            raise CatalogueRejected(source=source, reason="signature", detail=str(error)) from error

    return True


# --- reading one entry ------------------------------------------------------------------------


def _entry(published: object, *, position: int, catalogue: str, verified: bool) -> CatalogueEntry:
    """One `plugins` entry, with every field it must carry, named by where it sits."""
    where = f"the catalogue from {catalogue!r}, entry {position}"

    if not isinstance(published, Mapping):
        raise CatalogueDocumentError(f"{where} is not a JSON object")

    plugin_id = _string(published, "id", where=where)
    if not is_addon_id(plugin_id):
        raise CatalogueDocumentError(
            f"{where}: `id` is {plugin_id!r}, which is not a well-formed addon id. An id "
            "becomes a section of config.toml and an argument to an install, so it is "
            "lowercase letters and digits joined by single hyphens and nothing else"
        )

    summary = _string(published, "summary", where=where).strip()
    if len(summary) > MAX_SUMMARY_CHARS:
        raise CatalogueDocumentError(
            f"{where}: `summary` is {len(summary)} characters, and a catalogue entry's summary "
            f"is one line of at most {MAX_SUMMARY_CHARS}"
        )
    if not all(character.isprintable() for character in summary):
        raise CatalogueDocumentError(
            f"{where}: `summary` holds a control character. It is drawn in a list beside a "
            "button, and text that can move a cursor is not text"
        )

    install_source = _string(published, "source", where=where)
    _check_source(install_source, where=where, plugin_id=plugin_id)

    return CatalogueEntry(
        plugin_id=plugin_id,
        summary=summary,
        install_source=install_source,
        catalogue=catalogue,
        verified=verified,
    )


def _check_source(text: str, *, where: str, plugin_id: str) -> None:
    """The entry's source string, judged by the parser that will later have to read it.

    :func:`~innytypes.helper.versions.parse_source` and nothing new, so a catalogue can never
    offer a spelling the updater would refuse once the plugin was installed. The one rule
    added on top is the HTTPS rule: a git source is a URL this machine would clone, and the
    listing has no business naming one that is not encrypted.

    The HTTPS rule is the literal prefix, the same test
    :func:`innytypes.helper.config._parse_source` applies to a registered source's URL, and
    deliberately not ``httpx.URL(...).scheme``: this text came off the wire, and
    :class:`httpx.URL` *raises* on some malformed input, which would put an
    :class:`httpx.InvalidURL` through a caller that is catching :class:`CatalogueError`. A
    document is refused by this module's own refusal or not at all.
    """
    try:
        source = parse_source(text, plugin_id=plugin_id)
    except VersionCheckError as error:
        raise CatalogueDocumentError(f"{where}: {error}") from error

    if isinstance(source, GitSource) and not source.url.lower().startswith("https://"):
        raise CatalogueDocumentError(
            f"{where}: `source` is {text!r}, and a catalogue never offers a git source that "
            "is not HTTPS"
        )


def _string(entry: Mapping[str, object], key: str, *, where: str) -> str:
    """One required text field, refusing an absent, empty or non-text one by name."""
    if key not in entry:
        raise CatalogueDocumentError(f"{where}: `{key}` is missing")

    value = entry[key]
    if not isinstance(value, str):
        raise CatalogueDocumentError(f"{where}: `{key}` must be text, got {value!r}")
    if not value.strip():
        raise CatalogueDocumentError(f"{where}: `{key}` is empty")
    return value


def _moment(value: object) -> datetime | None:
    """One ISO timestamp from the cache, or ``None`` when it is not one this can compare.

    A naive timestamp is refused rather than assumed to be UTC: it would be subtracted from an
    aware one and raise, and a cache entry is never worth an exception.
    """
    if not isinstance(value, str):
        return None

    try:
        moment = datetime.fromisoformat(value)
    except ValueError:
        return None

    return None if moment.tzinfo is None else moment


# --- fetching -----------------------------------------------------------------------------------


def _get(client: httpx.Client, url: str, *, limit: int, what: str) -> bytes:
    """One GET over HTTPS, capped, through the helper's one fetcher.

    :func:`~innytypes.helper.update.stream_https` and nothing else: it is where the HTTPS rule
    is applied to every redirect hop **before** the request goes out, and a second GET in this
    file would be a second place for that check to be missing.
    """
    received = 0
    chunks: list[bytes] = []

    try:
        with stream_https(client, url, what=what) as response:
            for chunk in response.iter_bytes(_DOWNLOAD_CHUNK_BYTES):
                received += len(chunk)
                if received > limit:
                    raise CatalogueDocumentError(
                        f"{url} passed {limit} bytes and was abandoned; {what} is a small document"
                    )
                chunks.append(chunk)
    except UpdateError as error:
        raise CatalogueDocumentError(str(error)) from error
    except httpx.HTTPError as error:
        raise CatalogueDocumentError(f"{url} could not be read: {error}") from error

    return b"".join(chunks)
