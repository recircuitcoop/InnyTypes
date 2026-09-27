// The one redaction every telemetry payload passes through before it is queued (plan 0018 §3
// telemetry.py: Port; the port of telemetry.py:384-614).
//
// It fails closed, in four ways at once, because each is a place a leak could start:
// * the VALUE of any key whose name is about content, names, credentials, files, audio, the
//   environment, the user, the host or the hardware is dropped (the key stays, so a reader sees
//   the removal);
// * every registered credential is removed from every string by exact match (the one
//   SecretRegistry, plus the secrets the caller names: the raw machine identifier);
// * every absolute path is reduced to its part inside a package, or to REDACTED when it belongs
//   to no package it can recognise: a path it cannot attribute is somewhere in the person's files;
// * anything it cannot serialise, and anything too long or too deep, is replaced or cut.
//
// Matching by key name is a deny-list, and deny-lists fail open, so it is never the only defence:
// the reports this app builds are assembled from named fields (domain/telemetry/reports.ts).

import { REDACTED } from "../redaction/registry";

/**
 * A key whose lowercased name CONTAINS any of these never carries its value off the machine. The
 * plan's "what is never sent", in the words those things are spelled with, so `object_title`,
 * `spaceName` and `ANYTYPE_API_KEY` are covered by the entries they contain.
 */
export const FORBIDDEN_KEY_FRAGMENTS: readonly string[] = [
  // Anytype content, and the names of the objects and spaces it lives in.
  "content",
  "text",
  "body",
  "markdown",
  "snippet",
  "excerpt",
  "title",
  "name",
  "label",
  "space",
  "object",
  "property",
  "relation",
  "block",
  "note",
  "tag",
  "query",
  "search",
  // A node's settings: every configured value, secret or not.
  "setting",
  "config",
  "field",
  "value",
  // The Anytype API key, the proxy token, a node credential, and any other credential.
  "key",
  "token",
  "secret",
  "password",
  "passphrase",
  "credential",
  "auth",
  "cookie",
  "session",
  "bearer",
  "signature",
  // File contents, and the paths that say where a person keeps their files.
  "file",
  "path",
  "dir",
  "folder",
  "document",
  "attachment",
  "payload",
  "data",
  "blob",
  "bytes",
  // Audio, and everything derived from it.
  "audio",
  "sound",
  "voice",
  "speech",
  "record",
  "transcript",
  "caption",
  "subtitle",
  // Environment variable values: where an API key most often hides.
  "env",
  // Who the person is.
  "user",
  "account",
  "owner",
  "login",
  "email",
  "profile",
  "home",
  // What the machine is called, and where it is on a network.
  "host",
  "domain",
  "address",
  "network",
  "wifi",
  "ssid",
  // The raw OS machine identifier, and every other hardware identity.
  "identifier",
  "uuid",
  "guid",
  "serial",
  "hardware",
  "device",
];

/** Bounds on one redacted value, so one report cannot fill the disk the queue's bound protects. */
export const MAX_TEXT_LENGTH = 2000;
export const MAX_SEQUENCE_ITEMS = 100;
export const MAX_MAPPING_ITEMS = 100;
export const MAX_DEPTH = 8;

/**
 * A caller-named secret shorter than this is not removed by exact match: blanking a short string
 * would blank fragments of unrelated text (telemetry.py MINIMUM_IDENTIFIER_LENGTH).
 */
export const MINIMUM_SECRET_LENGTH = 8;

/** Everything before these in an absolute path is where the person keeps their files. */
const PACKAGE_MARKERS = ["/node_modules/", "/site-packages/", "/dist-packages/"];

/**
 * The app's own code: inside the packaged archive, or a checkout's app folder. A bare `/app/` or
 * `/src/` is not enough: `/Users/someone/app/private-notes.md` matches it, and the tail would be
 * the person's own names.
 */
const OWN_MARKERS = ["/app.asar/", "/innytypes/app/"];

/** A Python standard library, wherever the interpreter lives (a package environment's). */
const PYTHON_LIB = /\/(?:lib\/)?python3(?:\.\d+)?\//;

/**
 * An absolute POSIX path of at least two segments. The lookbehind refuses a `/` after a word
 * character, a dot, a colon or another slash, which keeps `https://host/path` from being read as
 * one. A `file://` URL is unwrapped first (below), so its path is not hidden the same way.
 */
const POSIX_PATH = /(?<![\w.:/])(?:\/[\w.+@%-]+){2,}\/?/g;

/** `C:\Users\someone\Documents\notes.md`, and the forward-slash spelling of the same thing. */
const WINDOWS_PATH = /(?<![\w:])[A-Za-z]:[\\/](?:[\w.+@%-]+[\\/]?){2,}/g;

const FILE_URL = /file:\/\//gi;

/** What redaction removes registered credentials with: the one SecretRegistry's redact. */
export type CredentialRedactor = (text: string) => string;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/**
 * The one function every payload passes through before it is queued. `secrets` are exact strings
 * that must not survive anywhere in the result, on top of what `credentials` removes. The result
 * is always JSON: a value this cannot understand is replaced, never passed through.
 */
export function redactPayload(
  payload: Readonly<Record<string, unknown>>,
  credentials: CredentialRedactor,
  secrets: readonly string[] = [],
): JsonObject {
  const named = [...secrets]
    .filter((secret) => secret.length >= MINIMUM_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);
  return redactMapping(payload, { credentials, secrets: named }, 0);
}

interface Scrubbers {
  readonly credentials: CredentialRedactor;
  readonly secrets: readonly string[];
}

function redactMapping(
  value: Readonly<Record<string, unknown>>,
  scrub: Scrubbers,
  depth: number,
): JsonObject {
  const redacted: JsonObject = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_MAPPING_ITEMS)) {
    // The key stays and the value goes: a report that says a field was removed is far easier to
    // read, and to audit, than one with a hole in it.
    redacted[key] = keyIsForbidden(key) ? REDACTED : redactValue(item, scrub, depth + 1);
  }
  return redacted;
}

function redactValue(value: unknown, scrub: Scrubbers, depth: number): Json {
  if (depth > MAX_DEPTH) {
    // Deeper than any report this app builds: what it wraps has not been looked at.
    return REDACTED;
  }
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    // NaN and the infinities are not JSON, and JSON.stringify would silently make them null.
    return Number.isFinite(value) ? value : REDACTED;
  }
  if (typeof value === "string") {
    return redactText(value, scrub);
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_SEQUENCE_ITEMS).map((item) => redactValue(item, scrub, depth + 1));
  }
  if (isPlainObject(value)) {
    return redactMapping(value, scrub, depth);
  }
  // An Error, a Date, a Map, a function, a bigint, a class instance: each can render something
  // from the list above through its own string form. None of them are sent.
  return REDACTED;
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/** Whether a key's NAME says its value is one of the things that is never sent. */
export function keyIsForbidden(key: string): boolean {
  const lowered = key.toLowerCase();
  return FORBIDDEN_KEY_FRAGMENTS.some((fragment) => lowered.includes(fragment));
}

/** One string: credentials out, then paths reduced, then bounded. */
function redactText(text: string, scrub: Scrubbers): string {
  // Credentials first: one that happens to look like a path is removed as a credential.
  let scrubbed = scrub.credentials(text);
  for (const secret of scrub.secrets) {
    scrubbed = scrubbed.replaceAll(secret, REDACTED);
  }
  scrubbed = scrubbed
    .replace(FILE_URL, "")
    .replace(POSIX_PATH, (found) => packageRelative(found))
    .replace(WINDOWS_PATH, (found) => packageRelative(found));
  return scrubbed.length > MAX_TEXT_LENGTH ? `${scrubbed.slice(0, MAX_TEXT_LENGTH)}…` : scrubbed;
}

/**
 * An absolute path reduced to its part inside a package, or removed entirely: "a stack trace with
 * file paths redacted to package-relative form", failing closed.
 */
export function packageRelative(path: string): string {
  const normalised = path.replaceAll("\\", "/");
  for (const marker of PACKAGE_MARKERS) {
    const at = normalised.lastIndexOf(marker);
    const tail = at === -1 ? "" : normalised.slice(at + marker.length);
    if (tail !== "") {
      return tail;
    }
  }
  for (const marker of OWN_MARKERS) {
    const at = normalised.lastIndexOf(marker);
    const tail = at <= 0 ? "" : normalised.slice(at + marker.length);
    if (tail !== "") {
      return `innytypes/${tail}`;
    }
  }
  const library = PYTHON_LIB.exec(normalised);
  if (library !== null) {
    const tail = normalised.slice(library.index + library[0].length);
    if (tail !== "") {
      return tail;
    }
  }
  return REDACTED;
}
