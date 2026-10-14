// Configuration › General › Recorders and folders (ux-writing: "BOYA · watching" · Add a
// folder…): one line per folder source step in the flows, read from the step's own form, by the
// folder's name and never its path; "No recorder or folder is watched yet." only when there is
// none. A recorder is a source a package such as monty provides; none ships yet, so only the
// shipped folder source (D18) is listed. Add a folder… goes to Configuration › Flows, where a
// source is added to a flow.
import { useEffect, useState } from "react";
import type { AppApi } from "../contract";
import { Button } from "../components/atoms/Button";
import { Code } from "../components/atoms/Code";
import { GeneralSection } from "../components/organisms/GeneralSection";
import { codeParts, folderSteps, recorderLine } from "../general";
import { useFlows } from "../store";
import { t } from "../strings";

/** A watched folder's line, by its step. */
interface Watched {
  readonly nodeId: string;
  readonly line: string;
}

export function RecordersSection({
  api,
  onAddFolder,
}: {
  readonly api: AppApi;
  readonly onAddFolder: () => void;
}) {
  const flows = useFlows();
  const [watched, setWatched] = useState<readonly Watched[] | null>(null);
  useEffect(() => {
    if (flows.status !== "ready") {
      return;
    }
    let live = true;
    const steps = folderSteps(flows.value);
    // Each step's folder is in its form's values; a step whose form cannot be read is left out.
    void Promise.all(
      steps.map(async (step): Promise<Watched | null> => {
        const form = await api.nodeForm(step.flowId, step.nodeId);
        const folder = form.ok ? form.value.values["folder"] : undefined;
        return typeof folder === "string" && folder !== ""
          ? { nodeId: step.nodeId, line: recorderLine(folder, step.on) }
          : null;
      }),
    ).then((lines) => {
      if (live) setWatched(lines.filter((line): line is Watched => line !== null));
    });
    return () => {
      live = false;
    };
  }, [api, flows]);
  return (
    <GeneralSection
      section="recorders"
      title={t("general.recorders")}
      state={
        watched === null ? null : watched.length === 0 ? (
          <span data-testid="general-recorders-state">{t("general.recorders.none")}</span>
        ) : (
          <ul data-testid="general-recorders-state" className="flex flex-col gap-1">
            {watched.map((entry) => (
              <li key={entry.nodeId} data-testid="general-recorder">
                {entry.line}
              </li>
            ))}
          </ul>
        )
      }
    >
      <div>
        <Button kind="secondary" onClick={onAddFolder} data-testid="general-add-folder">
          {t("general.addFolder")}
        </Button>
      </div>
    </GeneralSection>
  );
}

/** A line with its backticked part drawn as inline code (the AI apps line's address). */
export function WithCode({ text }: { readonly text: string }) {
  return (
    <>
      {codeParts(text).map((part, index) =>
        part.code ? (
          <Code key={index} kind="inline" testId="inline-code">
            {part.text}
          </Code>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}
