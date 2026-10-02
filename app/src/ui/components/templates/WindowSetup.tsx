// window/setup (Penpot 05 Templates › template / window / setup). The first run's window: the
// Sidebar in Setup mode (the walkthrough's step list), and a centred 560px column showing one
// Setup step at a time. Content-free: every region is the caller's.
import type { ReactNode } from "react";
import { cx, variantAttributes } from "../variant";

export interface WindowSetupProps {
  /** The Sidebar, mode Setup. */
  readonly sidebar: ReactNode;
  /** The current Setup step. */
  readonly children: ReactNode;
  readonly className?: string;
}

export function WindowSetup({ sidebar, children, className }: WindowSetupProps) {
  return (
    <div
      {...variantAttributes("window-setup")}
      className={cx("flex h-full w-full bg-surface-canvas", className)}
    >
      {sidebar}
      <main className="flex min-w-0 flex-1 items-start justify-center overflow-y-auto px-5 py-8">
        <div className="w-full max-w-[560px]">{children}</div>
      </main>
    </div>
  );
}
