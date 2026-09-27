// The one-time import's marker and report, as a single JSON file in userData (WI-0018-25): its
// mere existence is the "never twice" rule, and its content is what the report lists (what was
// imported, and what was ignored and why).

import fs from "node:fs";
import * as path from "node:path";
import type { LegacyImportReport, LegacyImportReportStore } from "../../ports/legacy-import";

export const LEGACY_IMPORT_REPORT_FILENAME = "legacy-import-report.json";

export class JsonLegacyImportReportStore implements LegacyImportReportStore {
  readonly #file: string;

  constructor(userDataDirectory: string) {
    this.#file = path.join(userDataDirectory, LEGACY_IMPORT_REPORT_FILENAME);
  }

  exists(): boolean {
    return fs.existsSync(this.#file);
  }

  write(report: LegacyImportReport): void {
    const scratch = `${this.#file}.${String(process.pid)}.tmp`;
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    fs.writeFileSync(scratch, `${JSON.stringify(report, null, 2)}\n`);
    fs.renameSync(scratch, this.#file);
  }
}
