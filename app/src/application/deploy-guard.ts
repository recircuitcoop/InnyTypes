// The deploy guard (spec 11.3, plan 0018 §2.2, WI-0018-08).
//
// Node-RED accepts a deploy naming a type it does not have, then stops EVERY flow and waits
// for the missing type (arch_pivot P7): one imported flow takes the whole runtime down. So a
// write to the flows is checked before Node-RED sees it, and refused when it names a type that
// is not registered, or whose package is not in the verified package store.
//
// The same guard refuses any request whose Host header is not the loopback address and the
// runtime's port. That is not the admin token the owner declined: it only stops a web page
// from reaching the admin API by DNS rebinding.
//
// This file decides; adapters/nodered/guard-middleware.ts puts it in front of Node-RED.

import type { Logger } from "../ports/logger";
import type { NodeRedEngine, NodeSet } from "../ports/node-red-engine";
import type { PackageStore } from "../ports/package-store";
import type { FlowsRoute, GuardAnswer, RequestGuard } from "../ports/request-guard";

/** Types every flow may name: Node-RED's structure, not nodes (spec 11.3). */
export const STRUCTURAL_TYPES: readonly string[] = ["tab", "subflow", "group"];

/** The module Node-RED gives its core nodes and every local node file (the generated types). */
export const CORE_MODULE = "node-red";

/** `inny-<package>-<id>` (spec 2.1): a package name has no hyphen, so the first one ends it. */
const INNY_TYPE = /^inny-([a-z][a-z0-9_]{1,39})-[a-z][a-z0-9_-]{0,63}$/;

const PASS: GuardAnswer = { ok: true };

type Fields = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The items of a list as Node-RED's body parsers may hand it over: a JSON array, or, from a
 * url-encoded body, an object with numeric keys. Anything else holds no nodes.
 */
function items(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  return isRecord(value) ? Object.values(value) : [];
}

function typeOf(node: unknown): string | null {
  return isRecord(node) && typeof node["type"] === "string" ? node["type"] : null;
}

/** Every distinct type a flows write names, in the order it first appears. */
export function typesNamedIn(route: FlowsRoute, body: unknown): string[] {
  const nodes: unknown[] = [];
  if (route === "flows") {
    nodes.push(...items(isRecord(body) && "flows" in body ? body["flows"] : body));
  } else if (isRecord(body)) {
    nodes.push(...items(body["nodes"]), ...items(body["configs"]));
    for (const subflow of items(body["subflows"])) {
      nodes.push(subflow);
      if (isRecord(subflow)) {
        nodes.push(...items(subflow["nodes"]), ...items(subflow["configs"]));
      }
    }
  }
  const types = new Set<string>();
  for (const node of nodes) {
    const type = typeOf(node);
    if (type !== null) {
      types.add(type);
    }
  }
  return [...types];
}

/** The package an InnyTypes type belongs to, or null when the type is not one. */
export function innyPackageOf(type: string): string | null {
  return INNY_TYPE.exec(type)?.[1] ?? null;
}

/** The set that registers `type`: loaded, enabled, and listing it. */
function registeringSet(type: string, sets: readonly NodeSet[]): NodeSet | undefined {
  return sets.find((set) => set.enabled && set.err === undefined && set.types.includes(type));
}

/**
 * The types of `types` a deploy may not name.
 *
 * - Structure (`tab`, `subflow`, `group`, `subflow:*`) is always allowed.
 * - Every other type must be registered.
 * - An InnyTypes type (`inny-<package>-<id>`) must also belong to a verified package.
 * - Any other type must be one of Node-RED's own: with the palette lock (spec 11.4, 11.5) those
 *   are `core/common`. A type from a module is refused even if something let it load.
 */
export function refusedTypes(
  types: readonly string[],
  sets: readonly NodeSet[],
  verified: ReadonlySet<string>,
): string[] {
  return types.filter((type) => {
    if (STRUCTURAL_TYPES.includes(type) || type.startsWith("subflow:")) {
      return false;
    }
    const set = registeringSet(type, sets);
    if (set === undefined) {
      return true;
    }
    const innyPackage = innyPackageOf(type);
    if (innyPackage !== null) {
      return !verified.has(innyPackage);
    }
    return set.module !== CORE_MODULE;
  });
}

/** Whether a Host header names this server: the loopback address or localhost, and its port. */
export function hostAllowed(host: string | undefined, port: number): boolean {
  if (host === undefined) {
    return false;
  }
  const named = host.toLowerCase();
  return named === `127.0.0.1:${String(port)}` || named === `localhost:${String(port)}`;
}

export interface DeployGuardDeps {
  readonly engine: NodeRedEngine;
  readonly store: PackageStore;
  readonly logger: Logger;
  /** The runtime's stable port (plan 0018 §2.2). */
  readonly port: number;
}

export class DeployGuard implements RequestGuard {
  readonly #deps: DeployGuardDeps;

  constructor(deps: DeployGuardDeps) {
    this.#deps = deps;
  }

  /** Any request: refused unless its Host header names this server. */
  checkHost(host: string | undefined): GuardAnswer {
    const { port, logger } = this.#deps;
    if (hostAllowed(host, port)) {
      return PASS;
    }
    // The header is whatever the client sent: quoted, so it cannot forge a log line.
    logger.warn(`refused a request for host ${JSON.stringify(host ?? null)}`);
    return {
      ok: false,
      status: 403,
      body: {
        code: "forbidden_host",
        message: `This server answers only as 127.0.0.1:${String(port)} or localhost:${String(port)}.`,
      },
    };
  }

  /** A write to the flows: refused when it names a type that may not be deployed. */
  async checkDeploy(route: FlowsRoute, body: unknown): Promise<GuardAnswer> {
    const { engine, store, logger } = this.#deps;
    const types = typesNamedIn(route, body);
    if (types.length === 0) {
      return PASS;
    }
    const refused = refusedTypes(types, await engine.nodeSets(), new Set(store.packages()));
    if (refused.length === 0) {
      return PASS;
    }
    const list = refused.join(", ");
    logger.warn(`refused a deploy naming types that are not installed: ${list}`);
    return {
      ok: false,
      status: 400,
      body: { code: "unknown_types", message: `Not installed in InnyTypes: ${list}` },
    };
  }
}
