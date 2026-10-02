// Penpot pages 01 Icons and 02 Atoms in the gallery: every atom in every variant, with the
// sample words the Penpot file uses.
import { Badge } from "../components/atoms/Badge";
import {
  Button,
  type ButtonKind,
  type ButtonSize,
  type ButtonState,
} from "../components/atoms/Button";
import { Checkbox, type CheckboxState } from "../components/atoms/Checkbox";
import { Chip, type ChipKind } from "../components/atoms/Chip";
import { Code } from "../components/atoms/Code";
import { Divider } from "../components/atoms/Divider";
import { Icon, ICON_NAMES } from "../components/atoms/Icon";
import {
  IconButton,
  type IconButtonKind,
  type IconButtonState,
} from "../components/atoms/IconButton";
import { Kbd } from "../components/atoms/Kbd";
import { Link, type LinkState } from "../components/atoms/Link";
import { NumberField } from "../components/atoms/NumberField";
import { Progress } from "../components/atoms/Progress";
import { Radio, RadioGroup, type RadioState } from "../components/atoms/Radio";
import { Range, type RangeState } from "../components/atoms/Range";
import { Select } from "../components/atoms/Select";
import { Skeleton, type SkeletonKind } from "../components/atoms/Skeleton";
import { Spinner } from "../components/atoms/Spinner";
import { StatusPill, type StatusPillState } from "../components/atoms/StatusPill";
import { Switch, type SwitchState } from "../components/atoms/Switch";
import { Textarea } from "../components/atoms/Textarea";
import { TextField } from "../components/atoms/TextField";
import { Tooltip } from "../components/atoms/Tooltip";
import type { FieldState } from "../components/field-box";
import { Cell, Group, Page } from "./frame";
import { TYPES } from "./samples";

const FIELD_STATES: readonly FieldState[] = ["default", "focus", "filled", "error", "disabled"];
const BUTTON_KINDS: readonly ButtonKind[] = ["primary", "secondary", "quiet", "destructive"];
const BUTTON_STATES: readonly ButtonState[] = [
  "default",
  "hover",
  "pressed",
  "disabled",
  "loading",
];
const BUTTON_SIZES: readonly ButtonSize[] = ["default", "large"];
const BUTTON_LABEL: Record<ButtonKind, string> = {
  primary: "Continue",
  secondary: "Later",
  quiet: "Skip this step",
  destructive: "Delete",
};
const YES_NO: readonly boolean[] = [false, true];

export function IconsPage() {
  return (
    <Page title="01 Icons">
      {([16, 20] as const).map((size) => (
        <Group key={size} component={`icon-${String(size)}`}>
          {ICON_NAMES.map((name) => (
            <Cell key={name} of="icon" width={150}>
              <Icon name={name} size={size} className="text-primary" />
            </Cell>
          ))}
        </Group>
      ))}
    </Page>
  );
}

export function AtomsPage() {
  return (
    <Page title="02 Atoms">
      <Group component="button">
        {BUTTON_SIZES.flatMap((size) =>
          BUTTON_KINDS.flatMap((kind) =>
            BUTTON_STATES.map((state) => (
              <Cell key={`${size}-${kind}-${state}`} of="button" width={250}>
                <Button kind={kind} state={state} size={size}>
                  {BUTTON_LABEL[kind]}
                </Button>
              </Cell>
            )),
          ),
        )}
      </Group>
      <Group component="icon-button">
        {(["secondary", "quiet"] as readonly IconButtonKind[]).flatMap((kind) =>
          (["default", "hover", "pressed", "disabled"] as readonly IconButtonState[]).map(
            (state) => (
              <Cell key={`${kind}-${state}`} of="icon-button" width={200}>
                <IconButton kind={kind} state={state} icon="ellipsis" label="More for this flow" />
              </Cell>
            ),
          ),
        )}
      </Group>
      <Group component="switch">
        {(["on", "off"] as readonly SwitchState[]).flatMap((state) =>
          YES_NO.map((disabled) => (
            <Cell key={`${state}-${String(disabled)}`} of="switch" width={200}>
              <Switch state={state} disabled={disabled} label="Flow on" />
            </Cell>
          )),
        )}
      </Group>
      <Group component="checkbox">
        {(["on", "off", "mixed"] as readonly CheckboxState[]).flatMap((state) =>
          YES_NO.map((disabled) => (
            <Cell key={`${state}-${String(disabled)}`} of="checkbox" width={200}>
              <Checkbox state={state} disabled={disabled} label="Select this run" />
            </Cell>
          )),
        )}
      </Group>
      <Group component="radio">
        {(["on", "off"] as readonly RadioState[]).flatMap((state) =>
          YES_NO.map((disabled) => (
            <Cell key={`${state}-${String(disabled)}`} of="radio" width={200}>
              <RadioGroup label="Where to file" hideLabel value={state === "on" ? "space" : null}>
                <Radio state={state} disabled={disabled} value="space" label="In a space" />
              </RadioGroup>
            </Cell>
          )),
        )}
      </Group>
      <Group component="text-field">
        {YES_NO.flatMap((suggested) =>
          FIELD_STATES.map((state) => (
            <Cell key={`${state}-${String(suggested)}`} of="text-field" width={280}>
              <TextField
                state={state}
                suggested={suggested}
                suggestedLabel="Suggested"
                label="Space name"
                placeholder="Space name"
                value={state === "default" || state === "focus" ? "" : "Renaissance"}
              />
            </Cell>
          )),
        )}
      </Group>
      <Group component="textarea">
        {FIELD_STATES.map((state) => (
          <Cell key={state} of="textarea" width={280}>
            <Textarea
              state={state}
              label="Focus"
              placeholder="What should the summary focus on?"
              value={state === "default" || state === "focus" ? "" : "Pricing and next steps"}
            />
          </Cell>
        ))}
      </Group>
      <Group component="number-field">
        {FIELD_STATES.map((state) => (
          <Cell key={state} of="number-field" width={200}>
            <NumberField
              state={state}
              label="Speakers"
              placeholder="0"
              incrementLabel="One more"
              decrementLabel="One fewer"
              value={state === "default" || state === "focus" ? "" : "2"}
            />
          </Cell>
        ))}
      </Group>
      <Group component="select">
        {FIELD_STATES.map((state) => (
          <Cell key={state} of="select" width={280}>
            <Select
              state={state}
              label="Object type"
              placeholder="Choose a type"
              options={TYPES}
              value={state === "default" || state === "focus" ? null : "meeting-notes"}
            />
          </Cell>
        ))}
      </Group>
      <Group component="range">
        {(["default", "focus", "disabled"] as readonly RangeState[]).map((state) => (
          <Cell key={state} of="range" width={240}>
            <Range state={state} value={50} label="Summary length" />
          </Cell>
        ))}
      </Group>
      <Group component="chip">
        {(["default", "selected", "removable"] as readonly ChipKind[]).map((kind) => (
          <Cell key={kind} of="chip" width={200}>
            <Chip kind={kind} removeLabel="Remove Renaissance">
              Renaissance
            </Chip>
          </Cell>
        ))}
      </Group>
      <Group component="status-pill">
        {(
          [
            ["running", "Running"],
            ["waiting", "Waiting for you"],
            ["done", "Done"],
            ["failed", "Failed"],
            ["off", "Off"],
          ] as const satisfies readonly (readonly [StatusPillState, string])[]
        ).map(([state, word]) => (
          <Cell key={state} of="status-pill" width={200}>
            <StatusPill state={state}>{word}</StatusPill>
          </Cell>
        ))}
      </Group>
      <Group component="badge">
        {[1, 3, 12].map((count) => (
          <Cell key={count} of="badge" width={120}>
            <Badge count={count} label={`${String(count)} waiting for you`} />
          </Cell>
        ))}
      </Group>
      <Group component="progress">
        <Cell of="progress" width={240}>
          <Progress mode="determinate" value={70} label="Transcribing" />
        </Cell>
        <Cell of="progress" width={240}>
          <Progress mode="indeterminate" label="Copying the recording" />
        </Cell>
      </Group>
      <Group component="spinner">
        {([16, 20] as const).map((size) => (
          <Cell key={size} of="spinner" width={120}>
            <Spinner size={size} label="Loading spaces" />
          </Cell>
        ))}
      </Group>
      <Group component="skeleton">
        {(["text", "circle", "block"] as readonly SkeletonKind[]).map((kind) => (
          <Cell key={kind} of="skeleton" width={240}>
            <Skeleton kind={kind} />
          </Cell>
        ))}
      </Group>
      <Group component="link">
        {(["default", "hover", "visited"] as readonly LinkState[]).map((state) => (
          <Cell key={state} of="link" width={200}>
            <Link state={state} href="#/gallery">
              Open in Anytype
            </Link>
          </Cell>
        ))}
      </Group>
      <Group component="kbd">
        {["Esc", "⌘", "Enter"].map((key) => (
          <Cell key={key} of="kbd" width={120}>
            <Kbd keyName={key} />
          </Cell>
        ))}
      </Group>
      <Group component="code">
        <Cell of="code" width={200}>
          <Code kind="inline">127.0.0.1:31010</Code>
        </Cell>
        <Cell of="code" width={320}>
          <Code kind="block">
            {'"mcpServers": {\n  "innytypes": {\n    "url": "http://127.0.0.1:31010/mcp"\n  }\n}'}
          </Code>
        </Cell>
      </Group>
      <Group component="divider">
        <Cell of="divider" width={240}>
          <Divider />
        </Cell>
      </Group>
      <Group component="tooltip">
        <Cell of="tooltip" width={240} height={64}>
          <Tooltip open content="Tuesday 2026-09-23, 14:20">
            <span tabIndex={0} className="text-body text-primary">
              Tuesday 14:20
            </span>
          </Tooltip>
        </Cell>
      </Group>
    </Page>
  );
}
