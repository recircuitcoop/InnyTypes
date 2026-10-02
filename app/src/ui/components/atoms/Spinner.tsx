// Spinner (Penpot 02 Atoms › spinner). Size: 16, 20. The loader-circle icon turning; still when
// the person prefers reduced motion. Announced as a status with its label.
import { cx, variantAttributes } from "../variant";
import { Icon } from "./Icon";

export interface SpinnerProps {
  readonly size?: 16 | 20;
  /** What is loading, read aloud ("Loading spaces"), from strings.ts. */
  readonly label: string;
  readonly className?: string;
}

export function Spinner({ size = 16, label, className }: SpinnerProps) {
  return (
    <span
      {...variantAttributes("spinner", { size })}
      role="status"
      className={cx("inline-flex shrink-0 text-secondary", className)}
    >
      <Icon name="loader-circle" size={size} className="animate-spin" />
      <span className="sr-only">{label}</span>
    </span>
  );
}
