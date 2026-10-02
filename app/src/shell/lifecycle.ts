// The shell's life (plan 0018 §2.2): one instance, whose second launch brings the first one's
// window forward; closing the window is not quitting; every quit goes through the one QuitFlow,
// which asks about undeployed edits unless a signal asked for the quit (nobody may be at the
// window to answer). Apart from main.ts so the composition root only constructs.
import type { App } from "electron";
import type { QuitFlow } from "../application/quit";
import type { Logger } from "../ports/logger";

export interface LifecycleDeps {
  readonly app: Pick<App, "requestSingleInstanceLock" | "exit" | "on" | "isReady" | "quit">;
  /** Where SIGTERM and SIGINT arrive. */
  readonly signals: Pick<NodeJS.Process, "on">;
  readonly quitFlow: Pick<QuitFlow, "done" | "request">;
  readonly bringForward: () => void;
  /** A window is open now. */
  readonly windowOpen: () => boolean;
  /** The children are supervised: the start got that far. */
  readonly started: () => boolean;
  readonly start: () => Promise<void>;
  readonly logger: Logger;
}

/** Runs the shell, or exits at once when another instance already runs. */
export function runShell(deps: LifecycleDeps): void {
  const { app, quitFlow, bringForward, logger } = deps;
  if (!app.requestSingleInstanceLock()) {
    app.exit(0);
    return;
  }
  app.on("second-instance", bringForward);
  // macOS: a dock click with no window open. Closing the window is not quitting.
  app.on("activate", () => {
    if (!deps.windowOpen() && app.isReady() && deps.started()) {
      bringForward();
    }
  });
  app.on("window-all-closed", () => {
    // Closing is not quitting (helper/window.py:65-67): the children keep running.
  });
  let quitBySignal = false;
  app.on("before-quit", (event) => {
    if (quitFlow.done) {
      return;
    }
    event.preventDefault();
    void quitFlow.request({ ask: !quitBySignal });
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    deps.signals.on(signal, () => {
      quitBySignal = true;
      app.quit();
    });
  }
  deps.start().catch((error: unknown) => {
    logger.error(`the shell could not start: ${String(error)}`);
    app.exit(1);
  });
}
