// The gallery's frame: a group per Penpot component (its section on the page and its own
// screenshot in gallery.e2e.ts), and a cell per variant labelled with the data-variant the
// component actually rendered, read from the DOM, so a label can never disagree with the code.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cx } from "../components/variant";

export interface GroupProps {
  /** The Penpot component name, also the screenshot's name. */
  readonly component: string;
  readonly children: ReactNode;
  /** Cells side by side (default) or one per line, for the wide ones. */
  readonly stack?: boolean;
}

export function Group({ component, children, stack = false }: GroupProps) {
  return (
    <section
      data-gallery-group={component}
      aria-labelledby={`group-${component}`}
      className="flex flex-col gap-3 rounded-m bg-surface-canvas p-4"
    >
      <h3 id={`group-${component}`} className="font-mono text-body font-medium text-primary">
        {component}
      </h3>
      <div className={cx("flex gap-4", stack ? "flex-col" : "flex-row flex-wrap items-start")}>
        {children}
      </div>
    </section>
  );
}

export interface CellProps {
  /** The data-component whose data-variant labels the cell. */
  readonly of: string;
  readonly children: ReactNode;
  /** The Penpot frame's width, when the component fills its container. */
  readonly width?: number;
  /** Room below for a list or calendar that opens from the control. */
  readonly height?: number;
}

export function Cell({ of, children, width, height }: CellProps) {
  const body = useRef<HTMLDivElement>(null);
  const [label, setLabel] = useState("");
  useLayoutEffect(() => {
    // Every instance in the cell (a menu shows its items' states together), each once.
    const variants = [...(body.current?.querySelectorAll(`[data-component="${of}"]`) ?? [])].map(
      (element) => element.getAttribute("data-variant") ?? "",
    );
    setLabel([...new Set(variants)].join(" · "));
  }, [of]);
  return (
    <figure data-gallery-cell={of} className="m-0 flex flex-col gap-2">
      <div
        ref={body}
        className="flex items-start"
        style={{
          ...(width === undefined ? {} : { width: `${String(width)}px` }),
          ...(height === undefined ? {} : { minHeight: `${String(height)}px` }),
        }}
      >
        {children}
      </div>
      <figcaption data-gallery-label className="font-mono text-caption text-secondary">
        {label === "" ? "(no variants)" : label}
      </figcaption>
    </figure>
  );
}

export function Page({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-title font-semibold text-primary">{title}</h2>
      {children}
    </section>
  );
}

/**
 * False on the first render, true from the next: for a pop-up the gallery holds open. Ark UI's
 * Menu places its list when it opens, so one that mounts already open is never placed; opening it
 * a frame later goes through that transition.
 */
export function useOpenedAfterMount(): boolean {
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    setOpened(true);
  }, []);
  return opened;
}
