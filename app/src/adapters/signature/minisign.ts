// The SignatureVerifier over node:crypto's Ed25519 and @noble/hashes' BLAKE2b (plan 0018 §1;
// WI-0018-14).
//
// Everything but the two primitives is domain/signature/minisign.ts: parsing, the key id, the
// two algorithms and the global signature. This file supplies the primitives:
//
// - Ed25519 is node:crypto: 32 raw bytes become a KeyObject, and node:crypto says whether a
//   signature verifies.
// - BLAKE2b-512, for the pre-hashed form, is @noble/hashes (MIT, audited, no dependencies, pure
//   JS). Plan 0018 §1 said node:crypto's `blake2b512`, but Electron's node:crypto is BoringSSL,
//   which has no BLAKE2b: `createHash("blake2b512")` throws in the shell and in both utility
//   processes, while the Node that runs vitest has it.
//
// Both work the same in Node and in Electron's processes (test/e2e/minisign-electron.e2e.ts runs
// them there).

import { createPublicKey, verify } from "node:crypto";
import { blake2b } from "@noble/hashes/blake2.js";
import {
  parsePublicKey,
  parseSignature,
  verifyMinisign,
  type Ed25519Verify,
  type MinisignPrimitives,
} from "../../domain/signature/minisign";
import type { SignatureVerifier } from "../../ports/signature-verifier";

/** RFC 8410's SubjectPublicKeyInfo header for an Ed25519 key; the 32 key bytes follow it. */
const ED25519_SPKI_PREFIX = Uint8Array.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

/** Ed25519 through node:crypto. Throws when the bytes are not an Ed25519 public key. */
export const nodeEd25519: Ed25519Verify = (message, signature, publicKey) => {
  const der = new Uint8Array(ED25519_SPKI_PREFIX.length + publicKey.length);
  der.set(ED25519_SPKI_PREFIX, 0);
  der.set(publicKey, ED25519_SPKI_PREFIX.length);
  const key = createPublicKey({ key: Buffer.from(der), format: "der", type: "spki" });
  // Ed25519 takes no digest: the algorithm argument is null.
  return verify(null, message, key, signature);
};

/** BLAKE2b with a 64-byte digest and no key: what `minisign -H` signs. */
export function blake2b512(bytes: Uint8Array): Uint8Array {
  return blake2b(bytes, { dkLen: 64 });
}

/** The primitives minisign verification runs on, in every process of the app. */
export const MINISIGN_PRIMITIVES: MinisignPrimitives = { ed25519: nodeEd25519, blake2b512 };

export class MinisignVerifier implements SignatureVerifier {
  verify(content: Uint8Array, signature: string, publicKey: string): string {
    return verifyMinisign(
      content,
      parseSignature(signature),
      parsePublicKey(publicKey),
      MINISIGN_PRIMITIVES,
    );
  }
}
