// Setup's node forms (plan 0022 §H, ux-writing "Node forms"): one screen per step of the starter
// flow after its source, in wire order, titled "Set up: *step name*" with "Step n of N." over
// it. The step's own form is read with nodeForm and saved with configureNode, the same calls the
// canvas's forms use; a field whose options come from Anytype (`innytype`) lists them through
// nodeOptions. Continue saves, and moves on only once the step is saved.
import { useEffect, useState } from "react";
import type { AppApi } from "../contract";
import type { Answer, Refusal } from "../answer";
import type { NodeForm, NodeOptions } from "../flow-contract";
import { Select } from "../components/atoms/Select";
import { Switch } from "../components/atoms/Switch";
import { TextField } from "../components/atoms/TextField";
import { Field } from "../components/molecules/Field";
import { InlineMessage } from "../components/molecules/InlineMessage";
import { SetupStep } from "../components/organisms/SetupStep";
import {
  draftOf,
  markedParts,
  plainOf,
  problemsByField,
  setupFields,
  valuesOf,
  type Draft,
  type MarkedPart,
  type SetupField,
} from "../setup-form";
import { t } from "../strings";
import { wordRefusal } from "../words";

/** A line whose names (ux-writing's `*…*`) are drawn in italics. */
export function Marked({ parts }: { readonly parts: readonly MarkedPart[] }) {
  return (
    <>
      {parts.map((part, index) =>
        part.named ? <em key={index}>{part.text}</em> : <span key={index}>{part.text}</span>,
      )}
    </>
  );
}

export interface SetupFormProps {
  readonly api: AppApi;
  readonly flowId: string;
  /** The step this screen sets up. */
  readonly step: { readonly id: string; readonly name: string };
  /** Which form, from 0, of how many. */
  readonly index: number;
  readonly count: number;
  readonly onBack: () => void;
  /** The step is saved: on to the next form, or Ready. */
  readonly onSaved: () => void;
}

export function SetupForm({ api, flowId, step, index, count, onBack, onSaved }: SetupFormProps) {
  const [form, setForm] = useState<Answer<NodeForm> | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  useEffect(() => {
    let live = true;
    void api.nodeForm(flowId, step.id).then((answer) => {
      if (!live) return;
      setForm(answer);
      if (answer.ok) setDraft(draftOf(setupFields(answer.value.schema), answer.value.values));
    });
    return () => {
      live = false;
    };
  }, [api, flowId, step.id]);
  const fields = form?.ok === true ? setupFields(form.value.schema) : [];
  const problems = problemsByField(refusal?.problems);
  const title = markedParts("setup.form.title", { step: step.name });
  const save = () => {
    setRefusal(null);
    void api.configureNode(flowId, step.id, valuesOf(fields, draft)).then((saved) => {
      if (saved.ok) {
        onSaved();
      } else {
        setRefusal(saved.refused);
      }
    });
  };
  return (
    <SetupStep
      progress={t("setup.form.progress", { step: index + 1, of: count })}
      title={<Marked parts={title} />}
      label={plainOf(title)}
      backLabel={t("setup.back")}
      continueLabel={t("setup.continue")}
      continueDisabled={form?.ok !== true}
      onBack={onBack}
      onContinue={save}
    >
      <div data-testid="setup-form" data-node={step.id} className="flex flex-col gap-4">
        {fields.map((field) => (
          <SetupFormField
            key={field.key}
            api={api}
            field={field}
            draft={draft}
            problem={problems[field.key]}
            onChange={(value) => {
              setDraft((before) => ({ ...before, [field.key]: value }));
            }}
          />
        ))}
        {form?.ok === false ? (
          <InlineMessage kind="failed">{wordRefusal(form.refused)}</InlineMessage>
        ) : null}
        {refusal === null ? null : (
          <div data-testid="setup-message">
            <InlineMessage kind="failed">
              {refusal.reason === "invalid" && refusal.params !== undefined ? (
                <Marked parts={markedParts("error.formIncomplete", refusal.params)} />
              ) : (
                wordRefusal(refusal)
              )}
            </InlineMessage>
          </div>
        )}
      </div>
    </SetupStep>
  );
}

interface FieldProps {
  readonly api: AppApi;
  readonly field: SetupField;
  readonly draft: Draft;
  readonly problem: string | undefined;
  readonly onChange: (value: string | boolean) => void;
}

function SetupFormField({ api, field, draft, problem, onChange }: FieldProps) {
  const value = draft[field.key];
  const text = typeof value === "string" ? value : "";
  return (
    <div data-testid={`setup-field-${field.key}`}>
      <Field
        label={field.label}
        state={problem === undefined ? "default" : "error"}
        {...(field.help === null ? {} : { help: field.help })}
        {...(problem === undefined ? {} : { error: problem })}
      >
        {(control) => {
          if (field.kind === "boolean") {
            return (
              <Switch
                state={value === true ? "on" : "off"}
                label={field.label}
                hideLabel
                onStateChange={(state) => {
                  onChange(state === "on");
                }}
              />
            );
          }
          if (field.kind === "enum") {
            return (
              <Select
                label={field.label}
                hideLabel
                options={field.options.map((option) => ({ value: option, label: option }))}
                value={text === "" ? null : text}
                onValueChange={(chosen) => {
                  onChange(chosen ?? "");
                }}
              />
            );
          }
          if (field.innytype !== null) {
            return <AnytypeSelect api={api} field={field} draft={draft} onChange={onChange} />;
          }
          return (
            <TextField
              id={control.id}
              {...(control.describedBy === undefined ? {} : { describedBy: control.describedBy })}
              state={problem === undefined ? "default" : "error"}
              type={field.kind === "secret" ? "password" : "text"}
              value={text}
              onValueChange={onChange}
            />
          );
        }}
      </Field>
    </div>
  );
}

/** A field whose options are the paired Anytype's spaces, or one space's types. */
function AnytypeSelect({ api, field, draft, onChange }: Omit<FieldProps, "problem">) {
  const [options, setOptions] = useState<Answer<NodeOptions> | null>(null);
  const innytype = field.innytype;
  const spaceId =
    innytype?.source === "types" && typeof draft[innytype.of] === "string"
      ? String(draft[innytype.of])
      : "";
  useEffect(() => {
    let live = true;
    setOptions(null);
    if (innytype === null || (innytype.source === "types" && spaceId === "")) {
      return;
    }
    const query =
      innytype.source === "spaces"
        ? ({ source: "spaces" } as const)
        : ({ source: "types", spaceId } as const);
    void api.nodeOptions(query).then((answer) => {
      if (live) setOptions(answer);
    });
    return () => {
      live = false;
    };
  }, [api, innytype, spaceId]);
  const value = typeof draft[field.key] === "string" ? String(draft[field.key]) : "";
  const listed = options?.ok === true ? options.value.options : [];
  // The value kept is offered under its own text when the answer lacks it: never dropped.
  const choices =
    listed.some((option) => option.value === value) || value === ""
      ? listed
      : [...listed, { value, label: value }];
  const reading = innytype?.source === "types" ? t("form.readingTypes") : t("form.readingSpaces");
  return (
    <div className="flex flex-col gap-1">
      <Select
        label={field.label}
        hideLabel
        state={options?.ok === true ? "default" : "disabled"}
        options={choices}
        value={value === "" ? null : value}
        onValueChange={(chosen) => {
          onChange(chosen ?? "");
        }}
      />
      {options === null && (innytype?.source === "spaces" || spaceId !== "") ? (
        <p className="text-caption text-secondary">{reading}</p>
      ) : null}
      {options?.ok === false ? (
        <InlineMessage kind="warning">{wordRefusal(options.refused)}</InlineMessage>
      ) : null}
    </div>
  );
}
