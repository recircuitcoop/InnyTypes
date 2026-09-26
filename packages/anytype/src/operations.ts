// The five Anytype node types (plan 0018 §4.2), each one input in, one event out.
//
// Each operation takes the instance's config and the input's payload, calls Anytype once
// through the shared client, and returns the port and data to emit. Nothing here retries and
// nothing here holds the key past the one call it is handed for.

import {
  anytypeLink,
  type AnytypeClient,
  type AnytypeObject,
} from "../../../app/src/adapters/anytype/api-client";

/** A config or payload that cannot be acted on; the message says which field and why. */
export class InputProblem extends Error {
  override name = "InputProblem";
}

/** What one input produced: the port it goes out on, its data, and a status line. */
export interface Outcome {
  readonly port: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly said: string;
}

export type Config = Readonly<Record<string, unknown>>;

export type Operation = (
  client: AnytypeClient,
  key: string,
  config: Config,
  payload: unknown,
) => Promise<Outcome>;

// ── config and payload reading ───────────────────────────────────────────────────────────

/** A string setting, `fallback` when it is unset or empty. */
function setting(config: Config, name: string, fallback: string): string {
  const value = config[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

/** A required string setting. */
function required(config: Config, name: string): string {
  const value = setting(config, name, "");
  if (value === "") {
    throw new InputProblem(`${name} is not set on this node`);
  }
  return value;
}

/** A whole-number setting within [1, max]; the node-red form may hand it as text. */
function limit(config: Config, fallback: number, max = 1000): number {
  const raw = config["limit"];
  const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    throw new InputProblem(`limit must be a whole number from 1 to ${String(max)}`);
  }
  return value;
}

/**
 * The value at a JSON pointer (RFC 6901) in `payload`; undefined when nothing is there.
 * A pointer that is not one is the node's configuration at fault, and says so.
 */
export function atPointer(payload: unknown, pointer: string, name: string): unknown {
  if (pointer === "") {
    return payload;
  }
  if (!pointer.startsWith("/")) {
    throw new InputProblem(`${name} ${JSON.stringify(pointer)} is not a JSON pointer (/a/b)`);
  }
  let here: unknown = payload;
  for (const raw of pointer.slice(1).split("/")) {
    const step = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(here) && /^(0|[1-9][0-9]*)$/.test(step)) {
      here = here[Number(step)];
    } else if (typeof here === "object" && here !== null && !Array.isArray(here)) {
      here = Object.hasOwn(here, step) ? (here as Record<string, unknown>)[step] : undefined;
    } else {
      return undefined;
    }
  }
  return here;
}

/** Text at a pointer: strings as they are, numbers and booleans spelled; else `fallback`. */
function textAt(payload: unknown, pointer: string, name: string, fallback: string): string {
  const value = atPointer(payload, pointer, name);
  if (typeof value === "string") {
    return value;
  }
  return typeof value === "number" || typeof value === "boolean" ? String(value) : fallback;
}

/** The object id the payload names; an input without one cannot be acted on. */
function objectIdFrom(config: Config, payload: unknown): string {
  const pointer = setting(config, "object_id_field", "/object_id");
  const id = atPointer(payload, pointer, "object_id_field");
  if (typeof id !== "string" || id.trim() === "") {
    throw new InputProblem(`the payload has no object id at ${pointer}`);
  }
  return id.trim();
}

/** One object as the events carry it, with the link the desktop app opens. */
function summary(object: AnytypeObject, fallbackSpace: string): Record<string, unknown> {
  const space = typeof object.raw["space_id"] === "string" ? object.raw["space_id"] : fallbackSpace;
  return {
    space_id: space,
    object_id: object.id,
    name: object.name,
    type_key: object.typeKey,
    link: anytypeLink(space, object.id),
  };
}

// ── the five types ───────────────────────────────────────────────────────────────────────

const createObject: Operation = async (client, key, config, payload) => {
  const space = required(config, "space_id");
  const name = textAt(payload, setting(config, "name_field", "/name"), "name_field", "Untitled");
  const body = textAt(payload, setting(config, "body_field", "/body"), "body_field", "");
  const created = await client.createObject(key, space, {
    type_key: setting(config, "type_key", "page"),
    name,
    body,
  });
  const named = created.name === "" ? name : created.name;
  return {
    port: "created",
    data: {
      space_id: space,
      object_id: created.id,
      name: named,
      link: anytypeLink(space, created.id),
    },
    said: `created ${named}`,
  };
};

/** A property value Anytype takes for a JSON value: text, a number or a checkbox. */
function propertyValue(key: string, value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    return { key, text: value };
  }
  if (typeof value === "number") {
    return { key, number: value };
  }
  if (typeof value === "boolean") {
    return { key, checkbox: value };
  }
  throw new InputProblem(`property ${key} can be set from text, a number or true/false only`);
}

const updateObject: Operation = async (client, key, config, payload) => {
  const space = required(config, "space_id");
  const objectId = objectIdFrom(config, payload);
  const wanted = Array.isArray(config["properties"]) ? (config["properties"] as unknown[]) : [];
  const properties: Record<string, unknown>[] = [];
  for (const entry of wanted) {
    const { key: property, value_field: pointer } = (entry ?? {}) as Record<string, unknown>;
    if (typeof property !== "string" || property === "" || typeof pointer !== "string") {
      throw new InputProblem("every property needs a key and a value_field");
    }
    const value = atPointer(payload, pointer, `the value_field of ${property}`);
    // A payload without that value leaves the property as it is.
    if (value !== undefined) {
      properties.push(propertyValue(property, value));
    }
  }
  const updated = await client.updateObject(key, space, objectId, { properties });
  return {
    port: "updated",
    data: {
      space_id: space,
      object_id: updated.id,
      name: updated.name,
      link: anytypeLink(space, updated.id),
      properties: properties.map((property) => property["key"]),
    },
    said: `updated ${updated.name || updated.id}`,
  };
};

const readObject: Operation = async (client, key, config, payload) => {
  const space = required(config, "space_id");
  const object = await client.getObject(key, space, objectIdFrom(config, payload));
  return {
    port: "object",
    data: { ...summary(object, space), object: object.raw },
    said: `read ${object.name || object.id}`,
  };
};

const readSpace: Operation = async (client, key, config) => {
  const space = required(config, "space_id");
  const most = limit(config, 50);
  const type = setting(config, "type_filter", "");
  const objects =
    type === ""
      ? await client.listObjects(key, space, most)
      : await client.search(key, space, { query: "", types: [type] }, most);
  return {
    port: "objects",
    data: {
      space_id: space,
      type_filter: type === "" ? null : type,
      objects: objects.map((object) => summary(object, space)),
    },
    said: `${String(objects.length)} objects`,
  };
};

const search: Operation = async (client, key, config, payload) => {
  const space = setting(config, "space_id", "");
  const pointer = setting(config, "query_field", "");
  const query =
    pointer === "" ? setting(config, "query", "") : textAt(payload, pointer, "query_field", "");
  const types = Array.isArray(config["types"])
    ? (config["types"] as unknown[]).filter((type): type is string => typeof type === "string")
    : [];
  const results = await client.search(
    key,
    space === "" ? null : space,
    types.length === 0 ? { query } : { query, types },
    limit(config, 20),
  );
  return {
    port: "results",
    data: {
      query,
      space_id: space === "" ? null : space,
      results: results.map((object) => summary(object, space)),
    },
    said: `${String(results.length)} found`,
  };
};

/** The operation of each declared type id (inny-package.json). */
export const OPERATIONS: Readonly<Record<string, Operation>> = {
  "create-object": createObject,
  "update-object": updateObject,
  "read-object": readObject,
  "read-space": readSpace,
  search,
};
