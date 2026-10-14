// The values of AppApi v2's board, Setup, update, package and General calls (plan 0022 §N), as
// they cross IPC. The domain's own types where the domain has one: the UI imports them as types
// (app/.dependency-cruiser.cjs, ui-imports-domain-types-only), so nothing is restated.
import type { BoardLayout } from "../domain/board/layout";
import type { Package, RowActions } from "../domain/packages/states";
import type { StatusPill, RuntimeBanner } from "../domain/status/status";
import type { SetupState } from "../domain/setup/setup";
import type { RollbackOffer, UpdateState } from "../domain/updates/machine";

export type {
  BoardLayout,
  Package,
  RollbackOffer,
  RowActions,
  RuntimeBanner,
  SetupState,
  StatusPill,
  UpdateState,
};

/** The `board` signal: this flow's board changed. */
export interface BoardChanged {
  readonly flowId: string;
}

/**
 * A move through Setup (plan 0022 §H, owner decisions 1 and 8): Continue (or the step's own
 * button that moves on), Back, the starter flow's form count once it is installed, and Ready's
 * closing choice (Try with a sample, Open Live, I'll build my own). The shell applies it with
 * domain/setup and stores the state, so a quit resumes at the same step.
 */
export type SetupMove =
  | { readonly kind: "next" }
  | { readonly kind: "back" }
  | { readonly kind: "starterForms"; readonly formCount: number }
  | { readonly kind: "finish" };

/** InnyTypes' own update (plan 0022 §G): the machine's state and the Go back offer. */
export interface UpdateView {
  readonly state: UpdateState;
  /** Go back, while it is offered (seven days after an update); null otherwise. */
  readonly goBack: RollbackOffer | null;
}

/** The status pill, the runtime banner and the Live badge (plan 0022 §I). */
export interface StatusView {
  readonly pill: StatusPill;
  readonly banner: RuntimeBanner | null;
  /** Questions waiting for the person, hidden places included. */
  readonly badge: number;
  /** The crash-loop limit the banner's Down sentence names ("5 times in 2 minutes"). */
  readonly crashLoop: { readonly crashes: number; readonly minutes: number };
}

/** Run history's retention (D8): days, or null for Forever. */
export interface Retention {
  readonly days: number | null;
}

/** The days General offers (D8); null is Forever. */
export const RETENTION_CHOICES: readonly (number | null)[] = [7, 30, 90, 365, null];

/** "Add a package… › From a folder": the folder the person chose; null when they cancelled. */
export interface ChosenFolder {
  readonly folder: string | null;
}

/** The `packages` signal: a package was installed, removed, updated or its state re-checked. */
export type PackagesChanged = null;

/** One package row in General (plan 0022 §F): its verified facets, publisher and actions. */
export interface PackageView {
  readonly package: Package;
  /** Who vouches for it ("by InnyTypes"); null for a folder nobody signed. */
  readonly publisher: string | null;
  /** The row's buttons, from domain/packages/states.ts `rowActions`, judged when listed. */
  readonly actions: RowActions;
}

/** A catalogue entry "Add a package… › From the catalogue" offers. */
export interface PackageOffer {
  /** `official`, or a registered source's name. */
  readonly source: string;
  readonly id: string;
  readonly name: string;
  readonly version: string | null;
  readonly summary: string;
}

/** General's Packages: every package's row, and what can be added from the catalogues. */
export interface PackagesView {
  readonly packages: readonly PackageView[];
  readonly offers: readonly PackageOffer[];
}
