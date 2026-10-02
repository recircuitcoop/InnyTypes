// The flow templates (plan 0022 §D): `index.json` (`[{id, name, line, packages, official,
// starter}]`; an entry with no `starter` is not the starter) and
// one `<id>.json` tab export per entry, copied into the build by tools/templates/check.mjs once
// each has passed its check (one tab, every node on it, no credentials, every type core or from
// a declared package).
//
// Read when asked, so a rebuilt template is what the next "Use this template" copies. An index
// that cannot be read offers no template; a template's file is read only for an id the index
// lists, so an id never reaches the file system as a path of its own.

import * as fs from "node:fs";
import * as path from "node:path";

import type { TabNode } from "../../domain/flows/tab";
import type { FlowTemplate, TemplateSource } from "../../ports/flow-admin";
import type { Logger } from "../../ports/logger";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A template's id: lowercase words joined by hyphens, and so a safe file name. */
const TEMPLATE_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The index's entries of the right shape, in its order; the others are skipped. */
export function parseTemplateIndex(value: unknown): FlowTemplate[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry: unknown): FlowTemplate[] => {
    if (!isRecord(entry)) {
      return [];
    }
    const { id, name, line, packages, official, starter = false } = entry;
    if (
      typeof id !== "string" ||
      !TEMPLATE_ID.test(id) ||
      typeof name !== "string" ||
      typeof line !== "string" ||
      !Array.isArray(packages) ||
      !packages.every((name) => typeof name === "string") ||
      typeof official !== "boolean" ||
      typeof starter !== "boolean"
    ) {
      return [];
    }
    return [{ id, name, line, packages: packages, official, starter }];
  });
}

export class FsTemplateSource implements TemplateSource {
  readonly #dir: string;
  readonly #logger: Logger;

  constructor(dir: string, logger: Logger) {
    this.#dir = dir;
    this.#logger = logger;
  }

  index(): readonly FlowTemplate[] {
    const value = this.#read("index.json");
    return value === undefined ? [] : parseTemplateIndex(value);
  }

  nodes(id: string): readonly TabNode[] | null {
    if (!this.index().some((entry) => entry.id === id)) {
      return null;
    }
    const value = this.#read(`${id}.json`);
    if (!Array.isArray(value)) {
      return null;
    }
    return value.filter(
      (node): node is TabNode =>
        isRecord(node) && typeof node["id"] === "string" && typeof node["type"] === "string",
    );
  }

  /** A file of the folder as JSON; undefined, and said, when it cannot be read. */
  #read(file: string): unknown {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.#dir, file), "utf8")) as unknown;
    } catch (error) {
      this.#logger.warn(`the flow template file ${file} cannot be read: ${String(error)}`);
      return undefined;
    }
  }
}
