// Nav item (Penpot 03 Molecules › nav-item). Surface: Configuration, Live. State: Default,
// Hover, Active. 36 high, radius s: the surface's icon (20), its label (body 14 medium), and for
// Live the badge counting what waits for you. The active item has the accent-soft fill.
import type { MouseEventHandler } from "react";
import { Badge } from "../atoms/Badge";
import { Icon, type IconName } from "../atoms/Icon";
import { cx, variantAttributes } from "../variant";

export type NavItemSurface = "configuration" | "live";
export type NavItemState = "default" | "hover" | "active";

export interface NavItemProps {
  readonly surface: NavItemSurface;
  readonly state?: NavItemState;
  readonly label: string;
  /** What waits for you; no badge at zero. */
  readonly count?: number;
  /** The badge's spoken words ("3 waiting for you"). */
  readonly countLabel?: string;
  readonly onClick?: MouseEventHandler<HTMLButtonElement>;
  readonly className?: string;
}

const ICON: Record<NavItemSurface, IconName> = {
  configuration: "settings-2",
  live: "activity",
};

export function NavItem({
  surface,
  state = "default",
  label,
  count = 0,
  countLabel,
  onClick,
  className,
}: NavItemProps) {
  const active = state === "active";
  return (
    <button
      {...variantAttributes("nav-item", { surface, state })}
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={cx(
        "flex h-[36px] w-full items-center gap-2 rounded-s px-2 text-left text-body font-medium",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
        active ? "bg-accent-soft text-accent" : "text-primary",
        state === "hover" && "bg-surface-sunken",
        state === "default" && "hover:bg-surface-sunken",
        className,
      )}
    >
      <Icon name={ICON[surface]} size={20} />
      <span className="flex-1 truncate">{label}</span>
      {count > 0 ? (
        <Badge count={count} {...(countLabel === undefined ? {} : { label: countLabel })} />
      ) : null}
    </button>
  );
}
