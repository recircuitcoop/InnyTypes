// Configuration › Flows (plan 0022 §D, §M; ux-writing "Configuration › Flows"): the Flows list
// with each flow's switch, Last run, health, Edit, Run history and its ⋯ menu; New flow from a
// template (a card per template) or a blank canvas; and the dialogs the menu opens: Rename, and
// Delete flow (Destructive). Every change goes through the flow-admin calls of AppApi v2; the
// list itself is the flows store, which the shell's flows push keeps current.
import { useState } from "react";
import type { Answer } from "../answer";
import { Button } from "../components/atoms/Button";
import { TextField } from "../components/atoms/TextField";
import { DialogButtons } from "../components/molecules/DialogButtons";
import { InlineMessage } from "../components/molecules/InlineMessage";
import { Dialog } from "../components/organisms/Dialog";
import { EmptyState } from "../components/organisms/EmptyState";
import { FlowsList, type FlowAction, type FlowsListWords } from "../components/organisms/FlowsList";
import type { AppApi } from "../contract";
import type { FlowSummary, FlowTemplateEntry } from "../flow-contract";
import type { Route } from "../routes";
import { useFlows } from "../store";
import { t } from "../strings";
import { wordDeleteFlow, wordRefusal } from "../words";
import { BLANK_TEMPLATE, flowRow } from "./flow-rows";

const WORDS: FlowsListWords = {
  title: t("nav.flows"),
  newFlow: t("flows.new"),
  fromTemplate: t("flows.new.template"),
  blankCanvas: t("flows.new.blank"),
  edit: t("flows.edit"),
  runHistory: t("flows.runHistory"),
  more: t("flows.more"),
  rename: t("flows.rename"),
  duplicate: t("flows.duplicate"),
  exportFlow: t("flows.export"),
  deleteFlow: t("flows.delete"),
  switchLabel: (name) => `${name} ${t("flows.on")}`,
};

/** The templates under From a template: not asked yet (closed), being read, or read. */
type Templates =
  | { readonly state: "closed" }
  | { readonly state: "loading" }
  | { readonly state: "ready"; readonly templates: readonly FlowTemplateEntry[] };

export interface FlowsScreenProps {
  readonly api: AppApi;
  readonly navigate: (route: Route) => void;
}

export function FlowsScreen({ api, navigate }: FlowsScreenProps) {
  const flows = useFlows();
  // The line a refused call left: shown above the list until the next call answers.
  const [problem, setProblem] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<FlowSummary | null>(null);
  const [renaming, setRenaming] = useState<{ flow: FlowSummary; name: string } | null>(null);
  const [templates, setTemplates] = useState<Templates>({ state: "closed" });

  /** The value of an answer, or null with its refusal shown. */
  const answered = <T,>(answer: Answer<T>): T | null => {
    if (!answer.ok) {
      setProblem(wordRefusal(answer.refused));
      return null;
    }
    setProblem(null);
    return answer.value;
  };

  /** A new flow from a template, then its canvas: the person fills its steps in there. */
  const makeFlow = async (templateId: string): Promise<void> => {
    const made = answered(await api.flowFromTemplate(templateId));
    if (made !== null) {
      setTemplates({ state: "closed" });
      navigate({ screen: "canvas", flowId: made.id });
    }
  };

  const openTemplates = async (): Promise<void> => {
    setTemplates({ state: "loading" });
    const listed = answered(await api.templates());
    setTemplates(
      listed === null
        ? { state: "closed" }
        : { state: "ready", templates: listed.filter((each) => each.id !== BLANK_TEMPLATE) },
    );
  };

  const act = async (flow: FlowSummary, action: FlowAction): Promise<void> => {
    switch (action) {
      case "edit":
        navigate({ screen: "canvas", flowId: flow.id });
        return;
      case "run-history":
        navigate({ screen: "history", flowId: flow.id });
        return;
      case "on":
      case "off":
        answered(await api.setFlowOn(flow.id, action === "on"));
        return;
      case "rename":
        setRenaming({ flow, name: flow.name });
        return;
      case "duplicate":
        answered(await api.duplicateFlow(flow.id));
        return;
      case "export":
        // A cancelled save dialog answers `saved: null`: nothing to say.
        answered(await api.exportFlow(flow.id));
        return;
      case "delete":
        setDeleting(flow);
        return;
    }
  };

  if (flows.status === "loading") {
    return null;
  }
  if (flows.status === "refused") {
    return <InlineMessage kind="failed">{wordRefusal(flows.refused)}</InlineMessage>;
  }
  const now = new Date();
  const byId = new Map(flows.value.map((flow) => [flow.id, flow]));
  return (
    <div data-testid="flows-screen" className="flex flex-col gap-5">
      {problem === null ? null : <InlineMessage kind="failed">{problem}</InlineMessage>}
      <FlowsList
        flows={flows.value.map((flow) => flowRow(flow, now))}
        words={WORDS}
        onAction={(flowId, action) => {
          const flow = byId.get(flowId);
          if (flow !== undefined) {
            void act(flow, action);
          }
        }}
        onNewFlow={(from) => {
          void (from === "blank" ? makeFlow(BLANK_TEMPLATE) : openTemplates());
        }}
      />
      {templates.state === "ready" ? (
        <TemplateCards
          templates={templates.templates}
          onUse={(id) => {
            void makeFlow(id);
          }}
          onClose={() => {
            setTemplates({ state: "closed" });
          }}
        />
      ) : null}
      {flows.value.length === 0 ? <EmptyState area="flows" message={t("flows.empty")} /> : null}
      <DeleteDialog
        flow={deleting}
        onClose={() => {
          setDeleting(null);
        }}
        onDelete={async (flow) => {
          setDeleting(null);
          answered(await api.deleteFlow(flow.id));
        }}
      />
      <RenameDialog
        renaming={renaming}
        onChange={(name) => {
          setRenaming((current) => (current === null ? null : { ...current, name }));
        }}
        onClose={() => {
          setRenaming(null);
        }}
        onRename={async (flow, name) => {
          setRenaming(null);
          answered(await api.renameFlow(flow.id, name));
        }}
      />
    </div>
  );
}

/**
 * New flow › From a template: each template as a card, its name and one line, and Use this
 * template (ux-writing "Templates"). Panel fill, radius m, 16 inside (design-system "Space",
 * "Shape"); Cancel closes the cards.
 */
function TemplateCards({
  templates,
  onUse,
  onClose,
}: {
  readonly templates: readonly FlowTemplateEntry[];
  readonly onUse: (id: string) => void;
  readonly onClose: () => void;
}) {
  return (
    <section
      data-testid="template-cards"
      aria-label={t("flows.new.template")}
      className="flex flex-col gap-3"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-body-large font-semibold text-primary">{t("flows.new.template")}</h3>
        <Button kind="quiet" onClick={onClose}>
          {t("dialog.cancel")}
        </Button>
      </div>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
        {templates.map((template) => (
          <li
            key={template.id}
            data-testid="template-card"
            data-template={template.id}
            className="flex flex-col justify-between gap-4 rounded-m border border-surface-line bg-surface-panel p-4"
          >
            <p className="text-body text-secondary">
              {t("flows.template.card", { name: template.name, line: template.line })}
            </p>
            <Button
              kind="secondary"
              data-testid="template-use"
              className="self-start"
              onClick={() => {
                onUse(template.id);
              }}
            >
              {t("flows.template.use")}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Delete flow: the Destructive dialog, Delete and Cancel; Escape is Cancel. */
function DeleteDialog({
  flow,
  onClose,
  onDelete,
}: {
  readonly flow: FlowSummary | null;
  readonly onClose: () => void;
  readonly onDelete: (flow: FlowSummary) => Promise<void>;
}) {
  const words = wordDeleteFlow(flow?.name ?? "");
  return (
    <Dialog
      kind="destructive"
      testId="flow-delete-dialog"
      open={flow !== null}
      title={words.title}
      body={words.body}
      onClose={onClose}
      buttons={
        <DialogButtons
          kind="destructive"
          testId="flow-delete"
          primaryLabel={t("flows.delete.yes")}
          cancelLabel={t("dialog.cancel")}
          onPrimary={() => {
            if (flow !== null) {
              void onDelete(flow);
            }
          }}
          onCancel={onClose}
        />
      }
    />
  );
}

/** Rename: one field holding the flow's name, Rename and Cancel. */
function RenameDialog({
  renaming,
  onChange,
  onClose,
  onRename,
}: {
  readonly renaming: { readonly flow: FlowSummary; readonly name: string } | null;
  readonly onChange: (name: string) => void;
  readonly onClose: () => void;
  readonly onRename: (flow: FlowSummary, name: string) => Promise<void>;
}) {
  return (
    <Dialog
      kind="neutral"
      testId="flow-rename-dialog"
      open={renaming !== null}
      title={t("flows.rename")}
      body=""
      onClose={onClose}
      buttons={
        <div className="flex flex-col gap-5">
          <TextField
            testId="flow-rename-name"
            value={renaming?.name ?? ""}
            label={t("flows.rename.name")}
            onValueChange={onChange}
          />
          <DialogButtons
            kind="neutral"
            testId="flow-rename"
            primaryLabel={t("flows.rename")}
            cancelLabel={t("dialog.cancel")}
            onPrimary={() => {
              if (renaming !== null) {
                void onRename(renaming.flow, renaming.name);
              }
            }}
            onCancel={onClose}
          />
        </div>
      }
    />
  );
}
