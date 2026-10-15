// Segmented control (Penpot 03 Molecules › segmented-control). Options: 2, 3. A sunken 32-high
// track, radius s; each option a 28-high segment, body 14 medium; the chosen one on the panel
// fill in the primary colour, the others secondary. Run history's All · Waiting · Failed · Done
// filter, a Slot's size. Behaviour (one choice, arrow keys, ARIA radiogroup) is Ark UI's
// SegmentGroup.
import { SegmentGroup } from "@ark-ui/react";
import { cx, variantAttributes } from "../variant";

export interface SegmentOption {
  readonly value: string;
  readonly label: string;
}

export interface SegmentedControlProps {
  readonly options: readonly SegmentOption[];
  readonly value: string | null;
  readonly onValueChange?: (value: string) => void;
  /** What is chosen ("Size"), read aloud. */
  readonly label: string;
  /** The root's test id; each option's is `<testId>-<value>`. */
  readonly testId?: string;
  readonly className?: string;
}

export function SegmentedControl({
  options,
  value,
  onValueChange,
  label,
  testId,
  className,
}: SegmentedControlProps) {
  return (
    <SegmentGroup.Root
      {...variantAttributes("segmented-control", { options: options.length }, testId)}
      value={value}
      orientation="horizontal"
      onValueChange={(details) => {
        if (details.value !== null) {
          onValueChange?.(details.value);
        }
      }}
      className={cx(
        "inline-flex h-[var(--inny-size-control)] items-center gap-[2px] rounded-s bg-surface-sunken p-[2px]",
        className,
      )}
    >
      <SegmentGroup.Label className="sr-only">{label}</SegmentGroup.Label>
      {options.map((option) => (
        <SegmentGroup.Item
          key={option.value}
          value={option.value}
          {...(testId === undefined ? {} : { "data-testid": `${testId}-${option.value}` })}
          className={cx(
            "inline-flex h-[28px] cursor-pointer items-center rounded-s px-3 text-body font-medium",
            "has-focus-visible:outline-2 has-focus-visible:outline-focus",
            option.value === value
              ? "bg-surface-panel text-primary"
              : "text-secondary hover:text-primary",
          )}
        >
          <SegmentGroup.ItemText>{option.label}</SegmentGroup.ItemText>
          <SegmentGroup.ItemControl />
          <SegmentGroup.ItemHiddenInput />
        </SegmentGroup.Item>
      ))}
    </SegmentGroup.Root>
  );
}
