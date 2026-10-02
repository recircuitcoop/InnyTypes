// Chip (Penpot 02 Atoms › chip). Kind: Default, Selected, Removable. 24 high, radius pill,
// caption 12 medium; Selected is accent-soft with an accent line; Removable carries an x that
// removes it (its accessible name comes from strings.ts).
import type { ReactNode } from "react";
import { cx, variantAttributes } from "../variant";
import { Icon } from "./Icon";

export type ChipKind = "default" | "selected" | "removable";

export interface ChipProps {
  readonly kind: ChipKind;
  readonly children: ReactNode;
  readonly onRemove?: () => void;
  /** The x's accessible name, e.g. "Remove Meeting notes"; required for Removable. */
  readonly removeLabel?: string;
  readonly className?: string;
}

export function Chip({ kind, children, onRemove, removeLabel, className }: ChipProps) {
  return (
    <span
      {...variantAttributes("chip", { kind })}
      className={cx(
        "inline-flex h-[24px] shrink-0 items-center gap-1 rounded-pill border text-caption font-medium whitespace-nowrap",
        kind === "selected"
          ? "border-accent bg-accent-soft text-accent"
          : "border-surface-line bg-surface-panel text-primary",
        kind === "removable" ? "pr-1 pl-2" : "px-2",
        className,
      )}
    >
      {children}
      {kind === "removable" ? (
        <button
          type="button"
          aria-label={removeLabel}
          onClick={onRemove}
          className="inline-flex size-4 items-center justify-center rounded-pill text-secondary hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-focus"
        >
          <Icon name="x" />
        </button>
      ) : null}
    </span>
  );
}
