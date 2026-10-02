// Setup (plan 0022 §H, Acceptance "resumes at the same step", owner decisions 1 and 8): Welcome,
// Reports, Connect Anytype, Source folder, the starter's step forms, Ready; no packages step, no
// starter choice, no recorder step. Next and back, completion, and never showing again.
import { describe, expect, it } from "vitest";
import {
  back,
  canGoBack,
  finish,
  FIRST_SETUP,
  formProgress,
  next,
  resume,
  SETUP_STEPS,
  setupForExistingInstall,
  shouldShowSetup,
  withStarterForms,
  type SetupState,
} from "../../../src/domain/setup/setup";

/** Presses Continue `times` times from the first step. */
function forward(times: number, from: SetupState = FIRST_SETUP): SetupState {
  let state = from;
  for (let pressed = 0; pressed < times; pressed += 1) {
    state = next(state);
  }
  return state;
}

/** At Source folder, with the starter flow installed with `forms` step forms. */
const atFolder = (forms: number) => withStarterForms(forward(3), forms);

/** Saves the state as settings would (JSON), then reads it back. */
const quitAndReopen = (state: SetupState): SetupState =>
  resume(JSON.parse(JSON.stringify(state)) as unknown);

describe("the steps", () => {
  it("runs Welcome, Reports, Connect Anytype, Source folder, step forms, Ready; nothing else", () => {
    expect(SETUP_STEPS).toEqual([
      "welcome",
      "reports",
      "connect-anytype",
      "source-folder",
      "node-forms",
      "ready",
    ]);
    const visited = [FIRST_SETUP.step];
    let state = FIRST_SETUP;
    for (let pressed = 0; pressed < 3; pressed += 1) {
      state = next(state);
      visited.push(state.step);
    }
    expect(visited).toEqual(SETUP_STEPS.slice(0, 4));
  });

  it("walks the starter flow's forms in order after Source folder, then Ready, and back again", () => {
    let state = next(atFolder(3));
    expect([state.step, state.formIndex, state.formCount]).toEqual(["node-forms", 0, 3]);
    expect(formProgress(state)).toEqual({ step: 1, of: 3 });
    state = next(next(state));
    expect(formProgress(state)).toEqual({ step: 3, of: 3 });
    expect(back(state).formIndex).toBe(1);
    state = next(state);
    expect(state.step).toBe("ready");
    expect(formProgress(state)).toBeNull();
    // Ready offers no Back: the flow is already on.
    expect(canGoBack(state)).toBe(false);
    // The first form's Back returns to Source folder.
    expect(back(next(atFolder(3))).step).toBe("source-folder");
  });

  it("goes from Source folder straight to Ready when the starter flow has no form", () => {
    expect(next(atFolder(0)).step).toBe("ready");
    expect(next(atFolder(-2)).step).toBe("ready");
    expect(atFolder(2.7).formCount).toBe(2);
    // Not a finite count: none, so Source folder goes straight to Ready, never to a form forever.
    for (const count of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(atFolder(count).formCount).toBe(0);
      expect(next(atFolder(count)).step).toBe("ready");
    }
  });

  it("goes back one step at a time, and never before Welcome", () => {
    expect(canGoBack(FIRST_SETUP)).toBe(false);
    expect(back(FIRST_SETUP)).toBe(FIRST_SETUP);
    expect(back(forward(3)).step).toBe("connect-anytype");
    expect(canGoBack(forward(1))).toBe(true);
  });

  it("ignores Ready's choice before Ready, and the starter's forms once on Ready", () => {
    expect(finish(FIRST_SETUP)).toBe(FIRST_SETUP);
    const ready = next(atFolder(0));
    expect(withStarterForms(ready, 4)).toBe(ready);
  });
});

describe("completion", () => {
  it("completes on Ready's choice (I'll build my own among them), and never shows again", () => {
    const ready = next(atFolder(0));
    expect(shouldShowSetup(ready)).toBe(true);
    const done = finish(ready);
    expect(done.completed).toBe(true);
    expect(shouldShowSetup(done)).toBe(false);
    expect(next(done)).toBe(done);
    expect(back(done)).toBe(done);
    expect(withStarterForms(done, 2)).toBe(done);
    expect(finish(done)).toBe(done);
    expect(shouldShowSetup(quitAndReopen(done))).toBe(false);
  });

  it("is never shown to a 0.2.1 user with flows or an answered reports question", () => {
    const existing = { flowsExist: false, reportsAnswered: false };
    expect(shouldShowSetup(setupForExistingInstall({ ...existing, flowsExist: true }))).toBe(false);
    expect(shouldShowSetup(setupForExistingInstall({ ...existing, reportsAnswered: true }))).toBe(
      false,
    );
    expect(setupForExistingInstall(existing)).toEqual(FIRST_SETUP);
  });
});

describe("resumes at the same step", () => {
  it("comes back at every step it was quit on, forms included", () => {
    for (let pressed = 0; pressed < 4; pressed += 1) {
      const state = forward(pressed);
      expect(quitAndReopen(state)).toEqual(state);
    }
    const secondForm = next(next(atFolder(4)));
    expect(quitAndReopen(secondForm)).toEqual(secondForm);
    expect(formProgress(quitAndReopen(secondForm))).toEqual({ step: 2, of: 4 });
    const ready = next(atFolder(0));
    expect(quitAndReopen(ready)).toEqual(ready);
  });

  it("starts afresh from what it cannot trust, but never undoes a completed setup", () => {
    expect(resume(undefined)).toEqual(FIRST_SETUP);
    expect(resume("welcome")).toEqual(FIRST_SETUP);
    expect(resume({ step: "recorder" })).toEqual(FIRST_SETUP);
    // The removed steps (owner decisions 1 and 8) are not steps any more.
    expect(resume({ step: "choose-packages" })).toEqual(FIRST_SETUP);
    expect(resume({ step: "starter-flow" })).toEqual(FIRST_SETUP);
    expect(resume({ step: "reports", formIndex: "x", formCount: -1 })).toEqual({
      ...FIRST_SETUP,
      step: "reports",
    });
    // A form index past the forms there are: back to the step before the forms.
    expect(resume({ step: "node-forms", formIndex: 5, formCount: 2 })).toEqual({
      ...FIRST_SETUP,
      step: "source-folder",
      formCount: 2,
    });
    expect(resume({ step: "nonsense", completed: true }).completed).toBe(true);
    expect(resume({ step: "reports", completed: true })).toEqual({
      ...FIRST_SETUP,
      step: "reports",
      completed: true,
    });
  });
});
