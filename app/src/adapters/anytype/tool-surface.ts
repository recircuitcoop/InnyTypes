// The committed tool surface of the pinned MCP server (plan 0018 §3, the port of
// anytype_mcp/tools.py): what the child must list, exactly, before anything is served.
//
// The pair (PACKAGE_VERSION, ANYTYPE_VERSION) decides which tools exist, so the surface is
// recorded in tool_surface.json, beside this file, and reviewed as a diff when a pin moves. A
// surface maps each tool name to a signature of its input schema rather than listing names, so
// a tool that kept its name and changed its arguments is caught too: that one is the dangerous
// case, because a caller keeps working until it fails.
//
// The signature is the old one byte for byte: sha256 over canonical JSON (sorted keys, no
// whitespace, non-ASCII kept), so the file the Python app recorded is the file this reads.

import { createHash } from "node:crypto";
import fs from "node:fs";
import * as path from "node:path";
import { compareSurfaces, ToolSurfaceMismatchError } from "../../domain/anytype/errors";
import type { McpTool } from "../../ports/anytype";

/** The committed record, shipped beside this file and in the app archive. */
export const TOOL_SURFACE_FILE = "tool_surface.json";

/** How a surface was obtained (tools.py:47-49); the two are not equally strong evidence. */
export const KNOWN_SOURCES = ["live-server", "bundled-spec"] as const;

const REQUIRED_FIELDS = ["package_version", "anytype_version", "tools", "source", "captured_at"];

/** A recorded tool surface could not be read: missing, malformed or truncated. */
export class ToolSurfaceError extends Error {
  override name = "ToolSurfaceError";
}

export interface ToolSurface {
  readonly packageVersion: string;
  readonly anytypeVersion: string;
  /** Tool name → signature of its input schema. */
  readonly tools: Readonly<Record<string, string>>;
  readonly source: string;
  readonly capturedAt: string;
}

/** Python's `json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** A stable fingerprint of one tool's input schema (tools.py:60-72). */
export function toolSignature(inputSchema: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(inputSchema), "utf8").digest("hex")}`;
}

/** A parsed record, naming whatever it is missing. */
export function parseToolSurface(data: unknown): ToolSurface {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new ToolSurfaceError("the recorded tool surface is not an object");
  }
  const record = data as Record<string, unknown>;
  const missing = REQUIRED_FIELDS.filter((field) => !(field in record));
  if (missing.length > 0) {
    throw new ToolSurfaceError(`the recorded tool surface is missing ${missing.join(", ")}`);
  }
  const tools = record["tools"];
  if (typeof tools !== "object" || tools === null || Array.isArray(tools)) {
    throw new ToolSurfaceError("the recorded tool surface has a `tools` that is not an object");
  }
  return {
    packageVersion: String(record["package_version"]),
    anytypeVersion: String(record["anytype_version"]),
    tools: Object.fromEntries(Object.entries(tools).map(([name, sig]) => [name, String(sig)])),
    source: String(record["source"]),
    capturedAt: String(record["captured_at"]),
  };
}

/** Read a recorded surface from `file`. */
export function loadToolSurface(file: string): ToolSurface {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new ToolSurfaceError(
      `could not read the tool surface at ${file}: ${String((error as NodeJS.ErrnoException).code)}`,
    );
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new ToolSurfaceError(`${file} is not valid JSON`);
  }
  return parseToolSurface(data);
}

/** The committed surface in `directory` (the folder this file is shipped in). */
export function committedToolSurface(directory: string): ToolSurface {
  return loadToolSurface(path.join(directory, TOOL_SURFACE_FILE));
}

/**
 * The live tools, checked against `expected` (session.py:225-246): an invalid or duplicated
 * tool is a named refusal, and any difference is a ToolSurfaceMismatchError naming it.
 */
export function verifyToolSurface(
  expected: Readonly<Record<string, string>>,
  tools: readonly McpTool[],
): void {
  const live: Record<string, string> = {};
  for (const tool of tools) {
    if (live[tool.name] !== undefined) {
      throw new ToolSurfaceError(`the Anytype MCP child listed the tool ${tool.name} twice`);
    }
    live[tool.name] = toolSignature(tool.inputSchema);
  }
  const diff = compareSurfaces(expected, live);
  if (diff.added.length + diff.removed.length + diff.changed.length > 0) {
    throw new ToolSurfaceMismatchError(diff);
  }
}
