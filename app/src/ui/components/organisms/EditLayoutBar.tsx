// Edit-layout bar (Penpot 04 Organisms › edit-layout-bar). Full width under the Board's Tab
// strip, accent-soft fill, 48 high: the one-line instruction (body 14), then Add tab (Quiet),
// Hidden (n) (Quiet; it opens the list of hidden places, each with Show; not shown when none is
// hidden) and Done (Primary). Leaving with Done keeps the changes; there is no separate save.
import type { ReactNode } from "react";
import { Button } from "../atoms/Button";
import { Icon } from "../atoms/Icon";
import { Menu } from "../molecules/Menu";
import { MenuItem } from "../molecules/MenuItem";
import { cx, variantAttributes } from "../variant";

export interface HiddenPlace {
  readonly id: string;
  readonly name: string;
}

export interface EditLayoutBarProps {
  /** "Editing the layout of Recordings to Anytype. Drag to move, drag a corner to resize." */
  readonly message: ReactNode;
  readonly addTabLabel: string;
  /** "Hidden (2)", worded by the caller with the count. */
  readonly hiddenLabel: string;
  /** "Show", after each hidden place's name. */
  readonly showLabel: string;
  readonly doneLabel: string;
  readonly hiddenPlaces: readonly HiddenPlace[];
  readonly onAddTab?: () => void;
  readonly onShow?: (placeId: string) => void;
  readonly onDone?: () => void;
  readonly className?: string;
}

export function EditLayoutBar({
  message,
  addTabLabel,
  hiddenLabel,
  showLabel,
  doneLabel,
  hiddenPlaces,
  onAddTab,
  onShow,
  onDone,
  className,
}: EditLayoutBarProps) {
  return (
    <div
      {...variantAttributes("edit-layout-bar")}
      className={cx(
        "flex h-[48px] w-full items-center gap-2 bg-accent-soft px-4 text-body text-primary",
        className,
      )}
    >
      <p className="flex-1 truncate">{message}</p>
      <Button kind="quiet" {...(onAddTab === undefined ? {} : { onClick: onAddTab })}>
        <Icon name="plus" />
        {addTabLabel}
      </Button>
      {hiddenPlaces.length === 0 ? null : (
        <Menu
          trigger={
            <Button kind="quiet">
              <Icon name="eye-off" />
              {hiddenLabel}
            </Button>
          }
        >
          {hiddenPlaces.map((place) => (
            <MenuItem
              key={place.id}
              value={place.id}
              icon="eye"
              label={`${place.name} · ${showLabel}`}
              onSelect={() => onShow?.(place.id)}
            />
          ))}
        </Menu>
      )}
      <Button kind="primary" {...(onDone === undefined ? {} : { onClick: onDone })}>
        {doneLabel}
      </Button>
    </div>
  );
}
