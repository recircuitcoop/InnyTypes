// The runtime ↔ services direct channel (plan 0018 §2.2): the shell hands each of them one end
// of a MessageChannelMain, so they talk to each other without the shell in between.
//
// Its messages:
// * `anytype-key`, services → runtime: the Anytype key, for the runtime's redactor, which must
//   know it before any node could print it. In memory, by structured clone, never written.
// * `call`, runtime → services, and its `answer`: what a step's form chooses from (plan 0022
//   §B, D9): `anytype.spaces` answers `[{id, name}]`, `anytype.types {spaceId}` answers
//   `[{key, name}]`, or either a refusal `{refused: {reason, sentence}}`. Ids and names only:
//   the key stays in the services process.
//
// INTERNAL: node authors never see it. Versioned like the shell channel, and parsed before use.

import { CHANNEL_VERSION, type OpResult } from "./messages";

/** The calls the runtime makes of the services process. */
export type PeerOp = "anytype.spaces" | "anytype.types";

export type PeerMessage =
  | { readonly v: 1; readonly t: "anytype-key"; readonly key: string }
  | {
      readonly v: 1;
      readonly t: "call";
      readonly id: string;
      readonly op: PeerOp;
      readonly args: unknown;
    }
  | { readonly v: 1; readonly t: "answer"; readonly id: string; readonly result: OpResult };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function isOpResult(value: unknown): value is OpResult {
  if (!isRecord(value)) {
    return false;
  }
  return value["ok"] === true || (value["ok"] === false && typeof value["error"] === "string");
}

/** A peer message as it arrives, or null when it is not one of this version. */
export function parsePeerMessage(raw: unknown): PeerMessage | null {
  if (!isRecord(raw) || raw["v"] !== CHANNEL_VERSION) {
    return null;
  }
  const id = raw["id"];
  switch (raw["t"]) {
    case "anytype-key": {
      const key = raw["key"];
      return typeof key === "string" && key !== "" ? { v: 1, t: "anytype-key", key } : null;
    }
    case "call": {
      const op = raw["op"];
      if (typeof id !== "string" || (op !== "anytype.spaces" && op !== "anytype.types")) {
        return null;
      }
      return { v: 1, t: "call", id, op, args: raw["args"] };
    }
    case "answer": {
      const result = raw["result"];
      return typeof id === "string" && isOpResult(result)
        ? { v: 1, t: "answer", id, result }
        : null;
    }
    default:
      return null;
  }
}
