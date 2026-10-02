// The box every text-like control is drawn in (Text field, Textarea, Number field, Select,
// Combobox, Multi-select, Date field): panel fill, a hairline line, radius s; Focus adds the
// 2px focus ring, Error turns the line to the failed colour, Disabled fades it. One place, so the
// controls of one form cannot drift apart.
import { cx } from "./variant";

/** Penpot's State axis shared by the text-like controls. */
export type FieldState = "default" | "focus" | "filled" | "error" | "disabled";

/** The box's classes for a state; a Focus given as a prop draws the ring at rest. */
export function fieldBoxClass(
  state: FieldState,
  ...extra: readonly (string | false | undefined)[]
) {
  return cx(
    "flex w-full rounded-s border bg-surface-panel text-body text-primary",
    state === "error" ? "border-failed" : "border-surface-line",
    state === "focus"
      ? "outline-2 -outline-offset-1 outline-focus"
      : "focus-within:outline-2 focus-within:-outline-offset-1 focus-within:outline-focus",
    state === "disabled" && "cursor-not-allowed opacity-[var(--inny-opacity-disabled)]",
    ...extra,
  );
}

/** The text inside a box: no frame of its own, placeholder in the muted colour. */
export const FIELD_TEXT_CLASS =
  "min-w-0 flex-1 bg-transparent text-body text-primary outline-none placeholder:text-muted disabled:cursor-not-allowed";

/** A list that opens from a control (Select, Combobox, Menu, Date field): panel, hairline, radius m. */
export const POPUP_SURFACE_CLASS =
  "z-10 flex flex-col rounded-m border border-surface-line bg-surface-panel shadow-raised outline-none";

/** One option in such a list: 32 high, the highlighted one on the sunken fill. */
export const OPTION_CLASS =
  "flex h-[var(--inny-size-control)] cursor-pointer items-center gap-2 rounded-s px-3 text-body text-primary data-highlighted:bg-surface-sunken data-disabled:cursor-not-allowed data-disabled:opacity-[var(--inny-opacity-disabled)]";
