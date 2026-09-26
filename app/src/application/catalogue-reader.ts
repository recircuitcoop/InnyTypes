// Reading a package catalogue: cache first, then the server (catalogue.py CatalogueReader,
// ported; WI-0018-14). Used by the Packages page and the version check (WI-0018-16, -17).
//
// One rule about keys, for every source alike: a key means a signature is required, and no key
// means every entry is unverified. The official catalogue is simply the read that always has
// one, the key shipped with the running release (plan 0003 D10: trust the signature, never the
// server). A registered source has one when it was given one (plan 0006 F1, F2).
//
// The order is the point: verify the bytes as they arrived, then parse, then keep. Nothing
// refused is ever kept. A kept copy that no longer passes is forgotten and the server asked
// again (a corrupt cache heals itself); a fetched one that fails is reported (a lying server
// should be).

import {
  CatalogueDocumentError,
  CatalogueRejected,
  MAX_CATALOGUE_BYTES,
  MAX_SIGNATURE_BYTES,
  OFFICIAL_SOURCE_NAME,
  parseCatalogue,
  SIGNATURE_SUFFIX,
  CatalogueError,
  type CatalogueSource,
  type PackageCatalogue,
} from "../domain/packages/catalogue";
import { decodeCachedCatalogue, encodeCachedCatalogue } from "../domain/packages/catalogue-cache";
import { MinisignError, parsePublicKey } from "../domain/signature/minisign";
import type { CatalogueCacheStore } from "../ports/catalogue-cache";
import type { HttpClient, HttpGetResult } from "../ports/http-client";
import type { SignatureVerifier } from "../ports/signature-verifier";

export interface CatalogueReaderOptions {
  readonly http: HttpClient;
  readonly cache: CatalogueCacheStore;
  readonly verifier: SignatureVerifier;
  /** Wall-clock time, epoch milliseconds: kept copies are compared across restarts. */
  readonly now: () => number;
  /**
   * How long a kept copy counts as fresh, read on every call: the update check interval from
   * the settings, and not a second number of its own (catalogue.py:469-472).
   */
  readonly maxAgeSeconds: () => number;
  /** Where the official catalogue is published: a build-time setting of a release. */
  readonly officialUrl: string;
  /** The minisign public key shipped with the running release; null when this build has none. */
  readonly officialKey: string | null;
}

export class CatalogueReader {
  readonly #options: CatalogueReaderOptions;

  constructor(options: CatalogueReaderOptions) {
    this.#options = options;
  }

  /** The catalogue this application ships pointed at. It must be signed. */
  async official(): Promise<PackageCatalogue> {
    const key = this.#options.officialKey;
    if (key === null) {
      // The alternative to refusing is reading a listing nobody signed.
      throw new CatalogueRejected({
        source: OFFICIAL_SOURCE_NAME,
        reason: "key",
        detail: "this build ships no public key to verify the official catalogue with",
      });
    }
    return this.#read(
      OFFICIAL_SOURCE_NAME,
      this.#options.officialUrl,
      this.#checkedKey(OFFICIAL_SOURCE_NAME, key),
    );
  }

  /** One registered source, verified only if it was given a key. */
  async registered(source: CatalogueSource): Promise<PackageCatalogue> {
    const key = source.publicKey === null ? null : this.#checkedKey(source.name, source.publicKey);
    return this.#read(source.name, source.url, key);
  }

  /**
   * A key that will not parse rejects the source before any request, rather than falling back
   * to "unverified": the user asked for this source to be checked.
   */
  #checkedKey(source: string, key: string): string {
    try {
      parsePublicKey(key);
    } catch (error) {
      if (error instanceof MinisignError) {
        throw new CatalogueRejected({
          source,
          reason: "key",
          detail: `the public key for this source is unusable: ${error.message}`,
          minisign: error.reason,
        });
      }
      throw error;
    }
    return key;
  }

  async #read(name: string, url: string, key: string | null): Promise<PackageCatalogue> {
    const { cache, now, maxAgeSeconds } = this.#options;
    const cached = decodeCachedCatalogue(cache.read(name), {
      name,
      url,
      maxAgeSeconds: maxAgeSeconds(),
      now: now(),
    });
    if (cached !== null) {
      try {
        return this.#build(name, url, cached.document, cached.signature, key, cached.fetchedAt);
      } catch (error) {
        if (!(error instanceof CatalogueError)) {
          throw error;
        }
        // Never used, and never the answer: thrown away, and the server asked again.
        cache.forget(name);
      }
    }

    const { document, signature } = await this.#fetch(name, url, key !== null);
    const fetchedAt = now();
    // Verified and parsed BEFORE anything is kept; everything that did not pass has thrown.
    const catalogue = this.#build(name, url, document, signature, key, fetchedAt);
    cache.write(name, encodeCachedCatalogue({ name, url, document, signature, fetchedAt }));
    return catalogue;
  }

  /** Verify the bytes as they arrived, then parse them: never the other way round. */
  #build(
    name: string,
    url: string,
    document: Uint8Array,
    signature: string | null,
    key: string | null,
    fetchedAt: number,
  ): PackageCatalogue {
    const verified = this.#verify(name, document, signature, key);

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(document);
    } catch {
      throw new CatalogueDocumentError("invalid", `the catalogue at ${url} is not UTF-8 text`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new CatalogueDocumentError(
        "invalid",
        `the catalogue at ${url} is not valid JSON: ${(error as Error).message}`,
      );
    }
    return {
      name,
      url,
      verified,
      fetchedAt,
      entries: parseCatalogue(parsed, { catalogue: name, verified, url }),
    };
  }

  /** Whether the document is verified, throwing when it was supposed to be and is not. */
  #verify(
    name: string,
    document: Uint8Array,
    signature: string | null,
    key: string | null,
  ): boolean {
    if (key === null) {
      // No key was ever given for this source: anyone may publish (F1), and every entry says
      // it is unverified.
      return false;
    }
    if (signature === null) {
      throw new CatalogueRejected({
        source: name,
        reason: "unsigned",
        detail: "a public key is held for this source, so an unsigned catalogue is not read",
      });
    }
    try {
      this.#options.verifier.verify(document, signature, key);
    } catch (error) {
      if (error instanceof MinisignError) {
        throw new CatalogueRejected({
          source: name,
          reason: "signature",
          detail: error.message,
          minisign: error.reason,
        });
      }
      throw error;
    }
    return true;
  }

  /**
   * The document, and its signature when a key is held to check it against. A source with no
   * key is one request, not two.
   */
  async #fetch(
    name: string,
    url: string,
    signed: boolean,
  ): Promise<{ document: Uint8Array; signature: string | null }> {
    const { http } = this.#options;
    const fetched = await http.get(url, { maxBytes: MAX_CATALOGUE_BYTES });
    if (!fetched.ok) {
      throw documentFailure(url, fetched, "a package catalogue");
    }
    if (!signed) {
      return { document: fetched.body, signature: null };
    }

    const signatureUrl = `${url}${SIGNATURE_SUFFIX}`;
    const raw = await http.get(signatureUrl, { maxBytes: MAX_SIGNATURE_BYTES });
    if (!raw.ok) {
      // A key is held, so an absent or unreadable signature is a document that cannot be
      // checked, and those are refused rather than read.
      throw new CatalogueRejected({
        source: name,
        reason: "unsigned",
        detail: `no signature could be read at ${signatureUrl}: ${raw.detail}`,
      });
    }
    try {
      return {
        document: fetched.body,
        signature: new TextDecoder("utf-8", { fatal: true }).decode(raw.body),
      };
    } catch {
      throw new CatalogueRejected({
        source: name,
        reason: "signature",
        detail: `the signature at ${signatureUrl} is not UTF-8 text`,
      });
    }
  }
}

function documentFailure(
  url: string,
  result: Extract<HttpGetResult, { ok: false }>,
  what: string,
): CatalogueDocumentError {
  if (result.failure === "oversize") {
    return new CatalogueDocumentError(
      "oversize",
      `${url} passed ${String(MAX_CATALOGUE_BYTES)} bytes and was abandoned; ${what} is a small document`,
    );
  }
  return new CatalogueDocumentError(
    "unreachable",
    `${what} could not be read from ${url}: ${result.detail}`,
  );
}
