// Field (Penpot 03 Molecules › field). State: Default, Error, Disabled. Suggested: Yes, No.
// The label (body 14 medium) above, the control, then the help line or, in Error, the error line
// (caption); 4px gaps. Suggested puts the "Suggested" tag right of the label. The control is
// drawn by the caller, who receives the id and description to wire it to.
import { useId, type ReactNode } from "react";
import { SuggestedTag } from "../atoms/TextField";
import { cx, variantAttributes } from "../variant";

export type FieldMoleculeState = "default" | "error" | "disabled";

/** What a Field hands its control so the label and the help or error line name it. */
export interface FieldControl {
  readonly id: string;
  readonly describedBy: string | undefined;
  readonly state: FieldMoleculeState;
}

export interface FieldProps {
  readonly state?: FieldMoleculeState;
  readonly suggested?: boolean;
  readonly suggestedLabel?: string;
  readonly label: string;
  readonly help?: string;
  /** Said when state is Error: what is wrong and what to do. */
  readonly error?: string;
  readonly children: (control: FieldControl) => ReactNode;
  readonly className?: string;
}

export function Field({
  state = "default",
  suggested = false,
  suggestedLabel,
  label,
  help,
  error,
  children,
  className,
}: FieldProps) {
  const id = useId();
  const line = state === "error" ? error : help;
  const lineId = line === undefined ? undefined : `${id}-line`;
  return (
    <div
      {...variantAttributes("field", { state, suggested })}
      aria-disabled={state === "disabled" ? true : undefined}
      className={cx("flex w-full flex-col gap-1", className)}
    >
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="text-body font-medium text-primary">
          {label}
        </label>
        {suggested && suggestedLabel !== undefined ? (
          <SuggestedTag>{suggestedLabel}</SuggestedTag>
        ) : null}
      </div>
      {children({ id, describedBy: lineId, state })}
      {line === undefined ? null : (
        <p
          id={lineId}
          className={cx("text-caption", state === "error" ? "text-failed" : "text-secondary")}
        >
          {line}
        </p>
      )}
    </div>
  );
}
