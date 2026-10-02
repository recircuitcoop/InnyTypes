// The two attributes every component's root carries (plan 0022 §L): `data-component`, the
// component's name as it appears in the Penpot library (`button`, `icon-button`), and
// `data-variant`, its variant axes and values as Penpot names them, lowercased and sorted by
// axis (`kind=primary;size=default;state=default`). With the same names on both sides, a
// component or axis that drifts from the design is visible in the DOM, in the gallery and in
// the e2e baselines, rather than found by eye.

/** One axis value: a Penpot value (`Primary`, `Done`), a count, or a Yes/No axis. */
export type AxisValue = string | number | boolean;

/** A Penpot value as it appears in data-variant: lowercase, spaces as hyphens, Yes/No booleans. */
export function axisValue(value: AxisValue): string {
  if (typeof value === "boolean") {
    return value ? "yes" : "no";
  }
  return String(value).trim().toLowerCase().replace(/\s+/g, "-");
}

/** The data-variant string: `axis=value` pairs, sorted by axis, joined with `;`. */
export function variantOf(axes: Readonly<Record<string, AxisValue>>): string {
  return Object.keys(axes)
    .map((axis) => axis.toLowerCase())
    .sort()
    .map((axis) => {
      const key = Object.keys(axes).find((name) => name.toLowerCase() === axis) as string;
      return `${axis}=${axisValue(axes[key] as AxisValue)}`;
    })
    .join(";");
}

/** The two root attributes, ready to spread onto the root element. */
export function variantAttributes(
  component: string,
  axes: Readonly<Record<string, AxisValue>> = {},
): { "data-component": string; "data-variant": string } {
  return { "data-component": component, "data-variant": variantOf(axes) };
}

/** Class names joined, skipping the ones a condition turned off. */
export function cx(...classes: readonly (string | false | null | undefined)[]): string {
  return classes
    .filter((name): name is string => typeof name === "string" && name !== "")
    .join(" ");
}
