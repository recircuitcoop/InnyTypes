// Date field (Penpot 03 Molecules › date-field). State: Default, Filled, Open. The Text field's
// box with the day written in full ("Thursday 2026-10-02"); open, a month calendar under it, the
// chosen day in the accent. For a form property with format date. Behaviour (grid keyboard,
// ARIA) is Ark UI's DatePicker.
import { DatePicker, parseDate } from "@ark-ui/react";
import { useState } from "react";
import { Icon } from "../atoms/Icon";
import { fieldBoxClass, FIELD_TEXT_CLASS, POPUP_SURFACE_CLASS } from "../field-box";
import { cx, variantAttributes } from "../variant";

export type DateFieldState = "default" | "filled" | "open";

export interface DateFieldProps {
  /** Held open (the gallery); otherwise the calendar opens from the field. */
  readonly state?: DateFieldState;
  /** The day as an ISO date ("2026-10-02"), or null. */
  readonly value: string | null;
  readonly onValueChange?: (value: string | null) => void;
  readonly placeholder?: string;
  readonly label: string;
  /** The month arrows' and the calendar button's accessible names, from strings.ts. */
  readonly previousLabel: string;
  readonly nextLabel: string;
  readonly openLabel: string;
  readonly className?: string;
}

const WEEKDAY = new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" });

/** "2026-10-02" as written in the field: "Thursday 2026-10-02". */
export function writtenDay(iso: string): string {
  const day = new Date(`${iso}T00:00:00Z`);
  return `${WEEKDAY.format(day)} ${iso}`;
}

/** The ISO date in what was typed ("Thursday 2026-10-02", "2026-10-02"), or undefined. */
export function typedDay(text: string): string | undefined {
  const match = /(\d{4}-\d{2}-\d{2})/.exec(text);
  return match?.[1];
}

export function DateField({
  state,
  value,
  onValueChange,
  placeholder,
  label,
  previousLabel,
  nextLabel,
  openLabel,
  className,
}: DateFieldProps) {
  const [openNow, setOpenNow] = useState(false);
  const open = state === undefined ? openNow : state === "open";
  const shown: DateFieldState = open ? "open" : value === null ? "default" : "filled";
  return (
    <DatePicker.Root
      {...variantAttributes("date-field", { state: shown })}
      value={value === null ? [] : [parseDate(value)]}
      open={open}
      onOpenChange={(details) => {
        setOpenNow(details.open);
      }}
      onValueChange={(details) => onValueChange?.(details.valueAsString[0] ?? null)}
      format={(date) => writtenDay(date.toString())}
      parse={(text) => {
        const iso = typedDay(text);
        return iso === undefined ? undefined : parseDate(iso);
      }}
      locale="en-GB"
      // Held open, it stays below the field: flipping above would follow the page's scroll.
      positioning={{ placement: "bottom-start", gutter: 4, flip: state === undefined }}
      className={cx("flex w-full flex-col gap-1", className)}
    >
      <DatePicker.Label className="sr-only">{label}</DatePicker.Label>
      <DatePicker.Control
        className={fieldBoxClass(
          open ? "focus" : "default",
          "h-[var(--inny-size-control)] items-center gap-2 px-3",
        )}
      >
        <DatePicker.Input placeholder={placeholder} className={cx(FIELD_TEXT_CLASS, "h-full")} />
        <DatePicker.Trigger aria-label={openLabel} className="text-secondary">
          <Icon name="clock-4" />
        </DatePicker.Trigger>
      </DatePicker.Control>
      <DatePicker.Positioner>
        <DatePicker.Content className={cx(POPUP_SURFACE_CLASS, "w-[240px] p-3")}>
          <DatePicker.View view="day">
            <DatePicker.Context>
              {(picker) => (
                <>
                  <DatePicker.ViewControl className="mb-2 flex items-center justify-between text-secondary">
                    <DatePicker.PrevTrigger aria-label={previousLabel}>
                      <Icon name="chevron-left" />
                    </DatePicker.PrevTrigger>
                    <DatePicker.RangeText className="text-body font-medium text-primary" />
                    <DatePicker.NextTrigger aria-label={nextLabel}>
                      <Icon name="chevron-right" />
                    </DatePicker.NextTrigger>
                  </DatePicker.ViewControl>
                  <DatePicker.Table className="w-full border-collapse">
                    <DatePicker.TableHead>
                      <DatePicker.TableRow>
                        {picker.weekDays.map((weekDay, index) => (
                          <DatePicker.TableHeader
                            key={index}
                            className="h-[20px] text-caption font-medium text-secondary"
                          >
                            {weekDay.narrow}
                          </DatePicker.TableHeader>
                        ))}
                      </DatePicker.TableRow>
                    </DatePicker.TableHead>
                    <DatePicker.TableBody>
                      {picker.weeks.map((week, index) => (
                        <DatePicker.TableRow key={index}>
                          {week.map((day, dayIndex) => (
                            <DatePicker.TableCell key={dayIndex} value={day} className="p-0">
                              <DatePicker.TableCellTrigger className="mx-auto flex h-[28px] w-[30px] items-center justify-center rounded-pill text-body text-primary data-outside-range:text-muted data-selected:bg-accent data-selected:text-on-accent hover:bg-surface-sunken">
                                {day.day}
                              </DatePicker.TableCellTrigger>
                            </DatePicker.TableCell>
                          ))}
                        </DatePicker.TableRow>
                      ))}
                    </DatePicker.TableBody>
                  </DatePicker.Table>
                </>
              )}
            </DatePicker.Context>
          </DatePicker.View>
        </DatePicker.Content>
      </DatePicker.Positioner>
    </DatePicker.Root>
  );
}
