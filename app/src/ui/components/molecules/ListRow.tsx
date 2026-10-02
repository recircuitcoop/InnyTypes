// List row (Penpot 03 Molecules › list-row). Kind: Flow, Run, Package. State: Default, Hover.
// Actions: One, Two. 48 high, 16 side padding, a hairline divider below: the title (body 14
// medium) and its meta line (caption, secondary) at the left; the row's status and controls,
// then its actions, at the right. Two actions means a further action and the ⋯ menu after the
// first. A row is an <li>; the caller's list is the <ul>.
import type { ReactNode } from "react";
import { cx, variantAttributes } from "../variant";

export type ListRowKind = "flow" | "run" | "package";
export type ListRowState = "default" | "hover";

export interface ListRowProps {
  readonly kind: ListRowKind;
  readonly state?: ListRowState;
  readonly title: ReactNode;
  readonly meta?: ReactNode;
  /** Between the title and the actions: a Switch, a Status pill. */
  readonly status?: ReactNode;
  /** The first action (Edit, Install). */
  readonly primaryAction: ReactNode;
  /** The rest (Run history and the ⋯ menu); present makes Actions "Two". */
  readonly moreActions?: ReactNode;
  readonly className?: string;
}

export function ListRow({
  kind,
  state = "default",
  title,
  meta,
  status,
  primaryAction,
  moreActions,
  className,
}: ListRowProps) {
  const actions = moreActions === undefined ? "one" : "two";
  return (
    <li
      {...variantAttributes("list-row", { kind, state, actions })}
      className={cx(
        "flex h-[48px] w-full items-center gap-3 border-b border-surface-line px-4",
        state === "hover" ? "bg-surface-sunken" : "bg-surface-panel hover:bg-surface-sunken",
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-body leading-tight font-medium text-primary">{title}</span>
        {meta === undefined ? null : (
          <span className="truncate text-caption text-secondary">{meta}</span>
        )}
      </div>
      {status}
      {primaryAction}
      {moreActions}
    </li>
  );
}
