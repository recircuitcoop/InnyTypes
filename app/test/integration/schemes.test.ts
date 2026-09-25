// adapters/electron/schemes.ts and adapters/fs/placement-store.ts against real folders: the
// app pages and view pages are served by the shell with their CSP as a header, a package's
// component only from its own view/ folder, nothing outside those folders, and the view
// session cancels every request outside its scheme. Placements survive a reopen.

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
import { APP_CSP, VIEW_CSP } from "../../src/domain/views/popout";

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
  fs.writeFileSync(
    path.join(viewDir, "view.html"),
    "<head><!-- inny:component --></head><script src=view.js></script>",
  );
  fs.writeFileSync(path.join(viewDir, "view.js"), "/* view */");
  fs.writeFileSync(path.join(kit, "view", "component.js"), "/* kit */");
  fs.writeFileSync(path.join(kit, "secret.txt"), "not served");
  files = { viewDir, packageFolder: (name) => (name === "kit" ? kit : null) };
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("the app pages (inny-app://app/)", () => {
  it("are served with the app CSP, and nothing else is", async () => {
    const page = appPageResponse("inny-app://app/index.html", pagesDir);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toBe(APP_CSP);
    expect(page.headers.get("content-type")).toMatch(/^text\/html/);
    expect(await page.text()).toBe("<p>app</p>");
    for (const url of [
      "inny-app://app/missing.html",
      "inny-app://other/index.html",
      "inny-app://app/..%2Fview%2Fview.js",
      "inny-app://app/sub/index.html",
    ]) {
      expect(appPageResponse(url, pagesDir).status, url).toBe(404);
    }
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
    serveAppPages(protocol, pagesDir);
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
