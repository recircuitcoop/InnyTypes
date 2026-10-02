// Package row (Penpot 04 Organisms › package-row). State: Registered, Not registered,
// Installing, Verifying, Failed check, Update available, Updating, Updated (rollback offered),
// From a folder. 64 high, two lines, 16 side padding, a hairline below. Line 1: the name (body
// medium), the version (mono), "by publisher" (caption) and, where they apply, the "From a
// folder: path" and "Unsigned" captions. Line 2: up to three Status pills with their words, each
// with the "checked when" caption beside it. The actions sit at the right, 8 apart.
//
// A row never shows a state InnyTypes has not verified: every pill comes with when it was
// checked (domain/packages/states.ts carries a verifiedAt on each), and the caller words both.
import type { ReactNode } from "react";
import { StatusPill, type StatusPillState } from "../atoms/StatusPill";
import { cx, variantAttributes } from "../variant";

export type PackageRowState =
  | "registered"
  | "not-registered"
  | "installing"
  | "verifying"
  | "failed-check"
  | "update-available"
  | "updating"
  | "updated"
  | "from-a-folder";

/** One verified fact on line 2: its pill and when it was checked. */
export interface PackageFacet {
  readonly state: StatusPillState;
  /** "Registered", "Installing · 60%", "Update to 0.4 available". */
  readonly label: string;
  /** "checked today 09:14". */
  readonly checked: string;
}

export interface PackageRowProps {
  readonly state: PackageRowState;
  readonly name: string;
  readonly version: string;
  /** "by l1nx". */
  readonly publisher: string;
  /** "From a folder: ~/packages/innyrize", "Unsigned". */
  readonly captions?: readonly string[];
  /** At most three. */
  readonly facets: readonly PackageFacet[];
  /** Register/Unregister (Quiet), Install/Remove (Secondary), Update (Primary) or Go back. */
  readonly actions: ReactNode;
  readonly className?: string;
}

export function PackageRow({
  state,
  name,
  version,
  publisher,
  captions = [],
  facets,
  actions,
  className,
}: PackageRowProps) {
  return (
    <li
      {...variantAttributes("package-row", { state })}
      className={cx(
        "flex h-[64px] w-full items-center gap-4 border-b border-surface-line bg-surface-panel px-4",
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-baseline gap-2">
          <span className="text-body font-medium text-primary">{name}</span>
          <span className="font-mono text-caption text-secondary">{version}</span>
          <span className="text-caption text-secondary">{publisher}</span>
          {captions.map((caption) => (
            <span key={caption} className="truncate text-caption text-secondary">
              {caption}
            </span>
          ))}
        </div>
        <ul className="flex items-center gap-3">
          {facets.slice(0, 3).map((facet) => (
            <li key={facet.label} className="flex items-center gap-1">
              <StatusPill state={facet.state}>{facet.label}</StatusPill>
              <span className="text-caption text-secondary">{facet.checked}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex shrink-0 items-center gap-2">{actions}</div>
    </li>
  );
}
