// The quit question (WI-0018-12): undeployed edits are put to the person in the app window
// before a quit goes ahead. Apart from main.ts so the composition root stays under its 600 lines
// (plan 0018 §2.3).

import type { BrowserWindow, IpcMain } from "electron";
import { isQuitChoice, type QuitChoice } from "../application/quit";
import type { Logger } from "../ports/logger";
import type * as Contract from "../ui/contract";
import { IPC } from "./ipc";

export interface QuitQuestionDeps {
  /** The app window, when there is one. */
  readonly window: () => BrowserWindow | null;
  readonly toPage: (channel: string, ...args: unknown[]) => void;
  /** Show the window in front, so the person sees the question. */
  readonly bringForward: () => void;
  /** The e2e gate's hidden runs: the question is asked without stealing focus. */
  readonly hidden: boolean;
  readonly logger: Logger;
}

export interface QuitQuestion {
  /** Ask in the app window; a window that is closed has no edits left to ask about. */
  ask(problem: string | null): Promise<QuitChoice>;
  /** The person's answer, from the page. */
  answer(choice: QuitChoice): void;
}

export function quitQuestion(deps: QuitQuestionDeps): QuitQuestion {
  /** The quit question waiting for the person's answer. */
  let answerQuit: ((choice: QuitChoice) => void) | null = null;
  return {
    ask: (problem) => {
      const window = deps.window();
      if (window === null || window.isDestroyed()) {
        return Promise.resolve("discard");
      }
      return new Promise((resolve) => {
        const closed = (): void => {
          answerQuit = null;
          resolve("discard");
        };
        window.once("closed", closed);
        answerQuit = (choice) => {
          window.off("closed", closed);
          answerQuit = null;
          deps.logger.info(`the quit question was answered: ${choice}`);
          resolve(choice);
        };
        deps.toPage(IPC.quitQuestion, { problem } satisfies Contract.QuitQuestion);
        if (!deps.hidden) {
          deps.bringForward();
        }
      });
    },
    answer: (choice) => {
      answerQuit?.(choice);
    },
  };
}

/** Quit in the window (F1: turning InnyTypes off is never hidden), and the person's answer. */
export function wireQuit(
  ipc: Pick<IpcMain, "handle">,
  question: QuitQuestion,
  app: { quit(): void },
  logger: Logger,
): void {
  ipc.handle(IPC.quit, () => {
    logger.info("Quit InnyTypes was pressed in the window");
    app.quit();
  });
  ipc.handle(IPC.quitAnswer, (_event, choice: unknown) => {
    if (isQuitChoice(choice)) {
      question.answer(choice);
    }
  });
}
