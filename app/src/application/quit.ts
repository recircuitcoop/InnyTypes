// The one quit (plan 0018 §7, WI-0018-12).
//
// In Electron the editor's `beforeunload` guard SILENTLY cancelled a quit while it held
// undeployed edits: the flows stopped, the process stayed (arch_pivot §4 surprise 1). Here the
// person is asked first, before anything stops: Deploy and quit, Quit and discard, or Cancel.
// Whatever is chosen, a quit stops every child, and the runtime runs `RED.stop()` on its
// `stop`; the shell lets the unload through afterwards, so nothing can hold a decided quit.

import type { EditorWindow } from "../ports/editor";
import type { Logger } from "../ports/logger";

export type QuitChoice = "deploy" | "discard" | "cancel";

export const isQuitChoice = (value: unknown): value is QuitChoice =>
  value === "deploy" || value === "discard" || value === "cancel";

export interface QuitDeps {
  readonly editor: EditorWindow;
  /** Ask the person; `problem` says why the choice before did not work, or is null. */
  readonly ask: (problem: string | null) => Promise<QuitChoice>;
  /** Stop every child (the runtime runs `RED.stop()`), and resolve once all have. */
  readonly stopChildren: () => Promise<void>;
  /** Really quit, once the children have stopped. */
  readonly exit: () => void;
  readonly logger: Logger;
}

export type QuitOutcome = "quit" | "cancelled" | "busy";

export class QuitFlow {
  readonly #deps: QuitDeps;
  #phase: "idle" | "deciding" | "stopping" | "done" = "idle";

  constructor(deps: QuitDeps) {
    this.#deps = deps;
  }

  /** No quit is under way: none asked for, or the last one cancelled. */
  get idle(): boolean {
    return this.#phase === "idle";
  }

  /** The children have stopped: the app may now really quit. */
  get done(): boolean {
    return this.#phase === "done";
  }

  /**
   * A quit was asked for. With `ask`, undeployed edits are put to the person first; without it
   * (a signal: nobody may be there to answer), they are discarded, and the log says so. A quit
   * already under way answers "busy".
   */
  async request(options: { readonly ask: boolean }): Promise<QuitOutcome> {
    if (this.#phase !== "idle") {
      return "busy";
    }
    this.#phase = "deciding";
    const { editor, logger } = this.#deps;
    const palette = await editor.palette();
    if (palette?.dirty === true) {
      if (!options.ask) {
        logger.warn("quitting on a signal: the editor's undeployed edits are discarded");
      } else if (!(await this.#decide())) {
        this.#phase = "idle";
        logger.info("quit cancelled: the editor keeps its undeployed edits");
        return "cancelled";
      }
    }
    this.#phase = "stopping";
    logger.info("quitting: stopping the children");
    await this.#deps.stopChildren();
    this.#phase = "done";
    logger.info("quit complete");
    this.#deps.exit();
    return "quit";
  }

  /** Put the undeployed edits to the person until a choice holds; false for Cancel. */
  async #decide(): Promise<boolean> {
    const { editor, logger } = this.#deps;
    let problem: string | null = null;
    for (;;) {
      const choice = await this.#deps.ask(problem);
      if (choice === "cancel") {
        return false;
      }
      if (choice === "discard") {
        logger.warn("Quit and discard: the editor's undeployed edits are discarded");
        return true;
      }
      problem = await editor.deploy();
      if (problem === null) {
        logger.info("Deploy and quit: the editor's edits are deployed");
        return true;
      }
      logger.warn(`Deploy and quit: the deploy did not finish (${problem}); asking again`);
    }
  }
}
