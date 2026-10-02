// Penpot page 04 Organisms in the gallery, part two: what Setup and Configuration are made of.
// Every variant, with content from three unrelated flows and ux-writing's words.
import { Button } from "../components/atoms/Button";
import { Icon } from "../components/atoms/Icon";
import { Link } from "../components/atoms/Link";
import { NumberField } from "../components/atoms/NumberField";
import { Progress } from "../components/atoms/Progress";
import { Select } from "../components/atoms/Select";
import { StatusPill } from "../components/atoms/StatusPill";
import { Switch } from "../components/atoms/Switch";
import { Field } from "../components/molecules/Field";
import { KeyValue } from "../components/molecules/KeyValue";
import { CanvasFrame } from "../components/organisms/CanvasFrame";
import { FlowsList, type FlowsListWords } from "../components/organisms/FlowsList";
import { GeneralSection, type GeneralSectionKind } from "../components/organisms/GeneralSection";
import { PackageRow, type PackageRowState } from "../components/organisms/PackageRow";
import {
  RunHistory,
  type RunHistoryRow,
  type RunHistoryWords,
} from "../components/organisms/RunHistory";
import { SetupStep } from "../components/organisms/SetupStep";
import { Sidebar } from "../components/organisms/Sidebar";
import { Cell, Group, Page, useOpenedAfterMount } from "./frame";
import { FLOW_STEPS, FLOWS, SPACES, TYPES } from "./samples";

export const SETUP_STEPS = [
  "Welcome",
  "Reports",
  "Connect Anytype",
  "Choose your packages",
  "Start with a simple flow?",
  "Set up a step",
  "Ready",
] as const;

export const FLOWS_WORDS: FlowsListWords = {
  title: "Flows",
  newFlow: "New flow",
  fromTemplate: "From a template",
  blankCanvas: "Blank canvas",
  edit: "Edit",
  runHistory: "Run history",
  more: "More",
  rename: "Rename",
  duplicate: "Duplicate",
  exportFlow: "Export flow…",
  deleteFlow: "Delete flow",
  switchLabel: (name) => `${name} on`,
};

export const FLOW_ROWS = [
  {
    id: "recordings",
    name: FLOWS.recordings,
    on: true,
    lastRun: "Last run: today, 14:20 · done",
    health: "Ready",
    healthState: "done",
  },
  {
    id: "invoices",
    name: FLOWS.invoices,
    on: true,
    lastRun: "Last run: yesterday, 18:05 · done",
    health: "1 step not set up",
    healthState: "waiting",
  },
  {
    id: "photos",
    name: FLOWS.photos,
    on: false,
    lastRun: "Last run: Monday, 09:12 · failed",
    health: "Failing since Monday",
    healthState: "failed",
  },
] as const;

export const HISTORY_WORDS: RunHistoryWords = {
  title: "Run history",
  back: "← Flows",
  retention: "Runs are kept for 90 days. Change this in Configuration › General.",
  filterLabel: "Show",
  rangeLabel: "When",
  search: "Search runs",
  clearSearch: "Clear the search",
  columns: {
    select: "Select all runs",
    when: "When",
    event: "Event",
    took: "Took",
    state: "State",
    notes: "Notes",
    more: "More",
  },
  selected: (count) => `${String(count)} runs selected`,
  rerun: "Re-run",
  delete: "Delete",
  clearSelection: "Clear selection",
  openResult: "Open result",
  rerunFrom: "Re-run from…",
  openInAnytype: "Open in Anytype",
  deleteRun: "Delete run",
  selectRun: (event) => `Select ${event}`,
};

/** Run history of Recordings to Anytype, newest first: the design-system rows. */
const HISTORY_ROWS: readonly RunHistoryRow[] = [
  {
    id: "coaching",
    when: "Tuesday 14:20",
    event: "2026-09-29 coaching",
    took: "32 min",
    state: "done",
    stateLabel: "Done",
    notes: [
      { state: "off", label: "2 notes" },
      { state: "waiting", label: "1 warning" },
    ],
    inAnytype: true,
  },
  {
    id: "standup",
    when: "Monday 09:05",
    event: "2026-09-28 standup",
    took: "14 min",
    state: "failed",
    stateLabel: "Failed",
    failure: "Failed at Transcribe: Mistral refused the key.",
  },
  {
    id: "intro",
    when: "Monday 08:40",
    event: "2026-09-28 intro call",
    took: "22 min",
    state: "done",
    stateLabel: "Done",
    inAnytype: true,
  },
  {
    id: "client",
    when: "Sunday 16:02",
    event: "2026-09-27 client call",
    took: "48 min",
    state: "waiting",
    stateLabel: "Waiting for you",
  },
];

const SELECTED = new Set(["coaching", "intro", "client"]);

function History({
  rows,
  filtered,
}: {
  readonly rows: readonly RunHistoryRow[];
  readonly filtered: boolean;
}) {
  return (
    <RunHistory
      flowName={FLOWS.recordings}
      rows={rows}
      words={HISTORY_WORDS}
      filters={[
        { value: "all", label: "All" },
        { value: "waiting", label: "Waiting" },
        { value: "failed", label: "Failed" },
        { value: "done", label: "Done" },
      ]}
      filter={filtered ? "failed" : "all"}
      ranges={[
        { value: "7", label: "Last 7 days" },
        { value: "30", label: "Last 30 days" },
      ]}
      range="7"
      query=""
      filtered={filtered}
      emptyMessage={
        filtered
          ? "No failed runs in the last 7 days."
          : "No runs yet. Plug in your recorder, or drop a file in a watched folder."
      }
      steps={FLOW_STEPS.recordings}
      backHref="#/gallery"
    />
  );
}

const CHECKED = "checked today 09:14";

/** Penpot's nine package rows: monty, innyrize and anytype, the catalogue that exists today. */
const PACKAGE_ROWS: readonly {
  readonly state: PackageRowState;
  readonly name: string;
  readonly version: string;
  readonly facets: readonly (readonly [Parameters<typeof StatusPill>[0]["state"], string])[];
  readonly captions?: readonly string[];
  readonly actions: readonly (readonly ["quiet" | "secondary" | "primary", string])[];
}[] = [
  {
    state: "registered",
    name: "monty",
    version: "1.2",
    facets: [
      ["done", "Registered"],
      ["done", "Installed"],
      ["done", "Up to date"],
    ],
    actions: [
      ["quiet", "Unregister"],
      ["secondary", "Remove"],
    ],
  },
  {
    state: "not-registered",
    name: "monty",
    version: "1.2",
    facets: [
      ["off", "Not registered"],
      ["done", "Installed"],
      ["done", "Up to date"],
    ],
    actions: [
      ["quiet", "Register"],
      ["secondary", "Remove"],
    ],
  },
  {
    state: "installing",
    name: "innyrize",
    version: "0.3",
    facets: [
      ["off", "Not registered"],
      ["running", "Installing · 60%"],
    ],
    actions: [
      ["quiet", "Register"],
      ["secondary", "Install"],
    ],
  },
  {
    state: "verifying",
    name: "innyrize",
    version: "0.3",
    facets: [
      ["off", "Not registered"],
      ["running", "Verifying…"],
    ],
    actions: [
      ["quiet", "Register"],
      ["secondary", "Install"],
    ],
  },
  {
    state: "failed-check",
    name: "anytype",
    version: "1.0",
    facets: [
      ["off", "Not registered"],
      ["failed", "Failed its check"],
    ],
    actions: [
      ["quiet", "Register"],
      ["secondary", "Install"],
    ],
  },
  {
    state: "update-available",
    name: "innyrize",
    version: "0.3",
    facets: [
      ["done", "Registered"],
      ["done", "Installed"],
      ["waiting", "Update to 0.4 available"],
    ],
    actions: [
      ["quiet", "Unregister"],
      ["secondary", "Remove"],
      ["primary", "Update"],
    ],
  },
  {
    state: "updating",
    name: "innyrize",
    version: "0.3",
    facets: [
      ["done", "Registered"],
      ["done", "Installed"],
      ["running", "Updating…"],
    ],
    actions: [
      ["quiet", "Unregister"],
      ["secondary", "Remove"],
    ],
  },
  {
    state: "updated",
    name: "innyrize",
    version: "0.4",
    facets: [
      ["done", "Registered"],
      ["done", "Installed"],
      ["done", "Updated to 0.4 on Tuesday"],
    ],
    actions: [
      ["quiet", "Unregister"],
      ["secondary", "Remove"],
      ["quiet", "Go back to 0.3"],
    ],
  },
  {
    state: "from-a-folder",
    name: "innyrize",
    version: "0.3",
    captions: ["From a folder: ~/packages/innyrize", "Unsigned"],
    facets: [
      ["done", "Registered"],
      ["done", "Installed"],
    ],
    actions: [
      ["quiet", "Unregister"],
      ["secondary", "Remove"],
      ["primary", "Check for changes"],
    ],
  },
];

export function SamplePackageRow({ row }: { readonly row: (typeof PACKAGE_ROWS)[number] }) {
  return (
    <PackageRow
      state={row.state}
      name={row.name}
      version={row.version}
      publisher={row.name === "anytype" ? "by InnyTypes" : "by l1nx"}
      {...(row.captions === undefined ? {} : { captions: row.captions })}
      facets={row.facets.map(([state, label]) => ({ state, label, checked: CHECKED }))}
      actions={row.actions.map(([kind, label]) => (
        <Button key={label} kind={kind}>
          {label}
        </Button>
      ))}
    />
  );
}

/** Each General section with ux-writing's state line and controls. */
function generalSection(section: GeneralSectionKind) {
  switch (section) {
    case "anytype":
      return (
        <GeneralSection section={section} title="Anytype" state="Connected · 8 spaces">
          <div>
            <Button kind="secondary">Pair again</Button>
          </div>
        </GeneralSection>
      );
    case "recorders":
      return (
        <GeneralSection section={section} title="Recorders and folders" state="BOYA · watching">
          <div>
            <Button kind="secondary">Add a folder…</Button>
          </div>
        </GeneralSection>
      );
    case "ai-apps":
      return (
        <GeneralSection
          section={section}
          title="AI apps"
          state="Claude, Codex and other apps can use your Anytype through InnyTypes at 127.0.0.1:31010."
        >
          <Field label="Change port">
            {(control) => (
              <NumberField
                id={control.id}
                value="31010"
                incrementLabel="One more"
                decrementLabel="One less"
              />
            )}
          </Field>
          <div>
            <Button kind="secondary">Copy setup for Codex</Button>
          </div>
        </GeneralSection>
      );
    case "start-at-login":
      return (
        <GeneralSection
          section={section}
          title="Start at login"
          state="InnyTypes starts when you log in."
        >
          <Switch state="on" label="Start at login" />
        </GeneralSection>
      );
    case "updates":
      return (
        <GeneralSection section={section} title="Updates" state="Downloading 0.3.0 · 42%">
          <Progress mode="determinate" value={42} label="Downloading 0.3.0" />
          <div className="flex items-center gap-2">
            <Button kind="secondary">Check now</Button>
            <Button kind="quiet">Go back to 0.2.1</Button>
            <Link href="#/gallery" className="ml-auto">
              Release notes
            </Link>
          </div>
          <Switch state="on" label="Check automatically" />
        </GeneralSection>
      );
    case "reports":
      return (
        <GeneralSection section={section} title="Reports" state="Sending anonymous crash reports.">
          <Switch state="on" label="Send reports" />
          <div>
            <Button kind="quiet">See what would be sent</Button>
          </div>
        </GeneralSection>
      );
    case "packages":
      return (
        <GeneralSection section={section} title="Packages" state="3 installed · 1 update">
          <div>
            <Button kind="secondary">
              Add a package…
              <Icon name="chevron-down" />
            </Button>
          </div>
          <ul className="flex flex-col border-t border-surface-line">
            {PACKAGE_ROWS.filter((row) =>
              ["update-available", "registered", "from-a-folder"].includes(row.state),
            ).map((row) => (
              <SamplePackageRow key={row.state} row={row} />
            ))}
          </ul>
        </GeneralSection>
      );
    case "advanced":
      return (
        <GeneralSection section={section} title="Advanced" state="Status details for support.">
          <KeyValue
            kind="pill"
            label="Runtime"
            value={<StatusPill state="running">Running</StatusPill>}
          />
          <KeyValue kind="mono" label="Ports" value="31010" />
        </GeneralSection>
      );
  }
}

const GENERAL_SECTIONS: readonly GeneralSectionKind[] = [
  "anytype",
  "recorders",
  "ai-apps",
  "start-at-login",
  "updates",
  "reports",
  "packages",
  "advanced",
];

export function ConfigurationOrganismsPage() {
  const menusOpen = useOpenedAfterMount();
  return (
    <Page title="04 Organisms · Setup and Configuration">
      <Group component="sidebar">
        <Cell of="sidebar" height={520}>
          <div className="h-[520px]">
            <Sidebar
              mode="setup"
              label="Set up InnyTypes"
              steps={SETUP_STEPS}
              current={3}
              status={<StatusPill state="running">Running</StatusPill>}
            />
          </div>
        </Cell>
        <Cell of="sidebar" height={520}>
          <div className="h-[520px]">
            <Sidebar
              mode="main"
              label="InnyTypes"
              active="live"
              liveLabel="Live"
              configurationLabel="Configuration"
              waiting={1}
              waitingLabel="1 waiting for you"
              status={<StatusPill state="running">Running</StatusPill>}
            />
          </div>
        </Cell>
      </Group>
      <Group component="flows-list">
        <Cell of="flows-list" width={880} height={420}>
          <FlowsList
            flows={FLOW_ROWS}
            words={FLOWS_WORDS}
            {...(menusOpen ? { menuOpenFor: "invoices" } : {})}
          />
        </Cell>
      </Group>
      <Group component="run-history" stack>
        <Cell of="run-history" width={1032}>
          <History rows={HISTORY_ROWS} filtered={false} />
        </Cell>
        <Cell of="run-history" width={1032}>
          <History
            rows={HISTORY_ROWS.map((row) => ({ ...row, selected: SELECTED.has(row.id) }))}
            filtered={false}
          />
        </Cell>
        <Cell of="run-history" width={1032}>
          <History rows={[]} filtered={false} />
        </Cell>
        <Cell of="run-history" width={1032}>
          <History rows={[]} filtered />
        </Cell>
      </Group>
      <Group component="general-section" stack>
        {GENERAL_SECTIONS.map((section) => (
          <Cell key={section} of="general-section" width={section === "packages" ? 1032 : 640}>
            {generalSection(section)}
          </Cell>
        ))}
      </Group>
      <Group component="package-row" stack>
        {PACKAGE_ROWS.map((row) => (
          <Cell key={row.state} of="package-row" width={1032}>
            <ul className="w-full">
              <SamplePackageRow row={row} />
            </ul>
          </Cell>
        ))}
      </Group>
      <Group component="canvas-frame" stack>
        {(["clean", "dirty"] as const).map((state) => (
          <Cell key={state} of="canvas-frame" width={1152}>
            <div className="h-[280px] w-full">
              <CanvasFrame
                state={state}
                flowName={state === "clean" ? FLOWS.photos : FLOWS.invoices}
                unsavedLabel="Unsaved changes"
                saveLabel="Save and run"
              >
                <div className="m-4 flex flex-1 items-center justify-center rounded-m border border-dashed border-muted text-body text-secondary">
                  Node-RED canvas
                </div>
              </CanvasFrame>
            </div>
          </Cell>
        ))}
      </Group>
      <Group component="setup-step">
        <Cell of="setup-step" width={560}>
          <SetupStep
            progress="Step 3 of 7."
            title="Set up: Summarise"
            backLabel="Back"
            continueLabel="Continue"
          >
            <Field label="Space" suggested suggestedLabel="Suggested">
              {() => <Select label="Space" value="renaissance" options={SPACES} />}
            </Field>
            <Field label="Type">
              {() => <Select label="Type" value="meeting-notes" options={TYPES} />}
            </Field>
          </SetupStep>
        </Cell>
      </Group>
    </Page>
  );
}
