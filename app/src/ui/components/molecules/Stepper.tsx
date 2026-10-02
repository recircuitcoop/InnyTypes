// Stepper (Penpot 03 Molecules › stepper). Position: Start, Middle, End. Where Setup is: the
// words ("Step 3 of 7", caption, secondary) over a row of 4px pills, the done and current ones
// in the accent, the current one 24 wide, the rest 8 wide in the line colour.
import { cx, variantAttributes } from "../variant";

export type StepperPosition = "start" | "middle" | "end";

export interface StepperProps {
  /** 1-based. */
  readonly current: number;
  readonly total: number;
  /** The words, from strings.ts ("Step 3 of 7"). */
  readonly label: string;
  readonly className?: string;
}

/** Start on the first step, End on the last, Middle between. */
export function stepperPosition(current: number, total: number): StepperPosition {
  if (current <= 1) {
    return "start";
  }
  return current >= total ? "end" : "middle";
}

export function Stepper({ current, total, label, className }: StepperProps) {
  const steps = Array.from({ length: total }, (_, index) => index + 1);
  return (
    <div
      {...variantAttributes("stepper", { position: stepperPosition(current, total) })}
      className={cx("flex flex-col gap-2", className)}
    >
      <p className="text-caption text-secondary">{label}</p>
      <div aria-hidden="true" className="flex items-center gap-1">
        {steps.map((step) => (
          <span
            key={step}
            className={cx(
              "h-1 rounded-pill",
              step === current ? "w-[24px]" : "w-[8px]",
              step <= current ? "bg-accent" : "bg-surface-line",
            )}
          />
        ))}
      </div>
    </div>
  );
}
