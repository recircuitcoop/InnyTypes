// Multi-select (Penpot 03 Molecules › multi-select). State: Filled, Empty. The Text field's box
// holding a removable Chip per chosen option, then room to type and the chevron; it grows a line
// when the chips wrap. For a form property that is an array of enum. Behaviour (listbox, typing
// to narrow, ARIA) is Ark UI's Combobox in its multiple mode.
import { Combobox as ArkCombobox, createListCollection } from "@ark-ui/react";
import { useMemo, useState } from "react";
import { Chip } from "../atoms/Chip";
import { Icon } from "../atoms/Icon";
import type { SelectOption } from "../atoms/Select";
import { fieldBoxClass, FIELD_TEXT_CLASS, OPTION_CLASS, POPUP_SURFACE_CLASS } from "../field-box";
import { cx, variantAttributes } from "../variant";
import { matchingOptions } from "./Combobox";

export interface MultiSelectProps {
  readonly options: readonly SelectOption[];
  readonly value: readonly string[];
  readonly onValueChange?: (value: string[]) => void;
  readonly placeholder?: string;
  readonly label: string;
  readonly hideLabel?: boolean;
  /** A chip's x, given the option's label ("Remove Meeting notes"), from strings.ts. */
  readonly removeLabel: (optionLabel: string) => string;
  readonly className?: string;
}

export function MultiSelect({
  options,
  value,
  onValueChange,
  placeholder,
  label,
  hideLabel = true,
  removeLabel,
  className,
}: MultiSelectProps) {
  const [text, setText] = useState("");
  const shown = useMemo(() => matchingOptions(options, text), [options, text]);
  const collection = useMemo(
    () => createListCollection<SelectOption>({ items: [...shown] }),
    [shown],
  );
  const chosen = value
    .map((chosenValue) => options.find((option) => option.value === chosenValue))
    .filter((option): option is SelectOption => option !== undefined);
  return (
    <ArkCombobox.Root
      {...variantAttributes("multi-select", { state: chosen.length > 0 ? "filled" : "empty" })}
      multiple
      collection={collection}
      value={[...value]}
      inputValue={text}
      onInputValueChange={(details) => {
        setText(details.inputValue);
      }}
      onValueChange={(details) => onValueChange?.(details.value)}
      positioning={{ sameWidth: true, gutter: 4 }}
      className={cx("flex w-full flex-col gap-1", className)}
    >
      <ArkCombobox.Label className={hideLabel ? "sr-only" : "text-body font-medium text-primary"}>
        {label}
      </ArkCombobox.Label>
      <ArkCombobox.Control
        className={fieldBoxClass(
          "default",
          "min-h-[var(--inny-size-control)] flex-wrap items-center gap-1 py-1 pr-2 pl-1",
        )}
      >
        {chosen.map((option) => (
          <Chip
            key={option.value}
            kind="removable"
            removeLabel={removeLabel(option.label)}
            onRemove={() =>
              onValueChange?.(value.filter((chosenValue) => chosenValue !== option.value))
            }
          >
            {option.label}
          </Chip>
        ))}
        <ArkCombobox.Input
          placeholder={placeholder}
          className={cx(FIELD_TEXT_CLASS, "h-[24px] min-w-[120px] pl-2")}
        />
        <ArkCombobox.Trigger className="text-secondary">
          <Icon name="chevron-down" />
        </ArkCombobox.Trigger>
      </ArkCombobox.Control>
      <ArkCombobox.Positioner>
        <ArkCombobox.Content className={cx(POPUP_SURFACE_CLASS, "p-1")}>
          {shown.map((option) => (
            <ArkCombobox.Item key={option.value} item={option} className={OPTION_CLASS}>
              <ArkCombobox.ItemText className="flex-1">{option.label}</ArkCombobox.ItemText>
              <ArkCombobox.ItemIndicator className="text-accent">
                <Icon name="check" />
              </ArkCombobox.ItemIndicator>
            </ArkCombobox.Item>
          ))}
        </ArkCombobox.Content>
      </ArkCombobox.Positioner>
    </ArkCombobox.Root>
  );
}
