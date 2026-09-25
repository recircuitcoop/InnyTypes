// A throwaway minisign signer, generated per test: the old suite's Signer
// (tests/test_helper_update_check.py:83-129), on node:crypto. No private key is ever committed.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

export interface SignOptions {
  /** `ED` (the default, and minisign's own) or `Ed`. */
  readonly prehashed?: boolean;
  readonly trustedComment?: string;
  /** Announce another key id than this signer's. */
  readonly keyId?: Uint8Array;
  /** Show this trusted comment instead of the one the global signature covers. */
  readonly tamperedComment?: string;
  /** Announce this algorithm instead of the one the signature was made with. */
  readonly algorithm?: string;
}

export class Signer {
  readonly keyId: Uint8Array;
  readonly #privateKey: KeyObject;
  readonly #publicKey: Uint8Array;

  constructor(keyId?: Uint8Array) {
    const pair = generateKeyPairSync("ed25519");
    this.#privateKey = pair.privateKey;
    const jwk = pair.publicKey.export({ format: "jwk" });
    this.#publicKey = Buffer.from(jwk.x ?? "", "base64url");
    this.keyId = keyId ?? randomBytes(8);
  }

  /** The bare base64 key line, which is what a registered source stores. */
  get publicKeyLine(): string {
    return Buffer.concat([Buffer.from("Ed"), this.keyId, this.#publicKey]).toString("base64");
  }

  /** The key as a `.pub` file: an untrusted comment line and the key line. */
  get publicKeyText(): string {
    return `untrusted comment: minisign public key (throwaway, generated in the test)\n${this.publicKeyLine}\n`;
  }

  sign(content: Uint8Array, options: SignOptions = {}): string {
    const prehashed = options.prehashed ?? true;
    const trustedComment = options.trustedComment ?? "timestamp:1758190000\tfile:catalogue.json";
    const message = prehashed ? createHash("blake2b512").update(content).digest() : content;
    const signature = sign(null, message, this.#privateKey);
    const globalSignature = sign(
      null,
      Buffer.concat([signature, Buffer.from(trustedComment, "utf8")]),
      this.#privateKey,
    );
    const algorithm = options.algorithm ?? (prehashed ? "ED" : "Ed");
    const announced = Buffer.concat([
      Buffer.from(algorithm, "latin1"),
      options.keyId ?? this.keyId,
      signature,
    ]);
    return (
      "untrusted comment: signature from a throwaway key\n" +
      `${announced.toString("base64")}\n` +
      `trusted comment: ${options.tamperedComment ?? trustedComment}\n` +
      `${globalSignature.toString("base64")}\n`
    );
  }
}
