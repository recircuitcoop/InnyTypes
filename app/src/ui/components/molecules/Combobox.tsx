// Combobox (Penpot 03 Molecules › combobox). State: Open, Closed. A Text field you type into
// to narrow a list of options (spaces, types); open, the list sits under it. Behaviour (filtering
// keyboard, ARIA combobox and listbox) is Ark UI's Combobox.
import { Combobox as ArkCombobox, createListCollection } from "@ark-ui/react";
import { useMemo, useState } from "react";
import { Icon } from "../atoms/Icon";
import type { SelectOption } from "../atoms/Select";
import { fieldBoxClass, FIELD_TEXT_CLASS, OPTION_CLASS, POPUP_SURFACE_CLASS } from "../field-box";
import { cx, variantAttributes } from "../variant";

export type ComboboxState = "open" | "closed";

export interface ComboboxProps {
  /** Held open or closed (the gallery); without it the list opens as the person types. */
  readonly state?: ComboboxState;
  readonly options: readonly SelectOption[];
  readonly value: string | null;
  /** The text typed so far. */
  readonly inputValue: string;
  readonly onInputValueChange?: (text: string) => void;
  readonly onValueChange?: (value: string | null) => void;
  readonly placeholder?: string;
  readonly label: string;
  readonly hideLabel?: boolean;
  readonly className?: string;
}

/** The options whose label contains the typed text, ignoring case. */
export function matchingOptions(
  options: readonly SelectOption[],
  text: string,
): readonly SelectOption[] {
  const wanted = text.trim().toLowerCase();
  return wanted === ""
    ? options
    : options.filter((option) => option.label.toLowerCase().includes(wanted));
}

export function Combobox({
  state,
  options,
  value,
  inputValue,
  onInputValueChange,
  onValueChange,
  placeholder,
  label,
  hideLabel = true,
  className,
}: ComboboxProps) {
  const [openNow, setOpenNow] = useState(false);
  const open = state === undefined ? openNow : state === "open";
  const shown = useMemo(() => matchingOptions(options, inputValue), [options, inputValue]);
  const collection = useMemo(
    () => createListCollection<SelectOption>({ items: [...shown] }),
    [shown],
  );
  return (
    <ArkCombobox.Root
      {...variantAttributes("combobox", { state: open ? "open" : "closed" })}
      collection={collection}
      value={value === null ? [] : [value]}
      inputValue={inputValue}
      open={open}
      onOpenChange={(details) => {
        setOpenNow(details.open);
      }}
      onInputValueChange={(details) => onInputValueChange?.(details.inputValue)}
      onValueChange={(details) => onValueChange?.(details.value[0] ?? null)}
      // Held open, it stays below the field: flipping above would follow the page's scroll.
      positioning={{ sameWidth: true, gutter: 4, flip: state === undefined }}
      className={cx("flex w-full flex-col gap-1", className)}
    >
      <ArkCombobox.Label className={hideLabel ? "sr-only" : "text-body font-medium text-primary"}>
        {label}
      </ArkCombobox.Label>
      <ArkCombobox.Control
        className={fieldBoxClass(
          open ? "focus" : "default",
          "h-[var(--inny-size-control)] items-center gap-2 px-3",
        )}
      >
        <ArkCombobox.Input placeholder={placeholder} className={cx(FIELD_TEXT_CLASS, "h-full")} />
        <ArkCombobox.Trigger className="text-secondary">
          <Icon name={open ? "search" : "chevron-down"} />
        </ArkCombobox.Trigger>
      </ArkCombobox.Control>
      <ArkCombobox.Positioner>
        <ArkCombobox.Content className={cx(POPUP_SURFACE_CLASS, "p-1")}>
          {shown.map((option) => (
            <ArkCombobox.Item key={option.value} item={option} className={OPTION_CLASS}>
              <ArkCombobox.ItemText>{option.label}</ArkCombobox.ItemText>
            </ArkCombobox.Item>
          ))}
        </ArkCombobox.Content>
      </ArkCombobox.Positioner>
    </ArkCombobox.Root>
  );
}
