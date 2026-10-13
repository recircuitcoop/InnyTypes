// The dataview shim in the tools/call path (plan 0024, WI-0024-02; temporary, removed with
// application/dataview-shim.ts): what the child receives for every dataview shape a client
// can send, driven through mcpDispatch with a fake child that answers the shim's own lookups
// the way the pinned package answers them (a tool result whose text is Anytype's JSON).
import { describe, expect, it } from "vitest";
import { mcpDispatch, type ServedMcp } from "../../src/application/mcp-dispatch";
import { REDACTED, SecretRegistry } from "../../src/domain/redaction/registry";
import type { McpSession, McpTool } from "../../src/ports/anytype";
import { RecordingLogger } from "../fakes/children";
import { FakeClock } from "../fakes/clock";

type Json = Record<string, unknown>;

const SPACE = "space-1";
const LEDGER = { id: "bafy-ledger-type", key: "ledger_item", name: "Ledger item" };
const PAGE_TYPE = { id: "bafy-page-type", key: "page", name: "Page" };
const QUERY_ID = "bafy-a-query";
const COLLECTION_ID = "bafy-a-collection";
const TOOLS: McpTool[] = ["API-patch-object", "API-create-object", "API-search-space"].map(
  (name) => ({ name, inputSchema: { type: "object" } }),
);

const text = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });

/** A child answering the shim's lookups from a two-page type list and three objects. */
class FakeAnytypeChild implements McpSession {
  closed = false;
  readonly calls: Json[] = [];
  /** What API-list-types answers instead, when set. */
  listTypes: ((args: Json) => unknown) | undefined;
  queryName = "Costs";

  initialize(): Promise<readonly McpTool[]> {
    return Promise.resolve(TOOLS);
  }
  ping(): Promise<void> {
    return Promise.resolve();
  }
  close(): void {
    this.closed = true;
  }
  onBroken(): void {
    // never broken here
  }

  request(_method: string, params: Readonly<Record<string, unknown>> = {}): Promise<unknown> {
    this.calls.push(structuredClone(params));
    const args = (params["arguments"] ?? {}) as Json;
    switch (params["name"]) {
      case "API-list-types":
        return Promise.resolve(this.listTypes?.(args) ?? this.typePage(args));
      case "API-get-object":
        return Promise.resolve(this.object(String(args["object_id"])));
      default:
        return Promise.resolve(text({ forwarded: params["name"] }));
    }
  }

  /** Page one holds Page, page two the Ledger item type: the shim must read past page one. */
  private typePage(args: Json): unknown {
    const first = args["offset"] === 0;
    return text({
      data: [first ? PAGE_TYPE : LEDGER].map((type) => ({
        ...type,
        object: "type",
        layout: "basic",
      })),
      pagination: { total: 2, offset: args["offset"], limit: args["limit"], has_more: first },
    });
  }

  private object(id: string): unknown {
    if (id === QUERY_ID) {
      return text({
        object: {
          id,
          object: "object",
          name: this.queryName,
          layout: "set",
          type: { name: "Query" },
        },
      });
    }
    if (id === COLLECTION_ID) {
      return text({ object: { id, object: "object", name: "Reading", layout: "collection" } });
    }
    return text({ object: "error", status: 404, code: "not_found", message: "object not found" });
  }

  /** The client's own calls that reached the child: everything but the shim's lookups. */
  forwarded(): Json[] {
    return this.calls.filter(
      (call) => call["name"] !== "API-list-types" && call["name"] !== "API-get-object",
    );
  }

  lookups(): unknown[] {
    return this.calls
      .filter((call) => !this.forwarded().includes(call))
      .map((call) => call["name"]);
  }
}

function subject(registry = new SecretRegistry(), logger = new RecordingLogger()) {
  const session = new FakeAnytypeChild();
  const served: ServedMcp = { session, tools: TOOLS };
  const handle = mcpDispatch({
    served: () => served,
    redact: (value) => registry.redact(value),
    clock: new FakeClock(),
    logger,
  });
  let id = 0;
  const call = async (name: string, args: unknown) =>
    handle(
      new TextEncoder().encode(
        JSON.stringify({
          jsonrpc: "2.0",
          id: ++id,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      ),
    );
  return { session, call, logger };
}

const VIEWS = [{ name: "Cost ledger", type: "table" }];
const dataview = (member: Json): Json => ({ type: "dataview", ...member, views: VIEWS });
const patch = (op: string, ...blocks: Json[]): Json => ({
  space_id: SPACE,
  object_id: "bafy-the-page",
  ops: [{ op, blocks }],
});
const rewritten = (id: string): Json => ({ type: "dataview", views: VIEWS, object_id: id });

describe("a dataview naming a type by source", () => {
  it.each([
    ["type-<key>", "type-ledger_item"],
    ["the type's object id", LEDGER.id],
    ["the type's api_key", LEDGER.key],
  ])("is forwarded with object_id and no source, from %s", async (_how, target) => {
    for (const op of ["insert_blocks", "replace_subtree"]) {
      const { session, call } = subject();
      await call("API-patch-object", patch(op, dataview({ source: [target] })));
      expect(session.forwarded()).toEqual([
        {
          name: "API-patch-object",
          arguments: { ...patch(op), ops: [{ op, blocks: [rewritten(LEDGER.id)] }] },
        },
      ]);
    }
  });

  it("is rewritten in a full-document API-create-object, wrapped in a minted body or not", async () => {
    const document = (block: Json): Json => ({
      name: "Cost ledger",
      type_key: "page",
      blocks: [
        { type: "text", text: "Costs" },
        { type: "layout", children: [block] },
      ],
    });
    const { session, call } = subject();
    const sent = dataview({ source: ["type-ledger_item"] });
    await call("API-create-object", { space_id: SPACE, ...document(sent) });
    await call("API-create-object", { space_id: SPACE, body: document(sent) });
    expect(session.forwarded()).toEqual([
      {
        name: "API-create-object",
        arguments: { space_id: SPACE, ...document(rewritten(LEDGER.id)) },
      },
      {
        name: "API-create-object",
        arguments: { space_id: SPACE, body: document(rewritten(LEDGER.id)) },
      },
    ]);
  });

  it("is resolved through the child's own type list, read past its first page, and once per call", async () => {
    const { session, call } = subject();
    await call(
      "API-patch-object",
      patch(
        "insert_blocks",
        dataview({ source: ["type-ledger_item"] }),
        dataview({ source: [LEDGER.key] }),
      ),
    );
    expect(session.lookups()).toEqual(["API-list-types", "API-list-types"]);
    expect(session.calls.slice(0, 2).map((lookup) => lookup["arguments"])).toEqual([
      { space_id: SPACE, offset: 0, limit: 100 },
      { space_id: SPACE, offset: 100, limit: 100 },
    ]);
    // A type the child no longer lists is not converted from any table of InnyTypes' own.
    const renamed = subject();
    renamed.session.listTypes = () => text({ data: [], pagination: { has_more: false } });
    const answer = await renamed.call(
      "API-patch-object",
      patch("insert_blocks", dataview({ source: ["type-ledger_item"] })),
    );
    expect(JSON.stringify(answer.body)).toContain("validation_failed");
    expect(renamed.session.forwarded()).toEqual([]);
  });

  it("naming a collection is forwarded with the collection's id as object_id", async () => {
    const { session, call } = subject();
    await call("API-patch-object", patch("insert_blocks", dataview({ source: [COLLECTION_ID] })));
    expect(session.forwarded()[0]?.["arguments"]).toEqual({
      ...patch("insert_blocks"),
      ops: [{ op: "insert_blocks", blocks: [rewritten(COLLECTION_ID)] }],
    });
  });
});

describe("a dataview whose target is not a type or a collection", () => {
  /** The validation_failed object in a refused call's answer. */
  const refusal = (body: unknown): Json => {
    const answer = (body as { result: { content: { text: string }[]; isError: boolean } }).result;
    expect(answer.isError).toBe(true);
    return JSON.parse(answer.content[0]?.text ?? "{}") as Json;
  };

  it.each([
    ["object_id", { object_id: QUERY_ID }],
    ["source", { source: [QUERY_ID] }],
  ])(
    "is refused with validation_failed naming %s and the Query it resolved to; nothing is forwarded",
    async (member, block) => {
      const { session, call } = subject();
      const answer = await call(
        "API-patch-object",
        patch("insert_blocks", dataview({ source: ["type-ledger_item"] }), dataview(block)),
      );
      expect(answer.status).toBe(200);
      expect(refusal(answer.body)).toEqual({
        object: "error",
        status: 400,
        code: "validation_failed",
        message:
          `ops[0].blocks[1].${member}: "${QUERY_ID}" resolves to a Query object "Costs" (layout "set"), ` +
          `not a type or a collection; a dataview shows a type's or a collection's objects ` +
          `(refused by InnyTypes, nothing was written)`,
      });
      // The good block before it is not written alone either: the whole call is refused.
      expect(session.forwarded()).toEqual([]);
    },
  );

  it("is refused when it names nothing in the space, or more than one target", async () => {
    const { session, call } = subject();
    const missing = await call(
      "API-patch-object",
      patch("replace_subtree", dataview({ object_id: "bafy-gone" })),
    );
    expect(refusal(missing.body)["message"]).toContain(
      'ops[0].blocks[0].object_id: "bafy-gone" resolves to nothing in this space',
    );
    const two = await call("API-create-object", {
      space_id: SPACE,
      blocks: [dataview({ source: [LEDGER.key, PAGE_TYPE.key] })],
    });
    expect(refusal(two.body)["message"]).toContain("blocks[0].source:");
    expect(refusal(two.body)["message"]).toContain(
      "resolves to 2 targets; a dataview shows exactly one",
    );
    expect(session.forwarded()).toEqual([]);
  });

  it("is refused in redacted words: what the child named reaches the client through redaction", async () => {
    const key = "dataview-canary-key-0123456789";
    const registry = new SecretRegistry();
    registry.protect(key);
    const { session, call } = subject(registry);
    session.queryName = `named ${key}`;
    const answer = await call(
      "API-patch-object",
      patch("insert_blocks", dataview({ object_id: QUERY_ID })),
    );
    expect(JSON.stringify(answer.body)).not.toContain(key);
    expect(JSON.stringify(answer.body)).toContain(REDACTED);
  });

  it("is answered as an MCP error, nothing forwarded, when Anytype refuses the lookup itself", async () => {
    const { session, call } = subject();
    session.listTypes = () =>
      text({ object: "error", status: 401, code: "unauthorized", message: "no" });
    const answer = await call(
      "API-patch-object",
      patch("insert_blocks", dataview({ source: [LEDGER.key] })),
    );
    expect(answer.body).toMatchObject({
      error: {
        code: -32000,
        message: "dataview target lookup failed: API-list-types answered 401 unauthorized",
      },
    });
    expect(session.forwarded()).toEqual([]);
  });
});

describe("what the shim leaves alone", () => {
  it("forwards a dataview already carrying a type's or a collection's object_id unchanged", async () => {
    const { session, call } = subject();
    const sent = [
      patch("insert_blocks", dataview({ object_id: LEDGER.id })),
      patch("replace_subtree", dataview({ object_id: COLLECTION_ID, source: ["kept-as-sent"] })),
    ];
    for (const args of sent) {
      await call("API-patch-object", args);
    }
    expect(session.forwarded()).toEqual(
      sent.map((args) => ({ name: "API-patch-object", arguments: args })),
    );
  });

  it("forwards every call with no dataview block unchanged, with no lookup made", async () => {
    const { session, call } = subject();
    const sent: [string, unknown][] = [
      ["API-search-space", { space_id: SPACE, query: "dataview", types: ["dataview"] }],
      [
        "API-create-object",
        { space_id: SPACE, name: "Plain", blocks: [{ type: "text", text: "x" }] },
      ],
      ["API-create-object", { space_id: SPACE, body: { name: "Shortcut", body: "# markdown" } }],
      // A dataview outside a block-writing op is not one this shim writes.
      [
        "API-patch-object",
        { space_id: SPACE, ops: [{ op: "set_properties", type: "dataview", source: [QUERY_ID] }] },
      ],
      ["API-patch-object", patch("insert_blocks", { type: "text", text: "no dataview" })],
    ];
    for (const [name, args] of sent) {
      await call(name, args);
    }
    expect(session.lookups()).toEqual([]);
    expect(session.forwarded()).toEqual(sent.map(([name, args]) => ({ name, arguments: args })));
  });

  it("does not log its lookups as client calls: one line per client call", async () => {
    const logger = new RecordingLogger();
    const { session, call } = subject(new SecretRegistry(), logger);
    await call(
      "API-patch-object",
      patch("insert_blocks", dataview({ source: ["type-ledger_item"] })),
    );
    await call("API-patch-object", patch("insert_blocks", dataview({ object_id: QUERY_ID })));
    expect(session.lookups().length).toBeGreaterThan(0);
    expect(logger.lines).toHaveLength(2);
    expect(logger.lines.every((line) => line.includes('"API-patch-object"'))).toBe(true);
  });
});
