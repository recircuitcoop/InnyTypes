// Board (Penpot 04 Organisms › board), one flow's page in Live. Mode: Viewing, Edit layout. The
// Tab strip above, with the flow picker and Edit layout (Secondary) at its right; under it the
// active tab's places (Slots) on a 12-column grid with 16 gaps. Edit layout adds the Edit-layout
// bar under the strip and each Slot's dashed outline and ⋯ menu (the caller passes its Slots with
// `editing`, so a Slot and its board cannot disagree about the mode).
import type { ReactNode } from "react";
import { Button } from "../atoms/Button";
import { TabStrip } from "../molecules/TabStrip";
import { cx, variantAttributes } from "../variant";

export type BoardMode = "viewing" | "edit-layout";

export interface BoardTabEntry {
  readonly id: string;
  readonly name: string;
}

export interface BoardProps {
  readonly mode: BoardMode;
  /** The tabs' spoken group name ("Board of Recordings to Anytype"). */
  readonly label: string;
  readonly tabs: readonly BoardTabEntry[];
  readonly activeTab: string;
  readonly onTabChange?: (tabId: string) => void;
  /** The Flow picker (a Select labelled "Flow"). */
  readonly flowPicker: ReactNode;
  readonly editLayoutLabel: string;
  readonly onEditLayout?: () => void;
  /** The Edit-layout bar, drawn in Edit layout only. */
  readonly bar?: ReactNode;
  /** The active tab's Slots, in their order; an Empty state when it has none. */
  readonly children: ReactNode;
  readonly className?: string;
}

export function Board({
  mode,
  label,
  tabs,
  activeTab,
  onTabChange,
  flowPicker,
  editLayoutLabel,
  onEditLayout,
  bar,
  children,
  className,
}: BoardProps) {
  const editing = mode === "edit-layout";
  return (
    <section
      {...variantAttributes("board", { mode })}
      aria-label={label}
      className={cx("flex w-full flex-col", className)}
    >
      <TabStrip
        label={label}
        value={activeTab}
        {...(onTabChange === undefined ? {} : { onValueChange: onTabChange })}
        tabs={tabs.map((tab) => ({ value: tab.id, label: tab.name }))}
        trailing={
          <div className="flex items-center gap-2 pb-1">
            <div className="w-[240px]">{flowPicker}</div>
            {editing ? null : (
              <Button
                kind="secondary"
                {...(onEditLayout === undefined ? {} : { onClick: () => onEditLayout() })}
              >
                {editLayoutLabel}
              </Button>
            )}
          </div>
        }
        panels={{
          [activeTab]: (
            <div className="flex flex-col gap-4 pt-4">
              {editing ? bar : null}
              <div className="grid grid-cols-12 items-start gap-4">{children}</div>
            </div>
          ),
        }}
      />
    </section>
  );
}
