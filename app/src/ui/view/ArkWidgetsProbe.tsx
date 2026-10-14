// Every Ark UI widget of the component library, drawn inside the pop-out page (plan 0022 risk 7:
// "an e2e opens every Ark widget in the pop-up under the byte-identical CSP"). Development
// builds only: view.tsx imports it behind INNY_BUILD_MODE, at `#ark-widgets`. The atoms and
// molecules are the gallery's own pages, so nothing is drawn twice two ways; the modal Dialog is
// the gallery's modal probe. The gallery draws its controls at rest, so the ones a person moves
// (a switch, a checkbox, a number, a slider, tabs) are drawn once more here, live, holding their
// value.
import { useState } from "react";
import { Checkbox, type CheckboxState } from "../components/atoms/Checkbox";
import { NumberField } from "../components/atoms/NumberField";
import { Range } from "../components/atoms/Range";
import { Switch, type SwitchState } from "../components/atoms/Switch";
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
  return (
    <section data-probe-live="controls" className="flex flex-col gap-4">
      <Switch state={on} label="Flow on" onStateChange={setOn} />
      <Checkbox state={ticked} label="Select this run" onStateChange={setTicked} />
      <NumberField
        value={count}
        label="Speakers"
        incrementLabel="One more"
        decrementLabel="One fewer"
        onValueChange={setCount}
      />
      <Range value={length} label="Summary length" onValueChange={setLength} />
      <TabStrip
        label="Configuration"
        value={tab}
        onValueChange={setTab}
        tabs={[
          { value: "flows", label: "Flows" },
          { value: "general", label: "General" },
        ]}
      />
    </section>
  );
}

export function ArkWidgetsProbe() {
  return (
    <div data-probe="ark-widgets" className="flex flex-col gap-8 p-6">
      <LiveControls />
      <ModalDialogProbe />
      <AtomsPage />
      <MoleculesPage />
    </div>
  );
}
