// Verifying a detached minisign signature: helper/minisign.py, ported (plan 0018 §3; WI-0018-14).
//
// Plan 0003 D10 is where the trust lives: "the helper trusts the signature, never the server".
// Whatever hosts a package, a catalogue or a release, only a signature this code accepts makes
// it trustworthy.
//
// The format, in full. A public key is an optional comment line and one base64 line: 2 bytes of
// algorithm (`Ed`), an 8-byte key id and a 32-byte Ed25519 key. A signature file is four lines:
//
//     untrusted comment: <anything; not signed, not trusted, not used>
//     <base64: 2-byte algorithm || 8-byte key id || 64-byte signature>
//     trusted comment: <text covered by the global signature>
//     <base64: 64-byte global signature over (signature || trusted comment)>
//
// `Ed` signs the file's own bytes; `ED` signs its BLAKE2b-512 hash (minisign -H, and minisign's
// default since 0.10). Both verify, and the one a signature announces is the one used: an `ED`
// signature is never tried as `Ed`, or the other way round.
//
// The global signature is checked, never skipped: without it the trusted comment, the one place
// a signature carries signed metadata, could be rewritten by anybody. `minisign -V` checks it.
//
// Pure: parsing and the verification rules. The two primitives, Ed25519 and BLAKE2b-512, are
// passed in by adapters/signature/minisign.ts, so this file has no I/O and imports nothing.

/** `Ed`: the signature covers the file's bytes. The only algorithm a public key announces. */
export const ALGORITHM_LEGACY = "Ed";
/** `ED`: the signature covers the file's BLAKE2b-512 hash. */
export const ALGORITHM_PREHASHED = "ED";

const TRUSTED_COMMENT_PREFIX = "trusted comment: ";
const UNTRUSTED_COMMENT_PREFIX = "untrusted comment:";

// Fixed widths from the minisign format.
const ALGORITHM_BYTES = 2;
const KEY_ID_BYTES = 8;
const PUBLIC_KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;

/**
 * Why a signature was refused. Every one of them has the same consequence (the bytes are not
 * used); the reason is for the person reading the report, and for tests that must tell a
 * refusal for the right reason from a refusal for any reason.
 *
 * - `malformed-key` / `malformed-signature`: the text is not a minisign key or signature.
 * - `wrong-key`: the signature was made by a key with another id than the one trusted.
 * - `unknown-algorithm`: the signature announces neither `Ed` nor `ED`.
 * - `bad-signature`: the signature does not verify over these bytes (a wrong signature, or a
 *   tampered file: the two cannot be told apart, and do not need to be).
 * - `tampered-comment`: the global signature does not cover this trusted comment.
 */
export type MinisignRefusal =
  | "malformed-key"
  | "malformed-signature"
  | "wrong-key"
  | "unknown-algorithm"
  | "bad-signature"
  | "tampered-comment";

/** A signature did not verify, or a key or signature could not be read. */
export class MinisignError extends Error {
  override name = "MinisignError";
  readonly reason: MinisignRefusal;

  constructor(reason: MinisignRefusal, message: string) {
    super(message);
    this.reason = reason;
  }
}

export interface MinisignPublicKey {
  readonly keyId: Uint8Array;
  readonly publicKey: Uint8Array;
}

export interface MinisignSignature {
  /** Two ASCII characters, as announced; `Ed` and `ED` are the only ones that verify. */
  readonly algorithm: string;
  readonly keyId: Uint8Array;
  readonly signature: Uint8Array;
  readonly trustedComment: string;
  readonly globalSignature: Uint8Array;
}

/**
 * The Ed25519 primitive: whether `signature` is `publicKey`'s signature over `message`. It
 * throws when the 32 bytes are not a usable Ed25519 key.
 */
export type Ed25519Verify = (
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
) => boolean;

/** The primitives verification runs on; the adapter supplies both. */
export interface MinisignPrimitives {
  readonly ed25519: Ed25519Verify;
  /** The 64-byte BLAKE2b digest of `bytes`, which the pre-hashed form signs. */
  readonly blake2b512: (bytes: Uint8Array) => Uint8Array;
}

/** A key id as minisign prints it: hex, in the order the bytes are stored. */
export function keyIdHex(keyId: Uint8Array): string {
  return Array.from(keyId, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Strict base64, as Python's `b64decode(validate=True)`: stray characters and wrong padding
 * are an error, never silently dropped.
 */
function decode(line: string, what: string, reason: MinisignRefusal): Uint8Array {
  if (line.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(line)) {
    throw new MinisignError(reason, `minisign ${what} is not valid base64`);
  }
  return Uint8Array.from(atob(line), (character) => character.charCodeAt(0));
}

function ascii(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

/**
 * A public key, from either the `.pub` file (comment line, key line) or the bare key line that
 * `minisign -P` prints and a registered source stores.
 */
export function parsePublicKey(text: string): MinisignPublicKey {
  const line = text
    .split(/\r\n|\r|\n/)
    .map((raw) => raw.trim())
    .find((raw) => raw !== "" && !raw.startsWith(UNTRUSTED_COMMENT_PREFIX));
  if (line === undefined) {
    throw new MinisignError("malformed-key", "minisign public key holds no key line");
  }
  const blob = decode(line, "public key", "malformed-key");
  const expected = ALGORITHM_BYTES + KEY_ID_BYTES + PUBLIC_KEY_BYTES;
  if (blob.length !== expected) {
    throw new MinisignError(
      "malformed-key",
      `minisign public key is ${String(blob.length)} bytes after decoding, expected ${String(expected)}`,
    );
  }
  // The prehashed form is a property of a signature, not of a key.
  const algorithm = ascii(blob.subarray(0, ALGORITHM_BYTES));
  if (algorithm !== ALGORITHM_LEGACY) {
    throw new MinisignError(
      "malformed-key",
      `minisign public key announces algorithm "${algorithm}", expected "${ALGORITHM_LEGACY}"`,
    );
  }
  return {
    keyId: blob.slice(ALGORITHM_BYTES, ALGORITHM_BYTES + KEY_ID_BYTES),
    publicKey: blob.slice(ALGORITHM_BYTES + KEY_ID_BYTES),
  };
}

/** A detached signature: both signatures and the trusted comment between them. */
export function parseSignature(text: string): MinisignSignature {
  const lines = text
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const [, signatureLine = "", trustedLine = "", globalLine = ""] = lines;
  if (lines.length !== 4) {
    throw new MinisignError(
      "malformed-signature",
      `minisign signature has ${String(lines.length)} non-empty lines, expected 4 ` +
        "(untrusted comment, signature, trusted comment, global signature)",
    );
  }
  if (!trustedLine.startsWith(TRUSTED_COMMENT_PREFIX)) {
    throw new MinisignError(
      "malformed-signature",
      `minisign signature's third line does not start with "${TRUSTED_COMMENT_PREFIX}"`,
    );
  }

  const blob = decode(signatureLine, "signature", "malformed-signature");
  const expected = ALGORITHM_BYTES + KEY_ID_BYTES + SIGNATURE_BYTES;
  if (blob.length !== expected) {
    throw new MinisignError(
      "malformed-signature",
      `minisign signature is ${String(blob.length)} bytes after decoding, expected ${String(expected)}`,
    );
  }
  const globalSignature = decode(globalLine, "global signature", "malformed-signature");
  if (globalSignature.length !== SIGNATURE_BYTES) {
    throw new MinisignError(
      "malformed-signature",
      `minisign global signature is ${String(globalSignature.length)} bytes after decoding, ` +
        `expected ${String(SIGNATURE_BYTES)}`,
    );
  }
  return {
    algorithm: ascii(blob.subarray(0, ALGORITHM_BYTES)),
    keyId: blob.slice(ALGORITHM_BYTES, ALGORITHM_BYTES + KEY_ID_BYTES),
    signature: blob.slice(ALGORITHM_BYTES + KEY_ID_BYTES),
    trustedComment: trustedLine.slice(TRUSTED_COMMENT_PREFIX.length),
    globalSignature,
  };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/**
 * Verify `content` against `signature` and `key`, throwing MinisignError on every failure.
 * Returns the trusted comment, which is trusted only because this returned.
 *
 * It throws rather than returning a boolean: a boolean can be dropped at the call site and the
 * bytes used anyway; an exception nobody catches stops whatever was about to use them.
 */
export function verifyMinisign(
  content: Uint8Array,
  signature: MinisignSignature,
  key: MinisignPublicKey,
  primitives: MinisignPrimitives,
): string {
  const { ed25519, blake2b512 } = primitives;
  // Public metadata, checked first so a signature from another key says so rather than
  // sending the reader looking for a corrupted download.
  if (!sameBytes(signature.keyId, key.keyId)) {
    throw new MinisignError(
      "wrong-key",
      `minisign signature was made by key ${keyIdHex(signature.keyId)}, ` +
        `but the trusted key is ${keyIdHex(key.keyId)}`,
    );
  }

  let message: Uint8Array;
  if (signature.algorithm === ALGORITHM_PREHASHED) {
    message = blake2b512(content);
  } else if (signature.algorithm === ALGORITHM_LEGACY) {
    message = content;
  } else {
    throw new MinisignError(
      "unknown-algorithm",
      `minisign signature announces algorithm "${signature.algorithm}", which this build does ` +
        `not understand (expected "${ALGORITHM_LEGACY}" or "${ALGORITHM_PREHASHED}")`,
    );
  }

  if (key.publicKey.length !== PUBLIC_KEY_BYTES || !usable(key.publicKey, ed25519)) {
    throw new MinisignError(
      "malformed-key",
      `minisign public key ${keyIdHex(key.keyId)} is not a usable Ed25519 key`,
    );
  }

  if (!ed25519(message, signature.signature, key.publicKey)) {
    throw new MinisignError(
      "bad-signature",
      `minisign signature does not verify against public key ${keyIdHex(key.keyId)}`,
    );
  }

  // The global signature covers the raw signature followed by the trusted comment. Without
  // this check the trusted comment is not trusted at all, whatever it is called.
  const comment = new TextEncoder().encode(signature.trustedComment);
  const signedComment = new Uint8Array(signature.signature.length + comment.length);
  signedComment.set(signature.signature, 0);
  signedComment.set(comment, signature.signature.length);
  if (!ed25519(signedComment, signature.globalSignature, key.publicKey)) {
    throw new MinisignError(
      "tampered-comment",
      "minisign global signature does not verify: the trusted comment does not belong to this " +
        "signature",
    );
  }
  return signature.trustedComment;
}

/** Whether the primitive accepts these bytes as a key at all: it throws when it does not. */
function usable(publicKey: Uint8Array, ed25519: Ed25519Verify): boolean {
  try {
    ed25519(new Uint8Array(0), new Uint8Array(SIGNATURE_BYTES), publicKey);
    return true;
  } catch {
    return false;
  }
}
