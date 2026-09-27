// Which old login item, if any, this platform and run may have to remove (WI-0018-25): macOS's
// LaunchAgent, Linux's autostart entry (the same directory the new one uses), or none — Windows
// is unproven for this cutover (plan 0018 §10 risk 1), and a login item is never touched for a
// run that is not the installed application.

import * as os from "node:os";
import type { LegacyLoginItem } from "../../ports/legacy-login-item";
import { LegacyLinuxAutostart } from "./legacy-login-item-linux";
import { LegacyMacLoginItem } from "./legacy-login-item-macos";

export function chooseLegacyLoginItem(
  platform: NodeJS.Platform,
  home: string,
  linuxAutostartDirectory: string,
): LegacyLoginItem | null {
  if (platform === "darwin") {
    return new LegacyMacLoginItem({
      path: `${home}/Library/LaunchAgents/it.l1nx.innytypes.helper.plist`,
      uid: os.userInfo().uid,
    });
  }
  if (platform === "linux") {
    return new LegacyLinuxAutostart(linuxAutostartDirectory);
  }
  return null;
}
