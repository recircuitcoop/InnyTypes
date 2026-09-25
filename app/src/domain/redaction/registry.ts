// The secret registry and redact() (plan 0018 §2.3, spec 11.1), the port of logs.py:47-106.
//
// Exact-match rather than pattern-matching, on purpose: a pattern that guesses what a
// credential looks like fails open on the credentials it did not anticipate, and a redactor
// that fails open is decoration. Every process keeps one registry. Whoever holds a credential
// (a node's credentials in the runtime, the Anytype key and the proxy token in the services
// process) registers it where it holds it, and the shell learns it as well, so a line is
// redacted at its source and again by the one writer.
//
// The cost of exact matching is that the secret is held here for the life of the process. That
// is the trade logs.py made and states: a redactor that can quietly forget a secret is a
// redactor that silently stops working.

/** What a redacted credential is replaced with: recognisable, so a reader sees a removal. */
export const REDACTED = "[redacted]";

export class SecretRegistry {
  // A private field, so neither util.inspect nor JSON.stringify ever shows what is held.
  readonly #secrets = new Set<string>();

  /**
   * Register a credential that must never reach the log. True when it was not known before.
   *
   * An empty secret is refused: `"x".replaceAll("", "…")` inserts the marker between every
   * character, so one empty registration would destroy every line in the process.
   */
  protect(secret: string): boolean {
    if (secret === "" || this.#secrets.has(secret)) {
      return false;
    }
    this.#secrets.add(secret);
    return true;
  }

  /** `text` with every registered credential replaced by REDACTED. */
  redact(text: string): string {
    // Longest first: where one secret contains another, replacing the longer one first leaves
    // a readable result instead of a half-substituted fragment.
    const longestFirst = [...this.#secrets].sort((a, b) => b.length - a.length);
    let redacted = text;
    for (const secret of longestFirst) {
      redacted = redacted.replaceAll(secret, REDACTED);
    }
    return redacted;
  }

  /** How many credentials are held, never which. */
  get size(): number {
    return this.#secrets.size;
  }

  toString(): string {
    return `SecretRegistry(${String(this.#secrets.size)} held)`;
  }

  toJSON(): string {
    return this.toString();
  }
}
