// Tab (Penpot 03 Molecules › tab). State: Default, Hover, Active. 40 high: the label, body 14
// medium, secondary at rest and primary on hover; the active tab is in the accent with a 2px
// accent underline. A tab only exists inside its Tab strip, which gives it Ark UI's Tabs
// behaviour (arrow keys, ARIA tab and tabpanel).
import { Tabs, useTabsContext } from "@ark-ui/react";
import type { ReactNode } from "react";
import { cx, variantAttributes } from "../variant";

export type TabState = "default" | "hover" | "active";

export interface TabProps {
  readonly value: string;
  readonly children: ReactNode;
  /** Held at a state (the gallery); otherwise Active follows the strip's value. */
  readonly state?: TabState;
  readonly className?: string;
}

export function Tab({ value, children, state, className }: TabProps) {
  const tabs = useTabsContext();
  const shown: TabState = state ?? (tabs.value === value ? "active" : "default");
  return (
    <Tabs.Trigger
      {...variantAttributes("tab", { state: shown })}
      value={value}
      className={cx(
        "relative inline-flex h-[40px] shrink-0 items-center px-4 text-body font-medium",
        "after:absolute after:inset-x-0 after:bottom-0 after:h-[2px]",
        "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus",
        shown === "active" && "text-accent after:bg-accent",
        shown === "hover" && "text-primary",
        shown === "default" && "text-secondary hover:text-primary",
        className,
      )}
    >
      {children}
    </Tabs.Trigger>
  );
}
