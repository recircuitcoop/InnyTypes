// The SettingsStore as one JSON file in userData (plan 0018 §2.3): the MCP endpoint (WI-0018-19),
// the launch-at-login switch (WI-0018-21) and the telemetry switch (WI-0018-22). WI-0018-25
// imports the old config.toml's [mcp] section into it once.
//
// * A missing file is "nothing stored": a machine never configured.
// * A file that cannot be read or is not a settings document is an error naming the file, never
//   an empty answer: silently treating it as unset would serve an address nobody chose.
// * A write keeps every other setting as it was, and goes to a scratch file renamed over the
//   target, so an interrupted write leaves the old document whole.

import fs from "node:fs";
import * as path from "node:path";
import type { StoredEndpoint } from "../../domain/endpoint/address";
import type { TelemetryAnswer } from "../../domain/telemetry/reports";
import type {
  LaunchAtLoginSetting,
  PackageSettingsStore,
  RunRetentionSetting,
  SettingsStore,
  UpdateSettingsStore,
} from "../../ports/settings-store";
import type { TelemetrySetting } from "../../ports/telemetry";

/** The settings file could not be read or written. */
export class SettingsFileError extends Error {
  override name = "SettingsFileError";
}

type Document = Record<string, unknown>;

const isObject = (value: unknown): value is Document =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export class JsonSettingsStore
  implements
    SettingsStore,
    LaunchAtLoginSetting,
    PackageSettingsStore,
    RunRetentionSetting,
    TelemetrySetting,
    UpdateSettingsStore
{
  readonly #file: string;

  constructor(file: string) {
    this.#file = file;
  }

  readEndpoint(): StoredEndpoint {
    const mcp = this.#read()["mcp"];
    if (mcp === undefined) {
      return {};
    }
    const { host, port } = isObject(mcp) ? mcp : { host: null, port: null };
    if (
      (host !== undefined && typeof host !== "string") ||
      (port !== undefined && (typeof port !== "number" || !Number.isInteger(port)))
    ) {
      throw new SettingsFileError(
        `the mcp setting in ${this.#file} must hold a host (text) and a port (a whole number)`,
      );
    }
    return {
      ...(host === undefined ? {} : { host }),
      ...(port === undefined ? {} : { port }),
    };
  }

  writeEndpoint(endpoint: StoredEndpoint): void {
    this.#write("mcp", { ...endpoint });
  }

  readLaunchAtLogin(): boolean {
    const on = this.#read()["launchAtLogin"];
    if (on !== undefined && typeof on !== "boolean") {
      throw new SettingsFileError(
        `the launchAtLogin setting in ${this.#file} must be true or false`,
      );
    }
    return on ?? false;
  }

  writeLaunchAtLogin(on: boolean): void {
    this.#write("launchAtLogin", on);
  }

  // The telemetry switch (WI-0018-22): absent is the question not answered yet, never a no.
  readTelemetry(): TelemetryAnswer {
    const on = this.#read()["telemetry"];
    if (on !== undefined && typeof on !== "boolean") {
      throw new SettingsFileError(`the telemetry setting in ${this.#file} must be true or false`);
    }
    return on === undefined ? "unset" : on ? "on" : "off";
  }

  writeTelemetry(on: boolean): void {
    this.#write("telemetry", on);
  }

  // The package settings (WI-0018-17), raw: domain/packages judges them.
  readPackages(): unknown {
    return this.#read()["packages"];
  }

  writePackages(packages: Readonly<Record<string, unknown>>): void {
    this.#write("packages", { ...packages });
  }

  readSources(): unknown {
    return this.#read()["sources"];
  }

  writeSources(sources: Readonly<Record<string, unknown>>): void {
    this.#write("sources", { ...sources });
  }

  // The self-update settings (WI-0018-24), raw: domain/update/policy.ts judges them.
  readUpdate(): unknown {
    return this.#read()["update"];
  }

  writeUpdate(update: Readonly<Record<string, unknown>>): void {
    this.#write("update", { ...update });
  }

  // Run history's retention (plan 0022 §C): `runs: {retentionDays}`, days or null for Forever.
  readRunRetentionDays(): number | null | undefined {
    const runs = this.#read()["runs"];
    if (runs === undefined) {
      return undefined;
    }
    const days = isObject(runs) ? runs["retentionDays"] : 0;
    if (
      days !== undefined &&
      days !== null &&
      (typeof days !== "number" || !Number.isInteger(days) || days < 1)
    ) {
      throw new SettingsFileError(
        `the runs.retentionDays setting in ${this.#file} must be a whole number of days, or null`,
      );
    }
    return days;
  }

  /** Store one setting, keeping every other as it was. */
  #write(name: string, value: unknown): void {
    const document = this.#read();
    document[name] = value;
    const scratch = `${this.#file}.${String(process.pid)}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      fs.writeFileSync(scratch, `${JSON.stringify(document, null, 2)}\n`);
      fs.renameSync(scratch, this.#file);
    } catch (error) {
      fs.rmSync(scratch, { force: true });
      throw new SettingsFileError(
        `could not write ${this.#file}: ${String((error as NodeJS.ErrnoException).code)}`,
      );
    }
  }

  #read(): Document {
    let text: string;
    try {
      text = fs.readFileSync(this.#file, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return {};
      }
      throw new SettingsFileError(`could not read ${this.#file}: ${String(code)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new SettingsFileError(`${this.#file} is not JSON`);
    }
    if (!isObject(parsed)) {
      throw new SettingsFileError(`${this.#file} does not hold a settings object`);
    }
    return parsed;
  }
}
