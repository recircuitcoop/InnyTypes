// Which day a time falls on, relative to now (ux-writing "Accessibility of the words": times are
// relative, absolute on hover): today, yesterday, a weekday within the last seven days, else the
// date. Values only; ui/strings.ts (WI-0022-10) words them.
//
// Pure and clock-free: the caller passes `now`. Days are calendar days in the local time zone, the
// one the person reads them in, so "yesterday" at 00:30 is the day before, not 24 hours before.

/** Midnight at the start of `date`'s local day. */
export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Whole calendar days from `then` to `now`; negative when `then` is in the future. */
export function daysBetween(then: Date, now: Date): number {
  // Rounded, because a day across a daylight-saving change is 23 or 25 hours long.
  return Math.round((startOfDay(now).getTime() - startOfDay(then).getTime()) / 86_400_000);
}

/**
 * The day of `then` as the person is told it. `weekday` is 0 (Sunday) to 6, as Date.getDay;
 * `date` is for anything a week or more ago, or in the future.
 */
export type RelativeDay =
  | { readonly kind: "today" }
  | { readonly kind: "yesterday" }
  | { readonly kind: "weekday"; readonly weekday: number }
  | { readonly kind: "date"; readonly date: Date };

export function relativeDay(then: Date, now: Date): RelativeDay {
  const days = daysBetween(then, now);
  if (days === 0) {
    return { kind: "today" };
  }
  if (days === 1) {
    return { kind: "yesterday" };
  }
  if (days > 1 && days < 7) {
    return { kind: "weekday", weekday: then.getDay() };
  }
  return { kind: "date", date: startOfDay(then) };
}
