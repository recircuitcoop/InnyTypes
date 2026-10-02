// Run history (Penpot 04 Organisms › run-history), a Configuration screen per flow. State: Rows,
// Selected, Empty, Filtered-empty. The title "Run history" with the flow's name and "← Flows";
// the retention caption; the filter row (a Segmented control All · Waiting · Failed · Done, the
// date range Select, a Search field); then the table of Table rows: a checkbox, When, Event,
// Took, the State pill, the Notes pills and the row's ⋯ menu (Open result, Re-run, Re-run from… ›
// with the flow's steps, Open in Anytype, a divider, Delete run in danger). A failed row carries
// its sentence under the event, in the failed colour. With rows checked, the bar "3 runs
// selected · Re-run · Delete · Clear selection" (accent-soft, 48 high) sits above the table.
//
// The state follows the rows, never a prop that could disagree with them: no rows is Empty, or
// Filtered-empty while a filter is narrowing; a checked row is Selected.
import { Menu as ArkMenu } from "@ark-ui/react";
import { Button } from "../atoms/Button";
import { Checkbox } from "../atoms/Checkbox";
import { Icon } from "../atoms/Icon";
import { IconButton } from "../atoms/IconButton";
import { Link } from "../atoms/Link";
import { Select, type SelectOption } from "../atoms/Select";
import { StatusPill, type StatusPillState } from "../atoms/StatusPill";
import { OPTION_CLASS, POPUP_SURFACE_CLASS } from "../field-box";
import { Menu, MenuSeparator } from "../molecules/Menu";
import { MenuItem } from "../molecules/MenuItem";
import { SearchField } from "../molecules/SearchField";
import { SegmentedControl, type SegmentOption } from "../molecules/SegmentedControl";
import { TableRow } from "../molecules/TableRow";
import { cx, variantAttributes } from "../variant";

export type RunHistoryState = "rows" | "selected" | "empty" | "filtered-empty";

/** One run, already worded. */
export interface RunHistoryRow {
  readonly id: string;
  /** "Tuesday 14:20". */
  readonly when: string;
  /** The recording's or file's name. */
  readonly event: string;
  /** "12 min". */
  readonly took: string;
  readonly state: StatusPillState;
  readonly stateLabel: string;
  /** "2 notes" (Off) and "1 warning" (Waiting), when present. */
  readonly notes?: readonly { readonly state: StatusPillState; readonly label: string }[];
  /** "Failed at Transcribe: Mistral refused the key." */
  readonly failure?: string;
  /** Whether it has an Anytype result to open. */
  readonly inAnytype?: boolean;
  readonly selected?: boolean;
}

/** The screen's words, from ux-writing. */
export interface RunHistoryWords {
  readonly title: string;
  readonly back: string;
  readonly retention: string;
  readonly filterLabel: string;
  readonly rangeLabel: string;
  readonly search: string;
  readonly clearSearch: string;
  readonly columns: {
    readonly select: string;
    readonly when: string;
    readonly event: string;
    readonly took: string;
    readonly state: string;
    readonly notes: string;
    readonly more: string;
  };
  /** "3 runs selected". */
  readonly selected: (count: number) => string;
  readonly rerun: string;
  readonly delete: string;
  readonly clearSelection: string;
  readonly openResult: string;
  readonly rerunFrom: string;
  readonly openInAnytype: string;
  readonly deleteRun: string;
  /** The checkbox's spoken name for a run ("Select 2026-09-29 coaching"). */
  readonly selectRun: (event: string) => string;
}

export type RunHistoryAction =
  | { readonly kind: "open-result" | "rerun" | "open-in-anytype" | "delete" }
  | { readonly kind: "rerun-from"; readonly step: string };

export interface RunHistoryProps {
  readonly flowName: string;
  readonly rows: readonly RunHistoryRow[];
  readonly words: RunHistoryWords;
  readonly filters: readonly SegmentOption[];
  readonly filter: string;
  readonly ranges: readonly SelectOption[];
  readonly range: string;
  readonly query: string;
  /** A filter or a search is narrowing the rows. */
  readonly filtered: boolean;
  /** The sentence when there are no rows (empty, or filtered empty). */
  readonly emptyMessage: string;
  /** The flow's steps in order, for Re-run from… ›. */
  readonly steps: readonly string[];
  readonly backHref: string;
  /** The row whose ⋯ menu is held open (the gallery, a screenshot). */
  readonly menuOpenFor?: string;
  readonly onFilter?: (value: string) => void;
  readonly onRange?: (value: string | null) => void;
  readonly onQuery?: (value: string) => void;
  readonly onSelect?: (runIds: readonly string[], selected: boolean) => void;
  readonly onAction?: (runId: string, action: RunHistoryAction) => void;
  readonly onSelectionAction?: (action: "rerun" | "delete" | "clear") => void;
  readonly className?: string;
}

export function runHistoryState(rows: readonly RunHistoryRow[], filtered: boolean) {
  if (rows.length === 0) return filtered ? "filtered-empty" : "empty";
  return rows.some((row) => row.selected === true) ? "selected" : "rows";
}

export function RunHistory(props: RunHistoryProps) {
  const { flowName, rows, words, filtered, emptyMessage, backHref, className } = props;
  const state: RunHistoryState = runHistoryState(rows, filtered);
  const selectedCount = rows.filter((row) => row.selected === true).length;
  return (
    <section
      {...variantAttributes("run-history", { state })}
      aria-label={`${words.title}: ${flowName}`}
      className={cx("flex w-full flex-col gap-4", className)}
    >
      <header className="flex flex-col gap-1">
        <div className="flex items-baseline gap-3">
          <h2 className="text-title leading-tight font-semibold text-primary">{words.title}</h2>
          <span className="text-body text-secondary">{flowName}</span>
          <Link href={backHref} className="ml-auto">
            {words.back}
          </Link>
        </div>
        <p className="text-caption text-secondary">{words.retention}</p>
      </header>
      <Filters {...props} />
      {state === "selected" ? (
        <div className="flex h-[48px] items-center gap-2 rounded-s bg-accent-soft px-4 text-body text-primary">
          <span className="flex-1 font-medium">{words.selected(selectedCount)}</span>
          <Button kind="secondary" onClick={() => props.onSelectionAction?.("rerun")}>
            {words.rerun}
          </Button>
          <Button kind="secondary" onClick={() => props.onSelectionAction?.("delete")}>
            {words.delete}
          </Button>
          <Button kind="quiet" onClick={() => props.onSelectionAction?.("clear")}>
            {words.clearSelection}
          </Button>
        </div>
      ) : null}
      {rows.length === 0 ? (
        <p className="pt-7 text-center text-body text-secondary">{emptyMessage}</p>
      ) : (
        <RunTable {...props} selectedCount={selectedCount} />
      )}
    </section>
  );
}

function Filters({
  words,
  filters,
  filter,
  ranges,
  range,
  query,
  onFilter,
  onRange,
  onQuery,
}: RunHistoryProps) {
  return (
    <div className="flex items-center gap-3">
      <SegmentedControl
        label={words.filterLabel}
        options={filters}
        value={filter}
        {...(onFilter === undefined ? {} : { onValueChange: onFilter })}
      />
      <div className="w-[180px] shrink-0">
        <Select
          label={words.rangeLabel}
          options={ranges}
          value={range}
          {...(onRange === undefined ? {} : { onValueChange: onRange })}
        />
      </div>
      <SearchField
        className="ml-auto max-w-[240px]"
        value={query}
        placeholder={words.search}
        label={words.search}
        clearLabel={words.clearSearch}
        {...(onQuery === undefined ? {} : { onValueChange: onQuery })}
      />
    </div>
  );
}

function RunTable({
  rows,
  words,
  steps,
  menuOpenFor,
  onSelect,
  onAction,
  selectedCount,
}: RunHistoryProps & { readonly selectedCount: number }) {
  const all = selectedCount === rows.length ? "on" : selectedCount === 0 ? "off" : "mixed";
  return (
    <table className="w-full border-collapse">
      <thead>
        <TableRow
          kind="header"
          cells={[
            <Checkbox
              key="all"
              state={all}
              label={words.columns.select}
              hideLabel
              onStateChange={(next) =>
                onSelect?.(
                  rows.map((row) => row.id),
                  next === "on",
                )
              }
            />,
            words.columns.when,
            words.columns.event,
            words.columns.took,
            words.columns.state,
            words.columns.notes,
            <span key="more" className="sr-only">
              {words.columns.more}
            </span>,
          ]}
        />
      </thead>
      <tbody>
        {rows.map((row) => (
          <TableRow
            key={row.id}
            kind="row"
            cells={[
              <Checkbox
                key="select"
                state={row.selected === true ? "on" : "off"}
                label={words.selectRun(row.event)}
                hideLabel
                onStateChange={(next) => onSelect?.([row.id], next === "on")}
              />,
              <span key="when" className="whitespace-nowrap">
                {row.when}
              </span>,
              <div key="event" className="flex flex-col py-2">
                <span>{row.event}</span>
                {row.failure === undefined ? null : (
                  <span className="text-caption text-failed">{row.failure}</span>
                )}
              </div>,
              row.took,
              <StatusPill key="state" state={row.state}>
                {row.stateLabel}
              </StatusPill>,
              <span key="notes" className="flex gap-1">
                {(row.notes ?? []).map((note) => (
                  <StatusPill key={note.label} state={note.state}>
                    {note.label}
                  </StatusPill>
                ))}
              </span>,
              <RowMenu
                key="more"
                row={row}
                words={words}
                steps={steps}
                open={menuOpenFor === row.id}
                {...(onAction === undefined ? {} : { onAction })}
              />,
            ]}
          />
        ))}
      </tbody>
    </table>
  );
}

function RowMenu({
  row,
  words,
  steps,
  open,
  onAction,
}: {
  readonly row: RunHistoryRow;
  readonly words: RunHistoryWords;
  readonly steps: readonly string[];
  readonly open: boolean;
  readonly onAction?: (runId: string, action: RunHistoryAction) => void;
}) {
  const act = (action: RunHistoryAction) => () => onAction?.(row.id, action);
  return (
    <Menu
      {...(open ? { open: true } : {})}
      trigger={
        <IconButton kind="quiet" icon="ellipsis" label={`${words.columns.more}: ${row.event}`} />
      }
    >
      <MenuItem
        value="open"
        icon="external-link"
        label={words.openResult}
        onSelect={act({ kind: "open-result" })}
      />
      <MenuItem
        value="rerun"
        icon="rotate-cw"
        label={words.rerun}
        onSelect={act({ kind: "rerun" })}
      />
      <ArkMenu.Root positioning={{ placement: "left-start", gutter: 4 }}>
        <ArkMenu.TriggerItem className={cx(OPTION_CLASS, "px-2")}>
          <Icon name="rotate-cw" className="shrink-0" />
          <span className="flex-1">{words.rerunFrom}</span>
          <Icon name="chevron-right" className="shrink-0 text-secondary" />
        </ArkMenu.TriggerItem>
        <ArkMenu.Positioner>
          <ArkMenu.Content className={cx(POPUP_SURFACE_CLASS, "w-[200px] p-1")}>
            {steps.map((step) => (
              <MenuItem
                key={step}
                value={`from-${step}`}
                label={step}
                onSelect={act({ kind: "rerun-from", step })}
              />
            ))}
          </ArkMenu.Content>
        </ArkMenu.Positioner>
      </ArkMenu.Root>
      {row.inAnytype === true ? (
        <MenuItem
          value="anytype"
          icon="external-link"
          label={words.openInAnytype}
          onSelect={act({ kind: "open-in-anytype" })}
        />
      ) : null}
      <MenuSeparator />
      <MenuItem
        value="delete"
        state="danger"
        icon="trash"
        label={words.deleteRun}
        onSelect={act({ kind: "delete" })}
      />
    </Menu>
  );
}
