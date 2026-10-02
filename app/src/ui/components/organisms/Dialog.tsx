// Dialog (Penpot 04 Organisms › dialog). Kind: Neutral, Warning, Destructive. 440 wide
// (size.popout-width), panel fill, radius l (the question pop-out's, owner decision 9), popout shadow, a scrim behind; the title (20) with
// its icon, the body (14, secondary), then Dialog buttons. Warning and Destructive tint the
// title's icon only. Behaviour (focus trap, Escape, ARIA dialog with its title and description)
// is Ark UI's Dialog.
//
// The scrim is color.ink.0 (near-black) at opacity.scrim in both themes. FOR THE OWNER: the tokens
// have no semantic scrim colour, so this one place reads a ramp token directly, as the Foundations
// page does. A `surface.scrim` token (light and dark) would replace it; until then no semantic
// token gives a dark veil in both themes (text.primary turns light in dark, and surface.canvas
// vanishes over the canvas).
//
// `contained` draws the dialog and its scrim inside the nearest positioned box, not over the
// window, and without trapping focus: for the gallery, which shows the three side by side.
import { Dialog as ArkDialog } from "@ark-ui/react";
import type { ReactNode } from "react";
import { Icon, type IconName } from "../atoms/Icon";
import { cx, variantAttributes } from "../variant";

export type DialogKind = "neutral" | "warning" | "destructive";

export interface DialogProps {
  readonly kind: DialogKind;
  readonly open: boolean;
  readonly title: string;
  readonly body: string;
  /** The Dialog buttons molecule. */
  readonly buttons: ReactNode;
  /** Escape and the scrim: the same as Cancel. */
  readonly onClose?: () => void;
  readonly contained?: boolean;
  readonly className?: string;
}

const ICON: Record<DialogKind, { name: IconName; className: string }> = {
  neutral: { name: "info", className: "text-secondary" },
  warning: { name: "triangle-alert", className: "text-waiting" },
  destructive: { name: "trash", className: "text-failed" },
};

/**
 * Near-black at the scrim opacity, in both themes (see the header: no surface.scrim yet). The
 * colour is a style, not a class: Tailwind cannot tell a bare var() is a colour, and the
 * `color:` hint that would tell it is refused by the token check.
 */
const SCRIM_STYLE = { backgroundColor: "var(--inny-color-ink-0)" } as const;

export function Dialog({
  kind,
  open,
  title,
  body,
  buttons,
  onClose,
  contained = false,
  className,
}: DialogProps) {
  const icon = ICON[kind];
  const place = contained ? "absolute" : "fixed";
  return (
    <ArkDialog.Root
      open={open}
      role={kind === "neutral" ? "dialog" : "alertdialog"}
      modal={!contained}
      trapFocus={!contained}
      preventScroll={!contained}
      closeOnInteractOutside={!contained}
      onOpenChange={(details) => {
        if (!details.open) {
          onClose?.();
        }
      }}
    >
      <ArkDialog.Backdrop
        className={cx(place, "inset-0 opacity-[var(--inny-opacity-scrim)]")}
        style={SCRIM_STYLE}
      />
      <ArkDialog.Positioner className={cx(place, "inset-0 flex items-center justify-center p-4")}>
        <ArkDialog.Content
          {...variantAttributes("dialog", { kind })}
          className={cx(
            "flex w-[var(--inny-size-popout-width)] max-w-full flex-col gap-5 rounded-l bg-surface-panel p-5 shadow-popout outline-none",
            className,
          )}
        >
          <div className="flex flex-col gap-2">
            <ArkDialog.Title className="flex items-center gap-2 text-title leading-tight font-semibold text-primary">
              <Icon name={icon.name} size={20} className={cx("shrink-0", icon.className)} />
              {title}
            </ArkDialog.Title>
            <ArkDialog.Description className="text-body text-secondary">
              {body}
            </ArkDialog.Description>
          </div>
          {buttons}
        </ArkDialog.Content>
      </ArkDialog.Positioner>
    </ArkDialog.Root>
  );
}
