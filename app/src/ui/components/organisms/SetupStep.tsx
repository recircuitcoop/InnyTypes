// Setup step (Penpot 04 Organisms › setup-step). One screen of the first-run walkthrough in a
// 560 centred column: "Step n of N" (caption), the title (page 26), the body (14), the step's
// form, then Back (Quiet) and Continue (Primary). A step with choices of its own (Reports' Send
// reports · Don't send, Ready's three) passes them as `actions` in place of Back and Continue.
import type { MouseEventHandler, ReactNode } from "react";
import { Button } from "../atoms/Button";
import { cx, variantAttributes } from "../variant";

export interface SetupStepProps {
  /** "Step 4 of 7"; absent on a screen that is not one of a series (ux-writing). */
  readonly progress?: string;
  /** The title; a name in it may be drawn apart (italics), so `label` says it plainly. */
  readonly title: ReactNode;
  /** The title as read aloud; the title itself when it is text. */
  readonly label?: string;
  /** The screen's text; a step's own form (Set up: Summarise) has none. */
  readonly body?: ReactNode;
  /** The step's form or choices. */
  readonly children?: ReactNode;
  /** Absent on the first screen, which has nothing to go back to. */
  readonly backLabel?: string;
  readonly continueLabel?: string;
  /** Continue is offered but cannot be pressed yet (the folder is not chosen). */
  readonly continueDisabled?: boolean;
  readonly onBack?: MouseEventHandler<HTMLButtonElement>;
  readonly onContinue?: MouseEventHandler<HTMLButtonElement>;
  /** The step's own buttons, in place of Back and Continue. */
  readonly actions?: ReactNode;
  readonly className?: string;
}

export function SetupStep({
  progress,
  title,
  label,
  body,
  children,
  backLabel,
  continueLabel,
  continueDisabled = false,
  onBack,
  onContinue,
  actions,
  className,
}: SetupStepProps) {
  return (
    <section
      {...variantAttributes("setup-step")}
      aria-label={label ?? (typeof title === "string" ? title : undefined)}
      className={cx("mx-auto flex w-full max-w-[560px] flex-col gap-5", className)}
    >
      <div className="flex flex-col gap-2">
        {progress === undefined ? null : <p className="text-caption text-secondary">{progress}</p>}
        <h1
          data-testid="setup-step-title"
          className="text-page leading-tight font-semibold text-primary"
        >
          {title}
        </h1>
        {body === undefined ? null : <p className="text-body text-primary">{body}</p>}
      </div>
      {children === undefined ? null : <div className="flex flex-col gap-4">{children}</div>}
      <div className="flex items-center justify-end gap-2">
        {actions ?? (
          <>
            {backLabel === undefined ? null : (
              <Button
                kind="quiet"
                data-testid="setup-back"
                {...(onBack === undefined ? {} : { onClick: onBack })}
              >
                {backLabel}
              </Button>
            )}
            {continueLabel === undefined ? null : (
              <Button
                kind="primary"
                data-testid="setup-continue"
                state={continueDisabled ? "disabled" : "default"}
                {...(onContinue === undefined ? {} : { onClick: onContinue })}
              >
                {continueLabel}
              </Button>
            )}
          </>
        )}
      </div>
    </section>
  );
}
