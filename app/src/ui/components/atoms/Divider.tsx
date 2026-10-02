// Divider (Penpot 02 Atoms › divider). 1px in the surface line colour; no variants.
import { cx, variantAttributes } from "../variant";

export interface DividerProps {
  readonly className?: string;
}

export function Divider({ className }: DividerProps) {
  return (
    <hr
      {...variantAttributes("divider")}
      className={cx("h-px w-full shrink-0 border-0 bg-surface-line", className)}
    />
  );
}
