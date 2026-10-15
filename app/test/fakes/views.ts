// AppApi's view members (WI-0018-10), the canvas's dirty flag and the quit question (WI-0018-12),
// for a test that never calls them.
import type { EditorPalette, ViewResult } from "../../src/ui/contract";
import { V2_UNUSED } from "./app-api-v2";

const never = <T>(): Promise<T> => Promise.reject(new Error("not used here"));

export const VIEWS_UNUSED = {
  submitView: (): Promise<ViewResult> => never(),
  // AppApi v2 (plan 0022 §N).
  ...V2_UNUSED,
  openView: (): Promise<void> => never(),
  editorPalette: (): Promise<EditorPalette | null> => never(),
  onQuitQuestion: (): void => undefined,
  answerQuit: (): Promise<void> => never(),
};
