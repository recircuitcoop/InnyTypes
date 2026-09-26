// The Anytype desktop app (plan 0018 §4.1 point 6; launcher.py:894 `_start_anytype`, 706, 986):
// started if it is not running, adopted if it is, and quit on Quit ONLY if InnyTypes started it.
//
// * Not installed is a documented degradation, never a failure to start: everything that does
//   not need Anytype still runs.
// * An adopted app was here before InnyTypes and must outlive it: no quit ever reaches it. Only a
//   start hands back a StartedApp, so there is nothing to quit an adopted one with.

import type { DesktopApps, StartedApp } from "../ports/desktop-apps";
import type { Logger } from "../ports/logger";

/** What the launch did about Anytype. */
export type AnytypeAppState = "started" | "adopted" | "missing" | "failed";

export interface AnytypeAppDeps {
  readonly apps: DesktopApps;
  /** Where the Anytype desktop app is installed; null when it is not (or must not be used). */
  readonly executable: string | null;
  readonly logger: Logger;
}

export class AnytypeApp {
  readonly #deps: AnytypeAppDeps;
  #state: AnytypeAppState | null = null;
  #started: StartedApp | null = null;
  #quitting = false;

  constructor(deps: AnytypeAppDeps) {
    this.#deps = deps;
  }

  /** What the launch did; null before `start` has answered. */
  get state(): AnytypeAppState | null {
    return this.#state;
  }

  /** Start Anytype, or adopt the one already running. Never throws. */
  async start(): Promise<AnytypeAppState> {
    const { apps, executable, logger } = this.#deps;
    if (executable === null) {
      logger.warn(
        "the Anytype desktop app was not found on this machine; InnyTypes starts without it " +
          "and everything that does not need it still runs",
      );
      return (this.#state = "missing");
    }
    try {
      const running = await apps.find(executable);
      if (this.#quitting) {
        // Quit while the process table was read: starting Anytype now would leave it behind.
        return (this.#state = "missing");
      }
      if (running !== null) {
        logger.info(
          `adopting the Anytype desktop app already running as process ${String(running.pid)}`,
        );
        return (this.#state = "adopted");
      }
      this.#started = apps.launch(executable);
      logger.info(`started the Anytype desktop app (process ${String(this.#started.pid)})`);
      return (this.#state = "started");
    } catch (error) {
      logger.error(`the Anytype desktop app could not be started: ${String(error)}`);
      return (this.#state = "failed");
    }
  }

  /** On Quit: quit Anytype when InnyTypes started it, and leave it running otherwise. */
  async quitIfOurs(): Promise<void> {
    this.#quitting = true;
    const started = this.#started;
    if (started === null) {
      if (this.#state === "adopted") {
        this.#deps.logger.info("leaving the Anytype desktop app running: InnyTypes adopted it");
      }
      return;
    }
    this.#started = null;
    this.#deps.logger.info(
      `quitting the Anytype desktop app InnyTypes started (process ${String(started.pid)})`,
    );
    try {
      await started.quit();
    } catch (error) {
      this.#deps.logger.error(`the Anytype desktop app did not quit: ${String(error)}`);
    }
  }
}
