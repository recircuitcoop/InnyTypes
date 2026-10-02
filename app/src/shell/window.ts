// The app window (plan 0018 §2.2): one window, opened on the app pages, brought forward by a second
// launch or a dock click, and the one path every message to the page takes. Apart from main.ts so
// the composition root only constructs; main.ts hands in Electron's BrowserWindow.
import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron";
import type { Logger } from "../ports/logger";

export interface AppWindowDeps {
  readonly createWindow: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  /** The app pages' URL, never the runtime's, so a runtime restart never blanks them. */
  readonly url: string;
  readonly preload: string;
  /** The e2e gate's hidden windows: nothing steals focus. */
  readonly hidden: boolean;
  readonly logger: Logger;
}

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
      height: 640,
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
