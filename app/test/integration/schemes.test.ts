// adapters/electron/schemes.ts and adapters/fs/placement-store.ts against real folders: the
// app pages and view pages are served by the shell with their CSP as a header, a package's
// component only from its own view/ folder, nothing outside those folders, and the view
// session cancels every request outside its scheme. Placements survive a reopen.

import { createHash } from "node:crypto";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appPageResponse,
  registerSchemes,
  serveAppPages,
  serveViewPages,
  viewPageResponse,
  type ViewFiles,
} from "../../src/adapters/electron/schemes";
import { JsonPlacementStore } from "../../src/adapters/fs/placement-store";
import { APP_CSP, VIEW_CSP, viewPageUrl } from "../../src/domain/views/popout";
import { contentHtml } from "../../src/ui/view/render";

/** The pop-out CSP's sha256, recorded when the pop-out page first loaded the tokens (WI-0022-13). */
const VIEW_CSP_SHA256 = "4fcc0d93707269393d4d4955133e6400b0be8e09cd9976359d6f9f6fbd8ece58";

let scratch: string;
let files: ViewFiles;
let pagesDir: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "inny-schemes-"));
  pagesDir = path.join(scratch, "pages");
  const viewDir = path.join(scratch, "view");
  const kit = path.join(scratch, "packages", "kit");
  for (const dir of [pagesDir, viewDir, path.join(kit, "view")]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(pagesDir, "index.html"), "<p>app</p>");
  fs.writeFileSync(path.join(pagesDir, "x.mp3"), "not served");
  fs.writeFileSync(
    path.join(viewDir, "view.html"),
    "<head><!-- inny:component --></head><script src=view.js></script>",
  );
  fs.writeFileSync(path.join(viewDir, "view.js"), "/* view */");
  fs.writeFileSync(path.join(kit, "view", "component.js"), "/* kit */");
  fs.writeFileSync(path.join(kit, "secret.txt"), "not served");
  const stylesDir = path.join(scratch, "styles");
  fs.mkdirSync(stylesDir);
  fs.writeFileSync(path.join(stylesDir, "tokens.css"), ":root { --inny-x: 1px; }");
  fs.writeFileSync(path.join(stylesDir, "app.css"), ".p-4 { padding: var(--inny-space-4); }");
  files = {
    viewDir,
    styles: {
      "tokens.css": path.join(stylesDir, "tokens.css"),
      "app.css": path.join(stylesDir, "app.css"),
    },
    packageFolder: (name) => (name === "kit" ? kit : null),
  };
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("the app pages (inny-app://app/)", () => {
  it("are served with the app CSP, and nothing else is", async () => {
    const page = appPageResponse("inny-app://app/index.html", [pagesDir]);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toBe(APP_CSP);
    expect(page.headers.get("content-type")).toMatch(/^text\/html/);
    expect(await page.text()).toBe("<p>app</p>");
    for (const url of [
      "inny-app://app/missing.html",
      "inny-app://other/index.html",
      "inny-app://app/..%2Fview%2Fview.js",
      "inny-app://app/sub/index.html",
      // The app pages serve no audio, even a sample sitting in their folder.
      "inny-app://app/x.mp3",
    ]) {
      expect(appPageResponse(url, [pagesDir]).status, url).toBe(404);
    }
  });
});

describe("the app pages from two folders (WI-0022-11)", () => {
  it("each file comes from the first folder that holds it", async () => {
    const uiDir = path.join(scratch, "ui");
    fs.mkdirSync(uiDir);
    fs.writeFileSync(path.join(uiDir, "app.css"), "/* new */");
    fs.writeFileSync(path.join(uiDir, "main.js"), "/* frame */");
    fs.writeFileSync(path.join(pagesDir, "app.css"), "/* old */");
    const dirs = [uiDir, pagesDir];
    expect(await appPageResponse("inny-app://app/app.css", dirs).text()).toBe("/* new */");
    expect(await appPageResponse("inny-app://app/main.js", dirs).text()).toBe("/* frame */");
    const page = appPageResponse("inny-app://app/index.html", dirs);
    expect(page.headers.get("content-security-policy")).toBe(APP_CSP);
    expect(await page.text()).toBe("<p>app</p>");
    expect(appPageResponse("inny-app://app/missing.js", dirs).status).toBe(404);
    expect(appPageResponse("inny-app://app/pages/app.js", dirs).status).toBe(404);
  });
});

describe("the view pages (inny-view://)", () => {
  it("the generic page on inny-view://app/, with the pop-out CSP", async () => {
    const page = viewPageResponse("inny-view://app/view.html", files);
    expect(page.headers.get("content-security-policy")).toBe(VIEW_CSP);
    expect(await page.text()).not.toContain("component.js");
    expect(viewPageResponse("inny-view://app/view.js", files).status).toBe(200);
    expect(viewPageResponse("inny-view://app/component.js", files).status).toBe(404);
    expect(viewPageResponse("inny-view://app/other.js", files).status).toBe(404);
    expect(viewPageResponse("inny-view://app/../x", files).status).toBe(404);
  });

  it("a package's origin: the same page loading its component, and its own view/ files only", async () => {
    const page = viewPageResponse("inny-view://kit/view.html", files);
    expect(page.headers.get("content-security-policy")).toBe(VIEW_CSP);
    expect(await page.text()).toContain('<script src="component.js"></script>');
    const component = viewPageResponse("inny-view://kit/component.js", files);
    expect(component.headers.get("content-security-policy")).toBe(VIEW_CSP);
    expect(await component.text()).toBe("/* kit */");
    expect(await viewPageResponse("inny-view://kit/view.js", files).text()).toBe("/* view */");
    expect(viewPageResponse("inny-view://kit/secret.txt", files).status).toBe(404);
    expect(viewPageResponse("inny-view://kit/missing.js", files).status).toBe(404);
    expect(viewPageResponse("inny-view://nobody/view.html", files).status).toBe(404);
    expect(viewPageResponse("inny-view://bad-name/view.html", files).status).toBe(404);
  });

  it("a package's own sample: the Listen button's source resolves to a file the scheme serves, under media-src 'self'", async () => {
    const handlers = new Map<string, (request: Request) => Response | Promise<Response>>();
    serveViewPages(
      { handle: (scheme, handler) => handlers.set(scheme, handler) },
      { onBeforeRequest: () => undefined },
      files,
    );
    const handler = handlers.get("inny-view");
    const page = viewPageUrl("kit");
    const pageResponse = await handler?.(new Request(page));
    // The pop-out page lets media come from its own origin, the package's origin.
    expect(pageResponse?.headers.get("content-security-policy")).toContain(
      "media-src 'self' data:",
    );

    for (const [name, type] of [
      ["sample.mp3", "audio/mpeg"],
      ["sample.ogg", "audio/ogg"],
      ["sample.wav", "audio/wav"],
    ] as const) {
      const bytes = Buffer.from(`bytes of ${name}`);
      fs.writeFileSync(path.join(scratch, "packages", "kit", "view", name), bytes);
      const html = contentHtml({ media: { kind: "audio", src: name } }, true);
      expect(html, name).toContain('data-testid="view-listen"');
      const src = /<audio[^>]* src="([^"]+)"/.exec(html)?.[1] ?? "";
      // The page resolves the relative source against itself: the same scheme and host.
      const resolved = new URL(src, page);
      expect(resolved.href).toBe(`inny-view://kit/${name}`);
      expect(`${resolved.protocol}//${resolved.host}`).toBe("inny-view://kit");
      const sample = await handler?.(new Request(resolved.href));
      expect(sample?.status, name).toBe(200);
      expect(sample?.headers.get("content-type"), name).toBe(type);
      expect(Buffer.from(await (sample as Response).arrayBuffer()).equals(bytes), name).toBe(true);
    }
    // A sample only ever comes from the package's view/ folder.
    fs.writeFileSync(path.join(scratch, "packages", "kit", "loose.mp3"), "outside view/");
    expect((await handler?.(new Request("inny-view://kit/loose.mp3")))?.status).toBe(404);
  });

  it("tokens served, CSP unchanged: tokens.css and app.css beside view.js, on every view origin, never a package's own", async () => {
    // The CSP's bytes, exactly as spec 8.5.5 words them: the pop-out's styles changed nothing.
    expect(VIEW_CSP).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
        "media-src 'self' data:; connect-src 'none'; form-action 'none'; frame-ancestors 'none'; " +
        "base-uri 'none'",
    );
    expect(createHash("sha256").update(VIEW_CSP).digest("hex")).toBe(VIEW_CSP_SHA256);
    // A package may not shadow the shell's tokens with a file of its own.
    fs.writeFileSync(path.join(scratch, "packages", "kit", "view", "tokens.css"), "/* forged */");
    for (const host of ["app", "kit"]) {
      for (const [name, body] of [
        ["tokens.css", ":root { --inny-x: 1px; }"],
        ["app.css", ".p-4 { padding: var(--inny-space-4); }"],
      ] as const) {
        const response = viewPageResponse(`inny-view://${host}/${name}`, files);
        expect(response.status, `${host} ${name}`).toBe(200);
        expect(response.headers.get("content-security-policy")).toBe(VIEW_CSP);
        expect(response.headers.get("content-type")).toMatch(/^text\/css/);
        expect(await response.text()).toBe(body);
      }
    }
    expect(viewPageResponse("inny-view://nobody/tokens.css", files).status).toBe(404);
    const unbuilt = { ...files, styles: { "tokens.css": path.join(scratch, "absent.css") } };
    expect(viewPageResponse("inny-view://app/tokens.css", unbuilt).status).toBe(404);
    expect(viewPageResponse("inny-view://app/app.css", unbuilt).status).toBe(404);
  });

  it("a missing shell page is a 404, never a crash", () => {
    const empty = { ...files, viewDir: path.join(scratch, "absent") };
    expect(viewPageResponse("inny-view://app/view.html", empty).status).toBe(404);
    expect(viewPageResponse("inny-view://kit/view.html", empty).status).toBe(404);
  });
});

describe("registration", () => {
  it("both schemes are standard and secure; the handlers are installed; the filter cancels the rest", async () => {
    const registered: unknown[] = [];
    registerSchemes({ registerSchemesAsPrivileged: (schemes) => registered.push(...schemes) });
    expect(registered).toEqual([
      { scheme: "inny-app", privileges: { standard: true, secure: true } },
      { scheme: "inny-view", privileges: { standard: true, secure: true } },
    ]);

    const handlers = new Map<string, (request: Request) => Response | Promise<Response>>();
    const protocol = {
      handle: (scheme: string, handler: (r: Request) => Response | Promise<Response>) =>
        handlers.set(scheme, handler),
    };
    let filter:
      ((details: { url: string }, callback: (r: { cancel: boolean }) => void) => void) | null =
      null;
    serveAppPages(protocol, [pagesDir]);
    serveViewPages(protocol, { onBeforeRequest: (listener) => (filter = listener) }, files);
    const app = await handlers.get("inny-app")?.(new Request("inny-app://app/index.html"));
    expect(app?.status).toBe(200);
    const view = await handlers.get("inny-view")?.(new Request("inny-view://app/view.js"));
    expect(view?.status).toBe(200);

    const cancelled = (url: string): boolean => {
      let answer = false;
      filter?.({ url }, (response) => {
        answer = response.cancel;
      });
      return answer;
    };
    expect(cancelled("inny-view://app/view.js")).toBe(false);
    expect(cancelled("devtools://devtools/bundled/inspector.html")).toBe(false);
    expect(cancelled("http://127.0.0.1:18800/red/settings")).toBe(true);
    expect(cancelled("file:///etc/hosts")).toBe(true);
    expect(cancelled("inny-app://app/index.html")).toBe(true);
  });
});

describe("JsonPlacementStore", () => {
  it("keeps placements across a reopen; a missing or broken file is an empty store", () => {
    const file = path.join(scratch, "data", "popout-placements.json");
    const store = new JsonPlacementStore(file);
    expect(store.get("view:t")).toBeNull();
    store.set("view:t", { x: 1, y: 2, width: 300, height: 400 });
    expect(new JsonPlacementStore(file).get("view:t")).toEqual({
      x: 1,
      y: 2,
      width: 300,
      height: 400,
    });
    fs.writeFileSync(file, "{broken");
    expect(new JsonPlacementStore(file).get("view:t")).toBeNull();
  });
});
