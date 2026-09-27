// The shell's telemetry (WI-0018-22): the first-launch question and the switch on the app page,
// the crash counts of the runtime, the services process and every node process, and one usage
// report per launch. Apart from main.ts so the composition root keeps only adapter construction
// (plan 0018 §2.3): main.ts builds the adapters and hands them in.
//
// Every report goes through the pipeline, which reads the switch again each time: while the
// question is unanswered this reports nothing, queues nothing and reads no machine identifier.

import { randomUUID } from "node:crypto";
import * as os from "node:os";
import type { IpcMain } from "electron";
import { CrashReports } from "../application/crash-reports";
import type { Supervisor } from "../application/supervisor";
import { TelemetryPipeline, type TelemetryDeps } from "../application/telemetry";
import type { SecretRegistry } from "../domain/redaction/registry";
import type { ChildName } from "../domain/supervision/child-state";
import {
  FIRST_LAUNCH_QUESTION,
  PRIVACY_NOTICE,
  usagePayload,
  type ReportedPackage,
  type Versions,
} from "../domain/telemetry/reports";
import type { Endpoints } from "../domain/telemetry/transports";
import type { TelemetryStatus } from "../ui/contract";
import { IPC } from "./ipc";

/** A package as the package store lists it, as far as a usage report looks at it. */
export interface ListedPackage {
  readonly name: string;
  readonly document: unknown;
  /** Installed by a person, not shipped with the app. */
  readonly installed: boolean;
  /** For an installed package: whether a publisher's signature covered it. */
  readonly signed: boolean;
}

export interface TelemetryWiring extends Pick<
  TelemetryDeps,
  "setting" | "queue" | "poster" | "machineIdentifier" | "hashIdentifier" | "clock" | "logger"
> {
  readonly ipc: Pick<IpcMain, "handle">;
  /** Where the build's endpoints are read from (the environment, until WI-0018-23's settings). */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly appVersion: string;
  /** The one log's registry: every credential it holds is removed from every payload. */
  readonly registry: Pick<SecretRegistry, "redact">;
  /** Where the raw machine identifier is registered: the one log. */
  readonly sink: TelemetryDeps["secrets"];
  /** The supervised children: a crash is read off each one's status; the runtime tells of nodes'. */
  readonly supervisors: ReadonlyMap<ChildName, Pick<Supervisor, "onStatus" | "onNodeCrash">>;
  readonly packages: () => readonly ListedPackage[];
}

/** The build's endpoints: empty, and so reporting nowhere, unless a release sets them. */
export function telemetryEndpoints(env: Readonly<Record<string, string | undefined>>): Endpoints {
  return {
    glitchtipDsn: env["INNYTYPES_GLITCHTIP_DSN"] ?? "",
    umamiUrl: env["INNYTYPES_UMAMI_URL"] ?? "",
    umamiWebsiteId: env["INNYTYPES_UMAMI_WEBSITE_ID"] ?? "",
  };
}

/**
 * The packages a usage report names: the shipped ones and the signed installs. An unsigned
 * package's name is whatever its author typed, maybe the person themselves, so it is only counted.
 */
export function reportedPackages(listed: readonly ListedPackage[]): {
  readonly named: readonly ReportedPackage[];
  readonly unsigned: number;
} {
  const named: ReportedPackage[] = [];
  let unsigned = 0;
  for (const entry of listed) {
    if (entry.installed && !entry.signed) {
      unsigned += 1;
      continue;
    }
    const document = entry.document as { readonly version?: unknown } | null;
    const version = typeof document?.version === "string" ? document.version : "unknown";
    named.push({ id: entry.name, version });
  }
  return { named, unsigned };
}

/** Build the pipeline, answer the page's telemetry calls, count crashes, and start the sender. */
export function wireTelemetry(deps: TelemetryWiring): TelemetryPipeline {
  const { ipc, registry } = deps;
  const pipeline = new TelemetryPipeline({
    ...deps,
    endpoints: telemetryEndpoints(deps.env),
    release: deps.appVersion,
    now: () => Date.now(),
    newId: () => randomUUID().replaceAll("-", ""),
    credentials: (text) => registry.redact(text),
    secrets: deps.sink,
  });
  const versions: Versions = {
    appVersion: deps.appVersion,
    os: process.platform,
    osVersion: os.release(),
    arch: process.arch,
  };
  const crashes = new CrashReports({
    record: (payload) => pipeline.recordCrash(payload),
    versions,
  });
  for (const supervisor of deps.supervisors.values()) {
    supervisor.onStatus((status) => {
      crashes.childStatus(status);
    });
  }
  deps.supervisors.get("runtime")?.onNodeCrash((stopped) => {
    crashes.nodeCrashed(stopped);
  });

  const reportUsage = (): void => {
    const { named, unsigned } = reportedPackages(deps.packages());
    pipeline.recordUsage({ ...usagePayload(versions, named), unsigned_packages: unsigned });
  };
  const status = (): TelemetryStatus => ({
    ...pipeline.state(),
    question: FIRST_LAUNCH_QUESTION,
    notice: PRIVACY_NOTICE,
  });
  ipc.handle(IPC.telemetry, status);
  ipc.handle(IPC.setTelemetry, (_event, on: unknown): TelemetryStatus => {
    if (typeof on === "boolean") {
      pipeline.answer(on);
      // A yes is what lets this launch's usage report be queued.
      if (on) {
        reportUsage();
      }
    }
    return status();
  });

  // This launch's usage report: queued only when the switch is already on.
  reportUsage();
  pipeline.start();
  return pipeline;
}
