// The privacy notice beside the reports question (D25; owner, 2026-10-15): Setup's Reports step
// and General › Reports while the question is unanswered draw it. Every line is a strings.ts line,
// in the order ui/general.ts's PRIVACY_NOTICE gives.
import { PRIVACY_NOTICE, PRIVACY_NOTICE_OPENING } from "../general";
import { t } from "../strings";

/** `level` is the parts' heading level: one below the heading the notice sits under. */
export function PrivacyNotice({ level }: { readonly level: 2 | 3 }) {
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <div data-testid="privacy-notice" className="flex flex-col gap-3 text-body text-primary">
      <p>{t(PRIVACY_NOTICE_OPENING)}</p>
      {PRIVACY_NOTICE.map((part) => (
        <div key={part.heading} className="flex flex-col gap-1">
          <Heading className="font-semibold">{t(part.heading)}</Heading>
          {part.lines.map((line) => (
            <p key={line}>{t(line)}</p>
          ))}
          {part.listed === undefined ? null : (
            <ul className="list-disc pl-5">
              {part.listed.map((line) => (
                <li key={line}>{t(line)}</li>
              ))}
            </ul>
          )}
          {(part.after ?? []).map((line) => (
            <p key={line}>{t(line)}</p>
          ))}
        </div>
      ))}
    </div>
  );
}
