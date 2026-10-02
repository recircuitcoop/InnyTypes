// What every AppApi v2 call answers (plan 0022 §N): its value, or a refusal. Never a throw across
// IPC: a call that could not reach its process is a refusal too ("restarting", "down").
//
// A refusal carries a ui/strings.ts KEY and the values of its slots, never English: the renderer
// words it (ui/words.ts `wordRefusal`), so every sentence a person reads is in strings.ts.
import type { StepUse } from "../domain/packages/states";
import type { StringKey } from "./strings";

/** Why a call was refused. */
export type RefusalReason =
  /** The call is declared and its work item has not landed yet (each call says which). */
  | "not-available"
  /** The process that answers it is restarting, or down; or the call failed on the way. */
  | "restarting"
  | "down"
  | "failed"
  /** Nothing to do: no update is ready to install. */
  | "nothing-to-do"
  /** Flow administration (plan 0022 §D). */
  | "dirty"
  | "loading"
  | "not-installed"
  | "gone"
  | "name"
  | "no-template"
  | "no-step"
  | "no-form"
  | "invalid"
  /** A step's dynamic options (plan 0022 §B). */
  | "not-paired"
  | "unreachable"
  | "unavailable"
  /** Packages (plan 0022 §F, D6). */
  | "in-use"
  | "shipped";

export interface Refusal {
  readonly reason: RefusalReason;
  /** The line that says so, by key; `params` fills its slots. */
  readonly sentence: StringKey;
  readonly params?: Readonly<Record<string, string | number>>;
  /** `invalid` only: what is wrong, field by field. */
  readonly problems?: readonly { readonly path: string; readonly message: string }[];
  /** `in-use` only (D6): every flow and step that uses the package, and what was refused. */
  readonly inUse?: {
    readonly name: string;
    readonly action: "unregister" | "remove";
    readonly uses: readonly StepUse[];
  };
}

export type Answer<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly refused: Refusal };
