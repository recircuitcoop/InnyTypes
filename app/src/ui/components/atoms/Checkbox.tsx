// Checkbox (Penpot 02 Atoms › checkbox). State: On, Off, Mixed. Disabled: Yes, No. A 16 square,
// radius s. Behaviour and ARIA (including the mixed state) are Ark UI's.
import { Checkbox as ArkCheckbox } from "@ark-ui/react";
import { cx, variantAttributes } from "../variant";
import { Icon } from "./Icon";

export type CheckboxState = "on" | "off" | "mixed";

export interface CheckboxProps {
  readonly state: CheckboxState;
  readonly disabled?: boolean;
  /** What it selects; read aloud always, shown unless hideLabel. */
  readonly label: string;
  readonly hideLabel?: boolean;
  readonly onStateChange?: (state: CheckboxState) => void;
  readonly className?: string;
}

export function Checkbox({
  state,
  disabled = false,
  label,
  hideLabel = false,
  onStateChange,
  className,
}: CheckboxProps) {
  const checked = state === "on" ? true : state === "mixed" ? "indeterminate" : false;
  return (
    <ArkCheckbox.Root
      {...variantAttributes("checkbox", { state, disabled })}
      checked={checked}
      disabled={disabled}
      onCheckedChange={(details) =>
        onStateChange?.(
          details.checked === "indeterminate" ? "mixed" : details.checked ? "on" : "off",
        )
      }
      className={cx(
        "inline-flex items-center gap-2 text-body text-primary",
        disabled ? "cursor-not-allowed opacity-[var(--inny-opacity-disabled)]" : "cursor-pointer",
        className,
      )}
    >
      <ArkCheckbox.Control
        className={cx(
          "inline-flex size-4 shrink-0 items-center justify-center rounded-s text-on-accent",
          "data-focus-visible:outline-2 data-focus-visible:outline-offset-2 data-focus-visible:outline-focus",
          state === "off" ? "border border-muted bg-surface-panel" : "bg-accent",
        )}
      >
        {state === "on" ? <Icon name="check" /> : null}
        {state === "mixed" ? <Icon name="minus" /> : null}
      </ArkCheckbox.Control>
      <ArkCheckbox.Label className={hideLabel ? "sr-only" : undefined}>{label}</ArkCheckbox.Label>
      <ArkCheckbox.HiddenInput />
    </ArkCheckbox.Root>
  );
}
