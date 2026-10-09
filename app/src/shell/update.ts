// The self-update check in the shell (WI-0018-24): scheduled, settings-driven, and installed
// at quit. shell/main.ts builds the adapters and hands them in; this file imports none
// (plan 0018 §2.3), which keeps the composition root under its 600 lines. `process.platform`
// and `process.arch` are read here, not passed in: shell/telemetry.ts reads them the same way,
// and only `process.env` is reserved for the composition roots (eslint.architecture.config.mjs).

import { UpdateCheck, type UpdateCheckPorts } from "../application/update-check";
import type { ReleasePlatform } from "../domain/update/release-metadata";

/** The first check, soon after the start; then once a day (application/update-check.ts). */
const FIRST_CHECK_MS = 60_000;

export type WireUpdateOptions = Omit<UpdateCheckPorts, "platform" | "arch">;

function releasePlatform(): ReleasePlatform | null {
  if (process.platform === "darwin") {
    return "mac";
  }
  return process.platform === "linux" ? "linux" : null;
}

/** Null on a platform this application does not self-update on (Windows: WI-0025-01). */
export function wireUpdate(options: WireUpdateOptions): UpdateCheck | null {
  const platform = releasePlatform();
  if (platform === null) {
    return null;
  }
  const updates = new UpdateCheck({ ...options, platform, arch: process.arch });
  updates.schedule(FIRST_CHECK_MS);
  return updates;
}
