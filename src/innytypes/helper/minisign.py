"""Verifying a detached minisign signature — the one thing that makes a download trustworthy.

The helper downloads code that it will later run, from a server it does not control. Plan
0003 (*Core auto-update*, D10) is explicit about where the trust lives: **"the helper trusts
the signature, never the server."** Hetzner, Scaleway, a self-hosted Forgejo, GitHub Releases
or a CDN in front of any of them are all interchangeable precisely because none of them is
trusted. This module is where that sentence becomes code, so it is the most
security-sensitive file in the helper.

**Why minisign and not something hand-rolled.** D9 chose minisign, which is Ed25519 with a
tiny, fixed file format. The signature *format* is parsed here — it is four lines of text and
two base64 blobs, and a parser for it is honest work. The *cryptography* is not: signature
verification is `PyNaCl`'s :class:`~nacl.signing.VerifyKey`, which is a binding to libsodium,
the same library minisign itself is built on. So what verifies a release here and what
verifies it when the release manager runs ``minisign -V`` are the same implementation of the
same primitive, and there is no second opinion to drift.

**The format, in full.** A minisign public key is a comment line and one base64 line holding
2 bytes of algorithm, an 8-byte key id and a 32-byte Ed25519 public key. A detached signature
file is four lines::

    untrusted comment: <anything; not signed, not trusted, not used>
    <base64: 2-byte algorithm || 8-byte key id || 64-byte signature>
    trusted comment: <text covered by the global signature>
    <base64: 64-byte global signature over (signature || trusted comment)>

The algorithm is ``Ed`` when the signature covers the file's raw bytes, and ``ED`` when it
covers the file's BLAKE2b-512 hash instead (minisign's ``-H``, the prehashed form). Both are
supported here, because a release manager should not have to remember which one this helper
happens to accept.

**The global signature is checked, not skipped.** It is the easy half to leave out — the
artifact is already authenticated by the first signature — and leaving it out would mean the
trusted comment, the one place a release carries signed metadata, could be rewritten by
anybody. ``minisign -V`` checks it, so this does too, and a release whose trusted comment has
been edited is refused here exactly as it would be there.

**Every failure is one exception type.** :class:`MinisignError` covers a malformed key, a
malformed signature, a signature made by a different key, an algorithm this build does not
know, and a signature that simply does not verify. The caller's response is identical in all
of them and it is the rule from plan 0003 step 2: the artifact is deleted and reported, never
kept and never run. A caller that had to tell those cases apart to decide *whether* to delete
would be a caller with a way to get it wrong.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
from dataclasses import dataclass
from pathlib import Path

from nacl.exceptions import BadSignatureError, CryptoError
from nacl.signing import VerifyKey

__all__ = [
    "ALGORITHM_LEGACY",
    "ALGORITHM_PREHASHED",
    "MinisignError",
    "MinisignPublicKey",
    "MinisignSignature",
    "parse_public_key",
    "parse_signature",
    "verify_file",
]

# The two signature algorithms minisign emits. `Ed` signs the artifact's own bytes; `ED`
# signs its BLAKE2b-512 hash, which is what lets a signer stream a large file. Anything
# else is a format this build does not understand, and an unknown algorithm is refused
# rather than guessed at — guessing is how a verifier ends up verifying nothing.
ALGORITHM_LEGACY = b"Ed"
ALGORITHM_PREHASHED = b"ED"

# The prefix minisign puts on the line whose contents the global signature covers.
_TRUSTED_COMMENT_PREFIX = "trusted comment: "

# Fixed widths from the minisign format. Named because a bare `2`, `8`, `32` or `64` in a
# slice is exactly the kind of detail that is wrong for a year without anybody noticing.
_ALGORITHM_BYTES = 2
_KEY_ID_BYTES = 8
_PUBLIC_KEY_BYTES = 32
_SIGNATURE_BYTES = 64

# How much of a file is hashed at a time when the prehashed form is used. A release bundle
# is large enough that reading it whole to hash it would be a needless memory spike.
_HASH_CHUNK_BYTES = 1024 * 1024

# BLAKE2b-512, which is what minisign's prehashed mode signs.
_PREHASH_DIGEST_BYTES = 64


class MinisignError(Exception):
    """A signature did not verify, or a key or signature could not be read.

    One type for every failure on purpose: see the module docstring. Whatever went wrong,
    the artifact is deleted and reported, and nothing about it is run.
    """


@dataclass(frozen=True)
class MinisignPublicKey:
    """A parsed minisign public key: the key id it announces and the Ed25519 key itself."""

    key_id: bytes
    public_key: bytes


@dataclass(frozen=True)
class MinisignSignature:
    """A parsed detached minisign signature file, including its signed trusted comment."""

    algorithm: bytes
    key_id: bytes
    signature: bytes
    trusted_comment: str
    global_signature: bytes


def parse_public_key(text: str) -> MinisignPublicKey:
    """Read a minisign public key, from either the ``.pub`` file or the bare base64 line.

    Both shapes are accepted because both are things a person legitimately has: the file
    ``minisign -G`` writes carries an untrusted comment line above the key, while
    ``minisign -P`` prints the key line on its own.
    """
    line = _key_line(text)
    blob = _decode(line, what="public key")

    expected = _ALGORITHM_BYTES + _KEY_ID_BYTES + _PUBLIC_KEY_BYTES
    if len(blob) != expected:
        raise MinisignError(
            f"minisign public key is {len(blob)} bytes after decoding, expected {expected}"
        )

    algorithm = blob[:_ALGORITHM_BYTES]
    # A public key always announces `Ed`; the prehashed form is a property of a signature,
    # not of a key. A key claiming anything else is not a minisign public key.
    if algorithm != ALGORITHM_LEGACY:
        raise MinisignError(
            f"minisign public key announces algorithm {algorithm!r}, expected {ALGORITHM_LEGACY!r}"
        )

    return MinisignPublicKey(
        key_id=blob[_ALGORITHM_BYTES : _ALGORITHM_BYTES + _KEY_ID_BYTES],
        public_key=blob[_ALGORITHM_BYTES + _KEY_ID_BYTES :],
    )


def parse_signature(text: str) -> MinisignSignature:
    """Read a detached minisign signature: both signatures and the trusted comment between them."""
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if len(lines) != 4:
        raise MinisignError(
            f"minisign signature has {len(lines)} non-empty lines, expected 4 "
            "(untrusted comment, signature, trusted comment, global signature)"
        )

    _, signature_line, trusted_line, global_line = lines

    if not trusted_line.startswith(_TRUSTED_COMMENT_PREFIX):
        raise MinisignError(
            f"minisign signature's third line does not start with {_TRUSTED_COMMENT_PREFIX!r}"
        )

    blob = _decode(signature_line, what="signature")
    expected = _ALGORITHM_BYTES + _KEY_ID_BYTES + _SIGNATURE_BYTES
    if len(blob) != expected:
        raise MinisignError(
            f"minisign signature is {len(blob)} bytes after decoding, expected {expected}"
        )

    global_signature = _decode(global_line, what="global signature")
    if len(global_signature) != _SIGNATURE_BYTES:
        raise MinisignError(
            f"minisign global signature is {len(global_signature)} bytes after decoding, "
            f"expected {_SIGNATURE_BYTES}"
        )

    return MinisignSignature(
        algorithm=blob[:_ALGORITHM_BYTES],
        key_id=blob[_ALGORITHM_BYTES : _ALGORITHM_BYTES + _KEY_ID_BYTES],
        signature=blob[_ALGORITHM_BYTES + _KEY_ID_BYTES :],
        trusted_comment=trusted_line[len(_TRUSTED_COMMENT_PREFIX) :],
        global_signature=global_signature,
    )


def verify_file(path: Path, signature: MinisignSignature, key: MinisignPublicKey) -> None:
    """Verify ``path`` against ``signature`` and ``key``, raising :class:`MinisignError` if not.

    Returns ``None`` on success and raises on every failure, rather than returning a boolean.
    A boolean can be dropped at the call site and the artifact used anyway; an exception that
    nobody catches stops the update. For code that decides whether to run downloaded software,
    the failure mode of forgetting must be "refuse", not "proceed".
    """
    # The key id is public metadata, not a secret, and it is checked first only because a
    # signature made by a different key deserves a message that says so rather than a bare
    # "does not verify" that sends the reader looking for a corrupted download.
    if signature.key_id != key.key_id:
        raise MinisignError(
            f"minisign signature was made by key {signature.key_id.hex()}, but this release "
            f"ships public key {key.key_id.hex()}"
        )

    if signature.algorithm == ALGORITHM_PREHASHED:
        message = _blake2b(path)
    elif signature.algorithm == ALGORITHM_LEGACY:
        # The legacy form signs the artifact's own bytes, so they all have to be in hand at
        # once. Releases should be signed prehashed (`minisign -S -H`) for exactly this
        # reason; the legacy form is accepted so an older signing setup still verifies.
        message = path.read_bytes()
    else:
        raise MinisignError(
            f"minisign signature announces algorithm {signature.algorithm!r}, which this "
            f"build does not understand (expected {ALGORITHM_LEGACY!r} or "
            f"{ALGORITHM_PREHASHED!r})"
        )

    verify_key = _verify_key(key)

    try:
        verify_key.verify(message, signature.signature)
    except BadSignatureError as error:
        raise MinisignError(
            f"minisign signature does not verify against public key {key.key_id.hex()}"
        ) from error

    # The global signature covers the raw signature followed by the trusted comment. Without
    # this check the trusted comment is not trusted at all, whatever it is called.
    signed_comment = signature.signature + signature.trusted_comment.encode("utf-8")
    try:
        verify_key.verify(signed_comment, signature.global_signature)
    except BadSignatureError as error:
        raise MinisignError(
            "minisign global signature does not verify: the trusted comment does not belong "
            "to this signature"
        ) from error


def _verify_key(key: MinisignPublicKey) -> VerifyKey:
    """Turn the 32 parsed bytes into libsodium's verifier, naming what is wrong if they are not."""
    try:
        return VerifyKey(key.public_key)
    except (CryptoError, ValueError, TypeError) as error:
        raise MinisignError(
            f"minisign public key {key.key_id.hex()} is not a usable Ed25519 key"
        ) from error


def _blake2b(path: Path) -> bytes:
    """The BLAKE2b-512 hash of a file, read in chunks so a large bundle is never held whole."""
    digest = hashlib.blake2b(digest_size=_PREHASH_DIGEST_BYTES)
    with path.open("rb") as handle:
        while chunk := handle.read(_HASH_CHUNK_BYTES):
            digest.update(chunk)
    return digest.digest()


def _key_line(text: str) -> str:
    """The base64 line of a public key file: the first line that is not a comment."""
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("untrusted comment:"):
            continue
        return line
    raise MinisignError("minisign public key holds no key line")


def _decode(line: str, *, what: str) -> bytes:
    """Strict base64: ``validate=True`` so stray characters are an error, not silently dropped."""
    try:
        return base64.b64decode(line, validate=True)
    except (binascii.Error, ValueError) as error:
        raise MinisignError(f"minisign {what} is not valid base64") from error
