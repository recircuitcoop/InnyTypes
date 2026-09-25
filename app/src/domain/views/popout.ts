// Pop-outs and the pages the shell serves (spec 8.5, plan 0018 §2.2; arch_pivot P10f, P11 §5.1).
//
// App pages are served by the SHELL on `inny-app://app/`, never by the runtime, so a runtime
// restart never blanks them. A view page is served on `inny-view://app/` (the generic renderer)
// or `inny-view://<package>/` (a package's own web component), in its own session partition,
// with the CSP below as a response header. Its only way out is the three-call bridge, which
// carries no ids: the shell binds each window to the one view or snapshot it was opened for.
//
// Pure: the constants, the value limits and the placement rules. Electron is the adapter's.

/** The scheme of the app pages, and the one host they are served on. */
export const APP_SCHEME = "inny-app";
export const APP_HOST = "app";
/** The scheme of view pages; host `app` is the generic renderer, any other host a package. */
export const VIEW_SCHEME = "inny-view";
export const VIEW_HOST = "app";
/** The session partition of every pop-out (spec 8.5.3). */
export const VIEW_PARTITION = "inny-views";

/** The pop-out CSP, exactly as spec 8.5.5 words it (proven in P10f). */
export const VIEW_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "connect-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'";

/** The app pages' CSP: the pop-out's, plus the editor's frame on the runtime's loopback port. */
export const APP_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "frame-src http://127.0.0.1:*; connect-src 'none'; form-action 'none'; " +
  "frame-ancestors 'none'; base-uri 'none'";

/** A pop-out's webPreferences, exactly as spec 8.5.4 lists them, with its bridge as preload. */
export function viewWebPreferences(preload: string) {
  return Object.freeze({
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    spellcheck: false,
    preload,
  } as const);
}

/** The IPC channels of the three-call bridge (spec 8.5.6): the preload and the shell share them. */
export const BRIDGE_CHANNELS = {
  get: "inny-view:get",
  submit: "inny-view:submit",
  action: "inny-view:action",
} as const;

/** What a pop-out was opened for; the bridge answers for this and nothing else. */
export interface PopoutTarget {
  readonly kind: "view" | "snapshot";
  readonly id: string;
}

export const popoutKey = (target: PopoutTarget): string => `${target.kind}:${target.id}`;

/** The most keys and the longest string that cross the bridge (spec 8.5.7). */
export const MAX_KEY_LENGTH = 64;
export const MAX_STRING_LENGTH = 2_000;

/**
 * Only a flat object crosses the bridge: string keys of at most 64 characters, and string
 * (truncated to 2,000 characters), finite number or boolean values. Everything else is dropped.
 */
export function sanitizeValues(values: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (typeof values !== "object" || values === null || Array.isArray(values)) {
    return out;
  }
  for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
    if (key.length > MAX_KEY_LENGTH) {
      continue;
    }
    if (typeof value === "string") {
      out[key] = value.slice(0, MAX_STRING_LENGTH);
    } else if (
      (typeof value === "number" && Number.isFinite(value)) ||
      typeof value === "boolean"
    ) {
      out[key] = value;
    }
  }
  return out;
}

/** Spec 2.1: a package name, which is also its view origin's host. */
const PACKAGE_NAME = /^[a-z][a-z0-9_]{1,39}$/;
/** A custom element's name: lower case, with a hyphen (HTML's valid custom element name). */
const ELEMENT_NAME = /^[a-z][a-z0-9]*-[a-z0-9-]*$/;

export const isPackageHost = (host: string): boolean =>
  host !== VIEW_HOST && PACKAGE_NAME.test(host);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The package whose own web component draws a view or snapshot, or null for the generic
 * renderer. Only the view's OWN package may draw it (`value.package`), and only when its
 * content names a valid custom element in `component.element`.
 */
export function componentPackageOf(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value["content"])) {
    return null;
  }
  const component = value["content"]["component"];
  const pkg = value["package"];
  if (!isRecord(component) || typeof component["element"] !== "string") {
    return null;
  }
  if (!ELEMENT_NAME.test(component["element"]) || typeof pkg !== "string") {
    return null;
  }
  return isPackageHost(pkg) ? pkg : null;
}

/** The page a pop-out loads: the generic renderer, or its package's own origin. */
export function viewPageUrl(componentPackage: string | null): string {
  return `${VIEW_SCHEME}://${componentPackage ?? VIEW_HOST}/view.html`;
}

// ── placement: remembered per view type ──────────────────────────────────────────────────

export interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A pop-out's size before any placement is remembered for its type. */
export const DEFAULT_SIZE = { width: 560, height: 640 } as const;

export function isBounds(value: unknown): value is Bounds {
  return (
    isRecord(value) &&
    ["x", "y", "width", "height"].every(
      (key) => typeof value[key] === "number" && Number.isInteger(value[key]),
    ) &&
    (value["width"] as number) > 0 &&
    (value["height"] as number) > 0
  );
}

/**
 * Whose placement a pop-out uses: its kind and its Node-RED type, so every view of one type
 * opens where the person last left one. Null when the type is not known (the runtime is down).
 */
export function placementKey(kind: PopoutTarget["kind"], value: unknown): string | null {
  if (!isRecord(value) || typeof value["type"] !== "string" || value["type"] === "") {
    return null;
  }
  return `${kind}:${value["type"]}`;
}

/** Placements read back from storage: every well-formed entry kept, anything else dropped. */
export function parsePlacements(text: string | null): Map<string, Bounds> {
  const placements = new Map<string, Bounds>();
  if (text === null) {
    return placements;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return placements;
  }
  if (!isRecord(parsed)) {
    return placements;
  }
  for (const [key, bounds] of Object.entries(parsed)) {
    if (isBounds(bounds)) {
      placements.set(key, bounds);
    }
  }
  return placements;
}

// ── the files the shell serves ───────────────────────────────────────────────────────────

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

/**
 * The flat file name a URL path asks for, and its content type; null for anything else (a
 * subfolder, `..`, an unknown extension). The shell serves nothing but these.
 */
export function servedFile(pathname: string): { name: string; type: string } | null {
  const match = /^\/([A-Za-z0-9][A-Za-z0-9_-]*)(\.[a-z]+)$/.exec(pathname);
  if (match === null) {
    return null;
  }
  const type = CONTENT_TYPES[match[2] as string];
  return type === undefined ? null : { name: `${match[1] as string}${match[2] as string}`, type };
}

/** Where a package's view page loads its component script: a marker in view.html. */
export const COMPONENT_MARKER = "<!-- inny:component -->";
export const COMPONENT_SCRIPT = '<script src="component.js"></script>';

/** An Anytype object link (a deep link the desktop app opens), and nothing else. */
const ANYTYPE_LINK = /^anytype:\/\/object\?objectId=[A-Za-z0-9._-]+&spaceId=[A-Za-z0-9._-]+$/;

export const isAnytypeLink = (url: string): boolean => ANYTYPE_LINK.test(url);
