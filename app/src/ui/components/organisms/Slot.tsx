// Slot (Penpot 04 Organisms › slot), on screen a "place". Kind: Card, Question, Result. Size: S,
// M, L. Hidden: Yes, No. It holds one view node's content: Card the flow's run cards, Question
// the question inline (the pop-out's fields), Result its result lines; Question and Result sit on
// a panel (radius m, raised shadow, 16 padding), a Run card brings its own. S spans 4 of the
// Board's 12 columns, M 6, L 12.
//
// In Edit layout every place has a dashed hairline outline and, top right, its ⋯ menu: the
// keyboard alternative to dragging (plan 0022 §P), Ark UI's Menu, so arrow keys, Enter and Escape
// work as in any menu: Move to tab ›, Move earlier, Move later, Size S/M/L, Hide (or Show). A
// hidden place is drawn only in Edit layout, at 40% and inert, with a "Hidden" pill; while viewing
// it is not drawn at all (its questions and failures still reach the person: domain/board/layout.ts).
import { Menu as ArkMenu } from "@ark-ui/react";
import type { ReactNode } from "react";
import { Icon } from "../atoms/Icon";
import { IconButton } from "../atoms/IconButton";
import { StatusPill } from "../atoms/StatusPill";
import { OPTION_CLASS, POPUP_SURFACE_CLASS } from "../field-box";
import { Menu, MenuSeparator } from "../molecules/Menu";
import { MenuItem } from "../molecules/MenuItem";
import { cx, variantAttributes } from "../variant";

export type SlotKind = "card" | "question" | "result";
export type SlotSize = "S" | "M" | "L";

/** The ⋯ menu's words, from ux-writing and plan §P. */
export interface SlotWords {
  /** The ⋯ button's spoken name, with the place's name after it ("Arrange: Transcript"). */
  readonly arrange: string;
  readonly moveToTab: string;
  readonly moveEarlier: string;
  readonly moveLater: string;
  /** "Size", read before the three sizes. */
  readonly size: string;
  readonly hide: string;
  readonly show: string;
  /** The pill on a hidden place. */
  readonly hidden: string;
}

/** What the ⋯ menu asks of the board; the board store applies it (domain layout's operations). */
export type SlotChange =
  | { readonly kind: "move"; readonly by: -1 | 1 }
  | { readonly kind: "move-to-tab"; readonly tabId: string }
  | { readonly kind: "size"; readonly size: SlotSize }
  | { readonly kind: "hide" }
  | { readonly kind: "show" };

export interface SlotTab {
  readonly id: string;
  readonly name: string;
}

export interface SlotProps {
  readonly kind: SlotKind;
  readonly size: SlotSize;
  readonly hidden?: boolean;
  /** Edit layout: the outline and the ⋯ menu; a hidden place is drawn only here. */
  readonly editing?: boolean;
  /** The place's name, for its menu ("Transcript", "Approve sending"). */
  readonly name: string;
  readonly words: SlotWords;
  /** The board's other tabs, for Move to tab. */
  readonly tabs?: readonly SlotTab[];
  /** First or last in its tab: Move earlier or Move later is disabled. */
  readonly first?: boolean;
  readonly last?: boolean;
  /** The ⋯ menu held open (the gallery, a screenshot). */
  readonly menuOpen?: boolean;
  readonly onChange?: (change: SlotChange) => void;
  readonly children: ReactNode;
  readonly className?: string;
}

const SPAN: Record<SlotSize, string> = { S: "col-span-4", M: "col-span-6", L: "col-span-12" };

const SIZES: readonly SlotSize[] = ["S", "M", "L"];

export function Slot({
  kind,
  size,
  hidden = false,
  editing = false,
  name,
  words,
  tabs = [],
  first = false,
  last = false,
  menuOpen,
  onChange,
  children,
  className,
}: SlotProps) {
  if (hidden && !editing) {
    return null;
  }
  return (
    <div
      {...variantAttributes("slot", { kind, size, hidden })}
      className={cx(
        "relative flex w-full flex-col",
        SPAN[size],
        editing && "outline-1 outline-offset-2 outline-muted outline-dashed",
        className,
      )}
    >
      {/* A hidden place is a preview in Edit layout, not usable content: inert, so it takes no
          focus or clicks and is not read out (its ⋯ menu and Hidden pill, outside, still are).
          Penpot draws it at 40%, which as live text would fail WCAG contrast; as an inactive
          component it is exempt (WCAG 1.4.3). */}
      <div className={cx("flex w-full flex-col", hidden && "opacity-40")} inert={hidden}>
        {kind === "card" ? (
          children
        ) : (
          <div className="flex w-full flex-col gap-3 rounded-m bg-surface-panel p-4 shadow-raised">
            {children}
          </div>
        )}
      </div>
      {editing ? (
        <div className="absolute top-2 right-2 flex items-center gap-2">
          {hidden ? <StatusPill state="off">{words.hidden}</StatusPill> : null}
          <Menu
            {...(menuOpen === undefined ? {} : { open: menuOpen })}
            trigger={
              <IconButton kind="secondary" icon="ellipsis" label={`${words.arrange}: ${name}`} />
            }
          >
            <SlotMenuItems
              size={size}
              hidden={hidden}
              words={words}
              tabs={tabs}
              first={first}
              last={last}
              {...(onChange === undefined ? {} : { onChange })}
            />
          </Menu>
        </div>
      ) : null}
    </div>
  );
}

function SlotMenuItems({
  size,
  hidden,
  words,
  tabs,
  first,
  last,
  onChange,
}: {
  readonly size: SlotSize;
  readonly hidden: boolean;
  readonly words: SlotWords;
  readonly tabs: readonly SlotTab[];
  readonly first: boolean;
  readonly last: boolean;
  readonly onChange?: (change: SlotChange) => void;
}) {
  return (
    <>
      {tabs.length === 0 ? null : (
        <ArkMenu.Root positioning={{ placement: "right-start", gutter: 4 }}>
          <ArkMenu.TriggerItem className={cx(OPTION_CLASS, "px-2")}>
            <Icon name="layout-grid" className="shrink-0" />
            <span className="flex-1">{words.moveToTab}</span>
            <Icon name="chevron-right" className="shrink-0 text-secondary" />
          </ArkMenu.TriggerItem>
          <ArkMenu.Positioner>
            <ArkMenu.Content className={cx(POPUP_SURFACE_CLASS, "w-[200px] p-1")}>
              {tabs.map((tab) => (
                <MenuItem
                  key={tab.id}
                  value={`tab-${tab.id}`}
                  label={tab.name}
                  onSelect={() => onChange?.({ kind: "move-to-tab", tabId: tab.id })}
                />
              ))}
            </ArkMenu.Content>
          </ArkMenu.Positioner>
        </ArkMenu.Root>
      )}
      <MenuItem
        value="earlier"
        icon="chevron-left"
        label={words.moveEarlier}
        {...(first ? { state: "disabled" as const } : {})}
        onSelect={() => onChange?.({ kind: "move", by: -1 })}
      />
      <MenuItem
        value="later"
        icon="chevron-right"
        label={words.moveLater}
        {...(last ? { state: "disabled" as const } : {})}
        onSelect={() => onChange?.({ kind: "move", by: 1 })}
      />
      <MenuSeparator />
      <ArkMenu.RadioItemGroup
        value={size}
        onValueChange={(details) => {
          const chosen = SIZES.find((candidate) => candidate === details.value);
          if (chosen !== undefined) {
            onChange?.({ kind: "size", size: chosen });
          }
        }}
      >
        <ArkMenu.ItemGroupLabel className="px-2 py-1 text-caption font-medium text-secondary">
          {words.size}
        </ArkMenu.ItemGroupLabel>
        {SIZES.map((option) => (
          <ArkMenu.RadioItem key={option} value={option} className={cx(OPTION_CLASS, "px-2")}>
            <span className="inline-flex size-4 shrink-0 items-center justify-center">
              <ArkMenu.ItemIndicator>
                <Icon name="check" />
              </ArkMenu.ItemIndicator>
            </span>
            <ArkMenu.ItemText className="flex-1">{`${words.size} ${option}`}</ArkMenu.ItemText>
          </ArkMenu.RadioItem>
        ))}
      </ArkMenu.RadioItemGroup>
      <MenuSeparator />
      {hidden ? (
        <MenuItem
          value="show"
          icon="eye"
          label={words.show}
          onSelect={() => onChange?.({ kind: "show" })}
        />
      ) : (
        <MenuItem
          value="hide"
          icon="eye-off"
          label={words.hide}
          onSelect={() => onChange?.({ kind: "hide" })}
        />
      )}
    </>
  );
}
