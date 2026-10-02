// Range (Penpot 02 Atoms › range). State: Default, Focus, Disabled. A 4px track on the sunken
// fill, the accent range, a 16 knob; Focus thickens the knob's line. Behaviour (keyboard steps,
// ARIA slider) is Ark UI's Slider.
import { Slider } from "@ark-ui/react";
import { cx, variantAttributes } from "../variant";

export type RangeState = "default" | "focus" | "disabled";

export interface RangeProps {
  readonly state?: RangeState;
  readonly value: number;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly onValueChange?: (value: number) => void;
  /** What it sets; read aloud always, shown unless hideLabel. */
  readonly label: string;
  readonly hideLabel?: boolean;
  readonly className?: string;
}

export function Range({
  state = "default",
  value,
  min = 0,
  max = 100,
  step = 1,
  onValueChange,
  label,
  hideLabel = true,
  className,
}: RangeProps) {
  return (
    <Slider.Root
      {...variantAttributes("range", { state })}
      value={[value]}
      min={min}
      max={max}
      step={step}
      disabled={state === "disabled"}
      onValueChange={(details) => onValueChange?.(details.value[0] ?? value)}
      className={cx(
        "flex w-full flex-col gap-1",
        state === "disabled" && "opacity-[var(--inny-opacity-disabled)]",
        className,
      )}
    >
      <Slider.Label className={hideLabel ? "sr-only" : "text-body font-medium text-primary"}>
        {label}
      </Slider.Label>
      <Slider.Control className="relative flex h-4 items-center">
        <Slider.Track className="h-1 w-full rounded-pill bg-surface-sunken">
          <Slider.Range className="h-full rounded-pill bg-accent" />
        </Slider.Track>
        <Slider.Thumb
          index={0}
          className={cx(
            "size-4 rounded-pill border-accent bg-surface-panel outline-none",
            state === "focus" ? "border-2" : "border data-focus-visible:border-2",
          )}
        >
          <Slider.HiddenInput />
        </Slider.Thumb>
      </Slider.Control>
    </Slider.Root>
  );
}
