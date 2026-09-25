// The runtime ↔ services direct channel (plan 0018 §2.2): the shell hands each of them one end
// of a MessageChannelMain, so they talk to each other without the shell in between.
//
// Its one message today carries the Anytype key from the services process, which reads it, to
// the runtime's redactor, which must know it before any node could print it. The key travels
// in memory, by structured clone, and is never written anywhere by this channel.
//
// INTERNAL: node authors never see it. Versioned like the shell channel, and parsed before use.

import { CHANNEL_VERSION } from "./messages";

export type PeerMessage = { readonly v: 1; readonly t: "anytype-key"; readonly key: string };

/** A peer message as it arrives, or null when it is not one of this version. */
export function parsePeerMessage(raw: unknown): PeerMessage | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const m = raw as Readonly<Record<string, unknown>>;
  if (m["v"] !== CHANNEL_VERSION || m["t"] !== "anytype-key") {
    return null;
  }
  const key = m["key"];
  return typeof key === "string" && key !== "" ? { v: 1, t: "anytype-key", key } : null;
}
