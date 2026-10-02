// `flows-meta.json` in the runtime's user data (plan 0022 §C): `{flowId: {template, createdAt}}`
// and nothing else. Whether a flow is on is its tab's `disabled` flag, never mirrored here.
//
// Read once, written whole on every change through a temporary file and a rename, so a crash
// mid-write leaves the old file. A file that is missing or unreadable is an empty one, and an
// entry of the wrong shape is skipped.

import * as fs from "node:fs";
import * as path from "node:path";

import type { FlowMeta, FlowMetaStore } from "../../ports/flow-admin";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The file's entries, each of the right shape; empty when it cannot be read. */
export function parseFlowsMeta(text: string | null): Map<string, FlowMeta> {
  const entries = new Map<string, FlowMeta>();
  let value: unknown;
  try {
    value = text === null ? {} : JSON.parse(text);
  } catch {
    return entries;
  }
  if (!isRecord(value)) {
    return entries;
  }
  for (const [flowId, meta] of Object.entries(value)) {
    if (
      isRecord(meta) &&
      (meta["template"] === null || typeof meta["template"] === "string") &&
      typeof meta["createdAt"] === "number"
    ) {
      entries.set(flowId, { template: meta["template"], createdAt: meta["createdAt"] });
    }
  }
  return entries;
}

export class JsonFlowMetaStore implements FlowMetaStore {
  readonly #file: string;
  readonly #entries: Map<string, FlowMeta>;

  constructor(file: string) {
    this.#file = file;
    let text: string | null = null;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      // Not there yet: no flow has meta.
    }
    this.#entries = parseFlowsMeta(text);
  }

  get(flowId: string): FlowMeta | null {
    return this.#entries.get(flowId) ?? null;
  }

  set(flowId: string, meta: FlowMeta): void {
    this.#entries.set(flowId, { template: meta.template, createdAt: meta.createdAt });
    this.#save();
  }

  remove(flowId: string): void {
    if (this.#entries.delete(flowId)) {
      this.#save();
    }
  }

  #save(): void {
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.#entries), null, 2));
    fs.renameSync(temporary, this.#file);
  }
}
