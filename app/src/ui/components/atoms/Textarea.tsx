// Textarea (Penpot 02 Atoms › textarea). State: Default, Focus, Filled, Error, Disabled. The Text
// field's box, 88 high, for a form property with maxLength over 200 or format multiline.
import type { ChangeEvent } from "react";
import { fieldBoxClass, FIELD_TEXT_CLASS, type FieldState } from "../field-box";
import { cx, variantAttributes } from "../variant";

export type TextareaState = FieldState;

export interface TextareaProps {
  readonly state?: TextareaState;
  readonly value: string;
  readonly placeholder?: string;
  readonly onValueChange?: (value: string) => void;
  readonly id?: string;
  readonly label?: string;
  readonly describedBy?: string;
  readonly className?: string;
}

export function Textarea({
  state = "default",
  value,
  placeholder,
  onValueChange,
  id,
  label,
  describedBy,
  className,
}: TextareaProps) {
  return (
    <div
      {...variantAttributes("textarea", { state })}
      aria-disabled={state === "disabled" ? true : undefined}
      className={fieldBoxClass(state, "h-[88px] items-stretch px-3 py-2", className)}
    >
      <textarea
        id={id}
        value={value}
        placeholder={placeholder}
        aria-label={label}
        aria-describedby={describedBy}
        aria-invalid={state === "error" ? true : undefined}
        disabled={state === "disabled"}
        readOnly={onValueChange === undefined}
        onChange={(event: ChangeEvent<HTMLTextAreaElement>) => onValueChange?.(event.target.value)}
        className={cx(FIELD_TEXT_CLASS, "resize-none leading-body")}
      />
    </div>
  );
}
