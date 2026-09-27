// What the old config.toml's document maps onto in the new settings (plan 0018 §10 risk 4;
// WI-0018-25): the telemetry answer, the launch-at-login switch, [plugins] and [update]'s
// checking policy into `packages`, [sources] into `sources`, [update].channel into `update`,
// and [mcp] into the endpoint setting.
//
// Every candidate is judged by the SAME validator the rest of the app judges that setting by
// (parsePackagePolicy, parseCatalogueSources, parseUpdatePolicy, checkedAddress) before it is
// ever offered for writing: one rule, not a second copy of it that could drift. A candidate that
// fails is not imported, and why is recorded rather than the import failing as a whole — one bad
// field never costs the rest of the file.
//
// What this deliberately does not carry over, and why, is also recorded: [helper] and [logging]
// (fixed constants and an environment variable now, not settings), update.check_jitter (no
// random delay in the new scheduler), and a plugin's `enabled`/`source` fields (the installed
// package's own record now, not a config.toml line).

import { parseCatalogueSources, CatalogueSettingsError } from "../packages/catalogue";
import { parsePackagePolicy, PackageSettingsError } from "../packages/versions";
import { parseUpdatePolicy, UpdateSettingsError } from "../update/policy";
import { checkedAddress, EndpointError } from "../endpoint/address";
import type { TomlTable, TomlValue } from "./legacy-toml";

/** One thing the old file said that this import did not carry over, and why. */
export interface LegacyIgnoredItem {
  readonly key: string;
  readonly reason: string;
}

export interface LegacyImportPlan {
  /** null: unanswered (absent, or not a boolean) — never imported as a no. */
  readonly telemetry: boolean | null;
  /** Whether the old file asked to start at login; only ever applied, never turned off. */
  readonly launchAtLoginWanted: boolean;
  readonly packagesSetting: Readonly<Record<string, unknown>> | null;
  readonly sourcesSetting: Readonly<Record<string, unknown>> | null;
  readonly updateSetting: Readonly<Record<string, unknown>> | null;
  readonly mcpSetting: { readonly host?: string; readonly port?: number } | null;
  /** One line per value actually carried over, in the words the report and the log use. */
  readonly imported: readonly string[];
  readonly ignored: readonly LegacyIgnoredItem[];
}

const KNOWN_TOP_LEVEL = new Set([
  "telemetry",
  "launch_at_login",
  "auto_check_versions",
  "update",
  "plugins",
  "mcp",
  "sources",
  "helper",
  "logging",
]);

const OLD_UPDATE_MODES = new Set(["auto", "manual", "off"]);

function isTable(value: TomlValue | TomlTable | undefined): value is TomlTable {
  return typeof value === "object";
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** auto/manual pass through; off has no equivalent mode, so it is imported as pinned (never
 * applied on its own, which is the closer of the two to "never auto-updated" than "auto"). */
function mapUpdateMode(
  value: TomlValue | TomlTable | undefined,
  where: string,
  ignored: LegacyIgnoredItem[],
  imported: string[],
): "auto" | "manual" | "pinned" | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !OLD_UPDATE_MODES.has(value)) {
    ignored.push({
      key: where,
      reason: `${JSON.stringify(value)} is not a recognised update mode`,
    });
    return undefined;
  }
  if (value === "off") {
    imported.push(`${where}: "off" has no equivalent mode in the new app; imported as "pinned"`);
    return "pinned";
  }
  return value === "auto" ? "auto" : "manual";
}

export function buildLegacyImportPlan(document: TomlTable): LegacyImportPlan {
  const imported: string[] = [];
  const ignored: LegacyIgnoredItem[] = [];

  for (const key of Object.keys(document)) {
    if (!KNOWN_TOP_LEVEL.has(key)) {
      ignored.push({ key, reason: "not a setting this import recognises" });
    }
  }
  if ("helper" in document) {
    ignored.push({
      key: "helper",
      reason:
        "the restart, breaker and resource-limit numbers it held are fixed constants in the " +
        "new app, not settings a person edits",
    });
  }
  if ("logging" in document) {
    ignored.push({
      key: "logging",
      reason:
        "verbosity is set by the INNYTYPES_LOG_LEVEL environment variable now, not a stored setting",
    });
  }

  // --- telemetry (WI-0018-22) -----------------------------------------------------------------
  let telemetry: boolean | null = null;
  if (typeof document["telemetry"] === "boolean") {
    telemetry = document["telemetry"];
    imported.push(`telemetry: ${String(telemetry)}`);
  } else if ("telemetry" in document) {
    ignored.push({ key: "telemetry", reason: "not true or false; left unanswered" });
  }

  // --- launch at login (WI-0018-21) -----------------------------------------------------------
  let launchAtLoginWanted = false;
  if ("launch_at_login" in document) {
    if (typeof document["launch_at_login"] === "boolean") {
      launchAtLoginWanted = document["launch_at_login"];
      imported.push(`launch_at_login: ${String(launchAtLoginWanted)}`);
    } else {
      ignored.push({ key: "launch_at_login", reason: "not true or false; treated as off" });
    }
  }

  // --- packages: [plugins] + auto_check_versions + [update].check_interval (WI-0018-17) -------
  const plugins = isTable(document["plugins"]) ? document["plugins"] : {};
  const updateSection = isTable(document["update"]) ? document["update"] : {};
  const packagesCandidate: Record<string, unknown> = {};

  const globalMode = mapUpdateMode(
    plugins["update_mode"],
    "plugins.update_mode",
    ignored,
    imported,
  );
  if (globalMode !== undefined) {
    packagesCandidate["update_mode"] = globalMode;
  }
  if (typeof document["auto_check_versions"] === "boolean") {
    packagesCandidate["auto_check_versions"] = document["auto_check_versions"];
    imported.push(
      `auto_check_versions: ${String(document["auto_check_versions"])} (applied to both package and update checks)`,
    );
  }
  if (typeof updateSection["check_interval"] === "number") {
    packagesCandidate["check_interval"] = updateSection["check_interval"];
    imported.push(
      `update.check_interval: ${String(updateSection["check_interval"])}s (applied to packages.check_interval)`,
    );
  }
  if ("check_jitter" in updateSection) {
    ignored.push({
      key: "update.check_jitter",
      reason: "the new scheduler has no random delay before a check",
    });
  }

  const overrides: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(plugins)) {
    if (name === "update_mode" || !isTable(value)) {
      continue;
    }
    const pinned = value["pinned"] === true;
    const mode = pinned
      ? "pinned"
      : mapUpdateMode(value["update_mode"], `plugins.${name}.update_mode`, ignored, imported);
    if (mode !== undefined) {
      overrides[name] = { update_mode: mode };
      imported.push(`plugins.${name}: packages.overrides.${name}.update_mode = ${mode}`);
    }
    // `enabled` and `source` have no config.toml-shaped home any more: enabled moved onto the
    // installed package's own record, and source is resolved at install time (WI-0018-15/-17).
  }
  if (Object.keys(overrides).length > 0) {
    packagesCandidate["overrides"] = overrides;
  }

  let packagesSetting: Readonly<Record<string, unknown>> | null = null;
  if (Object.keys(packagesCandidate).length > 0) {
    try {
      parsePackagePolicy(packagesCandidate);
      packagesSetting = packagesCandidate;
    } catch (error) {
      if (error instanceof PackageSettingsError) {
        ignored.push({ key: "plugins", reason: `could not be imported: ${reasonOf(error)}` });
      } else {
        throw error;
      }
    }
  }

  // --- sources: [sources.<name>] -> sources (WI-0018-17) ---------------------------------------
  let sourcesSetting: Readonly<Record<string, unknown>> | null = null;
  const sourcesSection = isTable(document["sources"]) ? document["sources"] : {};
  if (Object.keys(sourcesSection).length > 0) {
    try {
      parseCatalogueSources(sourcesSection);
      sourcesSetting = sourcesSection;
      imported.push(`sources: ${Object.keys(sourcesSection).join(", ")}`);
    } catch (error) {
      if (error instanceof CatalogueSettingsError) {
        ignored.push({ key: "sources", reason: `could not be imported: ${reasonOf(error)}` });
      } else {
        throw error;
      }
    }
  }

  // --- update: auto_check_versions + [update].channel -> update (WI-0018-24) -------------------
  let updateSetting: Readonly<Record<string, unknown>> | null = null;
  const rawChannel = updateSection["channel"];
  const channel: string | undefined = typeof rawChannel === "string" ? rawChannel : undefined;
  if (typeof document["auto_check_versions"] === "boolean" || channel !== undefined) {
    const candidate: Record<string, unknown> = {};
    if (typeof document["auto_check_versions"] === "boolean") {
      candidate["auto_check"] = document["auto_check_versions"];
    }
    if (channel !== undefined) {
      candidate["channel"] = channel;
    }
    try {
      parseUpdatePolicy(candidate);
      updateSetting = candidate;
      if (channel !== undefined) {
        imported.push(`update.channel: ${channel}`);
      }
    } catch (error) {
      if (error instanceof UpdateSettingsError) {
        ignored.push({
          key: "update.channel",
          reason: `could not be imported: ${reasonOf(error)}`,
        });
      } else {
        throw error;
      }
    }
  }

  // --- mcp: [mcp] -> the endpoint setting (WI-0018-19) ------------------------------------------
  let mcpSetting: { host?: string; port?: number } | null = null;
  const mcpSection = isTable(document["mcp"]) ? document["mcp"] : {};
  if ("host" in mcpSection || "port" in mcpSection) {
    const host = typeof mcpSection["host"] === "string" ? mcpSection["host"] : undefined;
    const port = typeof mcpSection["port"] === "number" ? mcpSection["port"] : undefined;
    try {
      checkedAddress(host ?? "127.0.0.1", port ?? 31010);
      mcpSetting = {
        ...(host !== undefined ? { host } : {}),
        ...(port !== undefined ? { port } : {}),
      };
      imported.push(`mcp: ${JSON.stringify(mcpSetting)}`);
    } catch (error) {
      if (error instanceof EndpointError) {
        ignored.push({ key: "mcp", reason: `could not be imported: ${reasonOf(error)}` });
      } else {
        throw error;
      }
    }
  }

  return {
    telemetry,
    launchAtLoginWanted,
    packagesSetting,
    sourcesSetting,
    updateSetting,
    mcpSetting,
    imported,
    ignored,
  };
}
