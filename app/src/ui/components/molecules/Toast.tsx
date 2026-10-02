// Toast (Penpot 03 Molecules › toast). Kind: Done, Failed, Waiting, Info. 480 wide, panel fill,
// hairline, radius m: the state's icon (20), one line saying what happened, an optional action
// (Secondary) and an x to dismiss. Failed is announced at once (alert); the others politely
// (status). This draws one toast; the app's toaster places and times them.
import { Button } from "../atoms/Button";
import { Icon, type IconName } from "../atoms/Icon";
import { cx, variantAttributes } from "../variant";

export type ToastKind = "done" | "failed" | "waiting" | "info";

export interface ToastProps {
  readonly kind: ToastKind;
  readonly message: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
  /** The x's accessible name ("Dismiss"), from strings.ts. */
  readonly dismissLabel: string;
  readonly onDismiss?: () => void;
  readonly className?: string;
}

const LOOK: Record<ToastKind, { icon: IconName; colour: string }> = {
  done: { icon: "circle-check", colour: "text-done" },
  failed: { icon: "circle-x", colour: "text-failed" },
  waiting: { icon: "message-circle-question-mark", colour: "text-waiting" },
  info: { icon: "info", colour: "text-running" },
};

export function Toast({
  kind,
  message,
  actionLabel,
  onAction,
  dismissLabel,
  onDismiss,
  className,
}: ToastProps) {
  const look = LOOK[kind];
  return (
    <div
      {...variantAttributes("toast", { kind })}
      role={kind === "failed" ? "alert" : "status"}
      className={cx(
        "flex w-full max-w-[480px] items-center gap-3 rounded-m border border-surface-line bg-surface-panel py-3 pr-3 pl-4 shadow-raised",
        className,
      )}
    >
      <Icon name={look.icon} size={20} className={cx("shrink-0", look.colour)} />
      <p className="min-w-0 flex-1 text-body text-primary">{message}</p>
      {actionLabel === undefined ? null : (
        <Button kind="secondary" {...(onAction === undefined ? {} : { onClick: onAction })}>
          {actionLabel}
        </Button>
      )}
      <button
        type="button"
        aria-label={dismissLabel}
        onClick={onDismiss}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-s text-secondary hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-focus"
      >
        <Icon name="x" />
      </button>
    </div>
  );
}
