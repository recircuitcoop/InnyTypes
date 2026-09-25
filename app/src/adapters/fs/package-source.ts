// Reading a package's files: a `.tgz` archive or a folder (ports/package-source.ts; WI-0018-15).
//
// The archive is gunzipped with node:zlib and read as a tar stream here, with no library: the
// format is small, and a reader of our own refuses everything a package may not hold rather
// than extracting it. Only regular files are kept (directories are implied by their paths).
// Links, devices and FIFOs are refused, as are paths that leave the package and a path given
// twice. The pax and GNU long-name records that tar tools write for long paths are honoured.
//
// Nothing is extracted to disk: the files are verified in memory first, and only verified bytes
// are ever written (adapters/fs/package-roots.ts).

import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";

import { pathProblem } from "../../domain/packages/archive";
import type { PackageSource } from "../../ports/package-source";

/** A package larger than this, unpacked, is refused rather than read into memory. */
export const MAX_PACKAGE_BYTES = 512 * 1024 * 1024;

const BLOCK = 512;
const gunzipAsync = promisify(gunzip);

/** A NUL-terminated field of a tar header, as text. */
function field(header: Uint8Array, start: number, length: number): string {
  const bytes = header.subarray(start, start + length);
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end === -1 ? bytes : bytes.subarray(0, end));
}

/** A tar header's octal number field. */
function octal(header: Uint8Array, start: number, length: number): number {
  const text = field(header, start, length).trim();
  if (!/^[0-7]*$/.test(text)) {
    throw new Error(`a tar header holds a size that is not octal: ${JSON.stringify(text)}`);
  }
  return text === "" ? 0 : parseInt(text, 8);
}

/** The `path` of a pax extended header, which overrides the next entry's name. */
function paxPath(data: Uint8Array): string | undefined {
  const text = new TextDecoder().decode(data);
  let found: string | undefined;
  let at = 0;
  while (at < text.length) {
    const space = text.indexOf(" ", at);
    const length = parseInt(text.slice(at, space), 10);
    if (space === -1 || !Number.isInteger(length) || length <= 0) {
      throw new Error("a pax extended header is malformed");
    }
    const record = text.slice(space + 1, at + length - 1);
    const equals = record.indexOf("=");
    if (record.slice(0, equals) === "path") {
      found = record.slice(equals + 1);
    }
    at += length;
  }
  return found;
}

/** An entry's path as a package path: `./` and a trailing `/` dropped, and judged. */
function packagePath(name: string): string {
  const cleaned = name.replace(/^(\.\/)+/, "").replace(/\/$/, "");
  const problem = pathProblem(cleaned);
  if (problem !== null) {
    throw new Error(`the archive holds ${problem}`);
  }
  return cleaned;
}

/** Every regular file of a tar stream, by package path. */
export function readTar(tar: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  let longName: string | undefined;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) {
      return files; // the end-of-archive marker
    }
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] ?? 0);
    const dataStart = offset + BLOCK;
    const data = tar.subarray(dataStart, dataStart + size);
    if (data.length < size) {
      throw new Error("the archive ends inside an entry");
    }
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    const prefix = field(header, 345, 155);
    const headerName = prefix === "" ? field(header, 0, 100) : `${prefix}/${field(header, 0, 100)}`;
    const name = longName ?? headerName;
    if (type === "x") {
      longName = paxPath(data) ?? longName;
      continue;
    }
    if (type === "L") {
      longName = field(data, 0, data.length);
      continue;
    }
    longName = undefined;
    if (type === "g" || type === "5") {
      continue; // a global pax header, or a directory, which its files imply
    }
    const file = packagePath(name);
    if (type !== "0" && type !== "\0") {
      throw new Error(`the archive holds ${file}, which is not a regular file (tar type ${type})`);
    }
    if (files.has(file)) {
      throw new Error(`the archive holds ${file} twice`);
    }
    files.set(file, Uint8Array.from(data));
  }
  throw new Error("the archive has no end-of-archive marker");
}

export class FsPackageSource implements PackageSource {
  async readArchive(archivePath: string): Promise<ReadonlyMap<string, Uint8Array>> {
    const compressed = await fs.promises.readFile(archivePath);
    let tar: Buffer;
    try {
      tar = await gunzipAsync(compressed, { maxOutputLength: MAX_PACKAGE_BYTES });
    } catch (error) {
      throw new Error(
        `it is not a gzip archive of at most ${String(MAX_PACKAGE_BYTES)} bytes: ` +
          (error as Error).message,
        { cause: error },
      );
    }
    return readTar(tar);
  }

  async readFolder(folder: string): Promise<ReadonlyMap<string, Uint8Array>> {
    const files = new Map<string, Uint8Array>();
    let total = 0;
    const entries = await fs.promises.readdir(folder, { recursive: true, withFileTypes: true });
    for (const entry of entries.sort((a, b) =>
      a.parentPath + a.name < b.parentPath + b.name ? -1 : 1,
    )) {
      const full = path.join(entry.parentPath, entry.name);
      const relative = path.relative(folder, full).split(path.sep).join("/");
      if (entry.isDirectory()) {
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`${relative} is not a regular file; a package holds regular files only`);
      }
      const bytes = await fs.promises.readFile(full);
      total += bytes.length;
      if (total > MAX_PACKAGE_BYTES) {
        throw new Error(`it is larger than ${String(MAX_PACKAGE_BYTES)} bytes`);
      }
      files.set(packagePath(relative), bytes);
    }
    return files;
  }
}
