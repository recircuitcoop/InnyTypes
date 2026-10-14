// Configuration › Flows › the canvas (plan 0022 §M; ux-writing "The Node-RED canvas"): the
// canvas frame around Node-RED's own editor, opened on the flow's tab (`/red/#flow/<id>`). Above
// it the flow's name, "Unsaved changes" while the editor holds edits not yet deployed, and Save
// and run, which presses the editor's own Deploy through the shell (saveCanvas). Inside the frame
// Node-RED keeps its own words and look (risk 1).
//
// The editor is another origin, so the page cannot read it: whether it is dirty is the shell's
// editorPalette, asked every second while the canvas is open, and the editor's address is the
// runtime's port, which stays the same for the session.
import { useEffect, useState } from "react";
import { InlineMessage } from "../components/molecules/InlineMessage";
import { CanvasFrame } from "../components/organisms/CanvasFrame";
import type { AppApi } from "../contract";
import { flowEditorUrl } from "../editor-url";
import { useFlows } from "../store";
import { t } from "../strings";
import { wordRefusal } from "../words";

/** How often the editor's dirty flag is asked while the canvas is open. */
export const DIRTY_POLL_MS = 1_000;

export interface CanvasScreenProps {
  readonly api: AppApi;
  readonly flowId: string;
}

export function CanvasScreen({ api, flowId }: CanvasScreenProps) {
  const flows = useFlows();
  const [address, setAddress] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let open = true;
    // The editor's address once the runtime has a port, then its dirty flag, every second.
    const look = async (): Promise<void> => {
      if (address === null) {
        const runtime = (await api.childStatus()).find((status) => status.child === "runtime");
        const url = flowEditorUrl(runtime, flowId);
        if (open && url !== null) {
          setAddress(url);
        }
        return;
      }
      const palette = await api.editorPalette();
      if (open) {
        setDirty(palette?.dirty ?? false);
      }
    };
    void look();
    const timer = setInterval(() => {
      void look();
    }, DIRTY_POLL_MS);
    return () => {
      open = false;
      clearInterval(timer);
    };
  }, [api, flowId, address]);

  const flow = flows.status === "ready" ? flows.value.find((each) => each.id === flowId) : null;
  const name = flow?.name ?? "";
  return (
    <CanvasFrame
      state={dirty ? "dirty" : "clean"}
      flowName={name}
      unsavedLabel={t("canvas.unsaved")}
      saveLabel={t("canvas.saveAndRun")}
      onSave={() => {
        void (async () => {
          const saved = await api.saveCanvas();
          if (saved.ok) {
            setProblem(null);
            setDirty(false);
          } else {
            setProblem(wordRefusal(saved.refused));
          }
        })();
      }}
    >
      <div className="flex min-w-0 flex-1 flex-col">
        {problem === null ? null : <InlineMessage kind="failed">{problem}</InlineMessage>}
        {address === null ? null : (
          <iframe
            data-testid="canvas-editor"
            title={name === "" ? t("nav.flows") : name}
            src={address}
            className="min-h-0 w-full flex-1 border-0"
          />
        )}
      </div>
    </CanvasFrame>
  );
}
