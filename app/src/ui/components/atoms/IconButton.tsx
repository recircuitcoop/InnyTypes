// Icon button (Penpot 02 Atoms › icon-button). Kind: Secondary, Quiet. State: Default, Hover,
// Pressed, Disabled. 32 square, radius s, a 16 icon. It has no visible words, so `label` is
// required: it is the button's accessible name (from strings.ts).
import type { ButtonHTMLAttributes, MouseEventHandler, Ref } from "react";
import { cx, variantAttributes } from "../variant";
import { Icon, type IconName } from "./Icon";

export type IconButtonKind = "secondary" | "quiet";
export type IconButtonState = "default" | "hover" | "pressed" | "disabled";

/**
 * The rest of a button's attributes pass through, and its ref, so a Menu or Tooltip can use it
 * as its trigger (Ark UI's asChild hands the trigger's id, ARIA and handlers to its child).
 */
export interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "className" | "onClick" | "children"
> {
  readonly ref?: Ref<HTMLButtonElement>;
  readonly kind: IconButtonKind;
  readonly state?: IconButtonState;
  readonly icon: IconName;
  readonly label: string;
  readonly onClick?: MouseEventHandler<HTMLButtonElement>;
  readonly className?: string;
}

/** Each kind's look in each state; never two utilities for one property (see Button). */
const LOOK: Record<IconButtonKind, Record<IconButtonState, string>> = {
  secondary: {
    default:
      "border border-surface-line bg-surface-panel hover:bg-surface-sunken active:border-muted",
    hover: "border border-surface-line bg-surface-sunken",
    pressed: "border border-muted bg-surface-sunken",
    disabled: "border border-surface-line bg-surface-panel",
  },
  quiet: {
    default: "hover:bg-surface-sunken active:bg-surface-line",
    hover: "bg-surface-sunken",
    pressed: "bg-surface-line",
    disabled: "",
  },
};

export function IconButton({
  kind,
  state = "default",
  icon,
  label,
  onClick,
  className,
  ...rest
}: IconButtonProps) {
  return (
    <button
      {...variantAttributes("icon-button", { kind, state })}
      type="button"
      aria-label={label}
      disabled={state === "disabled"}
      {...rest}
      onClick={onClick}
      className={cx(
        "inline-flex size-[var(--inny-size-control)] shrink-0 items-center justify-center rounded-s text-primary",
        "transition-[background-color,border-color] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
        LOOK[kind][state],
        state === "disabled" && "cursor-not-allowed opacity-[var(--inny-opacity-disabled)]",
        className,
      )}
    >
      <Icon name={icon} />
    </button>
  );
}
