// The app window (plan 0018 §2.2): one window, opened on the app pages, brought forward by a second
// launch or a dock click, and the one path every message to the page takes. Apart from main.ts so
// the composition root only constructs; main.ts hands in Electron's BrowserWindow.
import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron";
import { isAnytypeLink } from "../domain/views/popout";
import type { Logger } from "../ports/logger";

export interface AppWindowDeps {
  readonly createWindow: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  /** The app pages' URL, never the runtime's, so a runtime restart never blanks them. */
  readonly url: string;
  readonly preload: string;
  /** The e2e gate's hidden windows: nothing steals focus. */
  readonly hidden: boolean;
  readonly logger: Logger;
  /** Hand an anytype:// link to the desktop app (Run history's Open in Anytype). */
  readonly openExternal: (url: string) => void;
}

/**
 * The redesigned frame's band above the old pages (ui/pages/pages.css `#frame`), until
 * WI-0022-21's cutover: the window is taller by it, so the old pages keep their 640.
 */
export const FRAME_BAND_PX = 320;

export class AppWindow {
  readonly #deps: AppWindowDeps;
  #window: BrowserWindow | null = null;

  constructor(deps: AppWindowDeps) {
    this.#deps = deps;
  }

  /** The window, while one is open. */
  get current(): BrowserWindow | null {
    return this.#window;
  }

  open(): BrowserWindow {
    const { logger } = this.#deps;
    const window = this.#deps.createWindow({
      width: 960,
      height: 640 + FRAME_BAND_PX,
      title: "InnyTypes",
      show: !this.#deps.hidden,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        preload: this.#deps.preload,
      },
    });
    void window.loadURL(this.#deps.url);
    // The editor's beforeunload guard silently cancels a quit or a reload in Electron (arch_pivot
    // §4 surprise 1). Its edits were already put to the person (the quit question, the fallback's
    // prompt), so the unload always goes ahead, and the log says so.
    // The one way the app page points outside itself: an Anytype object, in Anytype.
    window.webContents.on("will-navigate", (event, url) => {
      if (isAnytypeLink(url)) {
        event.preventDefault();
        this.#deps.openExternal(url);
      }
    });
    window.webContents.on("will-prevent-unload", (event) => {
      logger.warn("the editor held undeployed changes as it unloaded; the unload goes ahead");
      event.preventDefault();
    });
    window.on("closed", () => {
      if (this.#window === window) {
        this.#window = null;
      }
    });
    this.#window = window;
    return window;
  }

  /** A second launch, or a click on the dock icon: show the one window, in front. */
  readonly bringForward = (): void => {
    const window = this.#window === null || this.#window.isDestroyed() ? this.open() : this.#window;
    if (window.isMinimized()) {
      window.restore();
    }
    window.show();
    window.focus();
  };

  /** Send to the app page, when it is open. */
  readonly toPage = (channel: string, ...args: unknown[]): void => {
    const window = this.#window;
    if (window !== null && !window.isDestroyed()) {
      window.webContents.send(channel, ...args);
    }
  };
}
