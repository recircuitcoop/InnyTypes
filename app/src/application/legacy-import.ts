// The old config.toml is imported exactly once (plan 0018 §10 risk 4; WI-0018-25). A report
// file is also the marker: its mere existence says the import already ran, so there is no
// separate flag that could fall out of step with it (break it, watch it fail: run this twice
// against the same report file and the second run must change nothing).
//
// launch_at_login is read from the plan but deliberately NOT written here. Registering it with
// the operating system, and only then persisting the setting, is shell/migration.ts's job,
// through the very LaunchAtLogin the Settings page itself uses (application/launch-at-login.ts)
// — so an import that could not register with the OS never claims the switch is on.

import { buildLegacyImportPlan, type LegacyImportPlan } from "../domain/migration/legacy-import";
import { LegacyTomlError, parseLegacyToml } from "../domain/migration/legacy-toml";
import type { LegacyImportReport, LegacyImportReportStore } from "../ports/legacy-import";
import type { Logger } from "../ports/logger";
import type {
  LaunchAtLoginSetting,
  PackageSettingsStore,
  SettingsStore,
  UpdateSettingsStore,
} from "../ports/settings-store";
import type { TelemetrySetting } from "../ports/telemetry";

export type { LegacyImportReport, LegacyImportReportStore } from "../ports/legacy-import";

export type ShellSettings = SettingsStore &
  LaunchAtLoginSetting &
  TelemetrySetting &
  PackageSettingsStore &
  UpdateSettingsStore;

export interface LegacyImportDeps {
  /** The old config.toml's text, or null when there is none to import. */
  readonly readLegacyConfig: () => string | null;
  readonly reportStore: LegacyImportReportStore;
  readonly shellSettings: ShellSettings;
  /** The services process's own settings file: the only one that holds the mcp endpoint. */
  readonly mcpSettings: SettingsStore;
  readonly logger: Logger;
}

function emptyReport(): LegacyImportReport {
  return {
    importedAt: new Date().toISOString(),
    launchAtLoginWanted: false,
    imported: [],
    ignored: [],
  };
}

/** Runs the one-time import. Returns null when it had already run before this call. */
export function runLegacyImport(deps: LegacyImportDeps): LegacyImportReport | null {
  if (deps.reportStore.exists()) {
    return null;
  }

  const text = deps.readLegacyConfig();
  if (text === null) {
    const report = emptyReport();
    deps.reportStore.write(report);
    deps.logger.info("legacy import: no old config.toml was found; nothing to import");
    return report;
  }

  let plan: LegacyImportPlan;
  try {
    plan = buildLegacyImportPlan(parseLegacyToml(text));
  } catch (error) {
    const reason = error instanceof LegacyTomlError ? error.message : String(error);
    const report: LegacyImportReport = {
      ...emptyReport(),
      ignored: [{ key: "config.toml", reason: `could not be read: ${reason}` }],
    };
    deps.reportStore.write(report);
    deps.logger.warn(
      `legacy import: the old config.toml could not be read; nothing was imported (${reason})`,
    );
    return report;
  }

  if (plan.telemetry !== null) {
    deps.shellSettings.writeTelemetry(plan.telemetry);
  }
  if (plan.packagesSetting !== null) {
    deps.shellSettings.writePackages(plan.packagesSetting);
  }
  if (plan.sourcesSetting !== null) {
    deps.shellSettings.writeSources(plan.sourcesSetting);
  }
  if (plan.updateSetting !== null) {
    deps.shellSettings.writeUpdate(plan.updateSetting);
  }
  if (plan.mcpSetting !== null) {
    deps.mcpSettings.writeEndpoint(plan.mcpSetting);
  }

  const report: LegacyImportReport = {
    importedAt: new Date().toISOString(),
    launchAtLoginWanted: plan.launchAtLoginWanted,
    imported: plan.imported,
    ignored: plan.ignored,
  };
  deps.reportStore.write(report);
  for (const line of plan.imported) {
    deps.logger.info(`legacy import: ${line}`);
  }
  for (const item of plan.ignored) {
    deps.logger.info(`legacy import ignored ${item.key}: ${item.reason}`);
  }
  return report;
}
