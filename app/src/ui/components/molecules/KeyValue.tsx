// Key-value (Penpot 03 Molecules › key-value). Kind: Text, Mono, Pill. 32 high: the key in the
// secondary colour in a 160 column, then the value: plain text, a value to copy in Code, or a
// Status pill. The contract's `fields` (key → value) are drawn with it.
import type { ReactNode } from "react";
import { Code } from "../atoms/Code";
import { cx, variantAttributes } from "../variant";

export type KeyValueKind = "text" | "mono" | "pill";

export interface KeyValueProps {
  readonly kind: KeyValueKind;
  readonly label: ReactNode;
  /** Text for Text and Mono; a Status pill for Pill. */
  readonly value: ReactNode;
  readonly className?: string;
}

export function KeyValue({ kind, label, value, className }: KeyValueProps) {
  return (
    <div
      {...variantAttributes("key-value", { kind })}
      className={cx("flex min-h-[32px] w-full items-center gap-3 text-body", className)}
    >
      <span className="w-[160px] shrink-0 text-secondary">{label}</span>
      <span className="min-w-0 flex-1 text-primary">
        {kind === "mono" ? <Code kind="inline">{value}</Code> : value}
      </span>
    </div>
  );
}
