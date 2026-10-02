// One Node-RED tab as a flow (plan 0022 §D, decision D7): the pure rules flow administration
// needs about a tab's nodes, with no Node-RED and no I/O.
//
// * `remapIds`: a duplicate or a template's copy gets new ids for every node, and every
//   reference between them follows: `z`, `g`, `wires`, `links`, a group's `nodes`, a catch's
//   `scope`, and any other top-level text naming one of the copied ids (a config node's
//   reference). A wire to a node outside the copy is dropped: it named nothing the copy holds.
//   No credentials are copied (D7: those steps then read "not set up").
// * `withoutCredentials`: an export holds none, at any depth.
// * `wireOrder`: the tab's nodes from its sources along their wires, the order "Re-run from…"
//   lists the steps in.

/** A node of a tab, as Node-RED's flow API hands it over: an id, a type, and its fields. */
export type TabNode = Readonly<Record<string, unknown>> & {
  readonly id: string;
  readonly type: string;
};

type Fields = Record<string, unknown>;

const isRecord = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Fields that are the node's own and never a reference, even when they look like an id. */
const OWN_FIELDS: ReadonlySet<string> = new Set(["id", "type", "name", "label", "info"]);

/** The value with every `credentials` key removed, at any depth. */
export function withoutCredentials<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => withoutCredentials(item)) as T;
  }
  if (!isRecord(value)) {
    return value;
  }
  const kept: Fields = {};
  for (const [key, field] of Object.entries(value)) {
    if (key !== "credentials") {
      kept[key] = withoutCredentials(field);
    }
  }
  return kept as T;
}

/** Whether `value` holds a `credentials` key anywhere. */
export function hasCredentials(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(hasCredentials);
  }
  if (!isRecord(value)) {
    return false;
  }
  return Object.entries(value).some(
    ([key, field]) => key === "credentials" || hasCredentials(field),
  );
}

/**
 * Copies of `nodes` with new ids from `newId`, every reference between them re-mapped, and no
 * credentials. The copies come back in the order given.
 */
export function remapIds(nodes: readonly TabNode[], newId: () => string): TabNode[] {
  const ids = new Map<string, string>(nodes.map((node) => [node.id, newId()]));
  const mapped = (value: unknown): unknown =>
    typeof value === "string" ? (ids.get(value) ?? value) : value;
  // A list of ids keeps only those the copy holds.
  const kept = (value: readonly unknown[]): string[] =>
    value.flatMap((item) =>
      typeof item === "string" && ids.has(item) ? [mapped(item) as string] : [],
    );
  return nodes.map((node) => {
    const copy: Fields = {};
    for (const [key, field] of Object.entries(withoutCredentials(node))) {
      if (OWN_FIELDS.has(key)) {
        copy[key] = key === "id" ? mapped(field) : field;
      } else if (key === "wires" && Array.isArray(field)) {
        // One list per output port: the port stays even when it is left with no wire.
        copy[key] = field.map((port: unknown) => (Array.isArray(port) ? kept(port) : []));
      } else if (Array.isArray(field) && field.every((item) => typeof item === "string")) {
        // `links`, a group's `nodes`, a catch's `scope`: each id the copy holds is followed.
        copy[key] = field.some((item) => ids.has(item)) ? kept(field) : field;
      } else {
        copy[key] = mapped(field);
      }
    }
    return copy as TabNode;
  });
}

/** The ids a node's wires lead to, port by port. */
function targets(node: TabNode): string[] {
  const wires = node["wires"];
  if (!Array.isArray(wires)) {
    return [];
  }
  return wires.flatMap((port: unknown) =>
    Array.isArray(port) ? port.filter((id): id is string => typeof id === "string") : [],
  );
}

const coordinate = (node: TabNode, axis: "x" | "y"): number => {
  const value = node[axis];
  return typeof value === "number" ? value : 0;
};

/** Top to bottom, then left to right: how a person reads the canvas. */
function byPosition(a: TabNode, b: TabNode): number {
  return coordinate(a, "y") - coordinate(b, "y") || coordinate(a, "x") - coordinate(b, "x");
}

/**
 * The nodes along their wires: from the nodes nothing wires into (`isSource` ones first, then
 * top to bottom), breadth first, each node once. A node only a loop reaches comes last, by
 * position, so every node is in the answer exactly once.
 */
export function wireOrder(
  nodes: readonly TabNode[],
  isSource: (node: TabNode) => boolean,
): TabNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const wiredInto = new Set(nodes.flatMap(targets));
  const roots = nodes
    .filter((node) => !wiredInto.has(node.id))
    .sort((a, b) => Number(isSource(b)) - Number(isSource(a)) || byPosition(a, b));
  const seen = new Set<string>();
  const ordered: TabNode[] = [];
  const queue = [...roots];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (seen.has(next.id)) {
      continue;
    }
    seen.add(next.id);
    ordered.push(next);
    for (const id of targets(next)) {
      const target = byId.get(id);
      if (target !== undefined && !seen.has(id)) {
        queue.push(target);
      }
    }
  }
  const left = nodes.filter((node) => !seen.has(node.id)).sort(byPosition);
  return [...ordered, ...left];
}
