// What is kept of a fetched catalogue, and when a kept copy may be used (catalogue.py:352-457).
//
// What is kept is the bytes and the signature, never the parsed result, and a kept copy goes
// through the identical verification a response does: one verifier, used twice. It is written
// only after verification and parsing have both passed (application/catalogue-reader.ts), so
// nothing rejected is ever kept.
//
// A kept copy counts only for the source name AND the URL it was fetched from (a source
// registered again elsewhere keeps its name, not its listing), only while younger than the
// update check interval, and never when its moment is in the future or has no time zone.
// Anything this build cannot account for is simply absent: the caller asks the server anyway.
//
// Pure: the store itself is ports/catalogue-cache.ts.

/** One catalogue as kept: the bytes, the signature, and the moment (epoch milliseconds). */
export interface CachedCatalogue {
  readonly document: Uint8Array;
  readonly signature: string | null;
  readonly fetchedAt: number;
}

/** An ISO 8601 moment that carries its offset; a naive one is not a moment this can compare. */
const AWARE_MOMENT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** The text the store keeps for one catalogue. The document must be UTF-8 (it was parsed). */
export function encodeCachedCatalogue(options: {
  name: string;
  url: string;
  document: Uint8Array;
  signature: string | null;
  fetchedAt: number;
}): string {
  return `${JSON.stringify(
    {
      document: new TextDecoder("utf-8", { fatal: true }).decode(options.document),
      fetched_at: new Date(options.fetchedAt).toISOString(),
      signature: options.signature,
      source: options.name,
      url: options.url,
    },
    null,
    2,
  )}\n`;
}

/**
 * The kept copy in `text`, or null when there is none, it is for another source or URL, it is
 * stale, it is from the future, or it is anything this build cannot read.
 */
export function decodeCachedCatalogue(
  text: string | null,
  options: { name: string; url: string; maxAgeSeconds: number; now: number },
): CachedCatalogue | null {
  if (text === null) {
    return null;
  }
  let kept: unknown;
  try {
    kept = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof kept !== "object" || kept === null || Array.isArray(kept)) {
    return null;
  }
  const record = kept as Record<string, unknown>;
  if (record["source"] !== options.name || record["url"] !== options.url) {
    return null;
  }
  const document = record["document"];
  const signature = record["signature"] ?? null;
  if (typeof document !== "string" || (signature !== null && typeof signature !== "string")) {
    return null;
  }
  const moment = record["fetched_at"];
  if (typeof moment !== "string" || !AWARE_MOMENT.test(moment)) {
    return null;
  }
  const fetchedAt = Date.parse(moment);
  if (Number.isNaN(fetchedAt)) {
    return null;
  }
  const ageSeconds = (options.now - fetchedAt) / 1000;
  // A negative age is a clock that moved, not a fresh catalogue.
  if (ageSeconds < 0 || ageSeconds >= options.maxAgeSeconds) {
    return null;
  }
  return { document: new TextEncoder().encode(document), signature, fetchedAt };
}
