// Every Ark UI widget of the component library, drawn inside the pop-out page (plan 0022 risk 7:
// "an e2e opens every Ark widget in the pop-up under the byte-identical CSP"). Development
// builds only: view.tsx imports it behind INNY_BUILD_MODE, at `#ark-widgets`. The atoms and
// molecules are the gallery's own pages, so nothing is drawn twice two ways; the modal Dialog is
// the gallery's modal probe. The gallery draws its controls at rest, so the ones a person moves
// (a switch, a checkbox, a number, a slider, tabs) are drawn once more here, live, holding their
// value. A Select, a Combobox, a Menu and a Tooltip are drawn live too, so the e2e finds each by
// its test id.
import { useState } from "react";
import { Button } from "../components/atoms/Button";
import { Checkbox, type CheckboxState } from "../components/atoms/Checkbox";
import { NumberField } from "../components/atoms/NumberField";
import { Range } from "../components/atoms/Range";
import { Select } from "../components/atoms/Select";
import { Switch, type SwitchState } from "../components/atoms/Switch";
import { Tooltip } from "../components/atoms/Tooltip";
import { Combobox } from "../components/molecules/Combobox";
import { Menu } from "../components/molecules/Menu";
import { MenuItem } from "../components/molecules/MenuItem";
import { TabStrip } from "../components/molecules/TabStrip";
import { AtomsPage } from "../gallery/atoms";
import { ModalDialogProbe } from "../gallery/ModalDialogProbe";
import { MoleculesPage } from "../gallery/molecules";

function LiveControls() {
  const [on, setOn] = useState<SwitchState>("off");
  const [ticked, setTicked] = useState<CheckboxState>("off");
  const [count, setCount] = useState("2");
  const [length, setLength] = useState(50);
  const [tab, setTab] = useState("flows");
  const [range, setRange] = useState<string | null>("7");
  const [typed, setTyped] = useState("");
  const [space, setSpace] = useState<string | null>(null);
  return (
    <section data-probe-live="controls" className="flex flex-col gap-4">
      <Switch state={on} label="Flow on" testId="probe-switch" onStateChange={setOn} />
      <Checkbox
        state={ticked}
        label="Select this run"
        testId="probe-checkbox"
        onStateChange={setTicked}
      />
      <NumberField
        testId="probe-number"
        value={count}
        label="Speakers"
        incrementLabel="One more"
        decrementLabel="One fewer"
        onValueChange={setCount}
      />
      <Range value={length} label="Summary length" testId="probe-range" onValueChange={setLength} />
      <TabStrip
        label="Configuration"
        testId="probe-tab"
        value={tab}
        onValueChange={setTab}
        tabs={[
          { value: "flows", label: "Flows" },
          { value: "general", label: "General" },
        ]}
      />
      <Select
        label="Range"
        testId="probe-select"
        value={range}
        options={[
          { value: "7", label: "Last 7 days" },
          { value: "30", label: "Last 30 days" },
        ]}
        onValueChange={setRange}
      />
      <Combobox
        label="Space"
        testId="probe-combobox"
        value={space}
        inputValue={typed}
        options={[
          { value: "work", label: "Work" },
          { value: "home", label: "Home" },
        ]}
        onInputValueChange={setTyped}
        onValueChange={setSpace}
      />
      <Menu
        testId="probe-menu"
        trigger={
          <Button kind="secondary" data-testid="probe-menu-trigger">
            More
          </Button>
        }
      >
        <MenuItem value="rename" label="Rename" />
      </Menu>
      <Tooltip content="Monday 29 September 2026, 14:20" testId="probe-tooltip">
        <span tabIndex={0} data-testid="probe-tooltip-trigger">
          today, 14:20
        </span>
      </Tooltip>
    </section>
  );
}

export function ArkWidgetsProbe() {
  return (
    <div
      data-testid="ark-widgets-probe"
      data-probe="ark-widgets"
      className="flex flex-col gap-8 p-6"
    >
      <LiveControls />
      <ModalDialogProbe />
      <AtomsPage />
      <MoleculesPage />
    </div>
  );
}
