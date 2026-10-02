// Penpot page 04 Organisms in the gallery, part one: what Live and the pop-outs are made of.
// Every variant, with content from three unrelated flows (design-system "Sample data proves the
// genericity"); the one Board holds ONE flow, as a board always does.
import { useState, type ReactNode } from "react";
import { Button } from "../components/atoms/Button";
import { Select } from "../components/atoms/Select";
import { TextField } from "../components/atoms/TextField";
import { DialogButtons } from "../components/molecules/DialogButtons";
import { Field } from "../components/molecules/Field";
import { Board, type BoardMode } from "../components/organisms/Board";
import { Dialog } from "../components/organisms/Dialog";
import { EditLayoutBar } from "../components/organisms/EditLayoutBar";
import { EmptyState } from "../components/organisms/EmptyState";
import { QuestionPopout } from "../components/organisms/QuestionPopout";
import { RunCard } from "../components/organisms/RunCard";
import { RuntimeBanner } from "../components/organisms/RuntimeBanner";
import {
  Slot,
  type SlotChange,
  type SlotKind,
  type SlotSize,
  type SlotWords,
} from "../components/organisms/Slot";
import { ResultLine } from "../components/molecules/ResultLine";
import { resultParts, wordTitle, type CardTitle, type RunResultLine } from "../components/wording";
import { Cell, Group, Page } from "./frame";
import {
  BOARD_CARDS,
  CAMERA_CARD,
  FLOWS,
  INVOICE_RESULTS,
  PHOTO_RESULTS,
  RECORDING_RESULTS,
  RUN_CARDS,
  SLOT_CARDS,
  type RunCardSample,
} from "./samples";

/** The place's words: ux-writing ("Hide", "Show", "Hidden") and plan 0022 §P's keyboard menu. */
export const SLOT_WORDS: SlotWords = {
  arrange: "Arrange",
  moveToTab: "Move to tab",
  moveEarlier: "Move earlier",
  moveLater: "Move later",
  size: "Size",
  hide: "Hide",
  show: "Show",
  hidden: "Hidden",
};

/** A sample card; `expanded` opens its notes and warnings, as pressing a pill does. */
export function SampleRunCard({
  sample,
  expanded = false,
}: {
  readonly sample: RunCardSample;
  readonly expanded?: boolean;
}) {
  return (
    <RunCard
      state={sample.state}
      title={sample.title}
      line={sample.line}
      pills={sample.pills}
      notes={sample.notes}
      warnings={sample.warnings}
      expanded={expanded}
      {...(sample.done === undefined ? {} : { done: sample.done })}
      {...(sample.actions.length === 0
        ? {}
        : {
            actions: sample.actions.map((label, index) => (
              <Button
                key={label}
                kind={index === 0 && sample.state === "waiting" ? "primary" : "secondary"}
              >
                {label}
              </Button>
            )),
          })}
    />
  );
}

/** Result lines under the event's title: a Result place's content. */
function Results({
  title,
  lines,
}: {
  readonly title: CardTitle;
  readonly lines: readonly RunResultLine[];
}) {
  return (
    <>
      <h3 className="text-body-large leading-tight font-semibold text-primary">
        {wordTitle(title)}
      </h3>
      {lines.map((line) => {
        const parts = resultParts(line.text);
        return (
          <ResultLine
            key={line.text}
            sink={line.sink}
            what={parts.what}
            {...(parts.where === undefined ? {} : { where: parts.where, href: "#/gallery" })}
          />
        );
      })}
    </>
  );
}

/** A question inline: the node's content (title, subtitle, fields) and Continue · Later. */
function Question({
  title,
  subtitle,
  children,
}: {
  readonly title: string;
  readonly subtitle: string;
  readonly children: ReactNode;
}) {
  return (
    <>
      <div className="flex flex-col gap-1">
        <h3 className="text-title leading-tight font-semibold text-primary">{title}</h3>
        <p className="text-caption text-secondary">{subtitle}</p>
      </div>
      {children}
      <div className="flex gap-2">
        <Button kind="primary">Continue</Button>
        <Button kind="secondary">Later</Button>
      </div>
    </>
  );
}

function SpeakerField() {
  return (
    <Field label="Speaker 2" suggested suggestedLabel="Suggested">
      {(control) => <TextField id={control.id} state="filled" suggested value="Marie-Lise" />}
    </Field>
  );
}

function SupplierField() {
  return (
    <Field label="Supplier" suggested suggestedLabel="Suggested">
      {() => (
        <Select
          label="Supplier"
          value="fritte"
          options={[
            { value: "fritte", label: "Fritte" },
            { value: "renaissance", label: "Renaissance" },
          ]}
        />
      )}
    </Field>
  );
}

/** Each kind's content at each size: S from Recordings, M from Invoices, L from Photos. */
function slotContent(kind: SlotKind, size: SlotSize): ReactNode {
  const flow = { S: "recordings", M: "invoices", L: "photos" } as const;
  switch (kind) {
    case "card":
      return <SampleRunCard sample={SLOT_CARDS[size]} />;
    case "question":
      if (size === "M") {
        return (
          <Question title="Which supplier is this?" subtitle="Fritte invoice 0413">
            <SupplierField />
          </Question>
        );
      }
      return size === "S" ? (
        <Question title="Who is speaker 2?" subtitle="client call, 48 min">
          <SpeakerField />
        </Question>
      ) : (
        <Question title="Which customer is this?" subtitle="2026-09-27 client call">
          <Field label="Customer">
            {() => (
              <Select
                label="Customer"
                value="fritte"
                options={[
                  { value: "fritte", label: "Fritte" },
                  { value: "renaissance", label: "Renaissance" },
                ]}
              />
            )}
          </Field>
        </Question>
      );
    case "result": {
      const results = {
        recordings: [{ name: "2026-09-27 client call", minutes: 48 }, RECORDING_RESULTS],
        invoices: [{ name: "Fritte invoice 0412", minutes: null }, INVOICE_RESULTS],
        photos: [CAMERA_CARD, PHOTO_RESULTS],
      } as const;
      const [title, lines] = results[flow[size]];
      return <Results title={title} lines={lines} />;
    }
  }
}

const SLOT_WIDTH: Record<SlotSize, number> = { S: 373, M: 568, L: 1152 };

/** The board's places, in order; the person arranges them (gallery state stands in for the store). */
interface Place {
  readonly id: string;
  readonly name: string;
  readonly kind: SlotKind;
  readonly size: SlotSize;
  readonly hidden: boolean;
}

const PLACES: readonly Place[] = [
  { id: "runs", name: "Runs", kind: "card", size: "L", hidden: false },
  { id: "speakers", name: "Name the speakers", kind: "question", size: "M", hidden: false },
  { id: "filed", name: "Filed", kind: "result", size: "M", hidden: false },
  { id: "transcript", name: "Transcript", kind: "result", size: "S", hidden: true },
];

function applyChange(places: readonly Place[], id: string, change: SlotChange): Place[] {
  const index = places.findIndex((place) => place.id === id);
  const place = places[index];
  if (place === undefined) return [...places];
  switch (change.kind) {
    case "move": {
      const next = [...places];
      const to = Math.max(0, Math.min(places.length - 1, index + change.by));
      next.splice(index, 1);
      next.splice(to, 0, place);
      return next;
    }
    case "size":
      return places.map((each) => (each.id === id ? { ...each, size: change.size } : each));
    case "hide":
    case "show":
      return places.map((each) =>
        each.id === id ? { ...each, hidden: change.kind === "hide" } : each,
      );
    case "move-to-tab":
      // The gallery draws the active tab only, so a place moved to another tab stays in view.
      return [...places];
  }
}

function placeContent(place: Place): ReactNode {
  switch (place.id) {
    case "runs":
      return (
        <div className="flex flex-col gap-3">
          {/* At the top of the list, left: the place's ⋯ menu takes the right in Edit layout. */}
          <div className="flex">
            <Button kind="quiet">Clear done</Button>
          </div>
          <div className="grid grid-cols-3 items-start gap-4">
            {BOARD_CARDS.map((sample) => (
              <SampleRunCard key={sample.title.name} sample={sample} />
            ))}
          </div>
        </div>
      );
    case "speakers":
      return (
        <Question title="Who is speaker 2?" subtitle="client call, 48 min">
          <SpeakerField />
        </Question>
      );
    case "filed":
      return (
        <Results title={{ name: "2026-09-29 coaching", minutes: 32 }} lines={RECORDING_RESULTS} />
      );
    default:
      return (
        <Results
          title={{ name: "2026-09-27 client call", minutes: 48 }}
          lines={RECORDING_RESULTS.slice(0, 1)}
        />
      );
  }
}

/** A Live board of Recordings to Anytype: three recordings, one card each, and two more places. */
export function LiveBoardSample({ mode }: { readonly mode: BoardMode }) {
  const [places, setPlaces] = useState<readonly Place[]>(PLACES);
  const editing = mode === "edit-layout";
  const hidden = places.filter((place) => place.hidden);
  return (
    <Board
      mode={mode}
      label={`Board of ${FLOWS.recordings}`}
      tabs={[
        { id: "overview", name: "Overview" },
        { id: "week", name: "This week" },
      ]}
      activeTab="overview"
      flowPicker={
        <Select
          label="Flow"
          value="recordings"
          options={[
            { value: "recordings", label: FLOWS.recordings },
            { value: "invoices", label: FLOWS.invoices },
            { value: "photos", label: FLOWS.photos },
          ]}
        />
      }
      editLayoutLabel="Edit layout"
      bar={
        <EditLayoutBar
          message={
            <>
              Editing the layout of <em>{FLOWS.recordings}</em>. Drag to move, drag a corner to
              resize.
            </>
          }
          addTabLabel="Add tab"
          hiddenLabel={`Hidden (${String(hidden.length)})`}
          showLabel="Show"
          doneLabel="Done"
          hiddenPlaces={hidden.map((place) => ({ id: place.id, name: place.name }))}
          onShow={(id) => {
            setPlaces(applyChange(places, id, { kind: "show" }));
          }}
        />
      }
    >
      {places.map((place, index) => (
        <Slot
          key={place.id}
          kind={place.kind}
          size={place.size}
          hidden={place.hidden}
          editing={editing}
          name={place.name}
          words={SLOT_WORDS}
          tabs={[{ id: "week", name: "This week" }]}
          first={index === 0}
          last={index === places.length - 1}
          onChange={(change) => {
            setPlaces(applyChange(places, place.id, change));
          }}
        >
          {placeContent(place)}
        </Slot>
      ))}
    </Board>
  );
}

export function LiveOrganismsPage() {
  return (
    <Page title="04 Organisms · Live">
      <Group component="run-card">
        {RUN_CARDS.map((sample) => (
          <Cell
            key={`${sample.state}-${sample.title.name}-${String(sample.pills.length)}`}
            of="run-card"
            width={480}
          >
            <SampleRunCard sample={sample} expanded={sample.pills.length === 3} />
          </Cell>
        ))}
      </Group>
      <Group component="slot">
        {(["card", "question", "result"] as const).flatMap((kind) =>
          (["S", "M", "L"] as const).flatMap((size) =>
            [true, false].map((hidden) => (
              <Cell key={`${kind}-${size}-${String(hidden)}`} of="slot" width={SLOT_WIDTH[size]}>
                <Slot
                  kind={kind}
                  size={size}
                  hidden={hidden}
                  editing={hidden}
                  name={`${kind} ${size}`}
                  words={SLOT_WORDS}
                  tabs={[{ id: "week", name: "This week" }]}
                >
                  {slotContent(kind, size)}
                </Slot>
              </Cell>
            )),
          ),
        )}
      </Group>
      <Group component="board" stack>
        {(["viewing", "edit-layout"] as const).map((mode) => (
          <Cell key={mode} of="board" width={1152}>
            <LiveBoardSample mode={mode} />
          </Cell>
        ))}
      </Group>
      <Group component="edit-layout-bar">
        <Cell of="edit-layout-bar" width={1152}>
          <EditLayoutBar
            message={
              <>
                Editing the layout of <em>{FLOWS.invoices}</em>. Drag to move, drag a corner to
                resize.
              </>
            }
            addTabLabel="Add tab"
            hiddenLabel="Hidden (2)"
            showLabel="Show"
            doneLabel="Done"
            hiddenPlaces={[
              { id: "pdf", name: "The PDF" },
              { id: "supplier", name: "Match the supplier" },
            ]}
          />
        </Cell>
      </Group>
      <Group component="empty-state">
        {(
          [
            ["flows", "No flows yet. Start from a template, or open a blank canvas.", undefined],
            [
              "live-no-flow",
              "Nothing lives here yet. Make a flow in Configuration › Flows.",
              "Go to Flows",
            ],
            [
              "live-idle",
              "Waiting for a recording. Plug in your recorder, or drop a file in a watched folder.",
              undefined,
            ],
            ["empty-tab", "This tab is empty. Choose Edit layout to move things here.", undefined],
          ] as const
        ).map(([area, message, action]) => (
          <Cell key={area} of="empty-state" width={480}>
            <EmptyState
              area={area}
              message={message}
              {...(action === undefined ? {} : { actionLabel: action })}
            />
          </Cell>
        ))}
      </Group>
      <Group component="question-popout">
        <Cell of="question-popout" width={440}>
          <QuestionPopout
            title="Which supplier is this?"
            subtitle="Fritte invoice 0413"
            contentNote="Package content (from the view's present)"
            continueLabel="Continue"
            laterLabel="Later"
            skipLabel="Skip this step"
          >
            <SupplierField />
          </QuestionPopout>
        </Cell>
        <Cell of="question-popout" width={440}>
          <QuestionPopout
            title="Send the customer brief to Fritte Reinvention?"
            subtitle="From client call"
            contentNote="Package content (from the view's present)"
            continueLabel="Continue"
            laterLabel="Later"
            skipLabel="Skip this step"
          />
        </Cell>
      </Group>
      <Group component="runtime-banner" stack>
        <Cell of="runtime-banner" width={1152}>
          <RuntimeBanner
            state="restarting"
            message="InnyTypes stopped unexpectedly and is restarting."
          />
        </Cell>
        <Cell of="runtime-banner" width={1152}>
          <RuntimeBanner
            state="down"
            message="InnyTypes stopped 5 times in 2 minutes and won't restart on its own."
            restartLabel="Restart"
          />
        </Cell>
      </Group>
      <Group component="dialog">
        {(
          [
            [
              "neutral",
              "Save your flow before quitting?",
              "Unsaved changes on the canvas are lost otherwise.",
              <DialogButtons
                key="b"
                kind="neutral"
                cancelLabel="Cancel"
                secondaryLabel="Quit without saving"
                primaryLabel="Save and quit"
              />,
            ],
            [
              "warning",
              "Skip Name the speakers?",
              "The flow continues without names. This can't be undone for this run.",
              <DialogButtons
                key="b"
                kind="neutral"
                cancelLabel="Skip"
                primaryLabel="Keep waiting"
              />,
            ],
            [
              "destructive",
              `Delete ${FLOWS.invoices}?`,
              "Its run history is deleted too. Runs in progress are stopped.",
              <DialogButtons
                key="b"
                kind="destructive"
                cancelLabel="Cancel"
                primaryLabel="Delete"
              />,
            ],
          ] as const
        ).map(([kind, title, body, buttons]) => (
          <Cell key={kind} of="dialog">
            <div className="relative h-[360px] w-[560px]">
              <Dialog kind={kind} open contained title={title} body={body} buttons={buttons} />
            </div>
          </Cell>
        ))}
      </Group>
    </Page>
  );
}
