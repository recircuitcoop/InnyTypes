// Configuration › General section (Penpot 04 Organisms › general-section). Section: Anytype,
// Recorders and folders, AI apps, Start at login, Updates, Reports, Packages, Advanced. The
// title (20), its one-line state (secondary), then the section's fields and buttons; the page
// puts 24 between sections. Packages is full width (its rows are 64-high Package rows); the
// others keep to the reading width.
import { useId, type ReactNode } from "react";
import { cx, variantAttributes } from "../variant";

export type GeneralSectionKind =
  | "anytype"
  | "recorders"
  | "ai-apps"
  | "start-at-login"
  | "updates"
  | "reports"
  | "packages"
  | "advanced";

export interface GeneralSectionProps {
  readonly section: GeneralSectionKind;
  readonly title: string;
  /** The one-line state ("Connected · 8 spaces"). */
  readonly state: ReactNode;
  /** The section's fields, switches, rows and buttons. */
  readonly children?: ReactNode;
  readonly className?: string;
}

export function GeneralSection({
  section,
  title,
  state,
  children,
  className,
}: GeneralSectionProps) {
  const titleId = useId();
  return (
    <section
      {...variantAttributes("general-section", { section })}
      aria-labelledby={titleId}
      className={cx(
        "flex w-full flex-col gap-3",
        section !== "packages" && "max-w-[var(--inny-size-reading-width)]",
        className,
      )}
    >
      <div className="flex flex-col gap-1">
        <h2 id={titleId} className="text-title leading-tight font-semibold text-primary">
          {title}
        </h2>
        <div className="text-body text-secondary">{state}</div>
      </div>
      {children === undefined ? null : <div className="flex flex-col gap-3">{children}</div>}
    </section>
  );
}
