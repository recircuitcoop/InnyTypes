// minisign verification (WI-0018-14): helper/minisign.py and its tests
// (tests/test_helper_update_check.py, "The minisign layer on its own"), ported.
//
// Three kinds of vector: signatures made in each test by a throwaway node:crypto signer (as the
// old suite made them with PyNaCl); signatures made once by the old helper's own Signer and
// checked by its verify_file (test/fixtures/minisign/python-helper-vectors.json, public halves
// only); and jedisct1/minisign's published key. The minisign CLI was not installed where these
// were written, so no CLI-made vector is committed.
import fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MINISIGN_PRIMITIVES, MinisignVerifier } from "../../src/adapters/signature/minisign";
import {
  keyIdHex,
  MinisignError,
  parsePublicKey,
  parseSignature,
  verifyMinisign,
  type MinisignRefusal,
} from "../../src/domain/signature/minisign";
import { Signer } from "../fakes/minisign-signer";

interface PythonVectors {
  publicKey: string;
  keyIdHex: string;
  contentBase64: string;
  prehashed: string;
  legacy: string;
}

const VECTORS = JSON.parse(
  fs.readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "fixtures",
      "minisign",
      "python-helper-vectors.json",
    ),
    "utf8",
  ),
) as PythonVectors;
const VECTOR_CONTENT = Buffer.from(VECTORS.contentBase64, "base64");

const CONTENT = new TextEncoder().encode("a release bundle");
const verifier = new MinisignVerifier();

/** The refusal `run` throws: a MinisignError, for this reason and no other. */
function refusal(run: () => unknown): { reason: MinisignRefusal; message: string } {
  try {
    run();
  } catch (error) {
    if (error instanceof MinisignError) {
      return { reason: error.reason, message: error.message };
    }
    throw error;
  }
  throw new Error("expected a MinisignError, and nothing was refused");
}

/** Replace the base64 line at `index` of a signature file. */
function withLine(signature: string, index: number, line: string): string {
  const lines = signature.split("\n");
  lines[index] = line;
  return lines.join("\n");
}

describe("both algorithms (minisign.py:72-73)", () => {
  it("verifies the pre-hashed (ED) and the legacy (Ed) form", () => {
    const signer = new Signer();
    for (const prehashed of [true, false]) {
      const comment = verifier.verify(
        CONTENT,
        signer.sign(CONTENT, { prehashed }),
        signer.publicKeyText,
      );
      expect(comment).toBe("timestamp:1758190000\tfile:catalogue.json");
    }
  });

  it("verifies the old helper's own vectors, in both forms", () => {
    expect(verifier.verify(VECTOR_CONTENT, VECTORS.prehashed, VECTORS.publicKey)).toContain(
      "file:innytypes.tar.gz",
    );
    expect(verifier.verify(VECTOR_CONTENT, VECTORS.legacy, VECTORS.publicKey)).toContain(
      "file:innytypes.tar.gz",
    );
    expect(keyIdHex(parsePublicKey(VECTORS.publicKey).keyId)).toBe(VECTORS.keyIdHex);
  });

  it("never tries a pre-hashed signature as a legacy one, or the other way round", () => {
    // Announcing the other algorithm over the same signature bytes must not verify: the
    // algorithm a signature announces decides what it covers.
    const signer = new Signer();
    const prehashedAsLegacy = signer.sign(CONTENT, { prehashed: true, algorithm: "Ed" });
    const legacyAsPrehashed = signer.sign(CONTENT, { prehashed: false, algorithm: "ED" });
    expect(
      refusal(() => verifier.verify(CONTENT, prehashedAsLegacy, signer.publicKeyText)),
    ).toMatchObject({ reason: "bad-signature" });
    expect(
      refusal(() => verifier.verify(CONTENT, legacyAsPrehashed, signer.publicKeyText)),
    ).toMatchObject({ reason: "bad-signature" });
  });
});

describe("each refusal, by name", () => {
  it("refuses a wrong key: a signature by a key with another id", () => {
    const trusted = new Signer();
    const impostor = new Signer();
    const { reason, message } = refusal(() =>
      verifier.verify(CONTENT, impostor.sign(CONTENT), trusted.publicKeyText),
    );
    expect(reason).toBe("wrong-key");
    expect(message).toContain(keyIdHex(impostor.keyId));
  });

  it("refuses a wrong signature: another key that claims the trusted key's id", () => {
    const trusted = new Signer();
    const forger = new Signer(trusted.keyId);
    expect(
      refusal(() => verifier.verify(CONTENT, forger.sign(CONTENT), trusted.publicKeyText)),
    ).toMatchObject({ reason: "bad-signature" });
  });

  it("refuses a wrong signature: the trusted key's signature over other content", () => {
    const signer = new Signer();
    const other = signer.sign(new TextEncoder().encode("some other artifact entirely"));
    const { reason, message } = refusal(() =>
      verifier.verify(CONTENT, other, signer.publicKeyText),
    );
    expect(reason).toBe("bad-signature");
    expect(message).toContain("does not verify");
  });

  it("refuses a tampered file, in both forms and for the old helper's vectors", () => {
    const signer = new Signer();
    const tampered = new TextEncoder().encode("a release bundlE");
    for (const prehashed of [true, false]) {
      expect(
        refusal(() =>
          verifier.verify(tampered, signer.sign(CONTENT, { prehashed }), signer.publicKeyText),
        ),
      ).toMatchObject({ reason: "bad-signature" });
    }
    const flipped = Buffer.from(VECTOR_CONTENT);
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 1;
    for (const signature of [VECTORS.prehashed, VECTORS.legacy]) {
      expect(refusal(() => verifier.verify(flipped, signature, VECTORS.publicKey))).toMatchObject({
        reason: "bad-signature",
      });
    }
  });

  it("refuses a tampered trusted comment: the global signature is checked", () => {
    const signer = new Signer();
    const signature = signer.sign(CONTENT, { tamperedComment: "file:something-else.tar.gz" });
    const { reason, message } = refusal(() =>
      verifier.verify(CONTENT, signature, signer.publicKeyText),
    );
    expect(reason).toBe("tampered-comment");
    expect(message).toContain("global signature does not verify");

    const edited = VECTORS.prehashed.replace("innytypes.tar.gz", "innytypes.tar.gy");
    expect(refusal(() => verifier.verify(VECTOR_CONTENT, edited, VECTORS.publicKey))).toMatchObject(
      { reason: "tampered-comment" },
    );
  });

  it("refuses a wrong algorithm", () => {
    const signer = new Signer();
    const { reason, message } = refusal(() =>
      verifier.verify(CONTENT, signer.sign(CONTENT, { algorithm: "XX" }), signer.publicKeyText),
    );
    expect(reason).toBe("unknown-algorithm");
    expect(message).toContain("does not understand");
  });

  it("refuses a key that is not a usable Ed25519 key", () => {
    const signer = new Signer();
    const key = parsePublicKey(signer.publicKeyText);
    const signature = parseSignature(signer.sign(CONTENT));
    for (const publicKey of [new TextEncoder().encode("too short"), new Uint8Array(32)]) {
      const broken = { keyId: key.keyId, publicKey };
      const { reason, message } = refusal(() =>
        verifyMinisign(CONTENT, signature, broken, MINISIGN_PRIMITIVES),
      );
      // An all-zero key is a point node:crypto may accept; it must still verify nothing.
      expect(["malformed-key", "bad-signature"]).toContain(reason);
      if (publicKey.length !== 32) {
        expect(message).toContain("not a usable Ed25519 key");
      }
    }
  });
});

describe("parsing (minisign.py parse_public_key, parse_signature)", () => {
  it("parses jedisct1/minisign's own published example key", () => {
    const key = parsePublicKey("RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3");
    expect(keyIdHex(key.keyId)).toBe("1fe8b442180f62e7");
    expect(key.publicKey).toHaveLength(32);
  });

  it("reads a key from the .pub file and from its bare line alike", () => {
    const signer = new Signer();
    expect(parsePublicKey(signer.publicKeyText)).toEqual(parsePublicKey(signer.publicKeyLine));
  });

  it.each([
    ["untrusted comment: only a comment\n", "holds no key line"],
    ["not base64 at all !!", "not valid base64"],
    [Buffer.concat([Buffer.from("Ed"), Buffer.alloc(8, "x")]).toString("base64"), "expected 42"],
    [Buffer.concat([Buffer.from("XX"), Buffer.alloc(40, "x")]).toString("base64"), "announces"],
    // Base64 without its padding is refused, as b64decode(validate=True) refuses it.
    ["RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3".slice(0, -2), "not valid base64"],
  ])("refuses the malformed key %j (%s)", (text, message) => {
    expect(refusal(() => parsePublicKey(text))).toMatchObject({
      reason: "malformed-key",
      message: expect.stringContaining(message) as unknown,
    });
  });

  const b64 = (...parts: [string, number][]): string =>
    Buffer.concat(parts.map(([fill, length]) => Buffer.alloc(length, fill))).toString("base64");

  it.each([
    ["one line only", "expected 4"],
    [
      `untrusted comment: c\n${b64(["E", 1], ["d", 1], ["k", 8], ["s", 64])}\nnot a trusted comment\n${b64(["g", 64])}`,
      "does not start with",
    ],
    [
      `untrusted comment: c\nnot base64 !!\ntrusted comment: t\n${b64(["g", 64])}`,
      "not valid base64",
    ],
    [
      `untrusted comment: c\n${b64(["E", 1], ["d", 1], ["k", 8])}\ntrusted comment: t\n${b64(["g", 64])}`,
      "expected 74",
    ],
    [
      `untrusted comment: c\n${b64(["E", 1], ["d", 1], ["k", 8], ["s", 64])}\ntrusted comment: t\n${b64(["g", 8])}`,
      "global signature is 8 bytes",
    ],
  ])("refuses the malformed signature %#: %s", (text, message) => {
    expect(refusal(() => parseSignature(text))).toMatchObject({
      reason: "malformed-signature",
      message: expect.stringContaining(message) as unknown,
    });
  });

  it("refuses a signature whose global signature line is not base64", () => {
    const signer = new Signer();
    expect(
      refusal(() =>
        verifier.verify(CONTENT, withLine(signer.sign(CONTENT), 3, "!!!!"), signer.publicKeyText),
      ),
    ).toMatchObject({ reason: "malformed-signature" });
  });
});
