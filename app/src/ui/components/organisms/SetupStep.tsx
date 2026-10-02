// Setup step (Penpot 04 Organisms › setup-step). One screen of the first-run walkthrough in a
// 560 centred column: "Step n of N" (caption), the title (page 26), the body (14), the step's
// form, then Back (Quiet) and Continue (Primary).
import type { MouseEventHandler, ReactNode } from "react";
import { Button } from "../atoms/Button";
import { cx, variantAttributes } from "../variant";

export interface SetupStepProps {
  /** "Step 4 of 7". */
  readonly progress: string;
  readonly title: string;
  /** The screen's text; a step's own form (Set up: Summarise) has none. */
  readonly body?: string;
  /** The step's form or choices. */
  readonly children?: ReactNode;
  /** Absent on the first screen, which has nothing to go back to. */
  readonly backLabel?: string;
  readonly continueLabel: string;
  readonly onBack?: MouseEventHandler<HTMLButtonElement>;
  readonly onContinue?: MouseEventHandler<HTMLButtonElement>;
  readonly className?: string;
}

export function SetupStep({
  progress,
  title,
  body,
  children,
  backLabel,
  continueLabel,
  onBack,
  onContinue,
  className,
}: SetupStepProps) {
  return (
    <section
      {...variantAttributes("setup-step")}
      aria-label={title}
      className={cx("mx-auto flex w-full max-w-[560px] flex-col gap-5", className)}
    >
      <div className="flex flex-col gap-2">
        <p className="text-caption text-secondary">{progress}</p>
        <h1 className="text-page leading-tight font-semibold text-primary">{title}</h1>
        {body === undefined ? null : <p className="text-body text-primary">{body}</p>}
      </div>
      {children === undefined ? null : <div className="flex flex-col gap-4">{children}</div>}
      <div className="flex items-center justify-end gap-2">
        {backLabel === undefined ? null : (
          <Button kind="quiet" {...(onBack === undefined ? {} : { onClick: onBack })}>
            {backLabel}
          </Button>
        )}
        <Button kind="primary" {...(onContinue === undefined ? {} : { onClick: onContinue })}>
          {continueLabel}
        </Button>
      </div>
    </section>
  );
}
