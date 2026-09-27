// The old installation's own login item (macOS LaunchAgent, Linux autostart entry): WI-0018-25
// removes it, and only once the new one is confirmed working. Two calls and no state, mirroring
// ports/login-item.ts's shape: whether it is there is asked of the filesystem, not remembered.

export interface LegacyLoginItem {
  /** Whether the old login item is there right now. */
  present(): boolean;
  /** Remove it. Safe when it is already gone. */
  remove(): void;
}
