// The package catalogue: a signed listing of which packages exist, and who says so
// (helper/catalogue.py format 1, ported; plan 0006 F1; WI-0018-14).
//
// The format is a published convention, not a private arrangement: "any plugin developer who
// follows this convention can become a plugin source" (plan 0006 F1). There is no registry.
// Publishing the file at an HTTPS URL is becoming a source; the official catalogue is simply
// the one this application ships pointed at.
//
// Verification is not consent. A catalogue signature settles that this listing came from that
// publisher and was not rewritten on the way. It vouches for no byte of any package (the
// package's own signature does that), and whether this machine acts on it alone is the
// source's own switch, never the signature.
//
// The document:
//
//     { "catalogue": 1,
//       "plugins": [ { "id": "monty", "summary": "Files what you do.", "source": "pypi:monty" } ] }
//
// with the detached minisign signature published beside it at the same URL plus `.minisig`.
// An entry may also name `"archive"`: the package's signed `.tgz`, an HTTPS URL or a path
// relative to the catalogue (WI-0018-16); it is what the Packages page installs from.
//
// Unknown keys inside an entry are ignored (an entry may grow a field); unknown top-level keys
// are refused (the shape of the document is what `catalogue` versions). A rejected document
// is rejected whole: no partial trust.
//
// Pure: parsing and validation. The read (cache first, then the server) is
// application/catalogue-reader.ts; the fetch and the cache are adapters behind ports.

import type { MinisignRefusal } from "../signature/minisign";

/** The version of the convention this build reads; anything else is refused. */
export const CATALOGUE_FORMAT = 1;
/** What a catalogue is called where it is published. */
export const CATALOGUE_FILENAME = "catalogue.json";
/** minisign's own default suffix: `minisign -Sm catalogue.json` writes catalogue.json.minisig. */
export const SIGNATURE_SUFFIX = ".minisig";
/**
 * Ceilings on what a server may hand back (catalogue.py:173-174). A thousand plugins is about
 * two hundred kilobytes, and a signature is four short lines.
 */
export const MAX_CATALOGUE_BYTES = 1024 * 1024;
export const MAX_SIGNATURE_BYTES = 4096;
/** An entry's summary is one line drawn beside a button. */
export const MAX_SUMMARY_CHARS = 200;
/** The name the official catalogue is listed and cached under; no registered source takes it. */
export const OFFICIAL_SOURCE_NAME = "official";

const KNOWN_TOP_LEVEL_KEYS = new Set(["catalogue", "plugins"]);
const SOURCE_KINDS = "'index', 'index:<name>', 'pypi:<project>' or 'git+<url>'";

/** manifest.py's addon id: lowercase letters and digits joined by single hyphens. */
const ADDON_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Whether `text` is a well-formed addon id, which a package id and a source name both are. */
export function isAddonId(text: string): boolean {
  return ADDON_ID.test(text);
}

// --- refusals --------------------------------------------------------------------------------

/**
 * The base of everything the catalogue refuses. One base, because the caller's response is the
 * same for all of them: this source is listed with what went wrong, and every other source is
 * still read. `reason` names the refusal for the report and for tests.
 */
export abstract class CatalogueError extends Error {
  abstract readonly reason: string;
}

/**
 * The document could not be fetched (`unreachable`), was larger than its ceiling (`oversize`),
 * or could not be understood (`invalid`).
 */
export class CatalogueDocumentError extends CatalogueError {
  override name = "CatalogueDocumentError";
  readonly reason: "unreachable" | "oversize" | "invalid";

  constructor(reason: "unreachable" | "oversize" | "invalid", message: string) {
    super(message);
    this.reason = reason;
  }
}

/**
 * A catalogue refused on its signature: `unsigned` (a key is held and no signature could be
 * read), `signature` (it did not verify; `minisign` says why) or `key` (no usable key to
 * verify against). Nothing of it is used or kept.
 */
export class CatalogueRejected extends CatalogueError {
  override name = "CatalogueRejected";
  readonly reason: "unsigned" | "signature" | "key";
  readonly source: string;
  readonly detail: string;
  readonly minisign: MinisignRefusal | null;

  constructor(options: {
    source: string;
    reason: "unsigned" | "signature" | "key";
    detail: string;
    minisign?: MinisignRefusal;
  }) {
    super(
      `the package catalogue from "${options.source}" failed its ${options.reason} check and ` +
        `was discarded: ${options.detail}`,
    );
    this.reason = options.reason;
    this.source = options.source;
    this.detail = options.detail;
    this.minisign = options.minisign ?? null;
  }
}

/** A registered source in the settings is not one this build can use. */
export class CatalogueSettingsError extends CatalogueError {
  override name = "CatalogueSettingsError";
  readonly reason = "settings";
}

// --- the document ----------------------------------------------------------------------------

/**
 * One package a catalogue says exists. `verified` is a property of the listing (the catalogue
 * carried a signature that checked out against a key this machine holds), never of the package.
 */
export interface CatalogueEntry {
  readonly packageId: string;
  readonly summary: string;
  readonly installSource: string;
  /** The name of the catalogue this entry came from. */
  readonly catalogue: string;
  readonly verified: boolean;
  /**
   * The HTTPS URL of the package's signed `.tgz` archive (WI-0018-16), resolved against the
   * catalogue's own URL. Absent from an entry that names only an old-style source, which this
   * build cannot install.
   */
  readonly archive?: string;
}

/** One source's whole listing, as read. `fetchedAt` is epoch milliseconds. */
export interface PackageCatalogue {
  readonly name: string;
  readonly url: string;
  readonly verified: boolean;
  readonly fetchedAt: number;
  readonly entries: readonly CatalogueEntry[];
}

/** The entry for one package, or null when this catalogue does not list it. */
export function entryFor(catalogue: PackageCatalogue, packageId: string): CatalogueEntry | null {
  return catalogue.entries.find((entry) => entry.packageId === packageId) ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): CatalogueDocumentError {
  return new CatalogueDocumentError("invalid", message);
}

/**
 * Validate one catalogue document, refusing anything it cannot account for. Every refusal
 * names the catalogue and the entry it came from: one bad line in forty is unfixable otherwise.
 */
export function parseCatalogue(
  document: unknown,
  options: { catalogue: string; verified: boolean; url?: string },
): CatalogueEntry[] {
  const { catalogue, verified } = options;
  if (!isRecord(document)) {
    throw invalid(`the catalogue from "${catalogue}" is not a JSON object`);
  }

  const announced = document["catalogue"];
  if (typeof announced !== "number" || !Number.isInteger(announced)) {
    throw invalid(
      `the catalogue from "${catalogue}" does not announce a \`catalogue\` format version; ` +
        `this build reads version ${String(CATALOGUE_FORMAT)}`,
    );
  }
  if (announced !== CATALOGUE_FORMAT) {
    throw invalid(
      `the catalogue from "${catalogue}" announces format version ${String(announced)}, and ` +
        `this build reads version ${String(CATALOGUE_FORMAT)}. A newer InnyTypes is what reads it`,
    );
  }

  const unknown = Object.keys(document)
    .filter((key) => !KNOWN_TOP_LEVEL_KEYS.has(key))
    .sort();
  if (unknown.length > 0) {
    throw invalid(
      `the catalogue from "${catalogue}" holds ${unknown.map((key) => `'${key}'`).join(", ")} ` +
        `at the top level, which version ${String(CATALOGUE_FORMAT)} of this convention does ` +
        "not define",
    );
  }

  const listed = document["plugins"];
  if (!Array.isArray(listed)) {
    throw invalid(
      `the catalogue from "${catalogue}" has no \`plugins\` list; a catalogue publishes one ` +
        "entry per package it offers",
    );
  }

  const entries = listed.map((published: unknown, position) =>
    parseEntry(
      published,
      `the catalogue from "${catalogue}", entry ${String(position)}`,
      { catalogue, verified },
      options.url,
    ),
  );

  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.packageId)) {
      repeated.add(entry.packageId);
    }
    seen.add(entry.packageId);
  }
  if (repeated.size > 0) {
    throw invalid(
      `the catalogue from "${catalogue}" lists ${[...repeated].sort().join(", ")} more than ` +
        "once; one package has one entry",
    );
  }
  return entries;
}

/** Python's str.isprintable: no control, format, surrogate, private, unassigned or separator. */
const NOT_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]|(?! )\p{Zs}/u;

function parseEntry(
  published: unknown,
  where: string,
  options: { catalogue: string; verified: boolean },
  catalogueUrl: string | undefined,
): CatalogueEntry {
  if (!isRecord(published)) {
    throw invalid(`${where} is not a JSON object`);
  }

  const packageId = requiredText(published, "id", where);
  if (!isAddonId(packageId)) {
    throw invalid(
      `${where}: \`id\` is "${packageId}", which is not a well-formed addon id: lowercase ` +
        "letters and digits joined by single hyphens and nothing else",
    );
  }

  const summary = requiredText(published, "summary", where).trim();
  if (summary.length > MAX_SUMMARY_CHARS) {
    throw invalid(
      `${where}: \`summary\` is ${String(summary.length)} characters, and a catalogue entry's ` +
        `summary is one line of at most ${String(MAX_SUMMARY_CHARS)}`,
    );
  }
  if (NOT_PRINTABLE.test(summary)) {
    throw invalid(
      `${where}: \`summary\` holds a control character. It is drawn in a list beside a button, ` +
        "and text that can move a cursor is not text",
    );
  }

  const installSource = requiredText(published, "source", where);
  checkInstallSource(installSource, where, packageId);

  const archive =
    "archive" in published ? archiveUrl(published["archive"], where, catalogueUrl) : undefined;
  return {
    packageId,
    summary,
    installSource,
    ...options,
    ...(archive === undefined ? {} : { archive }),
  };
}

/** The entry's archive as an absolute HTTPS URL, resolved against the catalogue's URL. */
function archiveUrl(value: unknown, where: string, catalogueUrl: string | undefined): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalid(`${where}: \`archive\` must be a URL or a path, got ${JSON.stringify(value)}`);
  }
  let resolved: URL;
  try {
    resolved = catalogueUrl === undefined ? new URL(value) : new URL(value, catalogueUrl);
  } catch {
    throw invalid(`${where}: \`archive\` is "${value}", which is not a URL`);
  }
  if (resolved.protocol !== "https:") {
    throw invalid(
      `${where}: \`archive\` is "${resolved.href}", and a package is never fetched in the clear`,
    );
  }
  return resolved.href;
}

/** One required text field, refusing an absent, empty or non-text one by name. */
function requiredText(entry: Record<string, unknown>, key: string, where: string): string {
  if (!(key in entry)) {
    throw invalid(`${where}: \`${key}\` is missing`);
  }
  const value = entry[key];
  if (typeof value !== "string") {
    throw invalid(`${where}: \`${key}\` must be text, got ${JSON.stringify(value)}`);
  }
  if (value.trim() === "") {
    throw invalid(`${where}: \`${key}\` is empty`);
  }
  return value;
}

/**
 * The entry's install source, by versions.py's parse_source rules (a prefix names the kind,
 * never the shape of a URL), plus one rule of the catalogue's own: a git source is HTTPS.
 */
function checkInstallSource(text: string, where: string, packageId: string): void {
  const kinds: [prefix: string, example: string][] = [
    ["git+", "'git+<url>', for example 'git+https://forge.example/monty.git'"],
    ["pypi:", "'pypi:<project>', for example 'pypi:monty'"],
    ["index:", "'index:<name>', or plain 'index' to use the package's own id"],
  ];
  if (text === "index") {
    return;
  }
  for (const [prefix, example] of kinds) {
    if (!text.startsWith(prefix)) {
      continue;
    }
    const rest = text.slice(prefix.length);
    if (rest === "") {
      throw invalid(
        `${where}: ${packageId}: source is '${prefix}' with nothing after it; write ${example}`,
      );
    }
    if (prefix === "git+" && !rest.toLowerCase().startsWith("https://")) {
      throw invalid(
        `${where}: \`source\` is "${text}", and a catalogue never offers a git source that is ` +
          "not HTTPS",
      );
    }
    return;
  }
  throw invalid(
    `${where}: ${packageId}: source "${text}" names no source kind this build can read; ` +
      `write ${SOURCE_KINDS}`,
  );
}

// --- the sources, from the settings ------------------------------------------------------------

/**
 * One registered source (config.py `[sources.<name>]`, plan 0006 F2). `publicKey` is the bare
 * base64 key line; null means the source gave none, and its entries are unverified.
 * `autoUpdate` null means the source has no opinion and the global default decides.
 */
export interface CatalogueSource {
  readonly name: string;
  readonly url: string;
  readonly publicKey: string | null;
  readonly autoUpdate: boolean | null;
}

const SOURCE_KEYS = new Set(["url", "public_key", "auto_update"]);

/**
 * The registered sources, from the settings' `sources` table (config.py:1175-1240): a name
 * that is an addon id and not `official`, an HTTPS URL, an optional single-line key and an
 * optional switch. Any publisher can be a source (F1); nothing here asks who they are.
 */
export function parseCatalogueSources(section: unknown): CatalogueSource[] {
  if (!isRecord(section)) {
    throw new CatalogueSettingsError("[sources] is not a table of [sources.<name>] tables");
  }
  return Object.entries(section).map(([name, value]) => {
    const where = `sources.${name}`;
    if (!isRecord(value)) {
      throw new CatalogueSettingsError(
        `unknown key "${name}" in [sources]: expected a [sources.<name>] table with a \`url\`, ` +
          "and optionally a `public_key` and an `auto_update` switch",
      );
    }
    if (!isAddonId(name)) {
      throw new CatalogueSettingsError(
        `[${where}] is not a well-formed source name: expected lowercase letters and digits ` +
          "joined by single hyphens (for example [sources.acme])",
      );
    }
    if (name === OFFICIAL_SOURCE_NAME) {
      throw new CatalogueSettingsError(
        `[${where}] is reserved for the catalogue this application ships pointed at; give ` +
          "this source another name",
      );
    }
    const unknown = Object.keys(value).filter((key) => !SOURCE_KEYS.has(key));
    if (unknown.length > 0) {
      throw new CatalogueSettingsError(`[${where}] holds unknown keys: ${unknown.join(", ")}`);
    }

    const url = value["url"];
    if (typeof url !== "string" || url === "") {
      throw new CatalogueSettingsError(
        `${where}.url is missing: a source is a name and an HTTPS URL`,
      );
    }
    if (!url.toLowerCase().startsWith("https://")) {
      throw new CatalogueSettingsError(
        `${where}.url is "${url}", which is not an HTTPS URL. A catalogue decides which code ` +
          "this machine offers to install, so it is never fetched in the clear",
      );
    }

    let publicKey: string | null = null;
    if ("public_key" in value) {
      const key = value["public_key"];
      publicKey = typeof key === "string" ? key.trim() : "";
      if (publicKey === "" || /\s/.test(publicKey)) {
        throw new CatalogueSettingsError(
          `${where}.public_key must be the single base64 line of a minisign public key (the ` +
            "second line of the .pub file), with no comment line and no spaces",
        );
      }
    }

    let autoUpdate: boolean | null = null;
    if ("auto_update" in value) {
      const flag = value["auto_update"];
      if (typeof flag !== "boolean") {
        throw new CatalogueSettingsError(`${where}.auto_update must be true or false`);
      }
      autoUpdate = flag;
    }
    return { name, url, publicKey, autoUpdate };
  });
}
