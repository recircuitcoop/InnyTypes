// What the application tells a person about, and in what words (plan 0018 §3 notification.py:
// "Port domain, replace delivery").
//
// Two things are kept apart, as the old helper kept them (notification.py):
// * A Notice is a CONDITION that is true right now. It carries no words: the kind, what it is
//   about, the version at stake where there is one, and the sentence saying why, taken from
//   whichever part made the decision (never written here: the part that refused something is the
//   one that knows why).
// * `compose` is the ONE place that decides what a notice says to a person. Every notification
//   goes through it, so the same condition always reads the same way.
//
// The once-only rule (a notification per change of state, never per repeat) is the NoticeBoard's
// (application/notices.ts), which is handed these notices wherever they are raised.

/** The things the application tells a person about. */
export type NoticeKind =
  /** The runtime or the services process crashed too often and is no longer restarted. */
  | "child-stopped"
  /** A node's process crashed too often and is no longer restarted (spec 6.5). */
  | "node-stopped"
  /** The Anytype MCP child stopped for good after the breaker's limit (§4.1 point 2). */
  | "mcp-child-stopped"
  /** The Anytype MCP child went silent and was restarted (§4.1 point 2). */
  | "mcp-child-restarted"
  /** The MCP endpoint could not be served at its address (§4.1 point 3). */
  | "endpoint-degraded"
  /** Anytype refused the key an Anytype node used: pair again (§4.2). */
  | "anytype-key-refused"
  /** An action view was presented for the first time and waits in the Inbox (spec 8.1). */
  | "view-waiting"
  /** A newer version of an installed package is available (WI-0018-17). */
  | "package-update-available"
  /** A package update is refused, and what is installed stays (WI-0018-17). */
  | "package-update-refused"
  /** A newer version of InnyTypes itself is verified and queued to install at quit (WI-0018-24). */
  | "core-update-available"
  /** The core update check found a tampered feed or artifact; nothing is installed (WI-0018-24). */
  | "core-update-refused";

export const NOTICE_KINDS: readonly NoticeKind[] = [
  "child-stopped",
  "node-stopped",
  "mcp-child-stopped",
  "mcp-child-restarted",
  "endpoint-degraded",
  "anytype-key-refused",
  "view-waiting",
  "package-update-available",
  "package-update-refused",
  "core-update-available",
  "core-update-refused",
];

/**
 * One condition that is true right now. `subject` is what it is about (a child, a node, a
 * package, a view); `version` is the version at stake where the kind has one; `detail` is the
 * sentence naming why.
 */
export interface Notice {
  readonly kind: NoticeKind;
  readonly subject: string;
  readonly version?: string;
  readonly detail?: string;
}

/** One notice as a desktop shows it. */
export interface Message {
  readonly title: string;
  readonly body: string;
}

/**
 * The words for one notice; the only place any of them are written. Plain language, and what to
 * do about it where there is something to do: a notification a person cannot act on is one they
 * learn to dismiss without reading (notification.py `compose`).
 */
export function compose(notice: Notice): Message {
  const { subject } = notice;
  const version = notice.version ?? "";
  const detail = notice.detail ?? "";
  switch (notice.kind) {
    case "child-stopped":
      // The supervisor's sentence already says what to do (crashLoopMessage: Press Restart).
      return { title: `InnyTypes stopped restarting the ${subject}`, body: sentences(detail) };
    case "node-stopped":
      return {
        title: `InnyTypes stopped restarting the node ${subject}`,
        body: sentences(detail, "Redeploy the flow to let it try again."),
      };
    case "mcp-child-stopped":
      // The body is the service's sentence and nothing else: it already says why, and a remedy
      // invented here would be a second, worse account of it (notification.py HOST_DEGRADED).
      return { title: `InnyTypes is running without the ${subject}`, body: sentences(detail) };
    case "mcp-child-restarted":
      return { title: `InnyTypes restarted the ${subject}`, body: sentences(detail) };
    case "endpoint-degraded":
      return {
        title: `InnyTypes is running without its ${subject}`,
        body: sentences(detail, "Choose another address in Settings."),
      };
    case "anytype-key-refused":
      return {
        title: `${subject} refused the InnyTypes key`,
        body: sentences(
          "An Anytype node's request was refused, so its input failed and was not retried",
          "Pair again with Anytype in Settings.",
        ),
      };
    case "view-waiting":
      return {
        title: "InnyTypes is waiting for you",
        body: detail === "" ? "A view waits in the Inbox." : detail,
      };
    case "package-update-available":
      return {
        title: `${subject} ${version} is available`,
        body: sentences(detail, "Install it on the Packages page."),
      };
    case "package-update-refused":
      return {
        title: `${subject} ${version} is being held back`,
        body: sentences(detail, "Nothing on your machine has changed."),
      };
    case "core-update-available":
      return {
        title: `InnyTypes ${version} is ready`,
        body: sentences(detail, "It installs the next time you quit InnyTypes."),
      };
    case "core-update-refused":
      return {
        title: "An InnyTypes update was refused",
        body: sentences(detail, "Nothing on your machine has changed."),
      };
  }
}

/** Whether two notices are the same thing to say: the same condition, in the same words. */
export function sameNotice(a: Notice, b: Notice): boolean {
  return (
    a.kind === b.kind &&
    a.subject === b.subject &&
    (a.version ?? "") === (b.version ?? "") &&
    (a.detail ?? "") === (b.detail ?? "")
  );
}

/** Which condition a notice is: one of each kind per subject is current at a time. */
export function noticeKey(kind: NoticeKind, subject: string): string {
  return `${kind}\u0000${subject}`;
}

export function isNoticeKind(value: unknown): value is NoticeKind {
  return typeof value === "string" && (NOTICE_KINDS as readonly string[]).includes(value);
}

/** Whether a value that crossed a process boundary is a notice. */
export function isNotice(value: unknown): value is Notice {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const fields = value as Readonly<Record<string, unknown>>;
  const optionalText = (name: string): boolean =>
    fields[name] === undefined || typeof fields[name] === "string";
  return (
    isNoticeKind(fields["kind"]) &&
    typeof fields["subject"] === "string" &&
    optionalText("version") &&
    optionalText("detail")
  );
}

/** One body from the pieces that are there, each ended so they read as sentences. */
function sentences(...parts: string[]): string {
  return parts
    .filter((part) => part !== "")
    .map((part) => (/[.!?]$/.test(part) ? part : `${part}.`))
    .join(" ");
}
