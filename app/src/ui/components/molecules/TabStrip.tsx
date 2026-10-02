// Tab strip (Penpot 03 Molecules › tab-strip). 40 high with a hairline below: one Tab per
// entry, the active one underlined; whatever sits right of the tabs (the Board's flow picker and
// Edit layout) goes in `trailing`. Each tab's panel is drawn under the strip. Behaviour is Ark
// UI's Tabs.
import { Tabs } from "@ark-ui/react";
import type { ReactNode } from "react";
import { cx, variantAttributes } from "../variant";
import { Tab, type TabState } from "./Tab";

export interface TabEntry {
  readonly value: string;
  readonly label: ReactNode;
  /** Held at a state (the gallery). */
  readonly state?: TabState;
}

export interface TabStripProps {
  /** What the tabs switch between ("Configuration"), read aloud. */
  readonly label: string;
  readonly tabs: readonly TabEntry[];
  readonly value: string | null;
  readonly onValueChange?: (value: string) => void;
  /** Each tab's panel by value; a tab without one has an empty panel. */
  readonly panels?: Readonly<Record<string, ReactNode>>;
  readonly trailing?: ReactNode;
  readonly className?: string;
}

export function TabStrip({
  label,
  tabs,
  value,
  onValueChange,
  panels = {},
  trailing,
  className,
}: TabStripProps) {
  return (
    <Tabs.Root
      {...variantAttributes("tab-strip")}
      value={value}
      onValueChange={(details) => onValueChange?.(details.value)}
      className={cx("flex w-full flex-col", className)}
    >
      <div className="flex items-center gap-3 border-b border-surface-line">
        <Tabs.List aria-label={label} className="flex flex-1 items-end">
          {tabs.map((tab) => (
            <Tab
              key={tab.value}
              value={tab.value}
              {...(tab.state === undefined ? {} : { state: tab.state })}
            >
              {tab.label}
            </Tab>
          ))}
        </Tabs.List>
        {trailing}
      </div>
      {tabs.map((tab) => (
        <Tabs.Content key={tab.value} value={tab.value} className="outline-none">
          {panels[tab.value]}
        </Tabs.Content>
      ))}
    </Tabs.Root>
  );
}
