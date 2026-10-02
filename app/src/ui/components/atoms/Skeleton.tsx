// Skeleton (Penpot 02 Atoms › skeleton). Kind: Text (a 12 line), Circle (32), Block (72, radius
// m). The sunken fill where content is about to be; hidden from assistive technology, which
// hears the Spinner or the region's busy state instead.
import { cx, variantAttributes } from "../variant";

export type SkeletonKind = "text" | "circle" | "block";

export interface SkeletonProps {
  readonly kind: SkeletonKind;
  readonly className?: string;
}

const SHAPE: Record<SkeletonKind, string> = {
  text: "h-[12px] w-full rounded-s",
  circle: "size-[var(--inny-size-control)] rounded-pill",
  block: "h-[72px] w-full rounded-m",
};

export function Skeleton({ kind, className }: SkeletonProps) {
  return (
    <span
      {...variantAttributes("skeleton", { kind })}
      aria-hidden="true"
      className={cx("block shrink-0 bg-surface-sunken", SHAPE[kind], className)}
    />
  );
}
