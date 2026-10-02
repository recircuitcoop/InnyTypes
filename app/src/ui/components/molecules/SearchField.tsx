// Search field (Penpot 03 Molecules › search-field). State: Default, Typing. The Text field's
// height on a pill, the search icon at the left; while typing it carries the focus ring and an x
// that clears it.
import type { ChangeEvent } from "react";
import { Icon } from "../atoms/Icon";
import { FIELD_TEXT_CLASS } from "../field-box";
import { cx, variantAttributes } from "../variant";

export type SearchFieldState = "default" | "typing";

export interface SearchFieldProps {
  readonly state?: SearchFieldState;
  readonly value: string;
  readonly placeholder: string;
  readonly onValueChange?: (value: string) => void;
  /** The accessible name ("Search runs") and the x's ("Clear the search"), from strings.ts. */
  readonly label: string;
  readonly clearLabel: string;
  readonly className?: string;
}

export function SearchField({
  state,
  value,
  placeholder,
  onValueChange,
  label,
  clearLabel,
  className,
}: SearchFieldProps) {
  // Typing is a search with text in it; a state given as a prop draws it at rest.
  const shown: SearchFieldState = state ?? (value === "" ? "default" : "typing");
  return (
    <div
      {...variantAttributes("search-field", { state: shown })}
      role="search"
      className={cx(
        "flex h-[var(--inny-size-control)] w-full items-center gap-2 rounded-pill border border-surface-line bg-surface-panel px-3 text-secondary",
        shown === "typing"
          ? "outline-2 -outline-offset-1 outline-focus"
          : "focus-within:outline-2 focus-within:-outline-offset-1 focus-within:outline-focus",
        className,
      )}
    >
      <Icon name="search" />
      <input
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label={label}
        readOnly={onValueChange === undefined}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onValueChange?.(event.target.value)}
        className={cx(FIELD_TEXT_CLASS, "h-full [&::-webkit-search-cancel-button]:hidden")}
      />
      {value === "" ? null : (
        <button
          type="button"
          aria-label={clearLabel}
          onClick={() => onValueChange?.("")}
          className="inline-flex size-4 items-center justify-center rounded-pill focus-visible:outline-2 focus-visible:outline-focus"
        >
          <Icon name="x" />
        </button>
      )}
    </div>
  );
}
