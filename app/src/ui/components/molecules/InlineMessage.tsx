// Inline message (Penpot 03 Molecules › inline-message). Kind: Warning, Failed, Done, Info. A
// line in the state's soft fill, radius s: the state's icon (16) and one sentence, body 14, that
// says what is wrong or right and what to do. Failed is announced at once (alert).
import type { ReactNode } from "react";
import { Icon, type IconName } from "../atoms/Icon";
import { cx, variantAttributes } from "../variant";

export type InlineMessageKind = "warning" | "failed" | "done" | "info";

export interface InlineMessageProps {
  readonly kind: InlineMessageKind;
  readonly children: ReactNode;
  readonly className?: string;
}

const LOOK: Record<InlineMessageKind, { icon: IconName; fill: string; colour: string }> = {
  warning: { icon: "triangle-alert", fill: "bg-waiting-soft", colour: "text-waiting" },
  failed: { icon: "circle-x", fill: "bg-failed-soft", colour: "text-failed" },
  done: { icon: "circle-check", fill: "bg-done-soft", colour: "text-done" },
  info: { icon: "info", fill: "bg-running-soft", colour: "text-running" },
};

export function InlineMessage({ kind, children, className }: InlineMessageProps) {
  const look = LOOK[kind];
  return (
    <div
      {...variantAttributes("inline-message", { kind })}
      role={kind === "failed" ? "alert" : "status"}
      className={cx("flex w-full items-center gap-2 rounded-s px-3 py-2", look.fill, className)}
    >
      <Icon name={look.icon} className={cx("shrink-0", look.colour)} />
      <p className="min-w-0 flex-1 text-body text-primary">{children}</p>
    </div>
  );
}
