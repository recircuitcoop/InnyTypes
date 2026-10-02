// Link (Penpot 02 Atoms › link). State: Default, Hover, Visited. Accent text, underlined on
// hover; a visited link in the secondary text colour.
import type { MouseEventHandler, ReactNode } from "react";
import { cx, variantAttributes } from "../variant";

export type LinkState = "default" | "hover" | "visited";

export interface LinkProps {
  readonly state?: LinkState;
  readonly href: string;
  readonly children: ReactNode;
  readonly onClick?: MouseEventHandler<HTMLAnchorElement>;
  readonly className?: string;
}

export function Link({ state = "default", href, children, onClick, className }: LinkProps) {
  return (
    <a
      {...variantAttributes("link", { state })}
      href={href}
      onClick={onClick}
      className={cx(
        "rounded-s text-body underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
        state === "visited" ? "text-secondary" : "text-accent",
        state === "hover" && "underline",
        state === "default" && "hover:underline",
        className,
      )}
    >
      {children}
    </a>
  );
}
