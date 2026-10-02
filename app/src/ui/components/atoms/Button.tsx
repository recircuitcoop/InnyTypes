// Button (Penpot 02 Atoms › button). Kind: Primary, Secondary, Quiet, Destructive. State:
// Default, Hover, Pressed, Disabled, Loading. Size: Default (32), Large (40). Radius s, padding
// 8 × 12, body 14 medium. A Hover or Pressed state given as a prop draws that state at rest
// (the gallery, a screenshot); Default draws the same on real hover and press.
import type { ButtonHTMLAttributes, MouseEventHandler, ReactNode, Ref } from "react";
import { cx, variantAttributes } from "../variant";
import { Icon } from "./Icon";

export type ButtonKind = "primary" | "secondary" | "quiet" | "destructive";
export type ButtonState = "default" | "hover" | "pressed" | "disabled" | "loading";
export type ButtonSize = "default" | "large";

/**
 * The rest of a button's attributes pass through, and its ref, so a Menu or Tooltip can use it
 * as its trigger (Ark UI's asChild hands the trigger's id, ARIA and handlers to its child).
 */
export interface ButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "className" | "onClick" | "children" | "type"
> {
  readonly ref?: Ref<HTMLButtonElement>;
  readonly kind: ButtonKind;
  readonly state?: ButtonState;
  readonly size?: ButtonSize;
  /** The label: what the button does, from strings.ts. */
  readonly children: ReactNode;
  readonly onClick?: MouseEventHandler<HTMLButtonElement>;
  readonly type?: "button" | "submit";
  readonly className?: string;
}

/**
 * Each kind's look in each drawn state, as the Penpot variants draw it. The sets never put two
 * utilities for one property on an element: which of two would win depends on Tailwind's
 * stylesheet order, not on the order here. `live` is the Default state, which shows hover and
 * press on the real pointer.
 *
 * Pressed on a filled button darkens it (brightness 90%) where Penpot draws it at 80% opacity:
 * on the light canvas 80% opacity takes the on-accent label below WCAG AA contrast, which the
 * gallery's axe pass fails. Hover keeps Penpot's 90% opacity, which passes.
 */
const LOOK: Record<ButtonKind, { live: string; hover: string; pressed: string; still: string }> = {
  primary: {
    live: "bg-accent text-on-accent hover:opacity-90 active:brightness-90",
    hover: "bg-accent text-on-accent opacity-90",
    pressed: "bg-accent text-on-accent brightness-90",
    still: "bg-accent text-on-accent",
  },
  secondary: {
    live: "border border-surface-line bg-surface-panel text-primary hover:bg-surface-sunken active:border-muted",
    hover: "border border-surface-line bg-surface-sunken text-primary",
    pressed: "border border-muted bg-surface-sunken text-primary",
    still: "border border-surface-line bg-surface-panel text-primary",
  },
  quiet: {
    live: "text-primary hover:bg-surface-sunken active:bg-surface-line",
    hover: "bg-surface-sunken text-primary",
    pressed: "bg-surface-line text-primary",
    still: "text-primary",
  },
  destructive: {
    live: "bg-failed text-on-accent hover:opacity-90 active:brightness-90",
    hover: "bg-failed text-on-accent opacity-90",
    pressed: "bg-failed text-on-accent brightness-90",
    still: "bg-failed text-on-accent",
  },
};

/** The look's classes for a state: Disabled and Loading draw the resting look, still. */
function lookOf(kind: ButtonKind, state: ButtonState): string {
  const look = LOOK[kind];
  switch (state) {
    case "default":
      return look.live;
    case "hover":
      return look.hover;
    case "pressed":
      return look.pressed;
    case "disabled":
    case "loading":
      return look.still;
  }
}

export function Button({
  kind,
  state = "default",
  size = "default",
  children,
  onClick,
  type = "button",
  className,
  ...rest
}: ButtonProps) {
  const inert = state === "disabled" || state === "loading";
  return (
    <button
      {...variantAttributes("button", { kind, state, size })}
      type={type}
      disabled={state === "disabled"}
      aria-disabled={inert ? true : undefined}
      aria-busy={state === "loading" ? true : undefined}
      {...rest}
      onClick={inert ? undefined : onClick}
      className={cx(
        "inline-flex shrink-0 items-center justify-center gap-2 rounded-s px-3 font-sans text-body font-medium leading-tight whitespace-nowrap",
        "transition-[opacity,background-color,border-color] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
        size === "large" ? "h-[var(--inny-size-control-large)]" : "h-[var(--inny-size-control)]",
        lookOf(kind, state),
        state === "disabled" && "cursor-not-allowed opacity-[var(--inny-opacity-disabled)]",
        state === "loading" && "cursor-progress",
        className,
      )}
    >
      {state === "loading" ? <Icon name="loader-circle" className="animate-spin" /> : null}
      {children}
    </button>
  );
}
