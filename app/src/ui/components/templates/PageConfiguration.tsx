// page/configuration (Penpot 05 Templates › template / page / configuration). The Sidebar
// (size.nav-width), then a column holding the runtime banner when there is one, the Tab strip
// (Flows, General) and the content, with 24px gutters. Prose keeps to size.reading-width; lists
// take the full width, so the width is the content's to choose. Content-free: every region is
// the caller's.
import type { ReactNode } from "react";
import { cx, variantAttributes } from "../variant";

export interface PageConfigurationProps {
  readonly sidebar: ReactNode;
  /** The Runtime banner, full width above the tabs, when InnyTypes is restarting or down. */
  readonly banner?: ReactNode;
  /** The Tab strip, Flows and General. */
  readonly tabs: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}

export function PageConfiguration({
  sidebar,
  banner,
  tabs,
  children,
  className,
}: PageConfigurationProps) {
  return (
    <div
      {...variantAttributes("page-configuration")}
      className={cx("flex h-full w-full bg-surface-canvas", className)}
    >
      {sidebar}
      <div className="flex min-w-0 flex-1 flex-col">
        {banner}
        <main className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 pt-5 pb-7">
          {tabs}
          {children}
        </main>
      </div>
    </div>
  );
}
