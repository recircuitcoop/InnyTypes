// Empty state (Penpot 04 Organisms › empty-state). Area: Flows, Live without a flow, Live with
// nothing running, Empty tab. One sentence (body 14, secondary) and, where ux-writing gives one,
// one Secondary button; centred, 48 above.
import type { MouseEventHandler } from "react";
import { Button } from "../atoms/Button";
import { cx, variantAttributes } from "../variant";

export type EmptyStateArea = "flows" | "live-no-flow" | "live-idle" | "empty-tab";

export interface EmptyStateProps {
  readonly area: EmptyStateArea;
  /** The one sentence, from ux-writing. */
  readonly message: string;
  /** The one button ("Go to Flows"), when the area has one. */
  readonly actionLabel?: string;
  readonly onAction?: MouseEventHandler<HTMLButtonElement>;
  readonly className?: string;
}

export function EmptyState({ area, message, actionLabel, onAction, className }: EmptyStateProps) {
  return (
    <div
      {...variantAttributes("empty-state", { area })}
      className={cx("flex w-full flex-col items-center gap-4 pt-7 text-center", className)}
    >
      <p className="max-w-[var(--inny-size-reading-width)] text-body text-secondary">{message}</p>
      {actionLabel === undefined ? null : (
        <Button kind="secondary" {...(onAction === undefined ? {} : { onClick: onAction })}>
          {actionLabel}
        </Button>
      )}
    </div>
  );
}
