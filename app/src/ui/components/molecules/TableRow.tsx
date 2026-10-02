// Table row (Penpot 03 Molecules › table-row). Kind: Header, Row, Hover. A header is 36 high on
// the sunken fill, caption 12 medium secondary; a row 44 high on the panel, body 14; Hover is a
// row under the pointer. A hairline below each. It is a real <tr>: the caller's <table> sets the
// column widths.
import type { ReactNode } from "react";
import { cx, variantAttributes } from "../variant";

export type TableRowKind = "header" | "row" | "hover";

export interface TableRowProps {
  readonly kind: TableRowKind;
  /** One node per column, in the table's column order. */
  readonly cells: readonly ReactNode[];
  readonly className?: string;
}

export function TableRow({ kind, cells, className }: TableRowProps) {
  const header = kind === "header";
  return (
    <tr
      {...variantAttributes("table-row", { kind })}
      className={cx(
        "border-b border-surface-line text-left",
        header && "h-[36px] bg-surface-sunken text-caption font-medium text-secondary",
        kind === "row" &&
          "h-[44px] bg-surface-panel text-body text-primary hover:bg-surface-sunken",
        kind === "hover" && "h-[44px] bg-surface-sunken text-body text-primary",
        className,
      )}
    >
      {cells.map((cell, index) =>
        header ? (
          <th key={index} scope="col" className="px-4 font-medium">
            {cell}
          </th>
        ) : (
          <td key={index} className="px-4">
            {cell}
          </td>
        ),
      )}
    </tr>
  );
}
