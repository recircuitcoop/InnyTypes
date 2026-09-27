// The one redaction every telemetry payload passes through (WI-0018-22), the port of
// telemetry.py:384-614: forbidden keys, registered credentials, paths reduced to package-relative
// form or removed, and every value bounded; plus what a report is made of and the privacy notice.
import { describe, expect, it } from "vitest";
import { REDACTED, SecretRegistry } from "../../src/domain/redaction/registry";
import {
  keyIsForbidden,
  MAX_DEPTH,
  MAX_MAPPING_ITEMS,
  MAX_SEQUENCE_ITEMS,
  MAX_TEXT_LENGTH,
  packageRelative,
  redactPayload,
} from "../../src/domain/telemetry/redact";
import {
  checkIdentifier,
  crashPayload,
  ERROR_RETENTION_DAYS,
  isReportKind,
  PRIVACY_NOTICE,
  TelemetryError,
  usagePayload,
  USAGE_RETENTION_MONTHS,
} from "../../src/domain/telemetry/reports";

const none = (text: string): string => text;

// The never-sent fields of telemetry.py's own parametrised test, one by one.
const NEVER_SENT = [
  "ANYTYPE_API_KEY",
  "IOPlatformUUID",
  "access_token",
  "account",
  "anytype_api_key",
  "api_key",
  "attachment",
  "audio",
  "authorization",
  "body_text",
  "content",
  "cookie",
  "device_id",
  "directory",
  "display_name",
  "document",
  "email",
  "env",
  "env_vars",
  "environ",
  "environment",
  "file",
  "file_contents",
  "file_path",
  "home",
  "home_directory",
  "home_path",
  "host",
  "host_name",
  "hostname",
  "ip_address",
  "mac_address",
  "machine_guid",
  "machine_identifier",
  "markdown",
  "object_content",
  "object_id",
  "object_name",
  "object_title",
  "page_title",
  "password",
  "path",
  "platform_uuid",
  "recording",
  "relation_name",
  "serial_number",
  "session_id",
  "snippet",
  "spaceName",
  "space_id",
  "space_name",
  "transcript",
  "transcription",
  "user",
  "user_name",
  "username",
];

describe("telemetry redaction: forbidden keys", () => {
  it.each(NEVER_SENT)("removes the value of %s, wherever it is nested", (field) => {
    const secret = "the-value-that-must-not-leave";
    const redacted = redactPayload(
      { [field]: secret, nested: { deeper: [{ [field]: secret }] } },
      none,
    );
    expect(JSON.stringify(redacted)).not.toContain(secret);
    expect(redacted[field]).toBe(REDACTED);
  });

  it("a forbidden key keeps its name, so the removal is visible", () => {
    expect(redactPayload({ space_name: "Diary", crashed: "runtime" }, none)).toEqual({
      space_name: REDACTED,
      crashed: "runtime",
    });
  });

  it("keeps the fields a report is actually made of", () => {
    const versions = { appVersion: "1.2.3", os: "linux", osVersion: "6.8", arch: "x64" };
    const crash = crashPayload(
      "node",
      true,
      { runtime: 1, services: 2, node: 3, nodeStopped: 1 },
      versions,
    );
    const usage = usagePayload(versions, [{ id: "anytype", version: "1.0.0" }]);
    const stamps = {
      kind: "error",
      machine_id: "ab".repeat(32),
      report_id: "0".repeat(32),
      at: "2026-09-26T12:00:00.000Z",
      unsigned_packages: 2,
    };
    expect(redactPayload({ ...crash, ...stamps }, none)).toEqual({ ...crash, ...stamps });
    expect(redactPayload({ ...usage, ...stamps }, none)).toEqual({ ...usage, ...stamps });
    // None of a report's own field names is on the never-sent list.
    for (const key of [...Object.keys(crash), ...Object.keys(usage), ...Object.keys(stamps)]) {
      expect(keyIsForbidden(key), key).toBe(false);
    }
  });

  it("the field-by-field check can fail", () => {
    // The canary for the parametrised test: a harmless key keeps its value.
    expect(redactPayload({ crashed: "the-value-that-must-not-leave" }, none)).toEqual({
      crashed: "the-value-that-must-not-leave",
    });
  });
});

describe("telemetry redaction: credentials and paths", () => {
  it("a registered credential is removed from any string", () => {
    const registry = new SecretRegistry();
    registry.protect("anytype-key-canary-1234");
    const redacted = redactPayload(
      {
        crashed: "said anytype-key-canary-1234 twice anytype-key-canary-1234",
        list: ["anytype-key-canary-1234"],
      },
      (text) => registry.redact(text),
    );
    expect(redacted).toEqual({ crashed: `said ${REDACTED} twice ${REDACTED}`, list: [REDACTED] });
  });

  it("a named secret is removed too, longest first, but one too short to be one is not", () => {
    const redacted = redactPayload({ a: "raw-identifier-ABCDEFGH and short" }, none, [
      "raw-identifier",
      "raw-identifier-ABCDEFGH",
      "short",
    ]);
    expect(redacted).toEqual({ a: `${REDACTED} and short` });
  });

  it("a path inside a package is reduced to package-relative form", () => {
    expect(packageRelative("/Users/someone/app/node_modules/express/lib/router.js")).toBe(
      "express/lib/router.js",
    );
    expect(
      packageRelative(
        "/Applications/InnyTypes.app/Contents/Resources/app.asar/dist/shell/main.cjs",
      ),
    ).toBe("innytypes/dist/shell/main.cjs");
    expect(packageRelative("/Users/someone/git/innytypes/app/dist/runtime/main.cjs")).toBe(
      "innytypes/dist/runtime/main.cjs",
    );
    expect(
      packageRelative("/home/someone/.venv/lib/python3.12/site-packages/httpx/_client.py"),
    ).toBe("httpx/_client.py");
    expect(packageRelative("/usr/lib/python3.12/json/decoder.py")).toBe("json/decoder.py");
    expect(packageRelative("C:\\Users\\someone\\AppData\\node_modules\\ajv\\dist\\ajv.js")).toBe(
      "ajv/dist/ajv.js",
    );
  });

  it("a path that belongs to no package is removed rather than shortened", () => {
    for (const where of [
      "/Users/someone/Documents/diary.md",
      "/Users/someone/app/private-notes.md",
      "/home/someone/node_modules/",
      "C:\\Users\\someone\\Documents\\notes.md",
    ]) {
      expect(packageRelative(where)).toBe(REDACTED);
    }
  });

  it("every absolute path in a string is reduced, a file URL's too, and a web URL is left alone", () => {
    const redacted = redactPayload(
      {
        a: "at /Users/someone/Documents/diary.md:3 and C:\\Users\\someone\\notes.md",
        b: "file:///Users/someone/Documents/diary.md",
        c: "see https://glitchtip.example/api/42/ for more",
        d: "from /Users/x/proj/node_modules/ajv/dist/core.js",
      },
      none,
    );
    expect(redacted).toEqual({
      a: `at ${REDACTED}:3 and ${REDACTED}`,
      b: REDACTED,
      c: "see https://glitchtip.example/api/42/ for more",
      d: "from ajv/dist/core.js",
    });
  });
});

describe("telemetry redaction: what cannot be understood, and bounds", () => {
  it("a value that cannot be serialised is removed rather than guessed at", () => {
    class Thing {
      readonly secret = "/Users/someone/secret.txt";
    }
    const redacted = redactPayload(
      {
        error: new Error("/Users/someone/secret.txt"),
        when: new Date(0),
        map: new Map([["a", 1]]),
        fn: () => 1,
        big: BigInt(1),
        nan: Number.NaN,
        inf: Number.POSITIVE_INFINITY,
        thing: new Thing(),
        bare: Object.create(null) as object,
        ok: [true, null, 1.5],
      },
      none,
    );
    expect(redacted).toEqual({
      error: REDACTED,
      when: REDACTED,
      map: REDACTED,
      fn: REDACTED,
      big: REDACTED,
      nan: REDACTED,
      inf: REDACTED,
      thing: REDACTED,
      bare: {},
      ok: [true, null, 1.5],
    });
    expect(() => JSON.stringify(redacted)).not.toThrow();
  });

  it("a very long string and a very deep, wide structure are bounded", () => {
    let deep: unknown = "bottom";
    for (let n = 0; n < MAX_DEPTH + 5; n += 1) {
      deep = { level: deep };
    }
    const wide = Object.fromEntries(
      Array.from({ length: MAX_MAPPING_ITEMS + 10 }, (_, n) => [`k${String(n)}`, n]),
    );
    const redacted = redactPayload(
      {
        long: "x".repeat(MAX_TEXT_LENGTH + 500),
        many: Array.from({ length: MAX_SEQUENCE_ITEMS + 10 }, (_, n) => n),
        deep,
        wide,
      },
      none,
    );
    expect(redacted["long"]).toBe(`${"x".repeat(MAX_TEXT_LENGTH)}…`);
    expect(redacted["many"]).toHaveLength(MAX_SEQUENCE_ITEMS);
    expect(Object.keys(redacted["wide"] as object)).toHaveLength(MAX_MAPPING_ITEMS);
    expect(JSON.stringify(redacted["deep"])).toContain(REDACTED);
    expect(JSON.stringify(redacted["deep"])).not.toContain("bottom");
  });
});

describe("telemetry reports", () => {
  it("an empty or stub identifier is refused by name rather than hashed", () => {
    expect(() => checkIdentifier("  ")).toThrow(TelemetryError);
    expect(() => checkIdentifier("  ")).toThrow("returned nothing");
    expect(() => checkIdentifier("1234567")).toThrow("7 characters");
    expect(checkIdentifier("  12345678\n")).toBe("12345678");
  });

  it("a report kind is usage or error, and nothing else", () => {
    expect(isReportKind("usage")).toBe(true);
    expect(isReportKind("error")).toBe(true);
    expect(isReportKind("crash")).toBe(false);
  });

  it("the privacy notice says what D25 requires it to say", () => {
    for (const needed of [
      "entirely optional",
      "HMAC-SHA256",
      "never leaves this machine",
      "which packages are installed",
      "which process crashed",
      "never contains",
      "Anytype content",
      "API key",
      "proxy token",
      "environment variables",
      "full paths inside your home directory",
      "user name",
      "host name",
      "raw identifier",
      `${String(ERROR_RETENTION_DAYS)} days`,
      `${String(USAGE_RETENTION_MONTHS)} months`,
      "GDPR",
      "pseudonymous personal data",
      "Settings page",
      "deletes anything still waiting",
    ]) {
      expect(PRIVACY_NOTICE, needed).toContain(needed);
    }
  });
});
