// The SettingsStore as one JSON file in userData (plan 0018 §2.3): the MCP endpoint (WI-0018-19)
// and the launch-at-login switch (WI-0018-21). WI-0018-25 imports the old config.toml's [mcp]
// section into it once.
//
// * A missing file is "nothing stored": a machine never configured.
// * A file that cannot be read or is not a settings document is an error naming the file, never
//   an empty answer: silently treating it as unset would serve an address nobody chose.
// * A write keeps every other setting as it was, and goes to a scratch file renamed over the
//   target, so an interrupted write leaves the old document whole.

import fs from "node:fs";
import * as path from "node:path";
import type { StoredEndpoint } from "../../domain/endpoint/address";
import type {
  LaunchAtLoginSetting,
  PackageSettingsStore,
  SettingsStore,
} from "../../ports/settings-store";

/** The settings file could not be read or written. */
export class SettingsFileError extends Error {
  override name = "SettingsFileError";
}

type Document = Record<string, unknown>;

const isObject = (value: unknown): value is Document =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export class JsonSettingsStore
  implements SettingsStore, LaunchAtLoginSetting, PackageSettingsStore
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

  // The package settings (WI-0018-17), raw: domain/packages judges them.
  readPackages(): unknown {
    return this.#read()["packages"];
  }

  readSources(): unknown {
    return this.#read()["sources"];
  }

  writeSources(sources: Readonly<Record<string, unknown>>): void {
    this.#write("sources", { ...sources });
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
