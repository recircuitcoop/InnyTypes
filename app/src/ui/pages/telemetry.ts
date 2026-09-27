// The telemetry question and switch (WI-0018-22): asked once, on the first launch, with the privacy
// notice in front of the choice (D25), and changed at any time on the Settings page. Until it is
// answered nothing is sent, queued or identified, and closing the window without answering is not
// a no: the question stays, and is asked again on the next launch.
//
// Plain on purpose, like every page: the owner will redesign the UI.

import type { AppApi, TelemetryStatus } from "../contract";
import { attributeOf, escape } from "../view/render";
import type { Region, Section } from "./page";

/** The notice as paragraphs, escaped. */
function noticeHtml(notice: string): string {
  return notice
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => `<p>${escape(line)}</p>`)
    .join("");
}

/** The first-launch question: shown only while it is unanswered. */
export function questionHtml(status: TelemetryStatus): string {
  if (status.answer !== "unset") {
    return "";
  }
  return (
    `<p><strong data-testid="telemetry-question-text">${escape(status.question)}</strong></p>` +
    `<div data-testid="telemetry-notice">${noticeHtml(status.notice)}</div>` +
    '<button type="button" data-telemetry="on" data-testid="telemetry-yes">Yes, send reports</button> ' +
    '<button type="button" data-telemetry="off" data-testid="telemetry-no">No</button>'
  );
}

const WORDS: Readonly<Record<TelemetryStatus["answer"], string>> = {
  on: "on",
  off: "off",
  unset: "not answered yet",
};

/** The switch on the Settings page: where it stands, the button that moves it, and the notice. */
export function switchHtml(status: TelemetryStatus): string {
  const problem =
    status.problem === null
      ? ""
      : `<p role="alert" data-testid="settings-telemetry-problem">${escape(status.problem)}</p>`;
  const to = status.answer === "on" ? "off" : "on";
  return (
    `<p>Send usage and crash reports: <span data-testid="settings-telemetry-state">${WORDS[status.answer]}</span> ` +
    `<button type="button" data-telemetry="${to}" data-testid="settings-telemetry-toggle">Turn ${to}</button></p>` +
    `<p>Waiting to be sent: <span data-testid="settings-telemetry-queued">${String(status.queued)}</span></p>` +
    problem +
    `<details><summary>What is sent</summary><div data-testid="settings-telemetry-notice">${noticeHtml(status.notice)}</div></details>`
  );
}

export interface TelemetryDom {
  /** The question above every page, shown while it is unanswered. */
  readonly question: Section & Region & { hidden: HTMLElement["hidden"] };
  /** The switch on the Settings page. */
  readonly settings: Section & Region;
  readonly message: Region;
}

/** Mount the question and the switch; the returned function draws both again. */
export function mountTelemetry(dom: TelemetryDom, api: AppApi): () => Promise<void> {
  const draw = (status: TelemetryStatus): void => {
    dom.question.innerHTML = questionHtml(status);
    dom.question.hidden = status.answer !== "unset";
    dom.settings.innerHTML = switchHtml(status);
  };
  const attempt = async (call: () => Promise<TelemetryStatus>): Promise<void> => {
    try {
      draw(await call());
    } catch (error) {
      dom.message.innerHTML = escape(error instanceof Error ? error.message : String(error));
    }
  };
  const onClick = (event: { readonly target: unknown }): void => {
    const to = attributeOf(event.target, "data-telemetry");
    if (to === "on" || to === "off") {
      dom.message.innerHTML = "";
      void attempt(() => api.setTelemetry(to === "on"));
    }
  };
  dom.question.on("click", onClick);
  dom.settings.on("click", onClick);
  return () => attempt(() => api.telemetry());
}
