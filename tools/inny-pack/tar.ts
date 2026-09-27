// A minimal USTAR writer for inny-pack (WI-0018-26), the counterpart of the app's own minimal
// tar READER (app/src/adapters/fs/package-source.ts's readTar): no dependency, and no more
// format than a package archive needs. Regular files only (a package holds regular files,
// domain/packages/archive.ts's pathProblem already refuses anything else by path), USTAR
// headers with the prefix field for a path over 100 bytes (POSIX 1003.1-1988), no pax or GNU
// long-name records -- readTar supports reading those for archives made by real tar tools, but
// a package's own paths are short enough that writing them is unnecessary complexity here.

const BLOCK = 512;
const NAME_MAX = 100;
const PREFIX_MAX = 155;

function nullPadded(text: string, length: number): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > length) {
    throw new Error(`${JSON.stringify(text)} is longer than ${String(length)} bytes`);
  }
  const field = new Uint8Array(length);
  field.set(bytes, 0);
  return field;
}

/** An octal field, NUL-terminated, left-padded with zeros (the tar convention). */
function octalField(value: number, length: number): Uint8Array {
  const digits = value.toString(8).padStart(length - 1, "0");
  if (digits.length > length - 1) {
    throw new Error(`${String(value)} does not fit in an octal field of ${String(length)} bytes`);
  }
  return nullPadded(digits, length);
}

/** Splits a package path into USTAR's name (<=100) and prefix (<=155) fields. */
function splitPath(path: string): { name: string; prefix: string } {
  if (path.length <= NAME_MAX) {
    return { name: path, prefix: "" };
  }
  // The standard split: prefix ends at the last '/' that still leaves name <= 100 bytes.
  for (let cut = path.length - NAME_MAX; cut > 0; cut -= 1) {
    if (path[cut - 1] === "/" && cut - 1 <= PREFIX_MAX) {
      return { name: path.slice(cut), prefix: path.slice(0, cut - 1) };
    }
  }
  throw new Error(`${JSON.stringify(path)} is too long for a USTAR archive (no split point)`);
}

function header(path: string, size: number): Uint8Array {
  const { name, prefix } = splitPath(path);
  const block = new Uint8Array(BLOCK);
  const write = (offset: number, field: Uint8Array): void => {
    block.set(field, offset);
  };
  write(0, nullPadded(name, 100));
  write(100, octalField(0o644, 8)); // mode
  write(108, octalField(0, 8)); // uid
  write(116, octalField(0, 8)); // gid
  write(124, octalField(size, 12));
  write(136, octalField(0, 12)); // mtime: 1970-01-01, so two builds of the same files match
  block.set(new TextEncoder().encode("        "), 148); // checksum, spaces while computed
  block[156] = "0".charCodeAt(0); // typeflag: a regular file
  write(257, nullPadded("ustar", 6));
  write(263, nullPadded("00", 2)); // version
  write(345, nullPadded(prefix, 155));

  let checksum = 0;
  for (const byte of block) {
    checksum += byte;
  }
  write(148, octalField(checksum, 8));
  block[148 + 7] = " ".charCodeAt(0); // the checksum field ends in a space, not NUL
  return block;
}

function padded(bytes: Uint8Array): Uint8Array {
  const remainder = bytes.length % BLOCK;
  if (remainder === 0) {
    return bytes;
  }
  const out = new Uint8Array(bytes.length + (BLOCK - remainder));
  out.set(bytes, 0);
  return out;
}

/** A USTAR archive of `files` (path order is the iteration order given), unended: the caller
 * gzips it (node:zlib) as domain/packages/archive.ts's format requires. */
export function writeTar(files: ReadonlyMap<string, Uint8Array>): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [path, bytes] of files) {
    parts.push(header(path, bytes.length));
    parts.push(padded(bytes));
  }
  parts.push(new Uint8Array(BLOCK * 2)); // the end-of-archive marker: two zero blocks
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const archive = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    archive.set(part, offset);
    offset += part.length;
  }
  return archive;
}
