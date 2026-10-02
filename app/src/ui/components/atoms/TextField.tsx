// Text field (Penpot 02 Atoms › text-field). State: Default, Focus, Filled, Error, Disabled.
// Suggested: Yes, No. Height 32, radius s, a hairline line; Focus adds the 2px focus ring;
// Suggested shows its tag in caption at the right, when the value is one the node guessed.
import type { ChangeEvent } from "react";
import { fieldBoxClass, FIELD_TEXT_CLASS, type FieldState } from "../field-box";
import { cx, variantAttributes } from "../variant";

export type TextFieldState = FieldState;

export interface TextFieldProps {
  readonly state?: TextFieldState;
  readonly suggested?: boolean;
  /** The Suggested tag's word, from strings.ts; drawn only when suggested. */
  readonly suggestedLabel?: string;
  readonly value: string;
  readonly placeholder?: string;
  readonly onValueChange?: (value: string) => void;
  /** The input's id, so a Field's label names it. */
  readonly id?: string;
  /** The accessible name when no Field label names it. */
  readonly label?: string;
  readonly describedBy?: string;
  readonly type?: "text" | "search" | "password";
  readonly className?: string;
}

/** The Suggested tag, shared with Field's label row. */
export function SuggestedTag({ children }: { readonly children: string }) {
  return (
    <span className="inline-flex h-[20px] shrink-0 items-center rounded-pill bg-accent-soft px-2 text-caption font-medium text-accent">
      {children}
    </span>
  );
}

export function TextField({
  state = "default",
  suggested = false,
  suggestedLabel,
  value,
  placeholder,
  onValueChange,
  id,
  label,
  describedBy,
  type = "text",
  className,
}: TextFieldProps) {
  return (
    <div
      {...variantAttributes("text-field", { state, suggested })}
      aria-disabled={state === "disabled" ? true : undefined}
      className={fieldBoxClass(
        state,
        "h-[var(--inny-size-control)] items-center gap-2 px-3",
        className,
      )}
    >
      <input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        aria-label={label}
        aria-describedby={describedBy}
        aria-invalid={state === "error" ? true : undefined}
        disabled={state === "disabled"}
        readOnly={onValueChange === undefined}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onValueChange?.(event.target.value)}
        className={cx(FIELD_TEXT_CLASS, "h-full")}
      />
      {suggested && suggestedLabel !== undefined ? (
        <SuggestedTag>{suggestedLabel}</SuggestedTag>
      ) : null}
    </div>
  );
}
