// Question pop-out (Penpot 04 Organisms › question-popout). Form: Yes, No. A 440-wide window
// (size.popout-width): the title (20), the subtitle (caption, secondary), the fields, then
// Continue (Primary), Later (Secondary) and Skip this step (Quiet).
//
// Only the chrome is InnyTypes'. The title, the subtitle and every field are the view node's own
// `present.content` (design-system "The contract"), drawn by the caller and passed in as children:
// nothing here knows what a speaker, a supplier or an album is. Form No is a question without
// fields, answered by the buttons alone.
import type { MouseEventHandler, ReactNode } from "react";
import { Button } from "../atoms/Button";
import { cx, variantAttributes } from "../variant";

export interface QuestionPopoutProps {
  /** The question, from the node. */
  readonly title: string;
  /** The event it is about, from the node ("2026-09-27 client call · 48 min"). */
  readonly subtitle?: string;
  /** A caption naming the region the package draws (the design file's marker). */
  readonly contentNote?: string;
  /** The node's fields; none makes it Form No. */
  readonly children?: ReactNode;
  readonly continueLabel: string;
  readonly laterLabel: string;
  readonly skipLabel: string;
  readonly onContinue?: MouseEventHandler<HTMLButtonElement>;
  readonly onLater?: MouseEventHandler<HTMLButtonElement>;
  readonly onSkip?: MouseEventHandler<HTMLButtonElement>;
  readonly className?: string;
}

export function QuestionPopout({
  title,
  subtitle,
  contentNote,
  children,
  continueLabel,
  laterLabel,
  skipLabel,
  onContinue,
  onLater,
  onSkip,
  className,
}: QuestionPopoutProps) {
  const form = children !== undefined && children !== null && children !== false;
  return (
    <section
      {...variantAttributes("question-popout", { form })}
      aria-label={title}
      className={cx(
        "flex w-[var(--inny-size-popout-width)] max-w-full flex-col gap-5 rounded-l bg-surface-panel p-5 shadow-popout",
        className,
      )}
    >
      <header className="flex flex-col gap-1">
        <h2 className="text-title leading-tight font-semibold text-primary">{title}</h2>
        {subtitle === undefined ? null : <p className="text-caption text-secondary">{subtitle}</p>}
        {contentNote === undefined ? null : (
          <p className="text-caption text-secondary italic">{contentNote}</p>
        )}
      </header>
      {form ? <div className="flex flex-col gap-4">{children}</div> : null}
      <div className="flex items-center gap-2">
        <Button kind="primary" {...(onContinue === undefined ? {} : { onClick: onContinue })}>
          {continueLabel}
        </Button>
        <Button kind="secondary" {...(onLater === undefined ? {} : { onClick: onLater })}>
          {laterLabel}
        </Button>
        <Button
          kind="quiet"
          className="ml-auto"
          {...(onSkip === undefined ? {} : { onClick: onSkip })}
        >
          {skipLabel}
        </Button>
      </div>
    </section>
  );
}
