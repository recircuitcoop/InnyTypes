// page/live (Penpot 05 Templates › template / page / live). The Sidebar, then the runtime banner
// when there is one, and the Board filling the rest with 24px gutters; the page scrolls
// vertically only. Content-free: every region is the caller's.
import type { ReactNode } from "react";
import { cx, variantAttributes } from "../variant";

export interface PageLiveProps {
  readonly sidebar: ReactNode;
  readonly banner?: ReactNode;
  /** The flow's Board, or the Empty state when there is no flow yet. */
  readonly children: ReactNode;
  readonly className?: string;
}

export function PageLive({ sidebar, banner, children, className }: PageLiveProps) {
  return (
    <div
      {...variantAttributes("page-live")}
      className={cx("flex h-full w-full bg-surface-canvas", className)}
    >
      {sidebar}
      <div className="flex min-w-0 flex-1 flex-col">
        {banner}
        <main className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-5 pt-5 pb-7">
          {children}
        </main>
      </div>
    </div>
  );
}
