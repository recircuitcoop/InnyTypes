// The channel's messages are typed and versioned (spec 10.2): both ends parse what arrives,
// and a message of another version, or of the right version with a wrong field, is refused.
import { describe, expect, it } from "vitest";
import {
  CHANNEL_VERSION,
  isCallOp,
  parseChildMessage,
  parseShellMessage,
  type ChildMessage,
  type ShellMessage,
} from "../../src/domain/channel/messages";

const RESTART = { reason: "types", added: ["a"], removed: [], requestedAt: 5 };
const CONFIG = { generation: 3, port: 18_800, userDir: "/u", restart: RESTART, forkedAt: 7 };
const INIT: ShellMessage = { v: 1, t: "init", config: CONFIG };

const SHELL_MESSAGES: ShellMessage[] = [
  INIT,
  { v: 1, t: "init", config: { ...CONFIG, port: null, restart: null } },
  { v: 1, t: "init", config: { ...CONFIG, credentialSecret: "fake-credential-secret" } },
  { v: 1, t: "stop", reason: "quit" },
  { v: 1, t: "stop", reason: "types" },
  { v: 1, t: "stop", reason: "restart" },
  { v: 1, t: "call", rid: "r1", op: "view.get", args: { id: "x" } },
  { v: 1, t: "call", rid: "r2", op: "flow.node.configure", args: { flowId: "t" } },
];

const CHILD_MESSAGES: ChildMessage[] = [
  { v: 1, t: "ready", pid: 12, generation: 3, port: 18_800 },
  { v: 1, t: "ready", pid: 12, generation: 3, port: null },
  { v: 1, t: "failed", error: "no" },
  { v: 1, t: "stopped", reason: "quit" },
  { v: 1, t: "reply", rid: "r1", result: { ok: true, value: null } },
  { v: 1, t: "reply", rid: "r1", result: { ok: false, error: "nope" } },
  { v: 1, t: "flows" },
];

describe("the channel's messages", () => {
  it("are version 1", () => {
    expect(CHANNEL_VERSION).toBe(1);
  });

  it("parse back to themselves, both directions", () => {
    for (const message of SHELL_MESSAGES) {
      expect(parseShellMessage(structuredClone(message))).toEqual(message);
    }
    for (const message of CHILD_MESSAGES) {
      expect(parseChildMessage(structuredClone(message))).toEqual(message);
    }
  });

  it("refuse a message from another channel version, or with none", () => {
    for (const message of SHELL_MESSAGES) {
      expect(parseShellMessage({ ...message, v: 2 })).toBeNull();
      expect(parseShellMessage({ ...message, v: undefined })).toBeNull();
    }
    for (const message of CHILD_MESSAGES) {
      expect(parseChildMessage({ ...message, v: 0 })).toBeNull();
    }
  });

  it("refuse what is not a message at all", () => {
    for (const raw of [null, undefined, 1, "init", [], [INIT], { v: 1 }, { v: 1, t: 5 }]) {
      expect(parseShellMessage(raw)).toBeNull();
      expect(parseChildMessage(raw)).toBeNull();
    }
  });

  it("refuse a message type the direction does not have", () => {
    expect(parseShellMessage({ v: 1, t: "ready", pid: 1, generation: 1, port: null })).toBeNull();
    expect(parseChildMessage({ v: 1, t: "init", config: CONFIG })).toBeNull();
  });

  it("refuse a wrong field in each shell message", () => {
    const bad: unknown[] = [
      { v: 1, t: "init", config: { ...CONFIG, generation: "3" } },
      { v: 1, t: "init", config: { ...CONFIG, port: 0 } },
      { v: 1, t: "init", config: { ...CONFIG, port: 70_000 } },
      { v: 1, t: "init", config: { ...CONFIG, port: 1.5 } },
      { v: 1, t: "init", config: { ...CONFIG, userDir: 1 } },
      { v: 1, t: "init", config: { ...CONFIG, forkedAt: Number.NaN } },
      { v: 1, t: "init", config: { ...CONFIG, restart: { reason: "x" } } },
      { v: 1, t: "init", config: { ...CONFIG, restart: { ...RESTART, added: [1] } } },
      { v: 1, t: "init", config: null },
      { v: 1, t: "init", config: { ...CONFIG, credentialSecret: 1 } },
      { v: 1, t: "init", config: { ...CONFIG, credentialSecret: "" } },
      { v: 1, t: "init", config: { ...CONFIG, credentialSecret: null } },
      { v: 1, t: "stop", reason: "crash" },
      { v: 1, t: "call", rid: 1, op: "view.get", args: null },
      { v: 1, t: "call", rid: "r", op: "rm -rf", args: null },
    ];
    for (const raw of bad) {
      expect(parseShellMessage(raw), JSON.stringify(raw)).toBeNull();
    }
  });

  it("refuse a wrong field in each child message", () => {
    const bad: unknown[] = [
      { v: 1, t: "ready", pid: "1", generation: 1, port: null },
      { v: 1, t: "ready", pid: 1, generation: 1, port: "18800" },
      { v: 1, t: "failed", error: 5 },
      { v: 1, t: "stopped", reason: "because" },
      { v: 1, t: "reply", rid: "r", result: { ok: true } },
      { v: 1, t: "reply", rid: "r", result: { ok: false } },
      { v: 1, t: "reply", rid: "r", result: "yes" },
      { v: 1, t: "reply", rid: 1, result: { ok: true, value: 1 } },
    ];
    for (const raw of bad) {
      expect(parseChildMessage(raw), JSON.stringify(raw)).toBeNull();
    }
  });

  it("know the runtime's four call operations and no other", () => {
    for (const op of ["view.get", "view.submit", "snapshot.get", "snapshot.action"]) {
      expect(isCallOp(op)).toBe(true);
    }
    expect(isCallOp("view.delete")).toBe(false);
    expect(isCallOp(1)).toBe(false);
  });
});
