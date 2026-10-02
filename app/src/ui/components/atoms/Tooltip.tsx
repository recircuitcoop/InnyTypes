// Tooltip (Penpot 02 Atoms › tooltip). Panel fill, raised shadow, radius s, caption text; no
// variants. Behaviour (delays, Escape, ARIA describedby) is Ark UI's Tooltip; the trigger is the
// child element, which keeps its own role and name.
import { Tooltip as ArkTooltip } from "@ark-ui/react";
import type { ReactElement } from "react";
import { cx, variantAttributes } from "../variant";

export interface TooltipProps {
  /** The tip, from strings.ts: a date in full, a disabled action's reason. */
  readonly content: string;
  /** The one element it describes. */
  readonly children: ReactElement;
  /** Held open (the gallery); otherwise it opens on hover and focus. */
  readonly open?: boolean;
  readonly className?: string;
}

export function Tooltip({ content, children, open, className }: TooltipProps) {
  return (
    <ArkTooltip.Root
      {...(open === undefined ? {} : { open })}
      openDelay={400}
      closeDelay={100}
      // Held open, it stays below its trigger: flipping above would follow the page's scroll.
      positioning={{ placement: "bottom-start", gutter: 4, flip: open === undefined }}
    >
      <ArkTooltip.Trigger asChild>{children}</ArkTooltip.Trigger>
      <ArkTooltip.Positioner>
        <ArkTooltip.Content
          {...variantAttributes("tooltip")}
          className={cx(
            "rounded-s bg-surface-panel px-2 py-1 text-caption text-primary shadow-raised",
            className,
          )}
        >
          {content}
        </ArkTooltip.Content>
      </ArkTooltip.Positioner>
    </ArkTooltip.Root>
  );
}
