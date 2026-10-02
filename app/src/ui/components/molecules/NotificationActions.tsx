// Notification actions (Penpot 03 Molecules › notification-actions). Count: 1, 2, 3. Up to
// three Secondary buttons, size Default, 8px gap: what a notification lets you do without
// opening the app (Open in Anytype; a question's answers).
import { Button } from "../atoms/Button";
import { cx, variantAttributes } from "../variant";

export interface NotificationAction {
  readonly label: string;
  readonly onClick?: () => void;
}

export interface NotificationActionsProps {
  /** One to three; more are not drawn. */
  readonly actions: readonly NotificationAction[];
  readonly className?: string;
}

export function NotificationActions({ actions, className }: NotificationActionsProps) {
  const shown = actions.slice(0, 3);
  return (
    <div
      {...variantAttributes("notification-actions", { count: shown.length })}
      className={cx("flex items-center gap-2", className)}
    >
      {shown.map((action) => (
        <Button
          key={action.label}
          kind="secondary"
          {...(action.onClick === undefined ? {} : { onClick: action.onClick })}
        >
          {action.label}
        </Button>
      ))}
    </div>
  );
}
