// Package archives and wheels, made in the test (WI-0018-15). No archive or wheel is
// committed: each is written here from the files a test names, and signed by the throwaway
// minisign signer of WI-0018-14 (fakes/minisign-signer.ts).
import { createHash } from "node:crypto";
import { crc32, gzipSync } from "node:zlib";

import type { Signer } from "./minisign-signer";

export type Files = Readonly<Record<string, string | Uint8Array>>;

/** One tar entry; `type` is the tar type flag ("0" a file, "2" a symlink, "5" a directory). */
export interface TarEntry {
  readonly name: string;
  readonly data?: Uint8Array;
  readonly type?: string;
}

const BLOCK = 512;
const bytesOf = (value: string | Uint8Array): Uint8Array =>
  typeof value === "string" ? new TextEncoder().encode(value) : value;

export const sha256 = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytesOf(bytes)).digest("hex");

function header(name: string, size: number, type: string): Uint8Array {
  const block = new Uint8Array(BLOCK);
  const put = (text: string, at: number): void => {
    block.set(new TextEncoder().encode(text), at);
  };
  put(name, 0);
  put("0000644\0", 100);
  put("0000000\0", 108);
  put("0000000\0", 116);
  put(size.toString(8).padStart(11, "0") + "\0", 124);
  put("00000000000\0", 136);
  put(type, 156);
  put("ustar\0", 257);
  put("00", 263);
  // The checksum: the header's bytes summed with the checksum field taken as spaces.
  put("        ", 148);
  const sum = block.reduce((total, byte) => total + byte, 0);
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return block;
}

/** A tar stream of the entries, in order, with the end-of-archive marker. */
export function tar(entries: readonly TarEntry[], options: { end?: boolean } = {}): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    const data = entry.data ?? new Uint8Array();
    parts.push(header(entry.name, data.length, entry.type ?? "0"));
    parts.push(data);
    parts.push(new Uint8Array((BLOCK - (data.length % BLOCK)) % BLOCK));
  }
  if (options.end ?? true) {
    parts.push(new Uint8Array(BLOCK * 2));
  }
  return Buffer.concat(parts);
}

/** A pax extended header entry that renames the next entry to `path`. */
export function paxPath(path: string): TarEntry {
  const body = (length: number): string => `${String(length)} path=${path}\n`;
  let length = body(0).length;
  while (body(length).length !== length) {
    length = body(length).length;
  }
  return { name: "PaxHeader", type: "x", data: new TextEncoder().encode(body(length)) };
}

/** A `.tgz` of the files, as a tar tool writes one. */
export function tgz(files: Files, extra: readonly TarEntry[] = []): Uint8Array {
  const entries: TarEntry[] = Object.entries(files).map(([name, data]) => ({
    name,
    data: bytesOf(data),
  }));
  return gzipSync(tar([...entries, ...extra]));
}

/** `files.json` for the files: every one listed with its sha256. */
export function filesJson(files: Files): string {
  const listed = Object.fromEntries(
    Object.entries(files).map(([name, data]) => [name, sha256(bytesOf(data))]),
  );
  return JSON.stringify({ files: listed }, null, 2);
}

export interface ArchiveOptions {
  /** Files put in the archive after files.json was written and signed. */
  readonly after?: Files;
  /** files.json put in the archive after signing, in place of the one signed. */
  readonly replaceListing?: string;
  /** Leave out the signature. */
  readonly unsigned?: boolean;
}

/** A signed package archive of the files: files.json, its signature, and the files. */
export function signedArchive(
  files: Files,
  signer: Signer,
  options: ArchiveOptions = {},
): Uint8Array {
  const listing = filesJson(files);
  const signature = signer.sign(new TextEncoder().encode(listing), {
    trustedComment: "timestamp:1758190000\tfile:files.json",
  });
  return tgz({
    ...files,
    ...options.after,
    "files.json": options.replaceListing ?? listing,
    ...(options.unsigned === true ? {} : { "files.json.minisig": signature }),
  });
}

// --- wheels ---------------------------------------------------------------------------------

function urlsafeDigest(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("base64url");
}

/** A zip of the files, stored (not deflated): all a wheel needs to be one. */
export function zip(files: Files): Uint8Array {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const data = bytesOf(value);
    const fileName = new TextEncoder().encode(name);
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(fileName.length, 26);
    local.push(head, fileName, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(fileName.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, fileName);
    offset += head.length + fileName.length + data.length;
  }
  const centralSize = central.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  const count = Object.keys(files).length;
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

/** A pure-Python wheel: its file name and bytes. Its module says its own name and version. */
export function wheel(name: string, version: string): { file: string; bytes: Uint8Array } {
  const distInfo = `${name}-${version}.dist-info`;
  const files: Record<string, string> = {
    [`${name}/__init__.py`]: `NAME = ${JSON.stringify(name)}\nVERSION = ${JSON.stringify(version)}\n`,
    [`${distInfo}/METADATA`]: `Metadata-Version: 2.1\nName: ${name}\nVersion: ${version}\n`,
    [`${distInfo}/WHEEL`]:
      "Wheel-Version: 1.0\nGenerator: innytypes-test\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
  };
  const record = Object.entries(files)
    .map(([file, text]) => {
      const data = bytesOf(text);
      return `${file},sha256=${urlsafeDigest(data)},${String(data.length)}`;
    })
    .concat(`${distInfo}/RECORD,,`)
    .join("\n");
  files[`${distInfo}/RECORD`] = record + "\n";
  return { file: `${name}-${version}-py3-none-any.whl`, bytes: zip(files) };
}
