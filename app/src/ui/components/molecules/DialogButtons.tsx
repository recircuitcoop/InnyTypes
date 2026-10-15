// Dialog buttons (Penpot 03 Molecules › dialog-buttons). Kind: Neutral, Destructive. Right-
// aligned, 8px gap: Cancel (Quiet), an optional second choice (Secondary), then the main action:
// Primary, or Destructive when it deletes. The safe action is the Primary one.
import { Button } from "../atoms/Button";
import { cx, variantAttributes } from "../variant";

export type DialogButtonsKind = "neutral" | "destructive";

export interface DialogButtonsProps {
  readonly kind: DialogButtonsKind;
  readonly primaryLabel: string;
  readonly cancelLabel: string;
  /** A second choice ("Quit without saving"); none when absent. */
  readonly secondaryLabel?: string;
  readonly onPrimary?: () => void;
  readonly onCancel?: () => void;
  readonly onSecondary?: () => void;
  /** The buttons' test ids: `<testId>-cancel`, `-secondary` and `-primary`. */
  readonly testId?: string;
  readonly className?: string;
}

export function DialogButtons({
  kind,
  primaryLabel,
  cancelLabel,
  secondaryLabel,
  onPrimary,
  onCancel,
  onSecondary,
  testId,
  className,
}: DialogButtonsProps) {
  return (
    <div
      {...variantAttributes("dialog-buttons", { kind })}
      className={cx("flex items-center justify-end gap-2", className)}
    >
      <Button
        kind="quiet"
        {...(testId === undefined ? {} : { "data-testid": `${testId}-cancel` })}
        {...(onCancel === undefined ? {} : { onClick: onCancel })}
      >
        {cancelLabel}
      </Button>
      {secondaryLabel === undefined ? null : (
        <Button
          kind="secondary"
          {...(testId === undefined ? {} : { "data-testid": `${testId}-secondary` })}
          {...(onSecondary === undefined ? {} : { onClick: onSecondary })}
        >
          {secondaryLabel}
        </Button>
      )}
      <Button
        kind={kind === "destructive" ? "destructive" : "primary"}
        {...(testId === undefined ? {} : { "data-testid": `${testId}-primary` })}
        {...(onPrimary === undefined ? {} : { onClick: onPrimary })}
      >
        {primaryLabel}
      </Button>
    </div>
  );
}
