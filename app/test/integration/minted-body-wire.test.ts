// What Anytype's API receives once the unwrap shim (plan 0023, WI-0023-02) has run: the real
// pinned child, behind mcpDispatch, against a local HTTP server standing in for Anytype. The
// server serves an OpenAPI spec whose request bodies are the recorded ones of the pinned surface
// (an anyOf for API-create-object and API-update-type, so the child mints `body` for them as it
// does live) and two flat ones; it records every request the child makes. Whether a live Anytype
// then answers dry_run instead of validation_failed is the owner's check (plan 0023).
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NodeMcpChildLauncher, pinnedPackageEntry } from "../../src/adapters/anytype/mcp-child";
import { systemClock } from "../../src/adapters/system/clock";
import { mcpDispatch } from "../../src/application/mcp-dispatch";
import { ToolSurfaceMismatchError } from "../../src/domain/anytype/errors";
import { childEnvironment } from "../../src/domain/anytype/pins";
import type { McpChild, McpTool } from "../../src/ports/anytype";
import type { McpHandler } from "../../src/ports/mcp-gateway";
import { RecordingLogger } from "../fakes/children";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCHEMAS = JSON.parse(
  fs.readFileSync(path.join(APP, "test", "fixtures", "minted-body", "input-schemas.json"), "utf8"),
) as Record<string, { properties: Record<string, unknown> }>;
const KEY = "wire-key-0123456789abcdef";

const pathParameter = (name: string) => ({
  name,
  in: "path",
  required: true,
  schema: { type: "string" },
});
const queryFlag = (name: string) => ({ name, in: "query", schema: { type: "boolean" } });
const jsonBody = (schema: unknown) => ({
  required: true,
  content: { "application/json": { schema } },
});
const ANSWERS = { 200: { description: "ok" } };

/** The fake Anytype's spec: two minted-body operations as pinned, two that flatten. */
const SPEC = {
  openapi: "3.0.0",
  info: { title: "fake Anytype", version: "1" },
  paths: {
    "/v1/spaces/{space_id}/objects": {
      post: {
        operationId: "create-object",
        parameters: [pathParameter("space_id"), queryFlag("dry_run")],
        requestBody: jsonBody(SCHEMAS["API-create-object"]?.properties["body"]),
        responses: ANSWERS,
      },
    },
    "/v1/spaces/{space_id}/types/{type}": {
      patch: {
        operationId: "update-type",
        parameters: [pathParameter("space_id"), pathParameter("type"), queryFlag("dry_run")],
        requestBody: jsonBody(SCHEMAS["API-update-type"]?.properties["body"]),
        responses: ANSWERS,
      },
    },
    "/v1/spaces/{space_id}/properties": {
      post: {
        operationId: "create-property",
        parameters: [pathParameter("space_id")],
        requestBody: jsonBody({
          type: "object",
          properties: { name: { type: "string" }, format: { type: "string" } },
        }),
        responses: ANSWERS,
      },
    },
    "/v1/spaces/{space_id}/objects/{object_id}": {
      patch: {
        operationId: "patch-object",
        parameters: [pathParameter("space_id"), pathParameter("object_id")],
        requestBody: jsonBody({
          type: "object",
          properties: { ops: { type: "array", items: { type: "object" } } },
        }),
        responses: ANSWERS,
      },
    },
  },
};

interface Received {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

const received: Received[] = [];
const server = http.createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url === "/docs/openapi.json") {
      response.end(JSON.stringify(SPEC));
      return;
    }
    const text = Buffer.concat(chunks).toString("utf8");
    received.push({
      method: request.method ?? "",
      url: request.url ?? "",
      body: text === "" ? undefined : (JSON.parse(text) as unknown),
    });
    response.end('{"object":"page","dry_run":true}');
  });
});

let child: McpChild;
let handle: McpHandler;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  const launcher = new NodeMcpChildLauncher({
    node: { command: process.execPath, env: {} },
    entry: pinnedPackageEntry(createRequire(import.meta.url).resolve),
    clock: systemClock,
    logger: new RecordingLogger(),
    // The fake spec is not the committed surface: the handshake names the difference, and the
    // session stays open for the tools it listed, which are what this child serves.
    expected: {},
  });
  child = launcher.launch(childEnvironment(KEY, base), () => undefined);
  await expect(child.session.initialize()).rejects.toBeInstanceOf(ToolSurfaceMismatchError);
  const tools = await listed();
  handle = mcpDispatch({
    served: () => ({ session: child.session, tools }),
    redact: (text) => text,
    clock: systemClock,
    logger: new RecordingLogger(),
  });
}, 30_000);

afterAll(async () => {
  await child.stop();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

/** The tools the child lists. */
async function listed(): Promise<McpTool[]> {
  const answer = (await child.session.request("tools/list")) as { tools: McpTool[] };
  return answer.tools;
}

/** One tools/call through mcpDispatch to the real child; what the fake Anytype received. */
async function wire(name: string, args: Readonly<Record<string, unknown>>): Promise<Received> {
  received.length = 0;
  const request = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  };
  const answer = await handle(new TextEncoder().encode(JSON.stringify(request)));
  expect(answer.body).toMatchObject({ result: { content: [{ type: "text" }] } });
  expect(received).toHaveLength(1);
  return received[0] as Received;
}

describe("the wire body, from the real pinned child", () => {
  it("mints `body` for the anyOf operations and flattens the flat ones, as pinned", async () => {
    const tools = await listed();
    const has = (name: string) =>
      Object.hasOwn(tools.find((t) => t.name === name)?.inputSchema["properties"] ?? {}, "body");
    expect(tools.map((t) => t.name).sort()).toEqual([
      "API-create-object",
      "API-create-property",
      "API-patch-object",
      "API-update-type",
    ]);
    expect(["API-create-object", "API-update-type"].every(has)).toBe(true);
    expect(["API-create-property", "API-patch-object"].some(has)).toBe(false);
  });

  it("sends API-create-object's shortcut as the body itself, not under `body`", async () => {
    const shortcut = { type: "page", name: "Shim probe", markdown: "hello" };
    const got = await wire("API-create-object", { space_id: "sp1", dry_run: true, body: shortcut });
    expect(got).toEqual({
      method: "POST",
      url: "/v1/spaces/sp1/objects?dry_run=true",
      body: shortcut,
    });
  }, 15_000);

  it("sends a full AnyBlock document (formatVersion 2.0) as the body itself", async () => {
    const document = {
      formatVersion: "2.0",
      kind: "object",
      type: "page",
      properties: { name: "Shim probe" },
      blocks: [{ id: "b1", text: { text: "hello", style: "Paragraph" } }],
    };
    const got = await wire("API-create-object", { space_id: "sp1", dry_run: true, body: document });
    expect(got).toEqual({
      method: "POST",
      url: "/v1/spaces/sp1/objects?dry_run=true",
      body: document,
    });
  }, 15_000);

  it("sends API-update-type's documented body as the body itself", async () => {
    const body = { name: "Renamed", plural_name: "Renamed ones", layout: "basic" };
    const got = await wire("API-update-type", { space_id: "sp1", type: "ty1", body });
    expect(got).toEqual({ method: "PATCH", url: "/v1/spaces/sp1/types/ty1", body });
  }, 15_000);

  it("sends the flat tools' bodies as they always were", async () => {
    expect(
      await wire("API-create-property", { space_id: "sp1", name: "Due", format: "date" }),
    ).toEqual({
      method: "POST",
      url: "/v1/spaces/sp1/properties",
      body: { name: "Due", format: "date" },
    });
    const ops = [{ op: "set_property", property: "name", value: "x" }];
    expect(await wire("API-patch-object", { space_id: "sp1", object_id: "o1", ops })).toEqual({
      method: "PATCH",
      url: "/v1/spaces/sp1/objects/o1",
      body: { ops },
    });
  }, 15_000);
});
