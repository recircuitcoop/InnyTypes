// Select (Penpot 02 Atoms › select). State: Default, Focus, Filled, Error, Disabled. The Text
// field's frame with a chevron; the options come from data. Its placeholder is drawn in the
// secondary text colour, where Penpot uses the muted one: unlike an input's placeholder it is
// the button's text, and muted on the panel fails WCAG AA contrast (the gallery's axe pass). Behaviour (listbox keyboard
// handling, typeahead, ARIA) is Ark UI's Select.
import { createListCollection, Select as ArkSelect } from "@ark-ui/react";
import { useMemo } from "react";
import { fieldBoxClass, OPTION_CLASS, POPUP_SURFACE_CLASS, type FieldState } from "../field-box";
import { cx, variantAttributes } from "../variant";
import { Icon } from "./Icon";

export type SelectState = FieldState;

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface SelectProps {
  readonly state?: SelectState;
  readonly options: readonly SelectOption[];
  readonly value: string | null;
  readonly placeholder?: string;
  readonly onValueChange?: (value: string | null) => void;
  /** What is chosen; read aloud always, shown unless hideLabel (a Field draws its own). */
  readonly label: string;
  readonly hideLabel?: boolean;
  readonly className?: string;
}

export function Select({
  state = "default",
  options,
  value,
  placeholder,
  onValueChange,
  label,
  hideLabel = true,
  className,
}: SelectProps) {
  const collection = useMemo(
    () =>
      createListCollection<SelectOption>({
        items: [...options],
        isItemDisabled: (option) => option.disabled === true,
      }),
    [options],
  );
  return (
    <ArkSelect.Root
      {...variantAttributes("select", { state })}
      collection={collection}
      value={value === null ? [] : [value]}
      disabled={state === "disabled"}
      invalid={state === "error"}
      positioning={{ sameWidth: true }}
      onValueChange={(details) => onValueChange?.(details.value[0] ?? null)}
      className={cx("flex w-full flex-col gap-1", className)}
    >
      <ArkSelect.Label className={hideLabel ? "sr-only" : "text-body font-medium text-primary"}>
        {label}
      </ArkSelect.Label>
      <ArkSelect.Control>
        <ArkSelect.Trigger
          className={fieldBoxClass(
            state,
            "h-[var(--inny-size-control)] items-center gap-2 px-3 text-left",
          )}
        >
          <ArkSelect.ValueText
            placeholder={placeholder}
            className={cx("min-w-0 flex-1 truncate", value === null && "text-secondary")}
          />
          <ArkSelect.Indicator className="text-secondary">
            <Icon name="chevron-down" />
          </ArkSelect.Indicator>
        </ArkSelect.Trigger>
      </ArkSelect.Control>
      <ArkSelect.Positioner>
        <ArkSelect.Content className={cx(POPUP_SURFACE_CLASS, "p-1")}>
          {options.map((option) => (
            <ArkSelect.Item key={option.value} item={option} className={OPTION_CLASS}>
              <ArkSelect.ItemText className="flex-1">{option.label}</ArkSelect.ItemText>
              <ArkSelect.ItemIndicator className="text-accent">
                <Icon name="check" />
              </ArkSelect.ItemIndicator>
            </ArkSelect.Item>
          ))}
        </ArkSelect.Content>
      </ArkSelect.Positioner>
      <ArkSelect.HiddenSelect />
    </ArkSelect.Root>
  );
}
