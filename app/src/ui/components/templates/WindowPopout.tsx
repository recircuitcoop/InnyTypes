// window/popout (Penpot 05 Templates › template / window / popout). A pop-out window's page:
// size.popout-width wide, as tall as its content, shadow.popout. It holds a Question pop-out
// (view.tsx draws one per question). Content-free: the content is the caller's.
import type { ReactNode } from "react";
import { cx, variantAttributes } from "../variant";

export interface WindowPopoutProps {
  readonly children: ReactNode;
  readonly className?: string;
}

export function WindowPopout({ children, className }: WindowPopoutProps) {
  return (
    <main
      {...variantAttributes("window-popout")}
      className={cx(
        "flex w-[var(--inny-size-popout-width)] flex-col overflow-hidden rounded-l bg-surface-panel shadow-popout",
        className,
      )}
    >
      {children}
    </main>
  );
}
