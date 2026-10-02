// Result line (molecule result-line). Sink: Anytype, File, Scheduled, Plain: the four result
// kinds of the protocol's done.results and the domain's ResultSink (plan 0022 §B), which the
// design system's contract names too; Penpot's drawing still says Schedule and lacks Plain, and is
// to be corrected to match. One line, body 14, of what a flow did and where: Anytype "Meeting
// notes → Renaissance" (the link opens the object), File "Moved recording to Archive" (the link
// opens the folder), Scheduled "Follow up on pricing · due Thursday", Plain "Deleted the
// recording" (no link for either). The person never sees a word for the sink itself.
// The link is underlined at rest, where Penpot's Link underlines only on hover: inside a
// sentence, colour alone may not set a link apart (WCAG 1.4.1; axe link-in-text-block).
import type { MouseEventHandler } from "react";
import { Icon, type IconName } from "../atoms/Icon";
import { Link } from "../atoms/Link";
import { cx, variantAttributes } from "../variant";

export type ResultLineSink = "anytype" | "file" | "scheduled" | "plain";

export interface ResultLineProps {
  readonly sink: ResultLineSink;
  /** What was done ("Meeting notes", "Moved recording to", "Deleted the recording"). */
  readonly what: string;
  /** Where it went ("Renaissance", "Archive"); drawn as the link. Scheduled and Plain have none. */
  readonly where?: string;
  readonly href?: string;
  readonly onOpen?: MouseEventHandler<HTMLAnchorElement>;
  readonly className?: string;
}

const ICON: Record<ResultLineSink, IconName> = {
  anytype: "external-link",
  file: "folder",
  scheduled: "clock-4",
  plain: "check",
};

export function ResultLine({ sink, what, where, href, onOpen, className }: ResultLineProps) {
  return (
    <p
      {...variantAttributes("result-line", { sink })}
      className={cx("flex items-center gap-2 text-body text-primary", className)}
    >
      <Icon name={ICON[sink]} className="shrink-0 text-secondary" />
      <span>
        {what}
        {sink === "anytype" ? <span aria-hidden="true"> →</span> : null}
        {where === undefined ||
        href === undefined ||
        sink === "scheduled" ||
        sink === "plain" ? null : (
          <>
            {" "}
            <Link
              href={href}
              className="underline"
              {...(onOpen === undefined ? {} : { onClick: onOpen })}
            >
              {where}
            </Link>
          </>
        )}
      </span>
    </p>
  );
}
