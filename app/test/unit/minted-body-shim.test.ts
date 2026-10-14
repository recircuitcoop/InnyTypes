// The unwrap shim (plan 0023, WI-0023-02), driven through mcpDispatch: a call to a tool whose
// body the pinned child wraps under `body` reaches the child with that body flat, so the child's
// HTTP client sends the document itself; every other call reaches it exactly as it came. The
// minted tools are served with their recorded input schemas, the pinned ones byte for byte.
import fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mcpDispatch } from "../../src/application/mcp-dispatch";
import { MINTED_BODY_TOOLS } from "../../src/domain/anytype/minted-body";
import type { McpSession, McpTool } from "../../src/ports/anytype";
import { RecordingLogger } from "../fakes/children";
import { FakeClock } from "../fakes/clock";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCHEMAS = JSON.parse(
  fs.readFileSync(path.join(APP, "test", "fixtures", "minted-body", "input-schemas.json"), "utf8"),
) as Record<string, Readonly<Record<string, unknown>>>;

/** Tools whose body the child flattens: their schema has no `body`, so nothing is unwrapped. */
const FLAT_TOOLS: readonly McpTool[] = [
  {
    name: "API-create-property",
    inputSchema: { type: "object", properties: { space_id: {}, name: {}, format: {} } },
  },
  {
    name: "API-patch-object",
    inputSchema: { type: "object", properties: { space_id: {}, object_id: {}, ops: {} } },
  },
];
const TOOLS: readonly McpTool[] = [
  ...Object.entries(SCHEMAS).map(([name, inputSchema]) => ({ name, inputSchema })),
  ...FLAT_TOOLS,
];

const SHORTCUT = { type: "page", name: "Shim probe", markdown: "hello" };
const DOCUMENT = {
  formatVersion: "2.0",
  kind: "object",
  type: "page",
  properties: { name: "Shim probe" },
  blocks: [{ id: "b1", text: { text: "hello", style: "Paragraph" } }],
};

/** A child session that records the params of every call it is asked to run. */
class RecordingSession implements McpSession {
  closed = false;
  readonly calls: Readonly<Record<string, unknown>>[] = [];

  initialize(): Promise<readonly McpTool[]> {
    return Promise.resolve(TOOLS);
  }
  ping(): Promise<void> {
    return Promise.resolve();
  }
  request(_method: string, params: Readonly<Record<string, unknown>> = {}): Promise<unknown> {
    this.calls.push(params);
    return Promise.resolve({ content: [{ type: "text", text: "{}" }] });
  }
  close(): void {
    this.closed = true;
  }
  onBroken(): void {
    // never broken here
  }
}

/** Sends one tools/call through mcpDispatch; returns the answer and what the child was asked. */
async function call(name: string, args: Readonly<Record<string, unknown>>) {
  const session = new RecordingSession();
  const handle = mcpDispatch({
    served: () => ({ session, tools: TOOLS }),
    redact: (text) => text,
    clock: new FakeClock(),
    logger: new RecordingLogger(),
  });
  const request = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  };
  const answer = await handle(new TextEncoder().encode(JSON.stringify(request)));
  return { answer, forwarded: session.calls };
}

describe("the unwrap shim", () => {
  it("serves the five inventoried tools with the schemas that mint `body`", () => {
    expect(Object.keys(SCHEMAS).sort()).toEqual(Object.keys(MINTED_BODY_TOOLS).sort());
  });

  it("forwards API-create-object's shortcut body flat, next to its parameters", async () => {
    const { forwarded } = await call("API-create-object", {
      space_id: "sp1",
      dry_run: true,
      body: SHORTCUT,
    });
    expect(forwarded).toEqual([
      { name: "API-create-object", arguments: { space_id: "sp1", dry_run: true, ...SHORTCUT } },
    ]);
    expect(forwarded[0]?.["arguments"]).not.toHaveProperty("body");
  });

  it("forwards a full AnyBlock document (formatVersion 2.0) flat", async () => {
    const { forwarded } = await call("API-create-object", {
      space_id: "sp1",
      dry_run: true,
      body: DOCUMENT,
    });
    expect(forwarded).toEqual([
      { name: "API-create-object", arguments: { space_id: "sp1", dry_run: true, ...DOCUMENT } },
    ]);
  });

  it("forwards API-update-type's documented body flat, its path parameters kept", async () => {
    const body = { name: "Renamed", plural_name: "Renamed ones", layout: "basic" };
    const { forwarded } = await call("API-update-type", { space_id: "sp1", type: "ty1", body });
    expect(forwarded).toEqual([
      { name: "API-update-type", arguments: { space_id: "sp1", type: "ty1", ...body } },
    ]);
  });

  it("unwraps every inventoried tool, and leaves the client's own params unchanged", async () => {
    for (const name of Object.keys(MINTED_BODY_TOOLS)) {
      const args = { space_id: "sp1", body: { formatVersion: "2.0", kind: "x" } };
      const { forwarded } = await call(name, args);
      expect(forwarded).toEqual([
        { name, arguments: { space_id: "sp1", formatVersion: "2.0", kind: "x" } },
      ]);
      expect(args).toHaveProperty("body");
    }
  });

  it("refuses a body member that is also an argument of the tool, forwarding nothing", async () => {
    // `dry_run` is a parameter of API-create-object, so sent flat the child would put it in
    // the query and never in the body; `extra` is a sibling the call itself already carries.
    for (const args of [
      { space_id: "sp1", body: { ...SHORTCUT, dry_run: true } },
      { space_id: "sp1", extra: 1, body: { ...SHORTCUT, extra: 2 } },
    ]) {
      const { answer, forwarded } = await call("API-create-object", args);
      expect(forwarded).toEqual([]);
      const body = answer.body as { id: unknown; error: { code: number; message: string } };
      expect(body.id).toBe(1);
      expect(body.error.code).toBe(-32602);
      expect(body.error.message).toMatch(/^API-create-object: body member "/);
    }
  });

  it("forwards a call it has nothing to unwrap exactly as it came", async () => {
    const cases: [string, Readonly<Record<string, unknown>>][] = [
      // Tools whose body the child already flattens: nothing to do, whatever they carry.
      ["API-create-property", { space_id: "sp1", name: "Due", format: "date" }],
      ["API-patch-object", { space_id: "sp1", object_id: "o1", ops: [{ op: "set" }] }],
      // A flat tool is never unwrapped, even if a client sends it a `body`.
      ["API-patch-object", { space_id: "sp1", object_id: "o1", body: { ops: [] } }],
      // A minted tool already called flat, or with a body that is not an object.
      ["API-create-object", { space_id: "sp1", ...SHORTCUT }],
      ["API-create-object", { space_id: "sp1", body: JSON.stringify(SHORTCUT) }],
    ];
    for (const [name, args] of cases) {
      const { forwarded } = await call(name, args);
      expect(forwarded).toEqual([{ name, arguments: args }]);
    }
  });
});
