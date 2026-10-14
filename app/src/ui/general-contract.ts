// The values of AppApi v2's board, Setup, update, package and General calls (plan 0022 §N), as
// they cross IPC. The domain's own types where the domain has one: the UI imports them as types
// (app/.dependency-cruiser.cjs, ui-imports-domain-types-only), so nothing is restated.
import type { BoardLayout, SlotSize } from "../domain/board/layout";
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

/**
 * A flow's board as Live reads it (plan 0022 §A, §C): its layout, reconciled with the flow's view
 * nodes, and `fresh`, the view nodes that got a place since Edit layout last named new places.
 * Edit layout's bar names those once ("New on the board: …"): entering it sends `seen`.
 */
export interface BoardView {
  readonly layout: BoardLayout;
  readonly fresh: readonly string[];
}

/**
 * One change made in Edit layout. The shell applies it with domain/board's own operations and
 * keeps the result at once: there is no separate save (ux-writing, Live: the board).
 * * `move`: to `tabId` at position `order` there (Move earlier, Move later, Move to tab, a drag);
 * * `seen`: Edit layout has just named these new places; they leave `fresh`, and a place that
 *   arrived after the page read the board stays in it, to be named next time.
 */
export type BoardChange =
  | {
      readonly kind: "move";
      readonly viewNodeId: string;
      readonly tabId: string;
      readonly order: number;
    }
  | { readonly kind: "size"; readonly viewNodeId: string; readonly size: SlotSize }
  | { readonly kind: "hide"; readonly viewNodeId: string }
  | { readonly kind: "show"; readonly viewNodeId: string }
  | { readonly kind: "add-tab"; readonly name: string }
  | { readonly kind: "rename-tab"; readonly tabId: string; readonly name: string }
  | { readonly kind: "remove-tab"; readonly tabId: string }
  | { readonly kind: "seen"; readonly viewNodeIds: readonly string[] };

/** The `board` signal: this flow's board changed. */
export interface BoardChanged {
  readonly flowId: string;
}

/**
 * A move through Setup (plan 0022 §H, owner decisions 1 and 8): Continue (or the step's own
 * button that moves on), Back, the starter flow's form count once it is installed, and Ready's
 * closing choice (Open Live, I'll build my own). The shell applies it with
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
  /** The "Check automatically" switch. */
  readonly autoCheck: boolean;
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

/**
 * The `packages` push (plan 0022 §F): an install's phase as it starts (fetching, verifying,
 * building, swapping) with its percentage and when, or null when something else changed: a
 * package was installed, removed, updated or re-checked. `name` is null until it is read.
 */
export type PackagesChanged = {
  readonly name: string | null;
  readonly phase: "fetching" | "verifying" | "building" | "swapping";
  readonly percent: number;
  readonly verifiedAt: Date;
} | null;

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
