// Every Ark UI widget of the component library, drawn inside the pop-out page (plan 0022 risk 7:
// "an e2e opens every Ark widget in the pop-up under the byte-identical CSP"). Development
// builds only: view.tsx imports it behind INNY_BUILD_MODE, at `#ark-widgets`. The atoms and
// molecules are the gallery's own pages, so nothing is drawn twice two ways; the modal Dialog is
// the gallery's modal probe.
import { AtomsPage } from "../gallery/atoms";
import { ModalDialogProbe } from "../gallery/ModalDialogProbe";
import { MoleculesPage } from "../gallery/molecules";

export function ArkWidgetsProbe() {
  return (
    <div data-probe="ark-widgets" className="flex flex-col gap-8 p-6">
      <ModalDialogProbe />
      <AtomsPage />
      <MoleculesPage />
    </div>
  );
}
