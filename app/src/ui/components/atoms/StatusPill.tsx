// Status pill (Penpot 02 Atoms › status-pill). State: Running, Waiting, Done, Failed, Off.
// Caption 12 medium, radius pill, the state's soft fill and its text colour. The word is always
// present: colour is never the only signal.
import type { ReactNode } from "react";
import { cx, variantAttributes } from "../variant";

export type StatusPillState = "running" | "waiting" | "done" | "failed" | "off";

export interface StatusPillProps {
  readonly state: StatusPillState;
  /** The state in words, from strings.ts ("Running", "Waiting for you"). */
  readonly children: ReactNode;
  readonly className?: string;
}

const LOOK: Record<StatusPillState, string> = {
  running: "bg-running-soft text-running",
  waiting: "bg-waiting-soft text-waiting",
  done: "bg-done-soft text-done",
  failed: "bg-failed-soft text-failed",
  off: "bg-surface-sunken text-secondary",
};

export function StatusPill({ state, children, className }: StatusPillProps) {
  return (
    <span
      {...variantAttributes("status-pill", { state })}
      className={cx(
        "inline-flex h-[20px] shrink-0 items-center rounded-pill px-2 text-caption font-medium whitespace-nowrap",
        LOOK[state],
        className,
      )}
    >
      {children}
    </span>
  );
}
