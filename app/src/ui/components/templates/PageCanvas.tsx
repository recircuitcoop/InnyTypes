// page/canvas (Penpot 05 Templates › template / page / canvas). The Sidebar, then the Canvas
// frame filling the rest; no page scroll (the Node-RED editor scrolls itself). Opened from
// Configuration › Flows. Content-free: every region is the caller's.
import type { ReactNode } from "react";
import { cx, variantAttributes } from "../variant";

export interface PageCanvasProps {
  readonly sidebar: ReactNode;
  readonly banner?: ReactNode;
  /** The Canvas frame. */
  readonly children: ReactNode;
  readonly className?: string;
}

export function PageCanvas({ sidebar, banner, children, className }: PageCanvasProps) {
  return (
    <div
      {...variantAttributes("page-canvas")}
      className={cx("flex h-full w-full overflow-hidden bg-surface-canvas", className)}
    >
      {sidebar}
      <div className="flex min-w-0 flex-1 flex-col">
        {banner}
        <main className="flex min-h-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
