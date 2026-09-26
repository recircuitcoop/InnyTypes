// The notice file (notification.py:602 NoticeFile): every condition true right now, on disk, in
// userData. Written whenever the set changes, before anything is shown, so a notification that
// was missed or dismissed changes nothing about what the file says. Replaced atomically: a
// scratch file of this process's own, renamed over the target.

import fs from "node:fs";
import * as path from "node:path";
import type { Notice } from "../../domain/notices/notices";
import type { NoticeStore } from "../../ports/notifier";

export const NOTICES_FILENAME = "notices.json";

export class JsonNoticeFile implements NoticeStore {
  readonly #file: string;

  constructor(file: string) {
    this.#file = file;
  }

  write(notices: readonly Notice[]): void {
    const document = notices.map((notice) => ({
      kind: notice.kind,
      subject: notice.subject,
      version: notice.version ?? "",
      detail: notice.detail ?? "",
    }));
    const scratch = `${this.#file}.${String(process.pid)}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      fs.writeFileSync(scratch, `${JSON.stringify(document, null, 2)}\n`);
      fs.renameSync(scratch, this.#file);
    } catch (error) {
      fs.rmSync(scratch, { force: true });
      throw error;
    }
  }
}
