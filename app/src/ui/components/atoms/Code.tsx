// Code (Penpot 02 Atoms › code). Kind: Inline, Block. IBM Plex Mono 13 on the sunken fill,
// radius s; for the few values a person must copy exactly (the AI apps endpoint, a config
// snippet).
import type { ReactNode } from "react";
import { cx, variantAttributes } from "../variant";

export type CodeKind = "inline" | "block";

export interface CodeProps {
  readonly kind: CodeKind;
  readonly children: ReactNode;
  readonly className?: string;
}

export function Code({ kind, children, className }: CodeProps) {
  if (kind === "block") {
    return (
      <pre
        {...variantAttributes("code", { kind })}
        className={cx(
          "overflow-x-auto rounded-s bg-surface-sunken p-3 font-mono text-[13px] leading-body text-primary",
          className,
        )}
      >
        <code>{children}</code>
      </pre>
    );
  }
  return (
    <code
      {...variantAttributes("code", { kind })}
      className={cx(
        "rounded-s bg-surface-sunken px-[6px] py-[2px] font-mono text-[13px] text-primary",
        className,
      )}
    >
      {children}
    </code>
  );
}
