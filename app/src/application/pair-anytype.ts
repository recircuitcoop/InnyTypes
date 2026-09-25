// Pairing with Anytype (plan 0018 §3, the keys.py row; keys.py:109-160 ported, `get-key`
// retired). Run from the Settings page through AppApi: "Pair with Anytype" asks Anytype for a
// challenge, the desktop app shows a four-digit code, the person types it, and the key Anytype
// returns is written to the canonical owner-only file (0600) and nowhere else.
//
// The key is never returned from here, never logged, and never part of an error: the store it
// is written through registers it with the redactor before the write.

import { PairingError } from "../domain/anytype/errors";
import type { AnytypeApi } from "../ports/anytype";
import type { Logger } from "../ports/logger";
import type { SecretStore } from "../ports/secret-store";

/** The code Anytype shows: exactly four digits, after trimming. */
export function pairingCode(code: unknown): string {
  const answer = typeof code === "string" ? code.trim() : "";
  if (!/^\d{4}$/.test(answer)) {
    throw new PairingError("Enter the four-digit code shown by Anytype.");
  }
  return answer;
}

export class Pairing {
  readonly #api: AnytypeApi;
  readonly #secrets: SecretStore;
  readonly #logger: Logger;
  #challenge: string | null = null;

  constructor(api: AnytypeApi, secrets: SecretStore, logger: Logger) {
    this.#api = api;
    this.#secrets = secrets;
    this.#logger = logger;
  }

  /** A challenge waits for its code. */
  get waiting(): boolean {
    return this.#challenge !== null;
  }

  /** Ask Anytype to show a code; a second start replaces the first challenge. */
  async start(): Promise<void> {
    this.#challenge = await this.#api.startPairing();
    this.#logger.info("Anytype is showing a pairing code for InnyTypes");
  }

  /**
   * Exchange the code for a key and store it. The key is returned only to the service, which
   * restarts the MCP child with it; nothing it reaches from here is shown to a person.
   */
  async complete(code: unknown): Promise<string> {
    const answer = pairingCode(code);
    const challenge = this.#challenge;
    if (challenge === null) {
      throw new PairingError("Start pairing with Anytype first, then enter the code it shows.");
    }
    const key = await this.#api.completePairing(challenge, answer);
    this.#challenge = null;
    // Only the canonical file: the legacy one is read, never written (§4.1).
    this.#secrets.write("anytype-api-key", key);
    this.#logger.info("stored the Anytype API key owner-only (0600)");
    return key;
  }
}
