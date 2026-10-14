// Live (plan 0022 §M; ux-writing "Live: the board"): the chosen flow's board. The flow decides
// what is on it (the run cards' place and one place per view node); the person decides where each
// sits and how big, in Edit layout.
//
// * Top of the board: the Flow picker, the board's tabs (`?tab=` in the address), Edit layout.
// * Edit layout: the bar (its instruction; Add tab; Hidden (n), each with Show; Done), and under
//   it the active tab's name field (double-clicking a tab's name goes there) and Remove tab. Each
//   change is kept at once by the shell (AppApi saveBoard, domain/board's operations): Done only
//   leaves the mode. "New on the board: …" is said once: entering Edit layout shows the new
//   places and tells the shell they were seen, however Edit layout is left afterwards.
// * Every place has its ⋯ menu (Move to tab ›, Move earlier, Move later, Size S/M/L, Hide or Show),
//   the keyboard alternative to dragging a place or its corner (Slot).
// * The run cards and the questions and results inside the places are WI-0022-13's; until then
//   the run cards' place says the flow is waiting, and a view node's place says its name.
import { useEffect, useRef, useState } from "react";
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
import { useBoard, useBoardStore, useFlows } from "../store";
import { sentence, t } from "../strings";

/** The run cards' place (domain/board RUNS_SLOT_ID): its id is a value, not a word. */
const RUNS_PLACE = "runs";

/** How long typing in a tab's name pauses before the name is kept. */
const RENAME_PAUSE_MS = 300;

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
  const boardStore = useBoardStore(flow.id);
  const [editing, setEditing] = useState(false);
  /** The new places Edit layout names while it is open; the shell forgot them on entering. */
  const [announced, setAnnounced] = useState<readonly string[]>([]);
  /** The line of a change the shell refused ("A board needs at least one tab."). */
  const [problem, setProblem] = useState<string | null>(null);
  /** Remove tab asked about a tab that holds places: its id. */
  const [removing, setRemoving] = useState<string | null>(null);
  /**
   * The tab Add tab just made: its name field takes the cursor once, its name selected, when the
   * tab first appears, and is forgotten as soon as the cursor is there or the person does
   * anything else. A later board change never moves the cursor.
   */
  const [named, setNamed] = useState<string | null>(null);
  /**
   * The place a menu just moved or resized, and the board as it was drawn then: moving its
   * element drops the focus, so its ⋯ button takes it back once, when the changed board is drawn.
   */
  const [arranged, setArranged] = useState<{
    readonly id: string;
    readonly before: unknown;
  } | null>(null);
  const drawn = board.status === "ready" ? board.value : null;
  useEffect(() => {
    if (arranged === null || drawn === null || drawn === arranged.before) {
      return;
    }
    setArranged(null);
    const button = document.querySelector(
      `[data-place="${CSS.escape(arranged.id)}"] [data-component="icon-button"]`,
    );
    // Only when the move dropped the focus: anywhere the person put it stays.
    if (button instanceof HTMLElement && document.activeElement === document.body) {
      button.focus();
    }
  }, [arranged, drawn]);
  // The new tab's field is drawn once the board has the tab and the address names it.
  const namedDrawn =
    named !== null &&
    tabId === named &&
    drawn?.layout.tabs.some((tab) => tab.id === named) === true;
  useEffect(() => {
    if (!namedDrawn) {
      return;
    }
    // Once: the field may not be focusable yet (Ark's Tabs shows its panel a frame later), so
    // try each frame for a moment; stop when the cursor is there or the person does anything.
    let frames = 60;
    let frame = 0;
    const stop = () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", stop, true);
      document.removeEventListener("pointerdown", stop, true);
      setNamed(null);
    };
    const attempt = () => {
      focusTabName();
      frames -= 1;
      if (document.activeElement?.id === TAB_NAME_FIELD || frames <= 0) {
        stop();
        return;
      }
      frame = window.requestAnimationFrame(attempt);
    };
    document.addEventListener("keydown", stop, true);
    document.addEventListener("pointerdown", stop, true);
    attempt();
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", stop, true);
      document.removeEventListener("pointerdown", stop, true);
    };
  }, [namedDrawn]);

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

  /** One change, kept by the shell; its answer is drawn at once (the push follows). */
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
    boardStore.set(answer.value);
    return answer.value.layout;
  };
  const slotChange = (viewNodeId: string, order: number, what: SlotChange): void => {
    // A place moved to another tab, or hidden, leaves this tab's keyboard path.
    setArranged(
      what.kind === "move" || what.kind === "size" ? { id: viewNodeId, before: drawn } : null,
    );
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
      setNamed(made.id);
      goTo(flow.id, made.id);
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
            {announced.length === 0 ? null : (
              <span data-testid="board-new-places">
                {" "}
                <Emphasised
                  text={t("board.newPlace", { place: announced.map(nameOf).join(", ") })}
                />
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
          setNamed(null);
          setAnnounced([]);
          setProblem(null);
        }}
      />
      <TabTools
        key={active.id}
        name={active.name}
        onTyping={() => {
          setNamed(null);
        }}
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
          if (id !== named) {
            setNamed(null);
          }
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
          setAnnounced(fresh);
          if (fresh.length > 0) {
            // Said now, once: leaving by Done, by the Flow picker, by another screen or by
            // quitting never says it again.
            void change({ kind: "seen", viewNodeIds: fresh });
          }
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
  const field = document.getElementById(TAB_NAME_FIELD);
  if (field instanceof HTMLInputElement) {
    field.focus();
    field.select();
  }
}

/** Edit layout's tools for the active tab: its name, and Remove tab. */
function TabTools({
  name,
  onTyping,
  onRename,
  onRemove,
}: {
  readonly name: string;
  /** The person typed in the field. */
  readonly onTyping: () => void;
  readonly onRename: (name: string) => void;
  readonly onRemove: () => void;
}) {
  // Typed here and kept once typing pauses (or the field goes); an empty name is not kept.
  const [draft, setDraft] = useState(name);
  const pending = useRef<{ name: string; timer: number } | null>(null);
  const keep = useRef(onRename);
  keep.current = onRename;
  const flush = () => {
    if (pending.current !== null) {
      window.clearTimeout(pending.current.timer);
      keep.current(pending.current.name);
      pending.current = null;
    }
  };
  // The field goes with its tab, or with Edit layout: what was typed is kept all the same.
  useEffect(() => flush, []);
  return (
    <div data-testid="board-tab-tools" className="flex items-center gap-2">
      <TextField
        id={TAB_NAME_FIELD}
        label={t("board.tabName")}
        value={draft}
        className="w-[240px]"
        onValueChange={(value) => {
          onTyping();
          setDraft(value);
          if (pending.current !== null) {
            window.clearTimeout(pending.current.timer);
            pending.current = null;
          }
          if (value.trim() !== "") {
            pending.current = { name: value, timer: window.setTimeout(flush, RENAME_PAUSE_MS) };
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
