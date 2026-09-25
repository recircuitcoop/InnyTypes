// BLAKE2b-512 for minisign's pre-hashed form (WI-0018-14). Electron's node:crypto has no
// blake2b512, so the app hashes with @noble/hashes through adapters/signature/minisign.ts; this
// holds that path to RFC 7693's own vector and to the Node that runs the tests, which does
// have blake2b512.
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { blake2b512 } from "../../src/adapters/signature/minisign";

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const nodeBlake2b = (bytes: Uint8Array): string =>
  createHash("blake2b512").update(bytes).digest("hex");

describe("BLAKE2b-512, as the verifier computes it", () => {
  it("gives RFC 7693 appendix A's digest of abc", () => {
    expect(hex(blake2b512(new TextEncoder().encode("abc")))).toBe(
      "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d1" + // blake2b digest
        "7d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923", // blake2b digest
    );
  });

  it("agrees with Node's blake2b512 at every length around the block boundaries", () => {
    // 0-400 covers the empty input, one exact 128-byte block, and several more.
    for (let length = 0; length <= 400; length += 1) {
      const bytes = randomBytes(length);
      expect(hex(blake2b512(bytes)), `length ${String(length)}`).toBe(nodeBlake2b(bytes));
    }
  });

  it("agrees with Node over a catalogue-sized input", () => {
    const bytes = randomBytes(1024 * 1024 + 129);
    expect(hex(blake2b512(bytes))).toBe(nodeBlake2b(bytes));
  });
});
