// Kbd (Penpot 02 Atoms › kbd). Key: Esc, ⌘, Enter. A key cap: mono 13, sunken fill, hairline,
// radius s. The Penpot axis is "Key"; the prop is keyName because React reserves `key`.
import { cx, variantAttributes } from "../variant";

export interface KbdProps {
  /** The key as written on the cap ("Esc", "⌘", "Enter"). */
  readonly keyName: string;
  readonly className?: string;
}

export function Kbd({ keyName, className }: KbdProps) {
  return (
    <kbd
      {...variantAttributes("kbd", { key: keyName })}
      className={cx(
        "inline-flex h-[20px] shrink-0 items-center rounded-s border border-surface-line bg-surface-sunken px-[6px] font-mono text-[13px] leading-none text-secondary",
        className,
      )}
    >
      {keyName}
    </kbd>
  );
}
