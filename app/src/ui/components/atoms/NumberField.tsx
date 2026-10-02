// Number field (Penpot 02 Atoms › number-field). State: Default, Focus, Filled, Error, Disabled.
// The Text field's box, 120 wide, with the up and down steps at the right. Behaviour (keyboard
// steps, clamping, ARIA spinbutton) is Ark UI's NumberInput.
import { NumberInput } from "@ark-ui/react";
import { fieldBoxClass, FIELD_TEXT_CLASS, type FieldState } from "../field-box";
import { cx, variantAttributes } from "../variant";
import { Icon } from "./Icon";

export type NumberFieldState = FieldState;

export interface NumberFieldProps {
  readonly state?: NumberFieldState;
  /** The value as typed ("" when empty). */
  readonly value: string;
  readonly placeholder?: string;
  readonly min?: number;
  readonly max?: number;
  readonly onValueChange?: (value: string) => void;
  readonly id?: string;
  readonly label?: string;
  /** The steps' accessible names, from strings.ts. */
  readonly incrementLabel: string;
  readonly decrementLabel: string;
  readonly className?: string;
}

export function NumberField({
  state = "default",
  value,
  placeholder,
  min,
  max,
  onValueChange,
  id,
  label,
  incrementLabel,
  decrementLabel,
  className,
}: NumberFieldProps) {
  return (
    <NumberInput.Root
      {...variantAttributes("number-field", { state })}
      value={value}
      {...(min === undefined ? {} : { min })}
      {...(max === undefined ? {} : { max })}
      {...(id === undefined ? {} : { ids: { input: id } })}
      disabled={state === "disabled"}
      invalid={state === "error"}
      onValueChange={(details) => onValueChange?.(details.value)}
      className={cx("w-[120px]", className)}
    >
      <NumberInput.Control
        className={fieldBoxClass(
          state,
          "h-[var(--inny-size-control)] items-center gap-1 pr-1 pl-3",
        )}
      >
        <NumberInput.Input
          placeholder={placeholder}
          aria-label={label}
          className={cx(FIELD_TEXT_CLASS, "h-full")}
        />
        <span className="flex flex-col text-secondary">
          <NumberInput.IncrementTrigger aria-label={incrementLabel} className="h-[14px]">
            <Icon name="chevron-up" />
          </NumberInput.IncrementTrigger>
          <NumberInput.DecrementTrigger aria-label={decrementLabel} className="h-[14px]">
            <Icon name="chevron-down" />
          </NumberInput.DecrementTrigger>
        </span>
      </NumberInput.Control>
    </NumberInput.Root>
  );
}
