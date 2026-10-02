// Menu item (Penpot 03 Molecules › menu-item). State: Default, Hover, Danger, Disabled. 32
// high, radius s: an icon, the label (body 14), and the key that does it as a Kbd. Danger (Delete
// flow, Delete run) is in the failed colour. A menu item only exists inside its Menu, which gives
// it Ark UI's Menu behaviour.
import { Menu } from "@ark-ui/react";
import { Icon, type IconName } from "../atoms/Icon";
import { Kbd } from "../atoms/Kbd";
import { cx, variantAttributes } from "../variant";

export type MenuItemState = "default" | "hover" | "danger" | "disabled";

export interface MenuItemProps {
  readonly value: string;
  readonly label: string;
  readonly icon?: IconName;
  readonly shortcut?: string;
  readonly state?: MenuItemState;
  readonly onSelect?: () => void;
  readonly className?: string;
}

export function MenuItem({
  value,
  label,
  icon,
  shortcut,
  state = "default",
  onSelect,
  className,
}: MenuItemProps) {
  return (
    <Menu.Item
      {...variantAttributes("menu-item", { state })}
      value={value}
      disabled={state === "disabled"}
      {...(onSelect === undefined ? {} : { onSelect })}
      className={cx(
        "flex h-[var(--inny-size-control)] cursor-pointer items-center gap-2 rounded-s px-2 text-body outline-none",
        state === "danger" ? "text-failed" : "text-primary",
        state === "hover" ? "bg-surface-sunken" : "data-highlighted:bg-surface-sunken",
        state === "disabled" && "cursor-not-allowed opacity-[var(--inny-opacity-disabled)]",
        className,
      )}
    >
      {icon === undefined ? null : <Icon name={icon} className="shrink-0" />}
      <span className="flex-1 truncate">{label}</span>
      {shortcut === undefined ? null : <Kbd keyName={shortcut} />}
    </Menu.Item>
  );
}
