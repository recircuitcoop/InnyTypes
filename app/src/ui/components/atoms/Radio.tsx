// Radio (Penpot 02 Atoms › radio). State: On, Off. Disabled: Yes, No. A 16 circle; On is the
// accent with a 6px dot. A radio only exists inside its group, so this file also holds
// RadioGroup, the Ark UI root that gives the items their keyboard handling and ARIA.
import { RadioGroup as ArkRadioGroup } from "@ark-ui/react";
import type { ReactNode } from "react";
import { cx, variantAttributes } from "../variant";

export type RadioState = "on" | "off";

export interface RadioGroupProps {
  /** The question the group answers; read aloud always, shown unless hideLabel. */
  readonly label: string;
  readonly hideLabel?: boolean;
  readonly value: string | null;
  readonly onValueChange?: (value: string) => void;
  readonly children: ReactNode;
  readonly className?: string;
}

export function RadioGroup({
  label,
  hideLabel = false,
  value,
  onValueChange,
  children,
  className,
}: RadioGroupProps) {
  return (
    <ArkRadioGroup.Root
      value={value}
      onValueChange={(details) => {
        if (details.value !== null) {
          onValueChange?.(details.value);
        }
      }}
      className={cx("flex flex-col gap-2", className)}
    >
      <ArkRadioGroup.Label className={hideLabel ? "sr-only" : "text-body font-medium text-primary"}>
        {label}
      </ArkRadioGroup.Label>
      {children}
    </ArkRadioGroup.Root>
  );
}

export interface RadioProps {
  /** On when the group's value is this radio's value. */
  readonly state: RadioState;
  readonly disabled?: boolean;
  readonly value: string;
  readonly label: string;
  readonly className?: string;
}

export function Radio({ state, disabled = false, value, label, className }: RadioProps) {
  const on = state === "on";
  return (
    <ArkRadioGroup.Item
      {...variantAttributes("radio", { state, disabled })}
      value={value}
      disabled={disabled}
      className={cx(
        "inline-flex items-center gap-2 text-body text-primary",
        disabled ? "cursor-not-allowed opacity-[var(--inny-opacity-disabled)]" : "cursor-pointer",
        className,
      )}
    >
      <ArkRadioGroup.ItemControl
        className={cx(
          "inline-flex size-4 shrink-0 items-center justify-center rounded-pill border",
          "data-focus-visible:outline-2 data-focus-visible:outline-offset-2 data-focus-visible:outline-focus",
          on ? "border-accent bg-accent" : "border-muted bg-surface-panel",
        )}
      >
        {on ? <span className="size-[6px] rounded-pill bg-surface-panel" /> : null}
      </ArkRadioGroup.ItemControl>
      <ArkRadioGroup.ItemText>{label}</ArkRadioGroup.ItemText>
      <ArkRadioGroup.ItemHiddenInput />
    </ArkRadioGroup.Item>
  );
}
