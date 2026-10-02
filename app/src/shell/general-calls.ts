// General's calls that are no single flow's (plan 0022 §I, D8): the status pill, the runtime
// banner and the Live badge, pushed whenever a child's status or the questions waiting change;
// and Run history's retention, 90 days unless changed, 7, 30, 90 or 365 days or Forever.
//
// The badge counts the questions the runtime has waiting (the Inbox's count) until WI-0022-13
// counts them from run records, hidden places included.
import type { IpcMain } from "electron";
import { DEFAULT_RETENTION_DAYS } from "../application/runs";
import type { Supervisor } from "../application/supervisor";
import type { AnytypeStatus } from "../domain/anytype/status";
import { runtimeBanner, statusPill } from "../domain/status/status";
import type { ChildStatus } from "../domain/supervision/child-state";
import type { Logger } from "../ports/logger";
import type { RunRetentionSetting } from "../ports/settings-store";
import type { Answer } from "../ui/answer";
import { RETENTION_CHOICES, type Retention, type StatusView } from "../ui/general-contract";
import { guarded, opOf, refused, unknownOp } from "./answer";
import { IPC } from "./ipc";
import type { PendingQuestions } from "./views";

export interface GeneralCallsDeps {
  readonly ipc: Pick<IpcMain, "handle">;
  /** Every supervised child: the runtime and the services process. */
  readonly children: readonly Pick<Supervisor, "status" | "onStatus">[];
  readonly services: Pick<Supervisor, "call">;
  readonly pending: PendingQuestions;
  readonly retention: RunRetentionSetting;
  readonly toPage: (channel: string, ...args: unknown[]) => void;
  readonly logger: Logger;
}

export function wireGeneralCalls(deps: GeneralCallsDeps): void {
  const { ipc, children, services, pending, retention, toPage, logger } = deps;
  /** Anytype's state, as last read; the pill needs it only while the runtime runs. */
  let anytype: AnytypeStatus | null = null;
  const view = (): StatusView => {
    const statuses: ChildStatus[] = children.map((child) => child.status());
    return {
      pill: statusPill({ children: statuses, anytype }),
      banner: runtimeBanner(statuses),
      badge: pending.pending() ?? 0,
    };
  };
  const readAnytype = async (): Promise<void> => {
    const answer = await services.call("anytype.status", null);
    anytype = answer.ok ? (answer.value as AnytypeStatus) : null;
  };
  const push = (): void => {
    toPage(IPC.statusChanged, view());
  };
  for (const child of children) {
    child.onStatus(() => {
      void readAnytype().then(push);
    });
  }
  pending.onChange(push);

  const days = (): Retention => {
    const stored = retention.readRunRetentionDays();
    return { days: stored === undefined ? DEFAULT_RETENTION_DAYS : stored };
  };
  ipc.handle(IPC.generalCall, (_event, call: unknown) => {
    const { op, args } = opOf(call);
    return guarded(op, logger, async (): Promise<Answer<StatusView | Retention>> => {
      switch (op) {
        case "status.get":
          await readAnytype();
          return { ok: true, value: view() };
        case "retention.get":
          return { ok: true, value: days() };
        case "retention.set": {
          const chosen = args["days"];
          if (!RETENTION_CHOICES.some((choice) => choice === chosen)) {
            logger.warn(`retention.set: ${String(chosen)} is not one of General's choices`);
            return refused("failed", "refused.failed");
          }
          retention.writeRunRetentionDays(chosen as number | null);
          return { ok: true, value: days() };
        }
        default:
          return unknownOp(op, "general", logger);
      }
    });
  });
}
