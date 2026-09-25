// The MCP session over the child's pipes (plan 0018 §3, the session.py row): framing, bounds,
// the handshake and the tool surface, pings, and a dead child failing every pending call.
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { StdioMcpSession } from "../../src/adapters/anytype/mcp-session";
import { toolSignature } from "../../src/adapters/anytype/tool-surface";
import {
  SessionBusyError,
  SessionError,
  ToolSurfaceMismatchError,
} from "../../src/domain/anytype/errors";
import { MCP_PROTOCOL_VERSION } from "../../src/domain/anytype/pins";
import { FakeClock } from "../fakes/clock";
import { flush } from "../fakes/anytype";

const SCHEMA = { type: "object", properties: { q: { type: "string" } } };
const TOOLS = [{ name: "API-search", inputSchema: SCHEMA }];
const EXPECTED = { "API-search": toolSignature(SCHEMA) };

type Message = Record<string, unknown> & { id?: number; method?: string };

/** A child on the other end of two pipes: what the session wrote, and a way to answer. */
function pipes(options: { maxFrameBytes?: number; maxPending?: number; timeout?: number } = {}) {
  const fromChild = new PassThrough();
  const toChild = new PassThrough();
  const written: Message[] = [];
  let raw = "";
  toChild.on("data", (chunk: Buffer) => {
    raw += chunk.toString("utf8");
    for (let end = raw.indexOf("\n"); end !== -1; end = raw.indexOf("\n")) {
      written.push(JSON.parse(raw.slice(0, end)) as Message);
      raw = raw.slice(end + 1);
    }
  });
  const clock = new FakeClock();
  const session = new StdioMcpSession({
    input: fromChild,
    output: toChild,
    clock,
    expected: EXPECTED,
    ...(options.maxFrameBytes === undefined ? {} : { maxFrameBytes: options.maxFrameBytes }),
    ...(options.maxPending === undefined ? {} : { maxPending: options.maxPending }),
    ...(options.timeout === undefined ? {} : { requestTimeoutMs: options.timeout }),
  });
  const reply = (message: Record<string, unknown>): void => {
    fromChild.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };
  return { session, written, reply, fromChild, toChild, clock };
}

/** Answer the handshake the way the pinned server does, listing `tools`. */
async function handshake(
  ctx: ReturnType<typeof pipes>,
  tools: readonly Record<string, unknown>[] = TOOLS,
) {
  const initialized = ctx.session.initialize();
  await flush();
  ctx.reply({ id: 1, result: { protocolVersion: MCP_PROTOCOL_VERSION } });
  await flush();
  ctx.reply({ id: 2, result: { tools } });
  return initialized;
}

describe("the handshake", () => {
  it("initializes, notifies, lists the tools and accepts the committed surface, in that order", async () => {
    const ctx = pipes();
    expect(await handshake(ctx)).toEqual(TOOLS);
    expect(ctx.written.map((m) => m.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
    expect((ctx.written[0]?.["params"] as Record<string, unknown>)["protocolVersion"]).toBe(
      MCP_PROTOCOL_VERSION,
    );
    expect(ctx.written[1]?.id).toBeUndefined();
  });

  it.each([
    ["added", [...TOOLS, { name: "API-new", inputSchema: SCHEMA }], { added: ["API-new"] }],
    ["removed", [], { removed: ["API-search"] }],
    [
      "changed",
      [{ name: "API-search", inputSchema: { type: "object" } }],
      { changed: ["API-search"] },
    ],
  ])("refuses a live surface with a tool %s, and names it", async (_how, tools, diff) => {
    const ctx = pipes();
    const error = await handshake(ctx, tools).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolSurfaceMismatchError);
    expect((error as ToolSurfaceMismatchError).diff).toMatchObject(diff);
    expect((error as Error).message).toContain("differ from the committed surface");
  });

  it.each([
    ["a tools/list that is not a list", { tools: "no" }, /without a tool list/],
    ["a tool without a name and a schema", { tools: [{ name: "x" }] }, /invalid tool definition/],
    [
      "two tools sharing one name",
      { tools: [...TOOLS, ...TOOLS] },
      /listed the tool API-search twice/,
    ],
  ])("refuses %s", async (_what, result, message) => {
    const ctx = pipes();
    const initialized = ctx.session.initialize();
    await flush();
    ctx.reply({ id: 1, result: {} });
    await flush();
    ctx.reply({ id: 2, result });
    await expect(initialized).rejects.toThrow(message);
    await expect(initialized).rejects.toBeInstanceOf(SessionError);
  });
});

describe("requests", () => {
  it("delivers each concurrent reply to the call with its own id", async () => {
    const ctx = pipes();
    const first = ctx.session.request("tools/call", { name: "a" });
    const second = ctx.session.request("tools/call", { name: "b" });
    await flush();
    ctx.reply({ id: 2, result: { for: "b" } });
    ctx.reply({ id: 1, result: { for: "a" } });
    expect(await first).toEqual({ for: "a" });
    expect(await second).toEqual({ for: "b" });
  });

  it("raises a refusal from the child with its message, and refuses a result that is not an object", async () => {
    const ctx = pipes();
    const refused = ctx.session.request("tools/call");
    const odd = ctx.session.request("tools/call");
    await flush();
    ctx.reply({ id: 1, error: { code: -1, message: "no such space" } });
    ctx.reply({ id: 2, result: [1] });
    await expect(refused).rejects.toThrow(
      "the Anytype MCP child refused tools/call: no such space",
    );
    await expect(odd).rejects.toThrow(/without an object result/);
    expect(ctx.session.closed).toBe(false);
  });

  it("times a request out after the session's bound and never sends it again", async () => {
    const ctx = pipes({ timeout: 1_000 });
    const call = ctx.session.request("tools/call", { name: "create" });
    await flush();
    ctx.clock.advance(999);
    await flush();
    ctx.clock.advance(1);
    await expect(call).rejects.toThrow("the Anytype MCP child timed out answering tools/call");
    ctx.clock.advance(60_000);
    await flush();
    // A retried tools/call can change Anytype twice: it was written exactly once.
    expect(ctx.written.filter((m) => m.method === "tools/call")).toHaveLength(1);
  });

  it("admits its pending limit and refuses the next, without queueing it", async () => {
    const ctx = pipes({ maxPending: 2 });
    void ctx.session.request("a").catch(() => undefined);
    void ctx.session.request("b").catch(() => undefined);
    await expect(ctx.session.request("c")).rejects.toBeInstanceOf(SessionBusyError);
    await flush();
    expect(ctx.written.map((m) => m.method)).toEqual(["a", "b"]);
  });

  it("sends a request frame at the size bound and refuses one over it, staying open", async () => {
    const ctx = pipes({ maxFrameBytes: 200 });
    const overhead =
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "m", params: { p: "" } })}\n`.length;
    const atBound = ctx.session.request("m", { p: "x".repeat(200 - overhead) });
    await flush();
    expect(ctx.written).toHaveLength(1);
    await expect(ctx.session.request("m", { p: "x".repeat(300) })).rejects.toThrow(
      "an MCP request exceeds the child frame limit",
    );
    expect(ctx.session.closed).toBe(false);
    ctx.reply({ id: 1, result: {} });
    expect(await atBound).toEqual({});
  });

  it("delivers a reply frame at the size bound and tears the session down on one over it", async () => {
    const ctx = pipes({ maxFrameBytes: 100 });
    const call = ctx.session.request("m");
    await flush();
    const base = `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { p: "" } })}\n`.length;
    ctx.reply({ id: 1, result: { p: "y".repeat(100 - base) } });
    expect(await call).toMatchObject({});
    const next = ctx.session.request("m");
    await flush();
    ctx.reply({ id: 2, result: { p: "y".repeat(200) } });
    await expect(next).rejects.toThrow("the Anytype MCP child sent an oversized frame");
    expect(ctx.session.closed).toBe(true);
  });

  it("ignores a frame carrying no id rather than failing on it", async () => {
    const ctx = pipes();
    const call = ctx.session.request("m");
    await flush();
    ctx.reply({ method: "notifications/message", params: { level: "info" } });
    ctx.reply({ id: 1, result: { ok: 1 } });
    expect(await call).toEqual({ ok: 1 });
  });

  it("sends a notification with its parameters, and refuses one after the session closed", async () => {
    const ctx = pipes();
    ctx.session.notify("notifications/progress", { value: 1 });
    await flush();
    expect(ctx.written[0]).toEqual({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { value: 1 },
    });
    ctx.session.close("done");
    expect(() => {
      ctx.session.notify("x");
    }).toThrow(SessionError);
  });
});

describe("a child that breaks the protocol, or dies", () => {
  it.each([
    ["ends its output", (c: ReturnType<typeof pipes>) => c.fromChild.end(), /closed its output/],
    [
      "sends malformed JSON",
      (c: ReturnType<typeof pipes>) => c.fromChild.write("{nope\n"),
      /malformed JSON/,
    ],
    [
      "answers an id nobody asked for",
      (c: ReturnType<typeof pipes>) => {
        c.reply({ id: 99, result: {} });
      },
      /unknown request id/,
    ],
    [
      "sends an id that is not a number",
      (c: ReturnType<typeof pipes>) => {
        c.reply({ id: "one", result: {} });
      },
      /invalid response id/,
    ],
    [
      "cannot be read from",
      (c: ReturnType<typeof pipes>) => c.fromChild.destroy(new Error("EIO")),
      /closed its output|could not read/,
    ],
    [
      "cannot be written to",
      (c: ReturnType<typeof pipes>) => c.toChild.destroy(new Error("EPIPE")),
      /could not write/,
    ],
  ])("fails every pending call when it %s", async (_what, act, message) => {
    const ctx = pipes();
    const calls = [ctx.session.request("a"), ctx.session.request("b")];
    await flush();
    act(ctx);
    for (const call of calls) {
      await expect(call).rejects.toThrow(message);
    }
    expect(ctx.session.closed).toBe(true);
    await expect(ctx.session.request("c")).rejects.toThrow("session is closed");
  });

  it("fails every call still waiting when a reply id is answered twice", async () => {
    const ctx = pipes();
    const first = ctx.session.request("a");
    const second = ctx.session.request("b");
    await flush();
    ctx.reply({ id: 1, result: {} });
    ctx.reply({ id: 1, result: {} });
    expect(await first).toEqual({});
    await expect(second).rejects.toThrow(/unknown request id/);
  });
});

describe("ping", () => {
  it("is MCP's own liveness question, and comes back with the child's answer", async () => {
    const ctx = pipes();
    const ping = ctx.session.ping(5_000);
    await flush();
    expect(ctx.written[0]).toMatchObject({ method: "ping" });
    expect(ctx.written[0]?.["params"]).toBeUndefined();
    ctx.reply({ id: 1, result: {} });
    await expect(ping).resolves.toBeUndefined();
  });

  it("is bounded by the smaller of its own bound and the session's, and names ping", async () => {
    const ctx = pipes({ timeout: 2_000 });
    const long = ctx.session.ping(10_000).catch((e: unknown) => e);
    ctx.clock.advance(2_000);
    expect(String(await long)).toContain("timed out answering ping");
    const short = ctx.session.ping(500).catch((e: unknown) => e);
    ctx.clock.advance(500);
    expect(String(await short)).toContain("timed out answering ping");
  });

  it("raises when the child refuses it", async () => {
    const ctx = pipes();
    const ping = ctx.session.ping(1_000);
    await flush();
    ctx.reply({ id: 1, error: { message: "busy" } });
    await expect(ping).rejects.toThrow("refused ping: busy");
  });
});

describe("the key", () => {
  it("is in no frame, error or string form the session makes", async () => {
    const key = "session-key-0123456789";
    const ctx = pipes();
    const call = ctx.session.request("tools/call", { name: "x" });
    await flush();
    ctx.fromChild.end();
    const error = await call.catch((e: unknown) => e);
    const everything = [JSON.stringify(ctx.written), String(error), String(ctx.session)].join("\n");
    expect(everything).not.toContain(key);
    expect(String(ctx.session)).toBe("StdioMcpSession(closed, 0 pending)");
  });
});
