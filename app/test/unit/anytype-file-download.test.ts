// API-download-file as InnyTypes answers it (plan 0019, slice 02): from Anytype's REST API, as
// one embedded resource, bounded in size and in how many run at once. Anytype here is a fake
// fetch serving files in the shape of its spec (GET /v2/spaces/{space_id}/files/{file_id}/content),
// read through the real client: never the person's Anytype.
import { createHash, randomBytes } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AnytypeClient } from "../../src/adapters/anytype/api-client";
import {
  ARGUMENTS_MESSAGE,
  BUSY_MESSAGE,
  FileDownloads,
  fileUri,
  headerMessage,
  ID_MESSAGE,
  MAX_FILE_BYTES,
  NOT_MODIFIED_MESSAGE,
  parseFileUri,
  WIDTH_MESSAGE,
} from "../../src/application/anytype-file-download";
import { RecordingLogger } from "../fakes/children";

const KEY = "file-download-canary-key-0123456789";
const SPACE = "space.one";
const CHUNK = 64 * 1024;

interface ServedFile {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  /** False to send no Content-Length, so only reading can find the size. */
  readonly declareLength?: boolean;
  /** What Content-Length says, when it should not be the truth. */
  readonly declaredLength?: number;
  /** Held until this settles, to keep a download running. */
  readonly hold?: Promise<void>;
  /** The file's ETag: an If-None-Match naming it is answered 304. */
  readonly etag?: string;
}

interface Asked {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** A fake Anytype: the probe, and each file's content route, with Range answered as 206. */
function fakeAnytype(files: Readonly<Record<string, ServedFile>>) {
  const asked: Asked[] = [];
  /** Bytes of each file's body the client pulled, so a test can tell what was read. */
  const pulled = new Map<string, number>();
  // The client always asks with a URL string.
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(input as string);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    if (url.pathname === "/v1/spaces") {
      return Response.json({ data: [] });
    }
    asked.push({ url: `${url.pathname}${url.search}`, headers });
    if (headers["authorization"] !== `Bearer ${KEY}`) {
      return Response.json({ code: "unauthorized" }, { status: 401 });
    }
    const route = /^\/v2\/spaces\/([^/]+)\/files\/([^/]+)\/content$/.exec(url.pathname);
    const id = route === null ? "" : decodeURIComponent(route[2] ?? "");
    const file = files[id];
    if (route === null || file === undefined) {
      return Response.json({ code: "not_found" }, { status: 404 });
    }
    await file.hold;
    if (file.etag !== undefined && headers["if-none-match"] === file.etag) {
      return new Response(null, { status: 304 });
    }
    let bytes = file.bytes;
    let status = 200;
    const reply: Record<string, string> = { "content-type": file.contentType };
    const range = /^bytes=(\d+)-(\d+)$/.exec(headers["range"] ?? "");
    if (range !== null) {
      const [first, last] = [Number(range[1]), Number(range[2])];
      bytes = file.bytes.subarray(first, last + 1);
      status = 206;
      reply["content-range"] =
        `bytes ${String(first)}-${String(last)}/${String(file.bytes.length)}`;
    }
    if (file.declareLength !== false) {
      reply["content-length"] = String(file.declaredLength ?? bytes.length);
    }
    pulled.set(id, 0);
    let offset = 0;
    // highWaterMark 0: nothing is pulled until the client reads.
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (offset >= bytes.length) {
            controller.close();
            return;
          }
          const chunk = bytes.subarray(offset, offset + CHUNK);
          offset += chunk.length;
          pulled.set(id, offset);
          controller.enqueue(chunk);
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(body, { status, headers: reply });
  };
  return { fetchFn, asked, pulled };
}

function subject(files: Readonly<Record<string, ServedFile>>, options: { maxBytes?: number } = {}) {
  const anytype = fakeAnytype(files);
  const logger = new RecordingLogger();
  const downloads = new FileDownloads({
    source: new AnytypeClient({ apiBaseUrl: "http://127.0.0.1:31009", fetch: anytype.fetchFn }),
    key: () => KEY,
    logger,
    ...options,
  });
  return { ...anytype, logger, downloads };
}

/** A generated PDF of `size` bytes: a real header and trailer around bytes that are not text. */
function pdf(size: number): Uint8Array {
  const bytes = new Uint8Array(randomBytes(size));
  bytes.set(new TextEncoder().encode("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n"), 0);
  bytes.set(new TextEncoder().encode("\n%%EOF\n"), size - 7);
  return bytes;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** The one resource block of a tools/call result, which must be all there is. */
function resourceOf(answer: Readonly<Record<string, unknown>>): Record<string, unknown> {
  expect(answer["isError"]).toBeUndefined();
  const content = answer["content"] as { type: string; resource: Record<string, unknown> }[];
  expect(content).toHaveLength(1);
  expect(content[0]?.type).toBe("resource");
  return content[0]?.resource ?? {};
}

describe("a file InnyTypes answers itself", () => {
  it("a PDF round-trips intact", async () => {
    const bytes = pdf(Math.round(7.3 * 1024 * 1024));
    const { downloads, asked } = subject({
      bafyreihpdf7q3x: { bytes, contentType: "application/pdf" },
    });
    const answer = await downloads.call({ space_id: SPACE, file_id: "bafyreihpdf7q3x" });
    const resource = resourceOf(answer);
    expect(resource["mimeType"]).toBe("application/pdf");
    expect(resource["uri"]).toBe("anytype-file://space.one/bafyreihpdf7q3x");
    expect(resource["text"]).toBeUndefined();
    const decoded = new Uint8Array(Buffer.from(String(resource["blob"]), "base64"));
    expect(decoded.length).toBe(bytes.length);
    expect(sha256(decoded)).toBe(sha256(bytes));
    // Asked of Anytype's REST API with the key.
    expect(asked.map((request) => request.url)).toEqual([
      `/v2/spaces/space.one/files/bafyreihpdf7q3x/content`,
    ]);
    expect(asked[0]?.headers["anytype-version"]).toBeTruthy();
    // The uri names the same file again.
    expect(parseFileUri(String(resource["uri"]))).toEqual({
      spaceId: SPACE,
      fileId: "bafyreihpdf7q3x",
    });
  });

  it("a text file is still text", async () => {
    const note = "Grüße, a note — in UTF-8.\n";
    const { downloads } = subject({
      note: { bytes: new TextEncoder().encode(note), contentType: "text/plain; charset=utf-8" },
      json: { bytes: new TextEncoder().encode('{"a":"é"}'), contentType: "application/json" },
      // Claims text/plain, but 0xFF 0xFE is not UTF-8: it stays bytes.
      latin: {
        bytes: Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0xff, 0xfe]),
        contentType: "text/plain",
      },
    });
    const text = resourceOf(await downloads.call({ space_id: SPACE, file_id: "note" }));
    expect(text).toEqual({
      uri: fileUri(SPACE, "note"),
      mimeType: "text/plain; charset=utf-8",
      text: note,
    });
    expect(resourceOf(await downloads.call({ space_id: SPACE, file_id: "json" }))["text"]).toBe(
      '{"a":"é"}',
    );
    const latin = resourceOf(await downloads.call({ space_id: SPACE, file_id: "latin" }));
    expect(latin["text"]).toBeUndefined();
    expect(latin["mimeType"]).toBe("text/plain");
    expect([...Buffer.from(String(latin["blob"]), "base64")]).toEqual([
      0x63, 0x61, 0x66, 0xe9, 0xff, 0xfe,
    ]);
  });

  it("an oversized file is refused, not read", async () => {
    const big = new Uint8Array(40 * 1024 * 1024);
    const { downloads, pulled, logger } = subject({
      declared: { bytes: big, contentType: "application/pdf" },
      undeclared: { bytes: big, contentType: "application/pdf", declareLength: false },
      // A header that lies: the body runs past what it said.
      understated: { bytes: big, contentType: "application/pdf", declaredLength: 1024 },
    });
    const sentence =
      "This file is 40 MB. InnyTypes sends files up to 16 MB, so it wasn't sent. " +
      "Ask for part of it with a byte range.";

    // Content-Length says so: refused before one byte of the body is read.
    expect(await downloads.call({ space_id: SPACE, file_id: "declared" })).toEqual({
      content: [{ type: "text", text: sentence }],
      isError: true,
    });
    expect(pulled.get("declared")).toBe(0);

    // No Content-Length, or a false one: read up to the bound and stopped there.
    for (const id of ["undeclared", "understated"]) {
      expect(await downloads.call({ space_id: SPACE, file_id: id })).toEqual({
        content: [
          {
            type: "text",
            text:
              "This file is over 16 MB. InnyTypes sends files up to 16 MB, so it wasn't sent. " +
              "Ask for part of it with a byte range.",
          },
        ],
        isError: true,
      });
      expect(pulled.get(id)).toBeGreaterThan(MAX_FILE_BYTES);
      expect(pulled.get(id)).toBeLessThanOrEqual(MAX_FILE_BYTES + CHUNK);
    }

    // One line each, with the space, the file and both sizes, never the key.
    expect(logger.lines).toEqual([
      `WARN a file was not sent: space "space.one", file "declared", ${String(big.length)} bytes, the bound is ${String(MAX_FILE_BYTES)} bytes`,
      `WARN a file was not sent: space "space.one", file "undeclared", more than ${String(MAX_FILE_BYTES)} bytes, the bound is ${String(MAX_FILE_BYTES)} bytes`,
      `WARN a file was not sent: space "space.one", file "understated", more than ${String(MAX_FILE_BYTES)} bytes, the bound is ${String(MAX_FILE_BYTES)} bytes`,
    ]);
    expect(logger.lines.join("\n")).not.toContain(KEY);

    // A file exactly at the bound is sent.
    const atBound = new Uint8Array(MAX_FILE_BYTES).fill(7);
    const exact = subject({ edge: { bytes: atBound, contentType: "application/octet-stream" } });
    const resource = resourceOf(await exact.downloads.call({ space_id: SPACE, file_id: "edge" }));
    expect(Buffer.from(String(resource["blob"]), "base64").length).toBe(MAX_FILE_BYTES);
  });

  it("two downloads at once, the third refused", async () => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const bytes = new TextEncoder().encode("held");
    const { downloads, asked } = subject({
      a: { bytes, contentType: "application/octet-stream", hold },
      b: { bytes, contentType: "application/octet-stream", hold },
      c: { bytes, contentType: "application/octet-stream" },
    });
    const first = downloads.call({ space_id: SPACE, file_id: "a" });
    const second = downloads.call({ space_id: SPACE, file_id: "b" });
    // Refused at once while both are running, not queued behind them: Anytype never hears of it.
    expect(await downloads.call({ space_id: SPACE, file_id: "c" })).toEqual({
      content: [{ type: "text", text: BUSY_MESSAGE }],
      isError: true,
    });
    expect(asked.some((request) => request.url.includes("/files/c/"))).toBe(false);
    release();
    resourceOf(await first);
    resourceOf(await second);
    // With both finished, the next is answered.
    resourceOf(await downloads.call({ space_id: SPACE, file_id: "c" }));
  });

  it("a byte range is passed through", async () => {
    const bytes = pdf(4096);
    const { downloads, asked } = subject({ doc: { bytes, contentType: "application/pdf" } });
    const answer = await downloads.call({
      space_id: SPACE,
      file_id: "doc",
      width: 0,
      Range: "bytes=100-1123",
      "If-None-Match": '"etag-1"',
      "If-Range": '"etag-1"',
    });
    // Each reached Anytype unchanged: width as the query parameter, the rest as headers.
    expect(asked).toHaveLength(1);
    expect(asked[0]?.url).toBe("/v2/spaces/space.one/files/doc/content?width=0");
    expect(asked[0]?.headers).toMatchObject({
      range: "bytes=100-1123",
      "if-none-match": '"etag-1"',
      "if-range": '"etag-1"',
    });
    // The 206 is answered as the partial bytes, and only those.
    const resource = resourceOf(answer);
    const decoded = new Uint8Array(Buffer.from(String(resource["blob"]), "base64"));
    expect(decoded.length).toBe(1024);
    expect(sha256(decoded)).toBe(sha256(bytes.subarray(100, 1124)));
  });

  it("says what is wrong with arguments that are not the spec's, and asks Anytype nothing", async () => {
    const { downloads, asked } = subject({});
    const refusals: [unknown, string][] = [
      [undefined, ARGUMENTS_MESSAGE],
      [{}, ARGUMENTS_MESSAGE],
      [{ space_id: SPACE }, ARGUMENTS_MESSAGE],
      [{ space_id: SPACE, file_id: "" }, ARGUMENTS_MESSAGE],
      [{ space_id: SPACE, file_id: 7 }, ID_MESSAGE],
      [{ space_id: SPACE, file_id: "x", width: -1 }, WIDTH_MESSAGE],
      [{ space_id: SPACE, file_id: "x", width: 1.5 }, WIDTH_MESSAGE],
      [{ space_id: SPACE, file_id: "x", width: "100" }, WIDTH_MESSAGE],
      [{ space_id: SPACE, file_id: "x", Range: 5 }, headerMessage("Range")],
      [{ space_id: SPACE, file_id: "x", Range: "bytes=0-1\r\nX-Evil: 1" }, headerMessage("Range")],
      [{ space_id: SPACE, file_id: "x", "If-Range": "a\nb" }, headerMessage("If-Range")],
      [{ space_id: SPACE, file_id: "x", "If-None-Match": "é" }, headerMessage("If-None-Match")],
    ];
    for (const [args, message] of refusals) {
      expect(await downloads.call(args)).toEqual({
        content: [{ type: "text", text: message }],
        isError: true,
      });
    }
    expect(asked).toEqual([]);
  });

  it("answers a 404, and no key, as tool errors", async () => {
    const { downloads } = subject({});
    const missing = await downloads.call({ space_id: SPACE, file_id: "gone" });
    expect(missing).toMatchObject({ isError: true });
    expect(JSON.stringify(missing)).toContain("404");
    const unpaired = new FileDownloads({
      source: { downloadFile: () => Promise.reject(new Error("not asked")) },
      key: () => null,
      logger: new RecordingLogger(),
    });
    expect(await unpaired.call({ space_id: SPACE, file_id: "x" })).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining("not paired") as unknown }],
    });
  });

  it("answers Anytype's 304 as not modified, not as an error", async () => {
    const { downloads, asked } = subject({
      doc: { bytes: new Uint8Array([1, 2, 3]), contentType: "application/pdf", etag: '"e1"' },
    });
    expect(
      await downloads.call({ space_id: SPACE, file_id: "doc", "If-None-Match": '"e1"' }),
    ).toEqual({ content: [{ type: "text", text: NOT_MODIFIED_MESSAGE }] });
    expect(asked[0]?.headers["if-none-match"]).toBe('"e1"');
    // Another ETag gets the file.
    resourceOf(await downloads.call({ space_id: SPACE, file_id: "doc", "If-None-Match": '"e0"' }));
  });
});

/** A server on a free loopback port that records every path asked of it. */
async function listening(
  answer: (path: string, response: http.ServerResponse) => void,
): Promise<{ base: string; paths: string[]; server: http.Server }> {
  const paths: string[] = [];
  const server = http.createServer((request, response) => {
    paths.push(request.url ?? "");
    answer(request.url ?? "", response);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    paths,
    server,
  };
}

const servers: http.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

describe("what a download may reach, over real HTTP and the real fetch", () => {
  /** Anytype answering every path with bytes, so a request that escaped its route shows. */
  async function anytypeAnsweringEverything(redirectTo?: string) {
    return listening((path, response) => {
      if (path === "/v1/spaces") {
        response.setHeader("content-type", "application/json");
        response.end('{"data":[]}');
      } else if (redirectTo !== undefined) {
        response.statusCode = 302;
        response.setHeader("location", redirectTo);
        response.end();
      } else {
        response.setHeader("content-type", "application/octet-stream");
        response.end(`bytes of ${path}`);
      }
    });
  }

  const downloadsFrom = (base: string) =>
    new FileDownloads({
      source: new AnytypeClient({ apiBaseUrl: base }),
      key: () => KEY,
      logger: new RecordingLogger(),
    });

  it("refuses an id that is a dot segment, or holds one, through the tool and through a uri", async () => {
    const anytype = await anytypeAnsweringEverything();
    const downloads = downloadsFrom(anytype.base);
    const probes: [string, string][] = [
      ["..", ".."],
      ["s", ".."],
      ["..", "x"],
      [".", "x"],
      ["s", "."],
      ["s", "../x"],
      ["s", "a/b"],
      ["s", "%2e%2e"],
      ["s", "-x"],
      ["s", "x?y"],
    ];
    for (const [spaceId, fileId] of probes) {
      expect(await downloads.call({ space_id: spaceId, file_id: fileId })).toEqual({
        content: [{ type: "text", text: ID_MESSAGE }],
        isError: true,
      });
    }
    for (const uri of [
      "anytype-file://../..",
      "anytype-file://s/..",
      "anytype-file://../x",
      "anytype-file://./x",
      "anytype-file://s/.",
      "anytype-file://%2e%2e/x",
      "anytype-file://s/%2E%2E",
      "anytype-file://s/a%2Fb",
      "anytype-file://s/%ZZ",
    ]) {
      expect(await downloads.read(uri)).toBeNull();
    }
    // Not one of them reached Anytype, not even its probe.
    expect(anytype.paths).toEqual([]);
    // A full space id, `<cid>.<replicationKey>`, and a CID are ids: those are asked for.
    const space = "bafyreigbtj4x2kbmzq.2k4hxc1wrhw1v";
    const resource = await downloads.call({ space_id: space, file_id: "bafybeih5x" });
    expect(resource).not.toHaveProperty("isError");
    expect(anytype.paths).toEqual(["/v1/spaces", `/v2/spaces/${space}/files/bafybeih5x/content`]);
    expect(await downloads.read(fileUri(space, "bafybeih5x"))).toMatchObject({ ok: true });
  });

  it("never follows a redirect: another host's bytes are never the file", async () => {
    const elsewhere = await listening((_path, response) => {
      response.setHeader("content-type", "text/plain");
      response.end("not Anytype's bytes");
    });
    const anytype = await anytypeAnsweringEverything(`${elsewhere.base}/foreign`);
    const answer = await downloadsFrom(anytype.base).call({ space_id: SPACE, file_id: "moved" });
    expect(answer).toMatchObject({
      isError: true,
      content: [{ type: "text", text: expect.stringContaining("redirect (HTTP 302)") as unknown }],
    });
    expect(JSON.stringify(answer)).not.toContain("not Anytype's bytes");
    expect(elsewhere.paths).toEqual([]);
  });
});
