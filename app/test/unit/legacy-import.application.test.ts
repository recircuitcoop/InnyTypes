// The one-time import orchestration (WI-0018-25): never runs twice, writes the settings a valid
// old config.toml maps to, and reports what it did and ignored.

import { describe, expect, it } from "vitest";
import { runLegacyImport, type ShellSettings } from "../../src/application/legacy-import";
import type { StoredEndpoint } from "../../src/domain/endpoint/address";
import type { LegacyImportReport, LegacyImportReportStore } from "../../src/ports/legacy-import";

class MemoryReportStore implements LegacyImportReportStore {
  written: LegacyImportReport[] = [];
  exists(): boolean {
    return this.written.length > 0;
  }
  write(report: LegacyImportReport): void {
    this.written.push(report);
  }
}

class MemoryShellSettings implements ShellSettings {
  telemetry: unknown;
  launchAtLogin = false;
  packages: unknown;
  sources: unknown;
  update: unknown;
  endpoint: StoredEndpoint = {};
  readTelemetry(): "unset" | "on" | "off" {
    return this.telemetry === undefined ? "unset" : this.telemetry ? "on" : "off";
  }
  writeTelemetry(on: boolean): void {
    this.telemetry = on;
  }
  readLaunchAtLogin(): boolean {
    return this.launchAtLogin;
  }
  writeLaunchAtLogin(on: boolean): void {
    this.launchAtLogin = on;
  }
  readPackages(): unknown {
    return this.packages;
  }
  writePackages(packages: Readonly<Record<string, unknown>>): void {
    this.packages = { ...packages };
  }
  readSources(): unknown {
    return this.sources;
  }
  writeSources(sources: Readonly<Record<string, unknown>>): void {
    this.sources = { ...sources };
  }
  readUpdate(): unknown {
    return this.update;
  }
  writeUpdate(update: Readonly<Record<string, unknown>>): void {
    this.update = { ...update };
  }
  readEndpoint(): StoredEndpoint {
    return this.endpoint;
  }
  writeEndpoint(endpoint: StoredEndpoint): void {
    this.endpoint = { ...endpoint };
  }
}

function silentLogger() {
  const lines: string[] = [];
  return {
    logger: {
      debug: () => undefined,
      info: (line: string) => lines.push(line),
      warn: (line: string) => lines.push(line),
      error: (line: string) => lines.push(line),
    },
    lines,
  };
}

const OLD_CONFIG = [
  "telemetry = true",
  "launch_at_login = true",
  "[mcp]",
  'host = "127.0.0.1"',
  "port = 32010",
].join("\n");

describe("runLegacyImport", () => {
  it("imports a valid old config.toml once, into the shell and mcp settings", () => {
    const reportStore = new MemoryReportStore();
    const shellSettings = new MemoryShellSettings();
    const mcpSettings = new MemoryShellSettings();
    const { logger } = silentLogger();
    const report = runLegacyImport({
      readLegacyConfig: () => OLD_CONFIG,
      reportStore,
      shellSettings,
      mcpSettings,
      logger,
    });
    expect(report?.launchAtLoginWanted).toBe(true);
    expect(shellSettings.telemetry).toBe(true);
    expect(mcpSettings.endpoint).toEqual({ host: "127.0.0.1", port: 32010 });
    expect(reportStore.exists()).toBe(true);
  });

  it("never runs twice: the second call changes nothing and returns null", () => {
    const reportStore = new MemoryReportStore();
    const shellSettings = new MemoryShellSettings();
    const mcpSettings = new MemoryShellSettings();
    const { logger } = silentLogger();
    let reads = 0;
    const deps = {
      readLegacyConfig: () => {
        reads += 1;
        return OLD_CONFIG;
      },
      reportStore,
      shellSettings,
      mcpSettings,
      logger,
    };
    runLegacyImport(deps);
    expect(reads).toBe(1);
    shellSettings.writeTelemetry(false); // simulate the person changing it after the import
    const second = runLegacyImport(deps);
    expect(second).toBeNull();
    expect(reads).toBe(1); // the file is never even read again
    expect(shellSettings.telemetry).toBe(false); // untouched by the second call
  });

  it("no old config.toml: writes an empty report and imports nothing", () => {
    const reportStore = new MemoryReportStore();
    const shellSettings = new MemoryShellSettings();
    const { logger } = silentLogger();
    const report = runLegacyImport({
      readLegacyConfig: () => null,
      reportStore,
      shellSettings,
      mcpSettings: shellSettings,
      logger,
    });
    expect(report).toEqual({
      importedAt: expect.any(String) as unknown,
      launchAtLoginWanted: false,
      imported: [],
      ignored: [],
    });
    expect(reportStore.exists()).toBe(true);
  });

  it("a config.toml this reader cannot parse is reported and logged, never thrown", () => {
    const reportStore = new MemoryReportStore();
    const shellSettings = new MemoryShellSettings();
    const { logger, lines } = silentLogger();
    const report = runLegacyImport({
      readLegacyConfig: () => "not = toml = at = all = [",
      reportStore,
      shellSettings,
      mcpSettings: shellSettings,
      logger,
    });
    expect(report?.ignored[0]?.key).toBe("config.toml");
    expect(lines.some((line) => line.includes("could not be read"))).toBe(true);
    expect(shellSettings.telemetry).toBeUndefined();
  });
});
