// Canvas frame (Penpot 04 Organisms › canvas-frame). State: Clean, Dirty. A 48-high top bar with
// the flow's name, "Unsaved changes" in secondary while Dirty, and Save and run (Primary, which
// presses Node-RED's Deploy); the Node-RED editor fills the rest. The frame is the caller's: the
// screen passes the iframe, the gallery a placeholder.
import type { MouseEventHandler, ReactNode } from "react";
import { Button } from "../atoms/Button";
import { cx, variantAttributes } from "../variant";

export type CanvasFrameState = "clean" | "dirty";

export interface CanvasFrameProps {
  readonly state: CanvasFrameState;
  readonly flowName: string;
  readonly unsavedLabel: string;
  readonly saveLabel: string;
  readonly onSave?: MouseEventHandler<HTMLButtonElement>;
  /** The Node-RED editor's frame. */
  readonly children: ReactNode;
  readonly className?: string;
}

export function CanvasFrame({
  state,
  flowName,
  unsavedLabel,
  saveLabel,
  onSave,
  children,
  className,
}: CanvasFrameProps) {
  return (
    <section
      {...variantAttributes("canvas-frame", { state })}
      aria-label={flowName}
      className={cx("flex h-full w-full flex-col bg-surface-canvas", className)}
    >
      <header className="flex h-[48px] shrink-0 items-center gap-3 border-b border-surface-line bg-surface-panel px-4">
        <h2 className="truncate text-body-large font-semibold text-primary">{flowName}</h2>
        {state === "dirty" ? (
          <span role="status" className="text-body text-secondary">
            {unsavedLabel}
          </span>
        ) : null}
        <Button
          kind="primary"
          className="ml-auto"
          {...(onSave === undefined ? {} : { onClick: onSave })}
        >
          {saveLabel}
        </Button>
      </header>
      <div className="flex min-h-0 flex-1">{children}</div>
    </section>
  );
}
