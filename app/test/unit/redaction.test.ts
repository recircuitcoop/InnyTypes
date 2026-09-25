// The secret registry (domain/redaction), the port of logs.py's protect/redact/REDACTOR.
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { REDACTED, SecretRegistry } from "../../src/domain/redaction/registry";

const KEY = "fake-anytype-key-that-must-not-be-written-13579";

describe("the secret registry", () => {
  it("replaces every occurrence of a registered secret with the marker", () => {
    const registry = new SecretRegistry();
    expect(registry.protect(KEY)).toBe(true);
    expect(registry.redact(`key=${KEY}; again ${KEY}`)).toBe(`key=${REDACTED}; again ${REDACTED}`);
  });

  it("leaves a clean text alone", () => {
    const registry = new SecretRegistry();
    registry.protect(KEY);
    expect(registry.redact("exited with code 70")).toBe("exited with code 70");
  });

  it("refuses an empty secret, which would otherwise destroy every line", () => {
    const registry = new SecretRegistry();
    expect(registry.protect("")).toBe(false);
    expect(registry.size).toBe(0);
    expect(registry.redact("untouched")).toBe("untouched");
  });

  it("registers a secret once however often it is protected", () => {
    const registry = new SecretRegistry();
    expect(registry.protect(KEY)).toBe(true);
    expect(registry.protect(KEY)).toBe(false);
    expect(registry.size).toBe(1);
  });

  it("replaces the longer of two nested secrets first, leaving no fragment", () => {
    const registry = new SecretRegistry();
    registry.protect("token");
    registry.protect("Bearer token-123");
    expect(registry.redact("header: Bearer token-123")).toBe(`header: ${REDACTED}`);
  });

  it("does not print its secrets when inspected, stringified or serialised", () => {
    const registry = new SecretRegistry();
    registry.protect(KEY);
    expect(inspect(registry, { showHidden: true, depth: 5 })).not.toContain(KEY);
    expect(String(registry)).not.toContain(KEY);
    expect(JSON.stringify({ registry })).not.toContain(KEY);
  });
});
