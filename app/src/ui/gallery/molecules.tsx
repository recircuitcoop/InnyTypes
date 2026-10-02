// Penpot page 03 Molecules in the gallery: every molecule in every variant, with sample content
// from three unrelated flows.
import { Button } from "../components/atoms/Button";
import { IconButton } from "../components/atoms/IconButton";
import { StatusPill } from "../components/atoms/StatusPill";
import { Switch } from "../components/atoms/Switch";
import { TextField } from "../components/atoms/TextField";
import { Combobox } from "../components/molecules/Combobox";
import { DateField } from "../components/molecules/DateField";
import { DialogButtons } from "../components/molecules/DialogButtons";
import { Field, type FieldMoleculeState } from "../components/molecules/Field";
import { FileDrop, type FileDropState } from "../components/molecules/FileDrop";
import { InlineMessage, type InlineMessageKind } from "../components/molecules/InlineMessage";
import { KeyValue } from "../components/molecules/KeyValue";
import { ListRow, type ListRowKind, type ListRowState } from "../components/molecules/ListRow";
import { Menu, MenuSeparator } from "../components/molecules/Menu";
import { MenuItem, type MenuItemState } from "../components/molecules/MenuItem";
import { MultiSelect } from "../components/molecules/MultiSelect";
import { NavItem, type NavItemState, type NavItemSurface } from "../components/molecules/NavItem";
import { NotificationActions } from "../components/molecules/NotificationActions";
import { ResultLine } from "../components/molecules/ResultLine";
import { SearchField } from "../components/molecules/SearchField";
import { SegmentedControl } from "../components/molecules/SegmentedControl";
import { Stepper } from "../components/molecules/Stepper";
import { TableRow, type TableRowKind } from "../components/molecules/TableRow";
import { TabStrip } from "../components/molecules/TabStrip";
import { Toast, type ToastKind } from "../components/molecules/Toast";
import { Cell, Group, Page, useOpenedAfterMount } from "./frame";
import { FLOWS, SPACES, TYPES } from "./samples";

/** Penpot's ten list-row variants (a Run row has one action only). */
const LIST_ROWS: readonly (readonly [ListRowKind, ListRowState, boolean])[] = [
  ["flow", "default", false],
  ["flow", "default", true],
  ["flow", "hover", false],
  ["flow", "hover", true],
  ["run", "default", false],
  ["run", "hover", false],
  ["package", "default", false],
  ["package", "default", true],
  ["package", "hover", false],
  ["package", "hover", true],
];

function rowContent(kind: ListRowKind) {
  switch (kind) {
    case "flow":
      return {
        title: FLOWS.recordings,
        meta: "Last run: today, 14:20 · done",
        status: (
          <>
            <Switch state="on" label={`${FLOWS.recordings} on`} hideLabel />
            <StatusPill state="done">Done</StatusPill>
          </>
        ),
        primary: "Edit",
        more: "Run history",
      };
    case "run":
      return {
        title: "Invoice 2026-118 from Fritte",
        meta: `${FLOWS.invoices} · Tuesday 09:12`,
        status: <StatusPill state="waiting">Waiting for you</StatusPill>,
        primary: "Answer",
        more: "Re-run",
      };
    case "package":
      return {
        title: "monty",
        meta: "Watches your recorder and folders",
        status: <StatusPill state="done">Installed</StatusPill>,
        primary: "Remove",
        more: "Check for changes",
      };
  }
}

export function MoleculesPage() {
  const menusOpen = useOpenedAfterMount();
  return (
    <Page title="03 Molecules">
      <Group component="field">
        {(["default", "error", "disabled"] as readonly FieldMoleculeState[]).flatMap((state) =>
          [false, true].map((suggested) => (
            <Cell key={`${state}-${String(suggested)}`} of="field" width={280}>
              <Field
                state={state}
                suggested={suggested}
                suggestedLabel="Suggested"
                label="Space"
                help="Where the summary is filed."
                error="Choose a space; this one no longer exists."
              >
                {(control) => (
                  <TextField
                    id={control.id}
                    state={control.state === "default" ? "filled" : control.state}
                    {...(control.describedBy === undefined
                      ? {}
                      : { describedBy: control.describedBy })}
                    value="Renaissance"
                  />
                )}
              </Field>
            </Cell>
          )),
        )}
      </Group>
      <Group component="search-field">
        <Cell of="search-field" width={240}>
          <SearchField
            value=""
            placeholder="Search flows"
            label="Search flows"
            clearLabel="Clear the search"
          />
        </Cell>
        <Cell of="search-field" width={240}>
          <SearchField
            value="client"
            placeholder="Search flows"
            label="Search flows"
            clearLabel="Clear the search"
          />
        </Cell>
      </Group>
      <Group component="combobox">
        <Cell of="combobox" width={280} height={150}>
          <Combobox
            state="open"
            label="Space"
            options={SPACES.slice(0, 3)}
            value={null}
            inputValue="Ren"
          />
        </Cell>
        <Cell of="combobox" width={280}>
          <Combobox
            state="closed"
            label="Space"
            placeholder="Choose a space"
            options={SPACES}
            value={null}
            inputValue=""
          />
        </Cell>
      </Group>
      <Group component="multi-select">
        <Cell of="multi-select" width={320}>
          <MultiSelect
            label="Object types"
            placeholder="Add a type"
            options={TYPES}
            value={["meeting-notes", "customer-brief"]}
            removeLabel={(type) => `Remove ${type}`}
          />
        </Cell>
        <Cell of="multi-select" width={320}>
          <MultiSelect
            label="Object types"
            placeholder="Choose types"
            options={TYPES}
            value={[]}
            removeLabel={(type) => `Remove ${type}`}
          />
        </Cell>
      </Group>
      <Group component="date-field">
        {(
          [
            ["default", null],
            ["filled", "2026-10-02"],
            ["open", "2026-10-02"],
          ] as const
        ).map(([state, value]) => (
          <Cell
            key={state}
            of="date-field"
            width={240}
            {...(state === "open" ? { height: 300 } : {})}
          >
            <DateField
              state={state}
              value={value}
              label="Due"
              placeholder="Pick a day"
              previousLabel="Previous month"
              nextLabel="Next month"
              openLabel="Open the calendar"
            />
          </Cell>
        ))}
      </Group>
      <Group component="file-drop">
        {(["idle", "over", "filled"] as readonly FileDropState[]).map((state) => (
          <Cell key={state} of="file-drop" width={400}>
            <FileDrop
              state={state}
              label="Drop a recording"
              message={
                state === "filled"
                  ? "Watching ~/Recordings"
                  : "Drop a recording here, or choose a folder to watch"
              }
              overMessage="Release to process it"
              actionLabel={state === "filled" ? "Change folder" : "Choose a folder…"}
            />
          </Cell>
        ))}
      </Group>
      <Group component="list-row" stack>
        {LIST_ROWS.map(([kind, state, two]) => {
          const content = rowContent(kind);
          return (
            <Cell key={`${kind}-${state}-${String(two)}`} of="list-row" width={720}>
              <ul className="w-full">
                <ListRow
                  kind={kind}
                  state={state}
                  title={content.title}
                  meta={content.meta}
                  status={content.status}
                  primaryAction={<Button kind="secondary">{content.primary}</Button>}
                  {...(two
                    ? {
                        moreActions: (
                          <>
                            <Button kind="quiet">{content.more}</Button>
                            <IconButton
                              kind="quiet"
                              icon="ellipsis"
                              label={`More for ${content.title}`}
                            />
                          </>
                        ),
                      }
                    : {})}
                />
              </ul>
            </Cell>
          );
        })}
      </Group>
      <Group component="table-row" stack>
        {(["header", "row", "hover"] as readonly TableRowKind[]).map((kind) => (
          <Cell key={kind} of="table-row" width={720}>
            <table className="w-full table-fixed border-collapse">
              <colgroup>
                <col className="w-[220px]" />
                <col className="w-[200px]" />
                <col className="w-[160px]" />
                <col />
              </colgroup>
              <tbody>
                <TableRow
                  kind={kind}
                  cells={
                    kind === "header"
                      ? ["Recording", "Flow", "When", "State"]
                      : [
                          "2026-09-27 client call",
                          FLOWS.recordings,
                          "Tuesday 14:20",
                          <StatusPill key="state" state="done">
                            Done
                          </StatusPill>,
                        ]
                  }
                />
              </tbody>
            </table>
          </Cell>
        ))}
      </Group>
      <Group component="key-value" stack>
        <Cell of="key-value" width={480}>
          <KeyValue kind="text" label="Anytype" value="Connected · 8 spaces" />
        </Cell>
        <Cell of="key-value" width={480}>
          <KeyValue kind="mono" label="Endpoint" value="127.0.0.1:31010" />
        </Cell>
        <Cell of="key-value" width={480}>
          <KeyValue
            kind="pill"
            label="Runtime"
            value={<StatusPill state="running">Running</StatusPill>}
          />
        </Cell>
      </Group>
      <Group component="result-line" stack>
        <Cell of="result-line" width={480}>
          <ResultLine sink="anytype" what="Meeting notes" where="Renaissance" href="#/gallery" />
        </Cell>
        <Cell of="result-line" width={480}>
          <ResultLine sink="file" what="Moved 42 files to" where="Archive" href="#/gallery" />
        </Cell>
        <Cell of="result-line" width={480}>
          <ResultLine sink="scheduled" what="Follow up on pricing · due Thursday" />
        </Cell>
        <Cell of="result-line" width={480}>
          <ResultLine sink="plain" what="Deleted the recording" />
        </Cell>
      </Group>
      <Group component="nav-item">
        {(["configuration", "live"] as readonly NavItemSurface[]).flatMap((surface) =>
          (["default", "hover", "active"] as readonly NavItemState[]).map((state) => (
            <Cell key={`${surface}-${state}`} of="nav-item" width={176}>
              <NavItem
                surface={surface}
                state={state}
                label={surface === "live" ? "Live" : "Configuration"}
                count={surface === "live" ? 1 : 0}
                countLabel="1 waiting for you"
              />
            </Cell>
          )),
        )}
      </Group>
      <Group component="tab">
        {(["default", "hover", "active"] as const).map((state) => (
          <Cell key={state} of="tab" width={120}>
            <TabStrip
              label="Configuration"
              value={state === "active" ? "flows" : null}
              tabs={[{ value: "flows", label: "Flows", state }]}
            />
          </Cell>
        ))}
      </Group>
      <Group component="tab-strip">
        <Cell of="tab-strip" width={480}>
          <TabStrip
            label="Configuration"
            value="flows"
            tabs={[
              { value: "flows", label: "Flows" },
              { value: "general", label: "General" },
            ]}
          />
        </Cell>
      </Group>
      <Group component="segmented-control">
        <Cell of="segmented-control" width={200}>
          <SegmentedControl
            label="Size"
            value="s"
            options={[
              { value: "s", label: "S" },
              { value: "m", label: "M" },
              { value: "l", label: "L" },
            ]}
          />
        </Cell>
        <Cell of="segmented-control" width={200}>
          <SegmentedControl
            label="Theme"
            value="light"
            options={[
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
          />
        </Cell>
      </Group>
      <Group component="menu-item">
        <Cell of="menu-item" width={300} height={200}>
          <Menu
            open={menusOpen}
            placement="bottom-start"
            trigger={<IconButton kind="secondary" icon="ellipsis" label="More for this run" />}
          >
            {(["default", "hover", "disabled", "danger"] as readonly MenuItemState[]).map(
              (state) => (
                <MenuItem
                  key={state}
                  value={state}
                  state={state}
                  icon={state === "danger" ? "trash" : "rotate-cw"}
                  label={state === "danger" ? "Delete flow" : "Run again"}
                  shortcut="Enter"
                />
              ),
            )}
          </Menu>
        </Cell>
      </Group>
      <Group component="menu">
        <Cell of="menu" width={300} height={200}>
          <Menu
            open={menusOpen}
            placement="bottom-start"
            trigger={<IconButton kind="secondary" icon="ellipsis" label="More for this run" />}
          >
            <MenuItem value="open" icon="external-link" label="Open result" />
            <MenuItem value="rerun" icon="rotate-cw" label="Re-run" />
            <MenuItem value="anytype" icon="external-link" label="Open in Anytype" />
            <MenuSeparator />
            <MenuItem value="delete" state="danger" icon="trash" label="Delete run" />
          </Menu>
        </Cell>
      </Group>
      <Group component="dialog-buttons">
        <Cell of="dialog-buttons" width={360}>
          <DialogButtons kind="destructive" cancelLabel="Cancel" primaryLabel="Delete" />
        </Cell>
        <Cell of="dialog-buttons" width={360}>
          <DialogButtons
            kind="neutral"
            cancelLabel="Cancel"
            secondaryLabel="Quit without saving"
            primaryLabel="Save and quit"
          />
        </Cell>
      </Group>
      <Group component="notification-actions" stack>
        <Cell of="notification-actions" width={320}>
          <NotificationActions actions={[{ label: "Open in Anytype" }]} />
        </Cell>
        <Cell of="notification-actions" width={320}>
          <NotificationActions actions={[{ label: "Open" }, { label: "Later" }]} />
        </Cell>
        <Cell of="notification-actions" width={320}>
          <NotificationActions
            actions={[{ label: "Marie-Lise" }, { label: "Valerie" }, { label: "Someone else" }]}
          />
        </Cell>
      </Group>
      <Group component="toast" stack>
        {(
          [
            ["done", "Filed: 3 summaries in Renaissance.", "Open"],
            ["failed", "Couldn't file the invoice. Is Anytype running?", "Retry"],
            ["waiting", "Waiting for you: which supplier is this?", "Answer"],
            ["info", "Moving 42 photos from the camera card, about 2 minutes.", undefined],
          ] as const satisfies readonly (readonly [ToastKind, string, string | undefined])[]
        ).map(([kind, message, action]) => (
          <Cell key={kind} of="toast" width={480}>
            <Toast
              kind={kind}
              message={message}
              dismissLabel="Dismiss"
              {...(action === undefined ? {} : { actionLabel: action })}
            />
          </Cell>
        ))}
      </Group>
      <Group component="inline-message" stack>
        {(
          [
            ["warning", "Summarise isn't set up yet: choose an object type."],
            ["failed", "Couldn't reach Anytype. Is it running?"],
            ["done", "Connected. Found 8 spaces."],
            ["info", "InnyTypes will notice when Anytype starts."],
          ] as const satisfies readonly (readonly [InlineMessageKind, string])[]
        ).map(([kind, text]) => (
          <Cell key={kind} of="inline-message" width={480}>
            <InlineMessage kind={kind}>{text}</InlineMessage>
          </Cell>
        ))}
      </Group>
      <Group component="stepper">
        {[1, 3, 7].map((current) => (
          <Cell key={current} of="stepper" width={160}>
            <Stepper current={current} total={7} label={`Step ${String(current)} of 7`} />
          </Cell>
        ))}
      </Group>
    </Page>
  );
}
