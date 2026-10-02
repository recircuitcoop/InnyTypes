// Sidebar (Penpot 04 Organisms › sidebar), the surface navigation. Mode: Setup, Main. 200 wide
// (size.nav-width), canvas fill, the status pill at the bottom. Main: two Nav items, Live and
// Configuration; Live's badge counts what waits for you. Setup: no Nav items, only the
// walkthrough's step list, the current step marked; it is never shown after the first run.
import type { ReactNode } from "react";
import { Icon } from "../atoms/Icon";
import { NavItem, type NavItemSurface } from "../molecules/NavItem";
import { cx, variantAttributes } from "../variant";

export type SidebarMode = "setup" | "main";

interface SidebarCommon {
  /** The navigation's name, read aloud ("InnyTypes"). */
  readonly label: string;
  /** The status pill at the bottom. */
  readonly status: ReactNode;
  readonly className?: string;
}

export interface SidebarMainProps extends SidebarCommon {
  readonly mode: "main";
  readonly active: NavItemSurface;
  readonly liveLabel: string;
  readonly configurationLabel: string;
  /** What waits for you, on Live's badge; none at zero. */
  readonly waiting?: number;
  readonly waitingLabel?: string;
  readonly onNavigate?: (surface: NavItemSurface) => void;
}

export interface SidebarSetupProps extends SidebarCommon {
  readonly mode: "setup";
  /** The walkthrough's screens, by title, in order. */
  readonly steps: readonly string[];
  /** The screen shown now, from 0. */
  readonly current: number;
}

export type SidebarProps = SidebarMainProps | SidebarSetupProps;

export function Sidebar(props: SidebarProps) {
  const { mode, label, status, className } = props;
  return (
    <nav
      {...variantAttributes("sidebar", { mode })}
      aria-label={label}
      className={cx(
        "flex h-full w-[var(--inny-size-nav-width)] shrink-0 flex-col gap-1 border-r border-surface-line bg-surface-canvas p-3",
        className,
      )}
    >
      {props.mode === "main" ? <MainItems {...props} /> : <SetupSteps {...props} />}
      <div className="mt-auto px-2 pt-3">{status}</div>
    </nav>
  );
}

function MainItems({
  active,
  liveLabel,
  configurationLabel,
  waiting = 0,
  waitingLabel,
  onNavigate,
}: SidebarMainProps) {
  return (
    <>
      <NavItem
        surface="live"
        state={active === "live" ? "active" : "default"}
        label={liveLabel}
        count={waiting}
        {...(waitingLabel === undefined ? {} : { countLabel: waitingLabel })}
        onClick={() => onNavigate?.("live")}
      />
      <NavItem
        surface="configuration"
        state={active === "configuration" ? "active" : "default"}
        label={configurationLabel}
        onClick={() => onNavigate?.("configuration")}
      />
    </>
  );
}

function SetupSteps({ steps, current }: SidebarSetupProps) {
  return (
    <ol className="flex flex-col gap-1">
      {steps.map((step, index) => (
        <li
          key={step}
          aria-current={index === current ? "step" : undefined}
          className={cx(
            "flex h-[36px] items-center gap-2 rounded-s px-2 text-body",
            index === current && "bg-accent-soft font-medium text-accent",
            index < current && "text-primary",
            index > current && "text-secondary",
          )}
        >
          {index < current ? (
            <Icon name="check" className="shrink-0" />
          ) : (
            <span aria-hidden="true" className="size-4 shrink-0" />
          )}
          <span className="truncate">{step}</span>
        </li>
      ))}
    </ol>
  );
}
