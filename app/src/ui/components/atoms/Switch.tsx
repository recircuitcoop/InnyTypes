// Switch (Penpot 02 Atoms › switch). State: On, Off. Disabled: Yes, No. A 32 × 18 track,
// radius pill; On uses the accent. The label states the effect. Behaviour and ARIA are Ark UI's.
import { Switch as ArkSwitch } from "@ark-ui/react";
import { cx, variantAttributes } from "../variant";

export type SwitchState = "on" | "off";

export interface SwitchProps {
  readonly state: SwitchState;
  readonly disabled?: boolean;
  /** What switching it does; read aloud always, shown unless hideLabel. */
  readonly label: string;
  readonly hideLabel?: boolean;
  readonly onStateChange?: (state: SwitchState) => void;
  readonly className?: string;
}

export function Switch({
  state,
  disabled = false,
  label,
  hideLabel = false,
  onStateChange,
  className,
}: SwitchProps) {
  const on = state === "on";
  return (
    <ArkSwitch.Root
      {...variantAttributes("switch", { state, disabled })}
      checked={on}
      disabled={disabled}
      onCheckedChange={(details) => onStateChange?.(details.checked ? "on" : "off")}
      className={cx(
        "inline-flex items-center gap-2 text-body text-primary",
        disabled ? "cursor-not-allowed opacity-[var(--inny-opacity-disabled)]" : "cursor-pointer",
        className,
      )}
    >
      <ArkSwitch.Control
        className={cx(
          "relative inline-block h-[18px] w-[32px] shrink-0 rounded-pill transition-colors",
          "data-focus-visible:outline-2 data-focus-visible:outline-offset-2 data-focus-visible:outline-focus",
          on ? "bg-accent" : "border border-muted bg-surface-sunken",
        )}
      >
        <ArkSwitch.Thumb
          className={cx(
            "absolute size-[14px] rounded-pill bg-surface-panel transition-[left]",
            on ? "top-[2px] left-[16px]" : "top-[1px] left-[1px] border border-muted",
          )}
        />
      </ArkSwitch.Control>
      <ArkSwitch.Label className={hideLabel ? "sr-only" : undefined}>{label}</ArkSwitch.Label>
      <ArkSwitch.HiddenInput />
    </ArkSwitch.Root>
  );
}
