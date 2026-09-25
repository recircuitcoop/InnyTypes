// adapters/process/codec.ts: frames validated by ajv against the spec's §4.5 schemas, the
// 1 MiB limit, and line splitting in bytes.

import fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  decodeFrame,
  encodeFrame,
  FrameTooLargeError,
  LineReader,
  MAX_FRAME_BYTES,
  OVERSIZE_HOLD_BYTES,
  type RuntimeFrame,
} from "../../src/adapters/process/codec";

const REPOSITORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const bytes = (text: string): Buffer => Buffer.from(text, "utf8");

describe("the frame schema file", () => {
  it("is exactly the JSON Schema block of spec §4.5", () => {
    const spec = fs.readFileSync(path.join(REPOSITORY, "docs/specs/node-protocol-v2.md"), "utf8");
    const section = spec.slice(
      spec.indexOf("### 4.5 JSON Schemas"),
      spec.indexOf("## 5. The event envelope"),
    );
    const block = /```json\n([\s\S]*?)\n```/.exec(section)?.[1] ?? "";
    const file = fs.readFileSync(
      path.join(REPOSITORY, "docs/specs/node-protocol-v2.schema.json"),
      "utf8",
    );
    expect(JSON.parse(file)).toEqual(JSON.parse(block));
  });
});

describe("decoding a node's line", () => {
  it("accepts every node frame of spec 4.2 in its schema's shape, ignoring unknown fields", () => {
    const frames = [
      { t: "ready" },
      { t: "status", text: "busy", fill: "yellow", shape: "ring" },
      { t: "log", level: "debug", msg: "hello" },
      { t: "emit", port: "out", data: [1, 2], in: "a" },
      { t: "done", in: "a", extra: true },
      { t: "error", message: "no", in: "a" },
      { t: "present", in: "a", content: { title: "T", fields: { n: 1, b: null } } },
      { t: "snapshot", content: {}, state: { x: 1 } },
      { t: "closed" },
    ];
    for (const frame of frames) {
      expect(decodeFrame(bytes(JSON.stringify(frame)))).toEqual({ kind: "frame", frame });
    }
  });

  it("refuses a known frame whose shape breaks its schema, saying where", () => {
    expect(decodeFrame(bytes('{"t":"status","text":"x","fill":"purple"}'))).toEqual({
      kind: "invalid",
      t: "status",
      problems: "/fill must be equal to one of the allowed values",
    });
    expect(decodeFrame(bytes('{"t":"done"}'))).toMatchObject({ kind: "invalid", t: "done" });
    const long = JSON.stringify({ t: "error", message: "m".repeat(2001) });
    expect(decodeFrame(bytes(long))).toMatchObject({ kind: "invalid", t: "error" });
  });

  it("reports an unknown frame type as unknown, runtime-bound types included", () => {
    expect(decodeFrame(bytes('{"t":"future"}'))).toEqual({ kind: "unknown", t: "future" });
    expect(decodeFrame(bytes('{"t":"start"}'))).toEqual({ kind: "unknown", t: "start" });
  });

  it("reports text that is not a frame as a protocol violation", () => {
    expect(decodeFrame(bytes("hello"))).toEqual({
      kind: "violation",
      reason: "not JSON",
      text: "hello",
    });
    expect(decodeFrame(bytes("[1]"))).toEqual({
      kind: "violation",
      reason: "not a frame (no string field t)",
      text: "[1]",
    });
    expect(decodeFrame(bytes('{"t":1}'))).toMatchObject({ kind: "violation" });
    expect(decodeFrame(Buffer.from([0x7b, 0xff, 0x7d]))).toMatchObject({
      kind: "violation",
      reason: "not UTF-8",
    });
  });

  it("discards a frame over 1 MiB, and reads the input id it carried", () => {
    const over = JSON.stringify({
      t: "emit",
      port: "out",
      data: "x".repeat(MAX_FRAME_BYTES),
      in: "the-input",
    });
    expect(decodeFrame(bytes(over))).toEqual({
      kind: "oversize",
      bytes: Buffer.byteLength(over),
      inputId: "the-input",
    });
    const noId = JSON.stringify({ t: "log", msg: "x".repeat(MAX_FRAME_BYTES) });
    expect(decodeFrame(bytes(noId))).toMatchObject({ kind: "oversize", inputId: null });
    expect(decodeFrame(Buffer.alloc(MAX_FRAME_BYTES + 1, 0x78))).toMatchObject({ inputId: null });
    expect(decodeFrame(Buffer.alloc(OVERSIZE_HOLD_BYTES + 1, 0x78))).toMatchObject({
      inputId: null,
    });
  });

  it("accepts a frame of exactly 1 MiB", () => {
    const empty = JSON.stringify({ t: "log", msg: "" });
    const frame = JSON.stringify({
      t: "log",
      msg: "x".repeat(MAX_FRAME_BYTES - Buffer.byteLength(empty)),
    });
    expect(Buffer.byteLength(frame)).toBe(MAX_FRAME_BYTES);
    expect(decodeFrame(bytes(frame)).kind).toBe("frame");
  });
});

describe("encoding a runtime frame", () => {
  it("writes one validated line", () => {
    expect(encodeFrame({ t: "cancel", in: "a" })).toBe('{"t":"cancel","in":"a"}\n');
  });

  it("refuses a frame the runtime built wrong", () => {
    const wrong = { t: "cancel", in: "" } as RuntimeFrame;
    expect(() => encodeFrame(wrong)).toThrow(
      /invalid cancel frame: \/in must NOT have fewer than 1 characters/,
    );
  });

  it("refuses a frame over 1 MiB", () => {
    const data = { v: "x".repeat(MAX_FRAME_BYTES) };
    expect(() => encodeFrame({ t: "fire", data })).toThrow(FrameTooLargeError);
    expect(() => encodeFrame({ t: "fire", data })).toThrow(
      "frame too large: 1048604 bytes, the limit is 1048576",
    );
  });
});

describe("the line reader", () => {
  it("splits on LF across chunks, and keeps a character split between chunks whole", () => {
    const reader = new LineReader();
    const text = Buffer.from('{"a":"é"}\n{"b":1}\n{"c"', "utf8");
    const cut = text.indexOf(0xc3) + 1; // inside the two bytes of é
    const lines = [...reader.push(text.subarray(0, cut)), ...reader.push(text.subarray(cut))];
    expect(
      lines.map((line) => (line.kind === "line" ? line.bytes.toString("utf8") : null)),
    ).toEqual(['{"a":"é"}', '{"b":1}']);
    expect(reader.end()).toEqual([{ kind: "line", bytes: Buffer.from('{"c"') }]);
    expect(reader.end()).toEqual([]);
  });

  it("stops holding a line longer than the hold, counts it, and reads the next one normally", () => {
    const reader = new LineReader();
    const chunk = Buffer.alloc(OVERSIZE_HOLD_BYTES, 0x78);
    expect(reader.push(chunk)).toEqual([]);
    expect(reader.push(Buffer.from("xx\nok\n"))).toEqual([
      { kind: "dropped", bytes: OVERSIZE_HOLD_BYTES + 2 },
      { kind: "line", bytes: Buffer.from("ok") },
    ]);
  });
});
