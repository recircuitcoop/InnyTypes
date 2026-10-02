// The 10-second sample Setup's "Try with a sample" runs the starter flow on (plan 0022 §H):
// a 16 kHz mono 16-bit PCM WAV of 10 seconds, with its CC0 licence beside it, copied into the package
// by both electron-builder configs.
import fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const APP = path.resolve(__dirname, "..", "..");
const SAMPLE = path.join(APP, "resources", "sample");

interface WavFormat {
  readonly audioFormat: number;
  readonly channels: number;
  readonly sampleRate: number;
  readonly byteRate: number;
  readonly bitsPerSample: number;
  readonly dataBytes: number;
}

/** The `fmt ` and `data` chunks of a RIFF/WAVE file, walking every chunk between. */
function readWav(bytes: Buffer): WavFormat {
  expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
  expect(bytes.toString("ascii", 8, 12)).toBe("WAVE");
  let format: Omit<WavFormat, "dataBytes"> | undefined;
  let dataBytes: number | undefined;
  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = bytes.toString("ascii", at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    if (id === "fmt ") {
      format = {
        audioFormat: bytes.readUInt16LE(at + 8),
        channels: bytes.readUInt16LE(at + 10),
        sampleRate: bytes.readUInt32LE(at + 12),
        byteRate: bytes.readUInt32LE(at + 16),
        bitsPerSample: bytes.readUInt16LE(at + 22),
      };
    }
    if (id === "data") {
      dataBytes = size;
    }
    // Chunks are padded to an even length.
    at += 8 + size + (size % 2);
  }
  if (format === undefined || dataBytes === undefined) {
    throw new Error("the sample has no fmt or no data chunk");
  }
  return { ...format, dataBytes };
}

describe("the bundled 10-second sample", () => {
  it("is a 16 kHz mono 16-bit PCM WAV of 10 seconds, whole to its last byte", () => {
    const bytes = fs.readFileSync(path.join(SAMPLE, "sample-10s.wav"));
    const wav = readWav(bytes);
    expect(wav).toMatchObject({
      audioFormat: 1,
      channels: 1,
      sampleRate: 16_000,
      bitsPerSample: 16,
    });
    expect(wav.byteRate).toBe(32_000);
    const seconds = wav.dataBytes / wav.byteRate;
    expect(Math.abs(seconds - 10)).toBeLessThanOrEqual(0.05);
    expect(bytes.length).toBeGreaterThanOrEqual(44 + wav.dataBytes);
  });

  it("has its CC0 licence beside it, saying it was generated for InnyTypes", () => {
    const licence = fs.readFileSync(path.join(SAMPLE, "LICENCE.txt"), "utf8");
    expect(licence).toContain("sample-10s.wav");
    expect(licence).toContain("Generated for InnyTypes");
    expect(licence).toContain("CC0 1.0 Universal");
  });

  it.each(["electron-builder.yml", "electron-builder.release.yml"])(
    "is copied into the package by %s",
    (config) => {
      const text = fs.readFileSync(path.join(APP, "packaging", config), "utf8");
      expect(text).toMatch(/- from: "resources\/sample"\n\s+to: "sample"\n/);
    },
  );
});
