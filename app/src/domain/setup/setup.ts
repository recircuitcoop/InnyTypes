// Setup, the first-run walkthrough (plan 0022 §H, ux-writing "The first run (Setup)").
//
// The steps, in order: Welcome, Reports, Connect Anytype, Choose your packages, Start with a simple
// flow?, then — only after "Install the simple flow" — one form per step of the starter flow, and
// Ready. There is no recorder step.
//
// * The state is written at every step (`setup {step, completed}` in settings), so a quit resumes
//   at the same step: `resume` reads it back, and starts afresh only when it cannot trust it.
// * Setup completes when the closing choice is made: "I'll build my own" at the starter step, or
//   either button on Ready. Once completed it never shows again: every move on a completed setup
//   returns it unchanged, and `shouldShowSetup` is false.
// * A 0.2.1 user never sees Setup: `setupForExistingInstall` marks it completed when flows exist
//   or the reports question was already answered.

export type SetupStep =
  | "welcome"
  | "reports"
  | "connect-anytype"
  | "choose-packages"
  | "starter-flow"
  | "node-forms"
  | "ready";

export const SETUP_STEPS: readonly SetupStep[] = [
  "welcome",
  "reports",
  "connect-anytype",
  "choose-packages",
  "starter-flow",
  "node-forms",
  "ready",
];

export interface SetupState {
  readonly step: SetupStep;
  /** Which of the starter flow's step forms is shown, from 0; 0 outside node-forms. */
  readonly formIndex: number;
  /** How many step forms the installed starter flow has; 0 until it is installed. */
  readonly formCount: number;
  readonly completed: boolean;
}

/** Where a new installation starts. */
export const FIRST_SETUP: SetupState = {
  step: "welcome",
  formIndex: 0,
  formCount: 0,
  completed: false,
};

/** The steps that simply go on to the next one; the starter and Ready steps end in a choice. */
const LINEAR_NEXT: Partial<Record<SetupStep, SetupStep>> = {
  welcome: "reports",
  reports: "connect-anytype",
  "connect-anytype": "choose-packages",
  "choose-packages": "starter-flow",
};

/** Setup is shown until it completes, and never after. */
export function shouldShowSetup(state: SetupState): boolean {
  return !state.completed;
}

/**
 * Continue (or the step's own button that moves on: Get started, Send reports / Don't send,
 * Connect / Skip for now). The starter step moves on only through `chooseStarter`; Ready only
 * through `finish`.
 */
export function next(state: SetupState): SetupState {
  if (state.completed) {
    return state;
  }
  if (state.step === "node-forms") {
    const formIndex = state.formIndex + 1;
    return formIndex < state.formCount
      ? { ...state, formIndex }
      : { ...state, step: "ready", formIndex: 0 };
  }
  const following = LINEAR_NEXT[state.step];
  return following === undefined ? state : { ...state, step: following };
}

/** Back, where the step offers it: never on Welcome, and never on Ready (the flow is on). */
export function back(state: SetupState): SetupState {
  if (state.completed || state.step === "welcome" || state.step === "ready") {
    return state;
  }
  if (state.step === "node-forms") {
    return state.formIndex > 0
      ? { ...state, formIndex: state.formIndex - 1 }
      : { ...state, step: "starter-flow", formIndex: 0 };
  }
  const index = SETUP_STEPS.indexOf(state.step);
  return { ...state, step: SETUP_STEPS[index - 1] ?? state.step };
}

/** Whether Back is offered on this step. */
export function canGoBack(state: SetupState): boolean {
  return back(state) !== state;
}

/**
 * The starter step's choice. "install": the simple flow was installed with `formCount` step
 * forms to fill in, walked in wire order (straight to Ready when it has none). "own": Setup
 * completes and Configuration › Flows opens.
 */
export function chooseStarter(
  state: SetupState,
  choice: "install" | "own",
  formCount = 0,
): SetupState {
  if (state.completed || state.step !== "starter-flow") {
    return state;
  }
  if (choice === "own") {
    return { ...state, completed: true };
  }
  const forms = Math.max(0, Math.floor(formCount));
  return forms === 0
    ? { ...state, step: "ready", formIndex: 0, formCount: 0 }
    : { ...state, step: "node-forms", formIndex: 0, formCount: forms };
}

/** Ready's closing choice, "Try with a sample" or "Open Live": Setup completes. */
export function finish(state: SetupState): SetupState {
  if (state.completed || state.step !== "ready") {
    return state;
  }
  return { ...state, completed: true };
}

/**
 * The node forms' progress, "Step 3 of 7." once worded (ui/strings.ts, WI-0022-10): the form shown,
 * counted from 1, and how many there are; null on any other step.
 */
export function formProgress(
  state: SetupState,
): { readonly step: number; readonly of: number } | null {
  if (state.step !== "node-forms") {
    return null;
  }
  return { step: state.formIndex + 1, of: state.formCount };
}

function isStep(value: unknown): value is SetupStep {
  return SETUP_STEPS.some((step) => step === value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * The state saved in settings, read back so a quit resumes at the same step. Anything that is not
 * a consistent state starts Setup afresh, except a saved `completed: true`, which is kept on its
 * own: a damaged file never brings Setup back to someone who finished it.
 */
export function resume(saved: unknown): SetupState {
  if (typeof saved !== "object" || saved === null) {
    return FIRST_SETUP;
  }
  const record = saved as Record<string, unknown>;
  const { step, formIndex, formCount, completed } = record;
  if (completed === true) {
    return { ...FIRST_SETUP, step: isStep(step) ? step : "ready", completed: true };
  }
  if (!isStep(step)) {
    return FIRST_SETUP;
  }
  const index = isCount(formIndex) ? formIndex : 0;
  const count = isCount(formCount) ? formCount : 0;
  if (step === "node-forms" && index >= count) {
    // A form that no longer exists: back to the choice that installs the flow.
    return { ...FIRST_SETUP, step: "starter-flow" };
  }
  return {
    step,
    formIndex: step === "node-forms" ? index : 0,
    formCount: count,
    completed: false,
  };
}

/**
 * Setup for an installation that predates it (plan 0022 §H): a 0.2.1 user with flows, or who
 * already answered the reports question, never sees it.
 */
export function setupForExistingInstall(existing: {
  readonly flowsExist: boolean;
  readonly reportsAnswered: boolean;
}): SetupState {
  if (existing.flowsExist || existing.reportsAnswered) {
    return { ...FIRST_SETUP, step: "ready", completed: true };
  }
  return FIRST_SETUP;
}
