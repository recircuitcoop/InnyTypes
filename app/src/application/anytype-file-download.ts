// API-download-file, answered by InnyTypes itself (plan 0019, "Where the fix lives" (b)).
//
// The pinned MCP child decodes every answer as UTF-8 and sends it as one stdout line, so a
// file that is not text is destroyed inside it, and one larger than a MiB closes its session.
// The endpoint therefore never forwards this tool: it reads the file from Anytype's REST API
// with the key this process holds, and answers one embedded `resource` block.
//
// * The block's uri is `anytype-file://<space_id>/<file_id>`; resources/read on that uri is
//   answered by the same code, so a client that reads resources gets the same contents.
// * `text` for a text/* or JSON file that is strict UTF-8, `blob` (base64) for anything else.
// * At most MAX_FILE_BYTES of file per answer and MAX_DOWNLOADS at once; a third is refused,
//   not queued. A bound is a refusal with `isError: true`, never a crash, and leaves one log
//   line with the space, the file and both sizes, never the key.
// * A `blob` written here is the one string the dispatch does not redact (D5): base64 cannot
//   hold the key verbatim, and replacing a substring of it would corrupt the file.

import type { FetchedFile, FileRequest, FileSource } from "../ports/anytype";
import type { Logger } from "../ports/logger";

/** The one tool answered here instead of by the child. */
export const DOWNLOAD_TOOL = "API-download-file";
/** The scheme of the uri a downloaded file is named by. */
export const FILE_URI_SCHEME = "anytype-file:";
/** The most file bytes one answer carries (D2): about 21.4 MiB once base64. */
export const MAX_FILE_BYTES = 16 * 1024 * 1024;
/** How many downloads may run at once (D2); the next is refused. */
export const MAX_DOWNLOADS = 2;

const MIB = 1024 * 1024;

/** One file as MCP carries it: an embedded resource's `resource`, or resources/read's entry. */
export type FileContents =
  | { readonly uri: string; readonly mimeType: string; readonly text: string }
  | { readonly uri: string; readonly mimeType: string; readonly blob: string };

/**
 * The file, or the sentence a client is told instead: a refusal, or, when an If-None-Match
 * matched, that the copy the client holds is still the file (not an error).
 */
export type Downloaded =
  | { readonly ok: true; readonly contents: FileContents }
  | { readonly ok: false; readonly message: string; readonly notModified?: true };

// Every `contents` built here, so the dispatch can tell a blob it may leave unredacted from a
// `blob` key the child happened to write.
const ownContents = new WeakSet<object>();

/** True when `value` is file contents this module built from Anytype's bytes. */
export function isOwnFileContents(value: unknown): boolean {
  return typeof value === "object" && value !== null && ownContents.has(value);
}

/**
 * True for a plain Anytype id: a CID such as `bafyrei…`, a short space ref, or a full space id
 * `<cid>.<replicationKey>`. Letters, digits, `.`, `_` and `-`, starting with a letter or digit,
 * so no id is ever a `.` or `..` path segment that fetch would resolve away.
 */
export function isAnytypeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(value);
}

/** The uri a file is named by. Only ever built from ids isAnytypeId accepted. */
export function fileUri(spaceId: string, fileId: string): string {
  return `${FILE_URI_SCHEME}//${encodeURIComponent(spaceId)}/${encodeURIComponent(fileId)}`;
}

/** The space and file a uri names, or null when it is not an anytype-file uri of two ids. */
export function parseFileUri(uri: string): FileRequest | null {
  const match = /^anytype-file:\/\/([^/?#]+)\/([^/?#]+)$/.exec(uri);
  if (match === null) {
    return null;
  }
  let spaceId: string;
  let fileId: string;
  try {
    spaceId = decodeURIComponent(match[1] ?? "");
    fileId = decodeURIComponent(match[2] ?? "");
  } catch {
    return null;
  }
  return isAnytypeId(spaceId) && isAnytypeId(fileId) ? { spaceId, fileId } : null;
}

/** The refusal of a file over the bound, its size rounded up to whole megabytes. */
export function oversizedMessage(size: number | null, maxBytes: number): string {
  const shown =
    size === null
      ? `over ${String(Math.ceil(maxBytes / MIB))} MB`
      : `${String(Math.ceil(size / MIB))} MB`;
  return (
    `This file is ${shown}. InnyTypes sends files up to ${String(Math.ceil(maxBytes / MIB))} MB, ` +
    "so it wasn't sent. Ask for part of it with a byte range."
  );
}

export const BUSY_MESSAGE = `InnyTypes is already sending ${String(MAX_DOWNLOADS)} files. Ask again when one has finished.`;
export const ARGUMENTS_MESSAGE = `${DOWNLOAD_TOOL} needs a space_id and a file_id.`;
export const ID_MESSAGE =
  "space_id and file_id must each be an Anytype id: letters, digits, '.', '_' and '-', " +
  "starting with a letter or digit.";
export const WIDTH_MESSAGE = "width must be a whole number of pixels, 0 or more.";
export const NOT_MODIFIED_MESSAGE =
  "The file has not changed since the ETag sent in If-None-Match, so it wasn't sent again.";

/** The refusal of a header argument that is not one line of visible text. */
export function headerMessage(name: string): string {
  return `${name} must be one line of text, such as ${name === "Range" ? "bytes=0-1023" : 'an ETag like "abc"'}.`;
}
export const NOT_PAIRED_MESSAGE = "InnyTypes is not paired with Anytype, so it cannot read files.";

export interface FileDownloadsDeps {
  /** Anytype's REST API. */
  readonly source: FileSource;
  /** The Anytype key now; null while there is none. May throw when it cannot be read. */
  readonly key: () => string | null;
  readonly logger: Logger;
  /** MAX_FILE_BYTES unless a test sets a smaller bound. */
  readonly maxBytes?: number;
}

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The tool's arguments as a request, or the sentence saying what is wrong with them. */
function requestOf(args: unknown): FileRequest | string {
  if (!isObject(args)) {
    return ARGUMENTS_MESSAGE;
  }
  const { space_id: spaceId, file_id: fileId, width } = args;
  if (spaceId === undefined || spaceId === "" || fileId === undefined || fileId === "") {
    return ARGUMENTS_MESSAGE;
  }
  if (!isAnytypeId(spaceId) || !isAnytypeId(fileId)) {
    return ID_MESSAGE;
  }
  if (width !== undefined && (!Number.isInteger(width) || (width as number) < 0)) {
    return WIDTH_MESSAGE;
  }
  const headers: Record<string, string> = {};
  for (const [name, field] of [
    ["Range", "range"],
    ["If-None-Match", "ifNoneMatch"],
    ["If-Range", "ifRange"],
  ] as const) {
    const value = args[name];
    if (value === undefined) {
      continue;
    }
    // Printable ASCII only: a CR or LF would split the header, and fetch refuses it anyway.
    if (typeof value !== "string" || !/^[\x20-\x7e]*$/.test(value)) {
      return headerMessage(name);
    }
    headers[field] = value;
  }
  return {
    spaceId,
    fileId,
    ...(width === undefined ? {} : { width: width as number }),
    ...headers,
  };
}

/** The media type without its parameters, lower-cased. */
function essence(contentType: string): string {
  return (contentType.split(";")[0] ?? "").trim().toLowerCase();
}

/** The bytes as text when the type says text or JSON and they are strict UTF-8; else null. */
function asText(contentType: string, bytes: Uint8Array): string | null {
  const type = essence(contentType);
  if (!type.startsWith("text/") && !type.includes("json")) {
    return null;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Downloads from Anytype, bounded in size and in how many run at once. */
export class FileDownloads {
  readonly #deps: FileDownloadsDeps;
  readonly #maxBytes: number;
  #running = 0;

  constructor(deps: FileDownloadsDeps) {
    this.#deps = deps;
    this.#maxBytes = deps.maxBytes ?? MAX_FILE_BYTES;
  }

  /** The tools/call result for API-download-file's `args`: one resource block, or an error. */
  async call(args: unknown): Promise<Readonly<Record<string, unknown>>> {
    const request = requestOf(args);
    const downloaded: Downloaded =
      typeof request === "string" ? { ok: false, message: request } : await this.download(request);
    if (!downloaded.ok) {
      const text = [{ type: "text", text: downloaded.message }];
      return downloaded.notModified === true ? { content: text } : { content: text, isError: true };
    }
    return { content: [{ type: "resource", resource: downloaded.contents }] };
  }

  /** The file a uri names, for resources/read; null when the uri is not an anytype-file one. */
  async read(uri: string): Promise<Downloaded | null> {
    const request = parseFileUri(uri);
    return request === null ? null : this.download(request);
  }

  /** One file, or why it was not sent. Never throws. */
  async download(request: FileRequest): Promise<Downloaded> {
    if (this.#running >= MAX_DOWNLOADS) {
      return { ok: false, message: BUSY_MESSAGE };
    }
    this.#running += 1;
    try {
      return await this.#download(request);
    } finally {
      this.#running -= 1;
    }
  }

  async #download(request: FileRequest): Promise<Downloaded> {
    let key: string | null;
    try {
      key = this.#deps.key();
    } catch (error) {
      return {
        ok: false,
        message: `The Anytype key could not be read: ${(error as Error).message}`,
      };
    }
    if (key === null) {
      return { ok: false, message: NOT_PAIRED_MESSAGE };
    }
    let fetched: FetchedFile;
    try {
      fetched = await this.#deps.source.downloadFile(key, request, this.#maxBytes);
    } catch (error) {
      // The client's messages name the URL and the status, never the key or a body.
      return { ok: false, message: (error as Error).message };
    }
    if (fetched.kind === "not-modified") {
      return { ok: false, message: NOT_MODIFIED_MESSAGE, notModified: true };
    }
    if (fetched.kind === "too-large") {
      const size =
        fetched.size === null ? `more than ${String(this.#maxBytes)}` : String(fetched.size);
      this.#deps.logger.warn(
        `a file was not sent: space ${JSON.stringify(request.spaceId)}, ` +
          `file ${JSON.stringify(request.fileId)}, ${size} bytes, the bound is ` +
          `${String(this.#maxBytes)} bytes`,
      );
      return { ok: false, message: oversizedMessage(fetched.size, this.#maxBytes) };
    }
    const mimeType = fetched.contentType ?? "application/octet-stream";
    const uri = fileUri(request.spaceId, request.fileId);
    const text = asText(mimeType, fetched.bytes);
    const contents: FileContents =
      text === null
        ? { uri, mimeType, blob: Buffer.from(fetched.bytes).toString("base64") }
        : { uri, mimeType, text };
    if (text === null) {
      ownContents.add(contents);
    }
    return { ok: true, contents };
  }
}
