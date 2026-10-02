// Setup (plan 0022 §H, Acceptance "resumes at the same step"): the step order with no recorder
// step, next and back, the starter choice, completion, and never showing again.
import { describe, expect, it } from "vitest";
import {
  back,
  canGoBack,
  chooseStarter,
  finish,
  FIRST_SETUP,
  formProgress,
  next,
  resume,
  SETUP_STEPS,
  setupForExistingInstall,
  shouldShowSetup,
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

/** Saves the state as settings would (JSON), then reads it back. */
const quitAndReopen = (state: SetupState): SetupState =>
  resume(JSON.parse(JSON.stringify(state)) as unknown);

describe("the steps", () => {
  it("runs Welcome, Reports, Connect Anytype, Packages, Starter flow, step forms, Ready; no recorder step", () => {
    expect(SETUP_STEPS).toEqual([
      "welcome",
      "reports",
      "connect-anytype",
      "choose-packages",
      "starter-flow",
      "node-forms",
      "ready",
    ]);
    const visited = [FIRST_SETUP.step];
    let state = FIRST_SETUP;
    for (let pressed = 0; pressed < 4; pressed += 1) {
      state = next(state);
      visited.push(state.step);
    }
    expect(visited).toEqual(SETUP_STEPS.slice(0, 5));
    // The starter step moves on only through its choice.
    expect(next(state)).toBe(state);
  });

  it("walks the starter flow's forms in order, then Ready, and back again", () => {
    let state = chooseStarter(forward(4), "install", 3);
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
    // The first form's Back returns to the choice.
    const firstForm = chooseStarter(forward(4), "install", 3);
    expect(back(firstForm).step).toBe("starter-flow");
  });

  it("goes straight to Ready when the starter flow has no form to fill in", () => {
    expect(chooseStarter(forward(4), "install").step).toBe("ready");
    expect(chooseStarter(forward(4), "install", -2).step).toBe("ready");
  });

  it("goes back one step at a time, and never before Welcome", () => {
    expect(canGoBack(FIRST_SETUP)).toBe(false);
    expect(back(FIRST_SETUP)).toBe(FIRST_SETUP);
    expect(back(forward(3)).step).toBe("connect-anytype");
    expect(canGoBack(forward(1))).toBe(true);
  });

  it("ignores a choice made on the wrong step", () => {
    expect(chooseStarter(FIRST_SETUP, "own")).toBe(FIRST_SETUP);
    expect(finish(FIRST_SETUP)).toBe(FIRST_SETUP);
  });
});

describe("completion", () => {
  it("completes with I'll build my own, and never shows again", () => {
    const done = chooseStarter(forward(4), "own");
    expect(done.completed).toBe(true);
    expect(shouldShowSetup(done)).toBe(false);
    expect(next(done)).toBe(done);
    expect(back(done)).toBe(done);
    expect(chooseStarter(done, "install", 2)).toBe(done);
    expect(finish(done)).toBe(done);
    expect(shouldShowSetup(quitAndReopen(done))).toBe(false);
  });

  it("completes on Ready's choice", () => {
    const ready = chooseStarter(forward(4), "install");
    expect(shouldShowSetup(ready)).toBe(true);
    const done = finish(ready);
    expect(done.completed).toBe(true);
    expect(shouldShowSetup(done)).toBe(false);
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
    for (let pressed = 0; pressed < 5; pressed += 1) {
      const state = forward(pressed);
      expect(quitAndReopen(state)).toEqual(state);
    }
    const secondForm = next(chooseStarter(forward(4), "install", 4));
    expect(quitAndReopen(secondForm)).toEqual(secondForm);
    expect(formProgress(quitAndReopen(secondForm))).toEqual({ step: 2, of: 4 });
    const ready = chooseStarter(forward(4), "install");
    expect(quitAndReopen(ready)).toEqual(ready);
  });

  it("starts afresh from what it cannot trust, but never undoes a completed setup", () => {
    expect(resume(undefined)).toEqual(FIRST_SETUP);
    expect(resume("welcome")).toEqual(FIRST_SETUP);
    expect(resume({ step: "recorder" })).toEqual(FIRST_SETUP);
    expect(resume({ step: "reports", formIndex: "x", formCount: -1 })).toEqual({
      ...FIRST_SETUP,
      step: "reports",
    });
    // A form index past the forms there are: back to the choice that installs the flow.
    expect(resume({ step: "node-forms", formIndex: 5, formCount: 2 }).step).toBe("starter-flow");
    expect(resume({ step: "nonsense", completed: true }).completed).toBe(true);
    expect(resume({ step: "reports", completed: true })).toEqual({
      ...FIRST_SETUP,
      step: "reports",
      completed: true,
    });
  });
});
