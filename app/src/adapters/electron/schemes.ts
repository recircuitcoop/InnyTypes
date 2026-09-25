// The shell's own schemes (plan 0018 §2.2, spec 8.5.3; arch_pivot P11 §5.1): app pages on
// `inny-app://app/`, view pages on `inny-view://app/` and a package's web component on
// `inny-view://<package>/`. Every page comes from the shell, never from the runtime, so a
// runtime restart can neither blank the app nor hang a pop-out half-loaded.
//
// Each response carries its CSP as a header. Only flat file names with a known extension are
// served (domain/views/popout `servedFile`), so no URL reaches outside the folders named here.

import * as fs from "node:fs";
import * as path from "node:path";

import {
  APP_CSP,
  APP_HOST,
  APP_SCHEME,
  COMPONENT_MARKER,
  COMPONENT_SCRIPT,
  isPackageHost,
  servedFile,
  VIEW_CSP,
  VIEW_HOST,
  VIEW_SCHEME,
} from "../../domain/views/popout";

/** Electron's `protocol` (before ready): the two schemes are standard and secure. */
export interface SchemeRegistrar {
  registerSchemesAsPrivileged(
    schemes: { scheme: string; privileges: { standard: boolean; secure: boolean } }[],
  ): void;
}

/** A session's `protocol`, as far as serving a scheme goes. */
export interface ProtocolHandler {
  handle(scheme: string, handler: (request: Request) => Response | Promise<Response>): void;
}

/** A session's `webRequest`, as far as cancelling requests goes. */
export interface RequestFilter {
  onBeforeRequest(
    listener: (details: { url: string }, callback: (response: { cancel: boolean }) => void) => void,
  ): void;
}

/** Call before `app` is ready: a scheme must be privileged before any session exists. */
export function registerSchemes(protocol: SchemeRegistrar): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true } },
    { scheme: VIEW_SCHEME, privileges: { standard: true, secure: true } },
  ]);
}

const notFound = (): Response => new Response("not found", { status: 404 });

function served(body: Buffer | string, type: string, csp: string): Response {
  return new Response(typeof body === "string" ? body : new Uint8Array(body), {
    headers: {
      "Content-Type": type,
      "Content-Security-Policy": csp,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** A file's bytes, or null when it is not there (or not a file). */
function readFile(file: string): Buffer | null {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

/** The app pages, from `pagesDir`, on `inny-app://app/` only. */
export function appPageResponse(url: string, pagesDir: string): Response {
  const parsed = new URL(url);
  const file = parsed.host === APP_HOST ? servedFile(parsed.pathname) : null;
  const body = file === null ? null : readFile(path.join(pagesDir, file.name));
  return file === null || body === null ? notFound() : served(body, file.type, APP_CSP);
}

export interface ViewFiles {
  /** The shell's generic view page: view.html and view.js. */
  readonly viewDir: string;
  /** A package's folder, or null when no installed package has this name. */
  readonly packageFolder: (name: string) => string | null;
}

/**
 * A view page. On `inny-view://app/`: the generic renderer. On `inny-view://<package>/`: the
 * same page, which also loads the package's `component.js`, and the package's own files from
 * its `view/` folder, all under the one CSP.
 */
export function viewPageResponse(url: string, files: ViewFiles): Response {
  const parsed = new URL(url);
  const file = servedFile(parsed.pathname);
  if (file === null) {
    return notFound();
  }
  const own = file.name === "view.html" || file.name === "view.js";
  if (parsed.host === VIEW_HOST) {
    const body = own ? readFile(path.join(files.viewDir, file.name)) : null;
    return body === null ? notFound() : served(body, file.type, VIEW_CSP);
  }
  const folder = isPackageHost(parsed.host) ? files.packageFolder(parsed.host) : null;
  if (folder === null) {
    return notFound();
  }
  if (!own) {
    const body = readFile(path.join(folder, "view", file.name));
    return body === null ? notFound() : served(body, file.type, VIEW_CSP);
  }
  const body = readFile(path.join(files.viewDir, file.name));
  if (body === null) {
    return notFound();
  }
  return file.name === "view.html"
    ? served(body.toString("utf8").replace(COMPONENT_MARKER, COMPONENT_SCRIPT), file.type, VIEW_CSP)
    : served(body, file.type, VIEW_CSP);
}

/** Serve the app pages on the default session. */
export function serveAppPages(protocol: ProtocolHandler, pagesDir: string): void {
  protocol.handle(APP_SCHEME, (request) => appPageResponse(request.url, pagesDir));
}

/**
 * Serve view pages on the pop-outs' own session, and cancel every request of that session
 * outside the view scheme (spec 8.5.3): a view page reaches no runtime, no file, no network.
 */
export function serveViewPages(
  protocol: ProtocolHandler,
  requests: RequestFilter,
  files: ViewFiles,
): void {
  protocol.handle(VIEW_SCHEME, (request) => viewPageResponse(request.url, files));
  requests.onBeforeRequest((details, callback) => {
    const allowed =
      details.url.startsWith(`${VIEW_SCHEME}://`) || details.url.startsWith("devtools://");
    callback({ cancel: !allowed });
  });
}
