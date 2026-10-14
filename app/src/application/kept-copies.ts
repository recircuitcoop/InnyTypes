// What an update replaced is kept seven days from the update (plan 0022 §F, D5), and pruned at
// the first start after that. A record from before `installedAt` existed (every 0.2.x one) is
// stamped at its first start instead: its kept copy then has seven days from that start, and is
// never deleted for lacking a date. The row does not pass that start off as the update's day.

import { ROLLBACK_WINDOW_MS } from "../domain/packages/states";
import type { Logger } from "../ports/logger";
import type { PackageRoots } from "../ports/package-roots";

export function keepSevenDays(roots: PackageRoots, now: number, logger: Logger): void {
  for (const { record } of roots.list()) {
    const name = record.package;
    if (roots.kept(name) === undefined) {
      continue;
    }
    if (record.installedAt === undefined) {
      roots.amend(name, { installedAt: now, updatedAtUnknown: true });
      logger.info(`packages: ${name}'s record had no install time; it is kept seven days from now`);
    } else if (now >= record.installedAt + ROLLBACK_WINDOW_MS) {
      roots.discardKept(name);
      logger.info(`packages: what ${name}'s last update replaced is past its seven days: pruned`);
    }
  }
}
