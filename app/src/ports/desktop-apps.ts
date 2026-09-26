// Another desktop application, as the shell starts, finds and quits it: the Anytype desktop app
// (plan 0018 §4.1 point 6). Starting hands back the only thing that may ever quit it; finding a
// running one hands back a pid and nothing to quit it with, so an adopted app cannot be quit by
// mistake (launcher.py:706 started_by_this_application).

/** A running app this application found, and did not start. */
export interface FoundApp {
  readonly pid: number;
}

/** An app this application started: the handle is what quits it. */
export interface StartedApp {
  readonly pid: number;
  /** Ask it to quit, and end it if it has not after a grace period. Settles once it is gone. */
  quit(): Promise<void>;
}

export interface DesktopApps {
  /** The app running from `executable`, or null when none is. */
  find(executable: string): Promise<FoundApp | null>;
  /** Start `executable`. Throws when it cannot be started. */
  launch(executable: string): StartedApp;
}
