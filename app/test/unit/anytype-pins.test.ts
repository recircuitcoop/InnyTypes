// The pins, the child's environment and the tool surface record (plan 0018 §3: the config.py,
// tools.py and test_pinning rows for the new app).
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  loadToolSurface,
  parseToolSurface,
  toolSignature,
  ToolSurfaceError,
  verifyToolSurface,
} from "../../src/adapters/anytype/tool-surface";
import {
  ANYTYPE_KEY_FILE_VARIABLE,
  ANYTYPE_KEY_LEGACY_FILE_VARIABLE,
  anytypeKeyEnvironment,
  anytypeKeyVariables,
} from "../../src/domain/anytype/pins";
import {
  compareSurfaces,
  isEmptyDiff,
  ToolSurfaceMismatchError,
} from "../../src/domain/anytype/errors";
import {
  ANYTYPE_VERSION,
  anytypeHeaders,
  childEnvironment,
  DEFAULT_API_BASE_URL,
  joinUrl,
  MAX_FRAME_BYTES,
  MAX_PENDING_REQUESTS,
  PACKAGE_NAME,
  PACKAGE_SPEC,
  PACKAGE_VERSION,
  REQUEST_TIMEOUT_MS,
} from "../../src/domain/anytype/pins";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPOSITORY = path.resolve(APP, "..");
const COMMITTED = path.join(APP, "src", "adapters", "anytype", "tool_surface.json");
const KEY = "pins-test-key-0123456789";

describe("the pins", () => {
  it("pins the package to an exact version, and the spec names it", () => {
    expect(PACKAGE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(PACKAGE_SPEC).toBe(`${PACKAGE_NAME}@${PACKAGE_VERSION}`);
  });

  it("is the version the workspace installs: the root package.json pins it exactly", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(REPOSITORY, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies[PACKAGE_NAME]).toBe(PACKAGE_VERSION);
    const lock = JSON.parse(
      fs.readFileSync(path.join(REPOSITORY, "package-lock.json"), "utf8"),
    ) as { packages: Record<string, { version?: string }> };
    expect(lock.packages[`node_modules/${PACKAGE_NAME}`]?.version).toBe(PACKAGE_VERSION);
  });

  it("pins the Anytype API version as a date, and the session bounds of session.py:14-16", () => {
    expect(ANYTYPE_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(MAX_FRAME_BYTES).toBe(1024 * 1024);
    expect(MAX_PENDING_REQUESTS).toBe(8);
    expect(REQUEST_TIMEOUT_MS).toBe(60_000);
  });

  it("defaults to the desktop app's own port", () => {
    expect(DEFAULT_API_BASE_URL).toBe("http://127.0.0.1:31009");
  });
});

describe("the child's environment", () => {
  it("carries both variables the server reads, the headers as its JSON contract", () => {
    const env = childEnvironment(KEY, "http://127.0.0.1:31012");
    expect(env["ANYTYPE_API_BASE_URL"]).toBe("http://127.0.0.1:31012");
    expect(JSON.parse(env["OPENAPI_MCP_HEADERS"] ?? "")).toEqual({
      Authorization: `Bearer ${KEY}`,
      "Anytype-Version": ANYTYPE_VERSION,
    });
    expect(anytypeHeaders(KEY)).toEqual(JSON.parse(env["OPENAPI_MCP_HEADERS"] ?? ""));
  });

  it("lets nothing inherited shadow the configured credential, and inherits nothing else", () => {
    const env = childEnvironment(KEY, DEFAULT_API_BASE_URL, {
      OPENAPI_MCP_HEADERS: '{"Authorization":"Bearer someone-else"}',
      ELECTRON_RUN_AS_NODE: "1",
    });
    expect(env["OPENAPI_MCP_HEADERS"]).toContain(KEY);
    expect(Object.keys(env).sort()).toEqual([
      "ANYTYPE_API_BASE_URL",
      "ELECTRON_RUN_AS_NODE",
      "OPENAPI_MCP_HEADERS",
    ]);
  });

  it("joins a base URL with a trailing slash without doubling it", () => {
    expect(joinUrl("http://127.0.0.1:31009/", "/v1/spaces")).toBe(
      "http://127.0.0.1:31009/v1/spaces",
    );
    expect(joinUrl("http://127.0.0.1:31009", "v1/spaces")).toBe("http://127.0.0.1:31009/v1/spaces");
  });
});

describe("the committed tool surface", () => {
  it("is the file the old app records, at the pinned pair, said how it was captured", () => {
    const surface = loadToolSurface(COMMITTED);
    expect(surface.packageVersion).toBe(PACKAGE_VERSION);
    expect(surface.anytypeVersion).toBe(ANYTYPE_VERSION);
    expect(["live-server", "bundled-spec"]).toContain(surface.source);
    expect(surface.capturedAt).not.toBe("");
    expect(Object.keys(surface.tools).length).toBeGreaterThan(0);
    // The two copies must not drift apart before the cutover: a pin bump re-records both.
    const old = path.join(REPOSITORY, "src", "innytypes", "anytype_mcp", "tool_surface.json");
    expect(fs.readFileSync(COMMITTED, "utf8")).toBe(fs.readFileSync(old, "utf8"));
  });

  it("names what a broken record is missing, and a record that is not JSON or absent", () => {
    expect(() => parseToolSurface({ tools: {} })).toThrow(/missing package_version/);
    expect(() =>
      parseToolSurface({
        package_version: "1",
        anytype_version: "2",
        source: "live-server",
        captured_at: "x",
        tools: [],
      }),
    ).toThrow(/`tools` that is not an object/);
    expect(() => parseToolSurface([])).toThrow(ToolSurfaceError);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "surface-"));
    try {
      fs.writeFileSync(path.join(dir, "bad.json"), "{not json");
      expect(() => loadToolSurface(path.join(dir, "bad.json"))).toThrow(/not valid JSON/);
      expect(() => loadToolSurface(path.join(dir, "absent.json"))).toThrow(/could not read/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("signs a schema by its content, not its key order", () => {
    const a = toolSignature({ type: "object", properties: { a: { type: "string" } } });
    const b = toolSignature({ properties: { a: { type: "string" } }, type: "object" });
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(toolSignature({ type: "object", properties: { a: { type: "number" } } })).not.toBe(a);
  });

  it("reports added, removed and changed names, and nothing for a surface against itself", () => {
    const before = { keep: "sha256:1", gone: "sha256:2", moved: "sha256:3" };
    const after = { keep: "sha256:1", moved: "sha256:4", fresh: "sha256:5" };
    expect(compareSurfaces(before, after)).toEqual({
      added: ["fresh"],
      removed: ["gone"],
      changed: ["moved"],
    });
    expect(isEmptyDiff(compareSurfaces(before, before))).toBe(true);
  });

  it("refuses a live list that differs, names the difference, and refuses a duplicated tool", () => {
    const schema = { type: "object" };
    const expected = { one: toolSignature(schema) };
    expect(() => {
      verifyToolSurface(expected, [{ name: "one", inputSchema: schema }]);
    }).not.toThrow();
    expect(() => {
      verifyToolSurface(expected, [
        { name: "one", inputSchema: schema },
        { name: "two", inputSchema: schema },
      ]);
    }).toThrow(ToolSurfaceMismatchError);
    expect(() => {
      verifyToolSurface(expected, [
        { name: "one", inputSchema: schema },
        { name: "one", inputSchema: schema },
      ]);
    }).toThrow(/listed the tool one twice/);
  });
});

describe("where a first-party Anytype node finds the key (WI-0018-20)", () => {
  it("names the canonical file, and the legacy one only when there is one", () => {
    expect(anytypeKeyEnvironment({ file: "/k", legacy: "/old" })).toEqual({
      [ANYTYPE_KEY_FILE_VARIABLE]: "/k",
      [ANYTYPE_KEY_LEGACY_FILE_VARIABLE]: "/old",
    });
    expect(anytypeKeyEnvironment({ file: "/k" })).toEqual({ INNYTYPES_ANYTYPE_KEY_FILE: "/k" });
  });

  it("uses the same two names the TS node SDK's anytypeKey() reads", () => {
    const sdk = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "..",
        "..",
        "sdk",
        "ts",
        "src",
        "node.ts",
      ),
      "utf8",
    );
    expect(sdk).toContain(`ANYTYPE_KEY_FILE_VARIABLE = "${ANYTYPE_KEY_FILE_VARIABLE}"`);
    expect(sdk).toContain(
      `ANYTYPE_KEY_LEGACY_FILE_VARIABLE = "${ANYTYPE_KEY_LEGACY_FILE_VARIABLE}"`,
    );
  });
});

describe("which node processes are told where the key is (WI-0018-20)", () => {
  const files = {
    "anytype-api-key": { file: "/h/.config/innytypes/anytype_api_key", legacy: "/h/old/key" },
    "mcp-proxy-token": { file: "/h/.config/innytypes/mcp_proxy_token" },
  };

  it("a first-party Anytype type: the key's two paths and nothing else, never the proxy token's", () => {
    const told = anytypeKeyVariables("anytype", true, files);
    expect(told).toEqual({
      [ANYTYPE_KEY_FILE_VARIABLE]: "/h/.config/innytypes/anytype_api_key",
      [ANYTYPE_KEY_LEGACY_FILE_VARIABLE]: "/h/old/key",
    });
    expect(JSON.stringify(told)).not.toContain("mcp_proxy_token");
  });

  it("any other package, an 'anytype' not shipped with the app, or no key location: nothing", () => {
    expect(anytypeKeyVariables("monty", true, files)).toEqual({});
    expect(anytypeKeyVariables("anytype", false, files)).toEqual({});
    expect(anytypeKeyVariables("anytype", true, undefined)).toEqual({});
    expect(
      anytypeKeyVariables("anytype", true, { "mcp-proxy-token": files["mcp-proxy-token"] }),
    ).toEqual({});
  });
});
