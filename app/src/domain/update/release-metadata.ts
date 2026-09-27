// electron-builder's own update feed format (the `latest-*.yml` electron-updater reads),
// parsed for exactly the shape it writes (plan 0018 §1, §3 update.py: Replace; WI-0018-24).
//
// Plan 0003 D10 again: trust the signature, never the server. This file only understands the
// document; application/update-check.ts fetches it and its detached minisign signature and
// verifies the signature BEFORE any byte here is trusted. What is parsed is never more lenient
// than what is verified: a line this does not recognise refuses the whole document, the same
// rule domain/signature/minisign.ts applies to its own format.
//
// The shape, as electron-builder writes it:
//
//     version: 1.2.3
//     files:
//       - url: InnyTypes-1.2.3-arm64-mac.zip
//         sha512: <base64>
//         size: 12345678
//     path: InnyTypes-1.2.3-arm64-mac.zip
//     sha512: <base64>
//     releaseDate: '2026-09-27T00:00:00.000Z'
//
// `path`/`sha512` at the top level mirror the first `files` entry for older readers; this
// parser reads them but never uses them, since `files` already carries the same fields
// per-artifact and is the one electron-updater itself reads for more than one target.

/** Why a `latest-*.yml` document was refused. */
export type ReleaseRefusal =
  | "malformed"
  | "unknown-key"
  | "missing-version"
  | "missing-files"
  | "malformed-file"
  | "no-matching-file"
  | "ambiguous-file";

/** The metadata could not be understood, or named no file this machine can use. */
export class ReleaseMetadataError extends Error {
  override name = "ReleaseMetadataError";
  readonly reason: ReleaseRefusal;

  constructor(reason: ReleaseRefusal, message: string) {
    super(message);
    this.reason = reason;
  }
}

export interface ReleaseFile {
  /** As electron-builder writes it: usually a bare filename, relative to the release. */
  readonly url: string;
  readonly sha512: string;
  readonly size: number;
}

export interface ReleaseMetadata {
  readonly version: string;
  readonly files: readonly ReleaseFile[];
}

/** The sha512 of `bytes`, base64: the digest a release file's metadata names it by. */
export type Sha512 = (bytes: Uint8Array) => string;

const TOP_LEVEL_KEYS = new Set([
  "version",
  "files",
  "path",
  "sha512",
  "releaseDate",
  "releaseName",
  "releaseNotes",
]);
const FILE_KEYS = new Set(["url", "sha512", "size"]);

/** A YAML scalar's quotes, when it has them; electron-builder quotes `releaseDate`. */
function unquote(value: string): string {
  const trimmed = value.trim();
  const first = trimmed.charAt(0);
  const last = trimmed.charAt(trimmed.length - 1);
  if (trimmed.length >= 2 && ((first === "'" && last === "'") || (first === '"' && last === '"'))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

type RawFile = { url?: string; sha512?: string; size?: string };

/**
 * The subset of YAML electron-builder's `latest-*.yml` actually uses: a flat map of scalars,
 * plus one `files:` block sequence of two-space-then-dash items whose fields sit at four
 * spaces. Nothing else — flow style, anchors, multi-document — is understood, and refusing
 * whole is preferred to reading part of a document a real publisher never produces this way.
 */
export function parseReleaseMetadata(text: string): ReleaseMetadata {
  const lines = text
    .split(/\r\n|\r|\n/)
    .map((line, position) => ({ line, position }))
    .filter(({ line }) => line.trim() !== "" && !line.trimStart().startsWith("#"));

  const top = new Map<string, string>();
  const files: RawFile[] = [];
  let index = 0;

  while (index < lines.length) {
    const entry = lines[index];
    if (entry === undefined) {
      break;
    }
    const topMatch = /^([A-Za-z][A-Za-z0-9_]*):[ \t]*(.*)$/.exec(entry.line);
    const [, key = "", rest = ""] = topMatch ?? [];
    if (topMatch === null) {
      throw new ReleaseMetadataError(
        "malformed",
        `line ${String(entry.position + 1)} is not a "key: value" line: ${entry.line}`,
      );
    }
    if (!TOP_LEVEL_KEYS.has(key)) {
      throw new ReleaseMetadataError(
        "unknown-key",
        `line ${String(entry.position + 1)} names an unknown key "${key}"`,
      );
    }
    if (top.has(key)) {
      throw new ReleaseMetadataError("malformed", `key "${key}" appears twice`);
    }
    index += 1;
    if (key !== "files") {
      top.set(key, unquote(rest));
      continue;
    }
    if (rest.trim() !== "") {
      throw new ReleaseMetadataError(
        "malformed",
        '"files:" must start a block sequence, not hold a value',
      );
    }
    top.set("files", "");
    let current: RawFile | null = null;
    while (index < lines.length) {
      const fileEntry = lines[index];
      if (fileEntry === undefined) {
        break;
      }
      const itemMatch = /^ {2}- ([A-Za-z][A-Za-z0-9_]*):[ \t]*(.*)$/.exec(fileEntry.line);
      if (itemMatch !== null) {
        const [, fieldKey = "", value = ""] = itemMatch;
        if (!FILE_KEYS.has(fieldKey)) {
          throw new ReleaseMetadataError(
            "malformed-file",
            `line ${String(fileEntry.position + 1)} names an unknown file key "${fieldKey}"`,
          );
        }
        current = { [fieldKey]: unquote(value) };
        files.push(current);
        index += 1;
        continue;
      }
      const fieldMatch = /^ {4}([A-Za-z][A-Za-z0-9_]*):[ \t]*(.*)$/.exec(fileEntry.line);
      if (fieldMatch !== null && current !== null) {
        const [, fieldKey = "", value = ""] = fieldMatch;
        if (!FILE_KEYS.has(fieldKey)) {
          throw new ReleaseMetadataError(
            "malformed-file",
            `line ${String(fileEntry.position + 1)} names an unknown file key "${fieldKey}"`,
          );
        }
        (current as Record<string, string>)[fieldKey] = unquote(value);
        index += 1;
        continue;
      }
      // Indented less than the block: the sequence ended; the outer loop reads it next.
      break;
    }
  }

  const version = top.get("version");
  if (version === undefined || version === "") {
    throw new ReleaseMetadataError("missing-version", "the metadata names no version");
  }
  if (files.length === 0) {
    throw new ReleaseMetadataError(
      "missing-files",
      "the metadata's files: block is empty or absent",
    );
  }
  const built = files.map((file, position): ReleaseFile => {
    if (file.url === undefined || file.sha512 === undefined || file.size === undefined) {
      throw new ReleaseMetadataError(
        "malformed-file",
        `files[${String(position)}] is missing url, sha512 or size`,
      );
    }
    const size = Number(file.size);
    if (!Number.isFinite(size) || size < 0 || !Number.isInteger(size)) {
      throw new ReleaseMetadataError(
        "malformed-file",
        `files[${String(position)}].size ("${file.size}") is not a whole number`,
      );
    }
    return { url: file.url, sha512: file.sha512, size };
  });
  return { version, files: built };
}

export type ReleasePlatform = "mac" | "linux";

/** electron-builder's own naming for a channel's per-platform metadata file. */
export function metadataFileName(channel: string, platform: ReleasePlatform): string {
  return `${channel}-${platform}.yml`;
}

/**
 * The one file this machine's architecture should install. A metadata document naming exactly
 * one file (the common case: one target built) is that file regardless of its name; naming
 * more than one is disambiguated by an `-<arch>.` or `-<arch>-` segment in its URL, as
 * electron-builder's own filenames carry it (`InnyTypes-1.2.3-arm64-mac.zip`).
 */
export function pickReleaseFile(files: readonly ReleaseFile[], arch: string): ReleaseFile {
  const first = files[0];
  if (files.length === 1 && first !== undefined) {
    return first;
  }
  const matches = files.filter(
    (file) => file.url.includes(`-${arch}.`) || file.url.includes(`-${arch}-`),
  );
  const [only, second] = matches;
  if (only !== undefined && second === undefined) {
    return only;
  }
  if (matches.length === 0) {
    throw new ReleaseMetadataError(
      "no-matching-file",
      `none of the metadata's files names this machine's architecture (${arch})`,
    );
  }
  throw new ReleaseMetadataError(
    "ambiguous-file",
    `more than one of the metadata's files names ${arch}; cannot choose`,
  );
}
