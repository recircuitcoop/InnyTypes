// Configuration › Flows list (Penpot 04 Organisms › flows-list). The title, New flow (Primary,
// a menu: From a template, Blank canvas) above; then a List row per flow: its name, its On/Off
// switch, "Last run: …", its health pill, Edit, Run history and a ⋯ Icon button opening the
// Menu (Rename, Duplicate, Export flow…, a divider, Delete flow in danger). Delete flow opens the
// Destructive dialog, which the screen owns.
import { Button } from "../atoms/Button";
import { Icon } from "../atoms/Icon";
import { IconButton } from "../atoms/IconButton";
import { StatusPill, type StatusPillState } from "../atoms/StatusPill";
import { Switch } from "../atoms/Switch";
import { ListRow } from "../molecules/ListRow";
import { Menu, MenuSeparator } from "../molecules/Menu";
import { MenuItem } from "../molecules/MenuItem";
import { cx, variantAttributes } from "../variant";

/** One flow's row, already worded. */
export interface FlowsListRow {
  readonly id: string;
  readonly name: string;
  readonly on: boolean;
  /** "Last run: today, 14:20 · done". */
  readonly lastRun: string;
  /** The health phrase ("Ready", "1 step not set up", "Failing since Monday") and its pill. */
  readonly health: string;
  readonly healthState: StatusPillState;
}

/** The words the list draws around its rows, from ux-writing. */
export interface FlowsListWords {
  readonly title: string;
  readonly newFlow: string;
  readonly fromTemplate: string;
  readonly blankCanvas: string;
  readonly edit: string;
  readonly runHistory: string;
  readonly more: string;
  readonly rename: string;
  readonly duplicate: string;
  readonly exportFlow: string;
  readonly deleteFlow: string;
  /** The switch's spoken name for a flow ("Recordings to Anytype on"). */
  readonly switchLabel: (name: string) => string;
}

export type FlowAction =
  "edit" | "run-history" | "rename" | "duplicate" | "export" | "delete" | "on" | "off";

export interface FlowsListProps {
  readonly flows: readonly FlowsListRow[];
  readonly words: FlowsListWords;
  /** The row whose ⋯ menu is held open (the gallery, a screenshot). */
  readonly menuOpenFor?: string;
  readonly onAction?: (flowId: string, action: FlowAction) => void;
  readonly onNewFlow?: (from: "template" | "blank") => void;
  readonly className?: string;
}

export function FlowsList({
  flows,
  words,
  menuOpenFor,
  onAction,
  onNewFlow,
  className,
}: FlowsListProps) {
  return (
    <section
      {...variantAttributes("flows-list")}
      aria-label={words.title}
      className={cx("flex w-full flex-col gap-4", className)}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-title leading-tight font-semibold text-primary">{words.title}</h2>
        <Menu
          placement="bottom-end"
          trigger={
            <Button kind="primary">
              {words.newFlow}
              <Icon name="chevron-down" />
            </Button>
          }
        >
          <MenuItem
            value="template"
            icon="layout-grid"
            label={words.fromTemplate}
            onSelect={() => onNewFlow?.("template")}
          />
          <MenuItem
            value="blank"
            icon="plus"
            label={words.blankCanvas}
            onSelect={() => onNewFlow?.("blank")}
          />
        </Menu>
      </div>
      {/* No overflow clipping: a row's ⋯ menu opens below the list. */}
      <ul className="flex flex-col border-t border-surface-line">
        {flows.map((flow) => (
          <ListRow
            key={flow.id}
            kind="flow"
            title={flow.name}
            meta={flow.lastRun}
            status={
              <>
                <Switch
                  state={flow.on ? "on" : "off"}
                  label={words.switchLabel(flow.name)}
                  hideLabel
                  onStateChange={(state) => onAction?.(flow.id, state)}
                />
                <StatusPill state={flow.healthState}>{flow.health}</StatusPill>
              </>
            }
            primaryAction={
              <Button kind="secondary" onClick={() => onAction?.(flow.id, "edit")}>
                {words.edit}
              </Button>
            }
            moreActions={
              <>
                <Button kind="quiet" onClick={() => onAction?.(flow.id, "run-history")}>
                  {words.runHistory}
                </Button>
                <Menu
                  {...(menuOpenFor === flow.id ? { open: true } : {})}
                  trigger={
                    <IconButton
                      kind="quiet"
                      icon="ellipsis"
                      label={`${words.more}: ${flow.name}`}
                    />
                  }
                >
                  <MenuItem
                    value="rename"
                    icon="pencil"
                    label={words.rename}
                    onSelect={() => onAction?.(flow.id, "rename")}
                  />
                  <MenuItem
                    value="duplicate"
                    icon="copy"
                    label={words.duplicate}
                    onSelect={() => onAction?.(flow.id, "duplicate")}
                  />
                  <MenuItem
                    value="export"
                    icon="download"
                    label={words.exportFlow}
                    onSelect={() => onAction?.(flow.id, "export")}
                  />
                  <MenuSeparator />
                  <MenuItem
                    value="delete"
                    state="danger"
                    icon="trash"
                    label={words.deleteFlow}
                    onSelect={() => onAction?.(flow.id, "delete")}
                  />
                </Menu>
              </>
            }
          />
        ))}
      </ul>
    </section>
  );
}
