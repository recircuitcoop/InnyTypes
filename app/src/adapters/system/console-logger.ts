// Notices as log lines, until desktop notices arrive with WI-0018-21. The lines themselves
// go to the one log (WI-0018-04).

import type { Logger } from "../../ports/logger";
import type { Notice, Notifier } from "../../ports/notifier";

/** Notices as log lines, until desktop notices arrive with WI-0018-21. */
export function logNotifier(logger: Logger): Notifier {
  return {
    raise: (notice: Notice) => {
      logger.error(`notice: ${notice.title}: ${notice.body}`);
    },
  };
}
