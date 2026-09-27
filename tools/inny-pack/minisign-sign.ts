// Minisign-COMPATIBLE key generation and signing for inny-pack (WI-0018-26). The app only
// ever verifies a signature (app/src/domain/signature/minisign.ts is pure parsing and
// verification; app/src/adapters/signature/minisign.ts supplies node:crypto's Ed25519 and
// @noble/hashes' BLAKE2b as its primitives) -- a package AUTHOR needs to sign, which is what
// this file adds. It writes exactly the format that verifier parses: the "Ed" (not
// pre-hashed) algorithm, over node:crypto's Ed25519 alone, so inny-pack needs no dependency
// of its own to produce a signature app/src/domain/signature/minisign.ts accepts unmodified.
//
// A "signing key" here is NOT a minisign secret key file (minisign's own is scrypt+xsalsa20
// encrypted under a passphrase); reimplementing that encrypted container is out of scope, and
// nothing in the app ever reads a secret key -- only a public key and a signature reach it.
// The file this module writes and reads (SigningKeyFile) is inny-pack's own small JSON, and
// docs/authors/packaging.md says plainly that it must never be committed or shared.

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as ed25519Sign,
} from "node:crypto";

/** `Ed`: domain/signature/minisign.ts's ALGORITHM_LEGACY, the only one this module produces. */
const ALGORITHM = "Ed";

/**
 * RFC 8410's SubjectPublicKeyInfo header for an Ed25519 key, exactly
 * adapters/signature/minisign.ts's ED25519_SPKI_PREFIX: the 32 raw key bytes follow it in the
 * DER that node:crypto's `export({ type: "spki", format: "der" })` produces.
 */
const SPKI_ED25519_PREFIX_LENGTH = 12;

export interface SigningKey {
  readonly keyId: Buffer;
  readonly publicKeyDer: Buffer;
  readonly privateKeyPkcs8: Buffer;
}

/** A fresh signing key: a random 8-byte id (minisign's own convention) and an Ed25519 pair. */
export function generateSigningKey(): SigningKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    keyId: randomBytes(8),
    publicKeyDer: publicKey.export({ type: "spki", format: "der" }),
    privateKeyPkcs8: privateKey.export({ type: "pkcs8", format: "der" }),
  };
}

function rawPublicKey(key: SigningKey): Buffer {
  return key.publicKeyDer.subarray(SPKI_ED25519_PREFIX_LENGTH);
}

/** The minisign public key text: what the app's parsePublicKey reads (2 + 8 + 32 bytes). */
export function publicKeyText(key: SigningKey, comment: string): string {
  const blob = Buffer.concat([Buffer.from(ALGORITHM, "ascii"), key.keyId, rawPublicKey(key)]);
  return `untrusted comment: ${comment}\n${blob.toString("base64")}\n`;
}

/** inny-pack's own key file shape (see the file header: not a minisign secret key file). */
export interface SigningKeyFile {
  readonly keyId: string;
  readonly publicKeyDer: string;
  readonly privateKeyPkcs8: string;
}

export function toKeyFile(key: SigningKey): SigningKeyFile {
  return {
    keyId: key.keyId.toString("base64"),
    publicKeyDer: key.publicKeyDer.toString("base64"),
    privateKeyPkcs8: key.privateKeyPkcs8.toString("base64"),
  };
}

export function fromKeyFile(file: SigningKeyFile): SigningKey {
  return {
    keyId: Buffer.from(file.keyId, "base64"),
    publicKeyDer: Buffer.from(file.publicKeyDer, "base64"),
    privateKeyPkcs8: Buffer.from(file.privateKeyPkcs8, "base64"),
  };
}

/**
 * A detached minisign signature of `content`, in exactly the four-line shape
 * domain/signature/minisign.ts's parseSignature reads: the signature over the raw bytes (the
 * "Ed" algorithm, never pre-hashed), then a global signature over (signature || trusted
 * comment) so the trusted comment cannot be rewritten once signed (see that file's header).
 */
export function signMinisign(
  content: Uint8Array,
  key: SigningKey,
  trustedComment: string,
  untrustedComment: string,
): string {
  const privateKey = createPrivateKey({ key: key.privateKeyPkcs8, format: "der", type: "pkcs8" });
  const signature = ed25519Sign(null, Buffer.from(content), privateKey);
  const signatureBlob = Buffer.concat([Buffer.from(ALGORITHM, "ascii"), key.keyId, signature]);
  const commentBytes = Buffer.from(trustedComment, "utf8");
  const globalSignature = ed25519Sign(null, Buffer.concat([signature, commentBytes]), privateKey);
  return (
    [
      `untrusted comment: ${untrustedComment}`,
      signatureBlob.toString("base64"),
      `trusted comment: ${trustedComment}`,
      globalSignature.toString("base64"),
    ].join("\n") + "\n"
  );
}

/** Round-trips a DER public key through node:crypto, to fail fast on a corrupt key file. */
export function checkPublicKeyDer(publicKeyDer: Buffer): void {
  createPublicKey({ key: publicKeyDer, format: "der", type: "spki" });
}
