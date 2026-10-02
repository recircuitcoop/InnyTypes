// Menu (Penpot 03 Molecules › menu). A pop-up list of Menu items, 288 wide, panel fill,
// hairline, radius m; a Divider between groups (the separator before Delete). Opened by its
// trigger, usually the ⋯ Icon button. Behaviour (focus, arrow keys, typeahead, Escape, ARIA
// menu) is Ark UI's Menu.
import { Menu as ArkMenu } from "@ark-ui/react";
import type { ReactElement, ReactNode } from "react";
import { POPUP_SURFACE_CLASS } from "../field-box";
import { cx, variantAttributes } from "../variant";

export interface MenuProps {
  /** The element that opens it (an Icon button). */
  readonly trigger: ReactElement;
  /** Menu items and separators. */
  readonly children: ReactNode;
  /** Held open (the gallery); otherwise it opens from its trigger. */
  readonly open?: boolean;
  /** Which edge of the trigger it lines up with: the end for a row's ⋯ at the right. */
  readonly placement?: "bottom-start" | "bottom-end";
  readonly className?: string;
}

export function Menu({ trigger, children, open, placement = "bottom-end", className }: MenuProps) {
  return (
    <ArkMenu.Root
      {...(open === undefined ? {} : { open })}
      // Held open, it stays below its trigger: flipping above would follow the page's scroll.
      positioning={{ placement, gutter: 4, flip: open === undefined }}
    >
      <ArkMenu.Trigger asChild>{trigger}</ArkMenu.Trigger>
      <ArkMenu.Positioner>
        <ArkMenu.Content
          {...variantAttributes("menu")}
          className={cx(POPUP_SURFACE_CLASS, "w-[288px] p-1", className)}
        >
          {children}
        </ArkMenu.Content>
      </ArkMenu.Positioner>
    </ArkMenu.Root>
  );
}

/** The hairline between a menu's groups. */
export function MenuSeparator() {
  return <ArkMenu.Separator className="my-1 h-px border-0 bg-surface-line" />;
}
