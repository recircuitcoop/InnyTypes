// Badge (Penpot 02 Atoms › badge). Count: 1, 3, 9+. An 18 circle on the waiting fill, on-accent
// text, caption 12 semibold; above nine it reads "9+". It counts what waits for you.
import { cx, variantAttributes } from "../variant";

export interface BadgeProps {
  readonly count: number;
  /** What is counted, read aloud with the number ("3 waiting for you"), from strings.ts. */
  readonly label?: string;
  readonly className?: string;
}

/** The number as drawn: the count, or "9+" above nine. */
export function badgeText(count: number): string {
  return count > 9 ? "9+" : String(count);
}

export function Badge({ count, label, className }: BadgeProps) {
  const text = badgeText(count);
  return (
    <span
      {...variantAttributes("badge", { count: text })}
      className={cx(
        "inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-pill bg-waiting px-1 text-caption leading-none font-semibold text-on-accent",
        className,
      )}
    >
      <span aria-hidden={label === undefined ? undefined : true}>{text}</span>
      {label === undefined ? null : <span className="sr-only">{label}</span>}
    </span>
  );
}
