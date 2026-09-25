// AppApi's view members (WI-0018-10) for a page test that never calls them.
import type { ViewResult } from "../../src/ui/contract";

const unused = (): Promise<ViewResult> => Promise.reject(new Error("not used here"));

export const VIEWS_UNUSED = {
  onViewPresented: (): void => undefined,
  onPendingViews: (): void => undefined,
  pendingViews: (): Promise<number | null> => Promise.reject(new Error("not used here")),
  view: unused,
  submitView: unused,
  snapshot: unused,
  pressAction: unused,
};
