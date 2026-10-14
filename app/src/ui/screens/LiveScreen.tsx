// Live (plan 0022 §M; ux-writing "Live: the board"): the chosen flow's board. The flow decides
// what is on it (the run cards' place and one place per view node); the person decides where each
// sits and how big, in Edit layout.
//
// * Top of the board: the Flow picker, the board's tabs (`?tab=` in the address), Edit layout.
// * Edit layout: the bar (its instruction; Add tab; Hidden (n), each with Show; Done), and under
//   it the active tab's name field (double-clicking a tab's name goes there) and Remove tab. Each
//   change is kept at once by the shell (AppApi saveBoard, domain/board's operations): Done only
//   leaves the mode, and forgets which places were new, so "New on the board: …" is said once.
// * Every place has its ⋯ menu (Move to tab ›, Move earlier, Move later, Size S/M/L, Hide or Show),
//   the keyboard alternative to dragging a place or its corner (Slot).
// * The run cards and the questions and results inside the places are WI-0022-13's; until then
//   the run cards' place says the flow is waiting, and a view node's place says its name.
import { useState } from "react";
import type { AppApi, BoardChange, BoardLayout, FlowSummary } from "../contract";
import { Button } from "../components/atoms/Button";
import { Select } from "../components/atoms/Select";
import { TextField } from "../components/atoms/TextField";
import { DialogButtons } from "../components/molecules/DialogButtons";
import { InlineMessage } from "../components/molecules/InlineMessage";
import { Board } from "../components/organisms/Board";
import { Dialog } from "../components/organisms/Dialog";
import { EditLayoutBar } from "../components/organisms/EditLayoutBar";
import { EmptyState } from "../components/organisms/EmptyState";
import { Slot, type SlotChange, type SlotWords } from "../components/organisms/Slot";
import { routeHash } from "../routes";
import { useBoard, useFlows } from "../store";
import { sentence, t } from "../strings";

/** The run cards' place (domain/board RUNS_SLOT_ID): its id is a value, not a word. */
const RUNS_PLACE = "runs";

/** The id of the active tab's name field, which Add tab and a double-click put the cursor in. */
const TAB_NAME_FIELD = "board-tab-name";

const SLOT_WORDS: SlotWords = {
  arrange: t("board.arrange"),
  moveToTab: t("board.moveToTab"),
  moveEarlier: t("board.moveEarlier"),
  moveLater: t("board.moveLater"),
  size: t("board.sizeHeading"),
  hide: t("board.hide"),
  show: t("board.show"),
  hidden: t("board.hiddenPill"),
  hiddenTooltip: t("board.hidden.tooltip"),
};

/** A line with `*…*` around the names a person gave, the names in italics (ui/strings.ts). */
function Emphasised({ text }: { readonly text: string }) {
  return (
    <>
      {text.split("*").map((part, index) =>
        // Every other part sits between two stars.
        index % 2 === 1 ? <em key={index}>{part}</em> : part,
      )}
    </>
  );
}

/** A line with its stars dropped, where only plain text can go (a dialog's title). */
const plain = (text: string) => text.replace(/\*/g, "");

const goTo = (flowId: string, tabId: string | null): void => {
  window.location.hash = routeHash({ screen: "live", flowId, tabId });
};

export interface LiveScreenProps {
  readonly api: AppApi;
  /** The flow in the address; null shows the first flow (or the empty state when none). */
  readonly flowId: string | null;
  readonly tabId: string | null;
  readonly onGoToFlows: () => void;
}

export function LiveScreen({ api, flowId, tabId, onGoToFlows }: LiveScreenProps) {
  const flows = useFlows();
  if (flows.status === "loading") {
    return null;
  }
  if (flows.status === "refused") {
    return (
      <InlineMessage kind="warning">{sentence({ key: flows.refused.sentence })}</InlineMessage>
    );
  }
  const noFlow = (
    <EmptyState
      area="live-no-flow"
      message={t("live.empty")}
      actionLabel={t("live.empty.goToFlows")}
      onAction={onGoToFlows}
    />
  );
  const flow = flowId === null ? flows.value[0] : flows.value.find((each) => each.id === flowId);
  if (flow === undefined) {
    return flowId === null ? (
      noFlow
    ) : (
      <InlineMessage kind="warning">{t("flows.refused.gone")}</InlineMessage>
    );
  }
  return <FlowBoard key={flow.id} api={api} flow={flow} flows={flows.value} tabId={tabId} />;
}

interface FlowBoardProps {
  readonly api: AppApi;
  readonly flow: FlowSummary;
  readonly flows: readonly FlowSummary[];
  readonly tabId: string | null;
}

function FlowBoard({ api, flow, flows, tabId }: FlowBoardProps) {
  const board = useBoard(flow.id);
  const [editing, setEditing] = useState(false);
  /** The line of a change the shell refused ("A board needs at least one tab."). */
  const [problem, setProblem] = useState<string | null>(null);
  /** Remove tab asked about a tab that holds places: its id. */
  const [removing, setRemoving] = useState<string | null>(null);

  if (board.status === "loading") {
    return null;
  }
  if (board.status === "refused") {
    return (
      <InlineMessage kind="warning">
        {sentence({
          key: board.refused.sentence,
          ...(board.refused.params === undefined ? {} : { params: board.refused.params }),
        })}
      </InlineMessage>
    );
  }
  const { layout, fresh } = board.value;
  const tabs = [...layout.tabs].sort((a, b) => a.order - b.order);
  const active = tabs.find((tab) => tab.id === tabId) ?? tabs[0];
  if (active === undefined) {
    return null; // a kept board always has a tab (boards.json's schema)
  }
  const slotsOf = (id: string) =>
    layout.slots.filter((slot) => slot.tabId === id).sort((a, b) => a.order - b.order);
  const shown = slotsOf(active.id);
  const nameOf = (viewNodeId: string) =>
    viewNodeId === RUNS_PLACE
      ? t("board.place.runs")
      : (flow.viewNodes.find((node) => node.id === viewNodeId)?.name ?? viewNodeId);

  /** One change, kept by the shell; the board's push brings the new layout. */
  const change = async (what: BoardChange): Promise<BoardLayout | null> => {
    const answer = await api.saveBoard(flow.id, what);
    if (!answer.ok) {
      setProblem(
        sentence({
          key: answer.refused.sentence,
          ...(answer.refused.params === undefined ? {} : { params: answer.refused.params }),
        }),
      );
      return null;
    }
    setProblem(null);
    return answer.value.layout;
  };
  const slotChange = (viewNodeId: string, order: number, what: SlotChange): void => {
    switch (what.kind) {
      case "move":
        void change({ kind: "move", viewNodeId, tabId: active.id, order: order + what.by });
        return;
      case "move-to-tab":
        void change({
          kind: "move",
          viewNodeId,
          tabId: what.tabId,
          order: slotsOf(what.tabId).length,
        });
        return;
      case "size":
        void change({ kind: "size", viewNodeId, size: what.size });
        return;
      case "hide":
      case "show":
        void change({ kind: what.kind, viewNodeId });
        return;
    }
  };
  const addTab = async () => {
    const before = new Set(layout.tabs.map((tab) => tab.id));
    const after = await change({ kind: "add-tab", name: t("board.newTab") });
    const made = after?.tabs.find((tab) => !before.has(tab.id));
    if (made !== undefined) {
      goTo(flow.id, made.id);
      focusTabName();
    }
  };
  const removeTab = (id: string) => {
    setRemoving(null);
    void change({ kind: "remove-tab", tabId: id }).then((after) => {
      if (after !== null) {
        goTo(flow.id, null);
      }
    });
  };
  const hidden = layout.slots.filter((slot) => slot.hidden);

  const bar = (
    <>
      <EditLayoutBar
        message={
          <>
            <Emphasised text={t("board.editing", { flow: flow.name })} />
            {fresh.length === 0 ? null : (
              <span data-testid="board-new-places">
                {" "}
                <Emphasised text={t("board.newPlace", { place: fresh.map(nameOf).join(", ") })} />
              </span>
            )}
          </>
        }
        addTabLabel={t("board.addTab")}
        hiddenLabel={t("board.hidden", { n: hidden.length })}
        showLabel={t("board.show")}
        doneLabel={t("board.done")}
        hiddenPlaces={hidden.map((slot) => ({
          id: slot.viewNodeId,
          name: nameOf(slot.viewNodeId),
        }))}
        onAddTab={() => {
          void addTab();
        }}
        onShow={(id) => {
          void change({ kind: "show", viewNodeId: id });
        }}
        onDone={() => {
          setEditing(false);
          setProblem(null);
          void change({ kind: "seen" });
        }}
      />
      <TabTools
        key={active.id}
        name={active.name}
        onRename={(name) => {
          void change({ kind: "rename-tab", tabId: active.id, name });
        }}
        onRemove={() => {
          // A tab that holds places asks first; the last tab is the shell's to refuse.
          if (shown.length > 0 && tabs.length > 1) {
            setRemoving(active.id);
          } else {
            removeTab(active.id);
          }
        }}
      />
    </>
  );

  return (
    <div data-testid="live-board" data-flow={flow.id} className="flex flex-col gap-3">
      {problem === null ? null : <InlineMessage kind="warning">{problem}</InlineMessage>}
      <Board
        mode={editing ? "edit-layout" : "viewing"}
        label={t("board.of", { flow: flow.name })}
        tabs={tabs.map((tab) => ({ id: tab.id, name: tab.name }))}
        tabLabel={(tab) => (
          <span
            onDoubleClick={() => {
              if (editing) {
                focusTabName();
              }
            }}
          >
            {tab.name}
          </span>
        )}
        activeTab={active.id}
        onTabChange={(id) => {
          goTo(flow.id, id);
        }}
        flowPicker={
          <Select
            label={t("live.flowPicker")}
            value={flow.id}
            options={flows.map((each) => ({ value: each.id, label: each.name }))}
            onValueChange={(id) => {
              if (id !== null && id !== flow.id) {
                goTo(id, null);
              }
            }}
          />
        }
        editLayoutLabel={t("board.editLayout")}
        onEditLayout={() => {
          setEditing(true);
        }}
        bar={bar}
      >
        {shown.length === 0 || shown.every((slot) => slot.hidden && !editing) ? (
          <EmptyState area="empty-tab" message={t("live.tabEmpty")} className="col-span-12" />
        ) : (
          shown.map((slot, index) => (
            <Slot
              key={slot.viewNodeId}
              dragId={slot.viewNodeId}
              kind={slot.kind}
              size={slot.size}
              hidden={slot.hidden}
              editing={editing}
              name={nameOf(slot.viewNodeId)}
              words={SLOT_WORDS}
              tabs={tabs.filter((tab) => tab.id !== active.id)}
              first={index === 0}
              last={index === shown.length - 1}
              onChange={(what) => {
                slotChange(slot.viewNodeId, slot.order, what);
              }}
              onDropOn={(dragged) => {
                void change({
                  kind: "move",
                  viewNodeId: dragged,
                  tabId: active.id,
                  order: slot.order,
                });
              }}
            >
              <PlaceContent viewNodeId={slot.viewNodeId} name={nameOf(slot.viewNodeId)} />
            </Slot>
          ))
        )}
      </Board>
      <Dialog
        kind="neutral"
        open={removing !== null}
        title={plain(t("board.removeTab.title", { tab: active.name }))}
        body={t("board.removeTab.body")}
        onClose={() => {
          setRemoving(null);
        }}
        buttons={
          <DialogButtons
            kind="neutral"
            primaryLabel={t("board.removeTab")}
            cancelLabel={t("dialog.cancel")}
            onPrimary={() => {
              if (removing !== null) {
                removeTab(removing);
              }
            }}
            onCancel={() => {
              setRemoving(null);
            }}
          />
        }
      />
    </div>
  );
}

/** Put the cursor in the active tab's name field, its name selected for typing. */
function focusTabName(): void {
  // After the new tab's field is drawn.
  window.setTimeout(() => {
    const field = document.getElementById(TAB_NAME_FIELD);
    if (field instanceof HTMLInputElement) {
      field.focus();
      field.select();
    }
  }, 0);
}

/** Edit layout's tools for the active tab: its name, and Remove tab. */
function TabTools({
  name,
  onRename,
  onRemove,
}: {
  readonly name: string;
  readonly onRename: (name: string) => void;
  readonly onRemove: () => void;
}) {
  // Typed here and kept as it is typed; an empty name is not kept.
  const [draft, setDraft] = useState(name);
  return (
    <div data-testid="board-tab-tools" className="flex items-center gap-2">
      <TextField
        id={TAB_NAME_FIELD}
        label={t("board.tabName")}
        value={draft}
        className="w-[240px]"
        onValueChange={(value) => {
          setDraft(value);
          if (value.trim() !== "") {
            onRename(value);
          }
        }}
      />
      <Button kind="quiet" onClick={onRemove}>
        {t("board.removeTab")}
      </Button>
    </div>
  );
}

/** What a place shows until WI-0022-13 draws its run cards, questions and results. */
function PlaceContent({
  viewNodeId,
  name,
}: {
  readonly viewNodeId: string;
  readonly name: string;
}) {
  if (viewNodeId === RUNS_PLACE) {
    return <EmptyState area="live-idle" message={t("live.idle")} />;
  }
  return <p className="text-body font-medium text-primary">{name}</p>;
}
