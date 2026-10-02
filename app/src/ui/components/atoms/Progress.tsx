// Progress (Penpot 02 Atoms › progress). Mode: Determinate, Indeterminate. A 4px bar, radius
// pill, the running colour on the sunken track. Behaviour and ARIA (progressbar, value text) are
// Ark UI's Progress.
import { Progress as ArkProgress } from "@ark-ui/react";
import { cx, variantAttributes } from "../variant";

export type ProgressMode = "determinate" | "indeterminate";

export interface ProgressProps {
  readonly mode: ProgressMode;
  /** 0–100; ignored when indeterminate. */
  readonly value?: number;
  /** What is progressing; read aloud, never shown (the step line says it). */
  readonly label: string;
  readonly className?: string;
}

export function Progress({ mode, value = 0, label, className }: ProgressProps) {
  return (
    <ArkProgress.Root
      {...variantAttributes("progress", { mode })}
      value={mode === "indeterminate" ? null : value}
      className={cx("w-full", className)}
    >
      <ArkProgress.Label className="sr-only">{label}</ArkProgress.Label>
      <ArkProgress.Track className="h-1 w-full overflow-hidden rounded-pill bg-surface-sunken">
        <ArkProgress.Range
          className={cx(
            "h-full rounded-pill bg-running transition-[width]",
            mode === "indeterminate" && "w-[30%] animate-pulse",
          )}
        />
      </ArkProgress.Track>
    </ArkProgress.Root>
  );
}
