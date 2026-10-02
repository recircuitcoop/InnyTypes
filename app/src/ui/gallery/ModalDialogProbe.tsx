// A modal Dialog for gallery.e2e.ts (plan 0022 §P, owner decision 11): the gallery draws its
// dialogs contained, with no focus trap, so the trap and Escape = Cancel are proved on this real
// modal instance at #/gallery/modal-dialog. Dev builds only, like the rest of the gallery.
import { useState } from "react";
import { Button } from "../components/atoms/Button";
import { DialogButtons } from "../components/molecules/DialogButtons";
import { Dialog } from "../components/organisms/Dialog";
import { t } from "../strings";

export function ModalDialogProbe() {
  const [open, setOpen] = useState(false);
  /** How the last opening ended: "cancel" (Cancel, Escape or the scrim) or "confirm". */
  const [outcome, setOutcome] = useState("none");
  const end = (how: string) => {
    setOutcome(how);
    setOpen(false);
  };
  return (
    <main data-probe="modal-dialog" data-probe-outcome={outcome} className="p-6">
      <Button
        kind="secondary"
        data-testid="open-dialog"
        onClick={() => {
          setOpen(true);
        }}
      >
        {t("board.removeTab")}
      </Button>
      <Dialog
        kind="warning"
        open={open}
        title={t("board.removeTab.title", { tab: "Customers" })}
        body={t("board.removeTab.body")}
        onClose={() => {
          end("cancel");
        }}
        buttons={
          <DialogButtons
            kind="neutral"
            primaryLabel={t("board.removeTab")}
            cancelLabel={t("dialog.cancel")}
            onPrimary={() => {
              end("confirm");
            }}
            onCancel={() => {
              end("cancel");
            }}
          />
        }
      />
    </main>
  );
}
