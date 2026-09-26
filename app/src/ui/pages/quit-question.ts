// The quit question (WI-0018-12): a quit found edits in the editor that are not deployed.
// The shell asks here before anything stops, and waits for one of three answers; the editor's
// own unload guard never gets to cancel the quit silently (arch_pivot §4 surprise 1).
//
// Plain on purpose: the owner will redesign the UI. Tests find everything by `data-testid`.

import type { AppApi, QuitChoice, QuitQuestion } from "../contract";
import { attributeOf, escape } from "../view/render";
import type { Region, Section } from "./page";

const CHOICES: readonly QuitChoice[] = ["deploy", "discard", "cancel"];

export function quitQuestionHtml(question: QuitQuestion): string {
  const problem =
    question.problem === null
      ? ""
      : `<p role="alert" data-testid="quit-problem">${escape(question.problem)}</p>`;
  return (
    '<p data-testid="quit-text">InnyTypes is quitting, and the editor has changes that are not deployed.</p>' +
    problem +
    '<button type="button" data-quit-choice="deploy" data-testid="quit-deploy">Deploy and quit</button> ' +
    '<button type="button" data-quit-choice="discard" data-testid="quit-discard">Quit and discard</button> ' +
    '<button type="button" data-quit-choice="cancel" data-testid="quit-cancel">Cancel</button>'
  );
}

export interface QuitQuestionDom {
  readonly section: Section;
  readonly box: Region & { hidden: HTMLElement["hidden"] };
}

export function mountQuitQuestion(dom: QuitQuestionDom, api: AppApi): void {
  api.onQuitQuestion((question) => {
    dom.box.innerHTML = quitQuestionHtml(question);
    dom.box.hidden = false;
  });
  dom.section.on("click", (event) => {
    const choice = attributeOf(event.target, "data-quit-choice");
    const chosen = CHOICES.find((known) => known === choice);
    if (chosen === undefined) {
      return;
    }
    dom.box.hidden = true;
    dom.box.innerHTML = "";
    void api.answerQuit(chosen);
  });
}
