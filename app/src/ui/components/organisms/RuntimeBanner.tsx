// Runtime banner (Penpot 04 Organisms › runtime-banner). State: Restarting, Down. Full width
// under the top bar, 48 high: the waiting-soft fill while InnyTypes restarts itself, the
// failed-soft fill once it gave up, with Restart as the Primary button. It belongs to no surface;
// any page shows it.
import type { MouseEventHandler } from "react";
import { Button } from "../atoms/Button";
import { Icon } from "../atoms/Icon";
import { cx, variantAttributes } from "../variant";

export type RuntimeBannerState = "restarting" | "down";

export interface RuntimeBannerProps {
  readonly state: RuntimeBannerState;
  /** The sentence, from ux-writing. */
  readonly message: string;
  /** Restart's label; the button is shown when Down. */
  readonly restartLabel?: string;
  readonly onRestart?: MouseEventHandler<HTMLButtonElement>;
  readonly className?: string;
}

export function RuntimeBanner({
  state,
  message,
  restartLabel,
  onRestart,
  className,
}: RuntimeBannerProps) {
  const down = state === "down";
  return (
    <div
      {...variantAttributes("runtime-banner", { state })}
      role={down ? "alert" : "status"}
      className={cx(
        "flex h-[48px] w-full items-center gap-3 px-5 text-body text-primary",
        down ? "bg-failed-soft" : "bg-waiting-soft",
        className,
      )}
    >
      <Icon
        name={down ? "circle-x" : "loader-circle"}
        className={cx("shrink-0", down ? "text-failed" : "animate-spin text-waiting")}
      />
      <p className="flex-1 truncate">{message}</p>
      {down && restartLabel !== undefined ? (
        <Button kind="primary" {...(onRestart === undefined ? {} : { onClick: onRestart })}>
          {restartLabel}
        </Button>
      ) : null}
    </div>
  );
}
