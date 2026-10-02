// The two plain-TypeScript helpers every component is built on (plan 0022 §L): the data-variant
// string that names a component's Penpot variant in the DOM, and the box the text-like controls
// share. The components themselves are seen in the gallery and its screenshots
// (test/e2e/gallery.e2e.ts).
import { describe, expect, it } from "vitest";

import {
  FIELD_TEXT_CLASS,
  fieldBoxClass,
  OPTION_CLASS,
  POPUP_SURFACE_CLASS,
} from "../../src/ui/components/field-box";
import { axisValue, cx, variantAttributes, variantOf } from "../../src/ui/components/variant";
import { FLOWS, SPACES, TYPES } from "../../src/ui/gallery/samples";

describe("data-variant", () => {
  it("names Penpot's axes and values lowercased, sorted by axis", () => {
    expect(variantOf({ Kind: "Primary", State: "Default", Size: "Large" })).toBe(
      "kind=primary;size=large;state=default",
    );
    expect(variantOf({ state: "loading", kind: "quiet", size: "default" })).toBe(
      "kind=quiet;size=default;state=loading",
    );
  });

  it("writes Yes/No axes as yes and no, counts as numbers, spaces as hyphens", () => {
    expect(axisValue(true)).toBe("yes");
    expect(axisValue(false)).toBe("no");
    expect(axisValue(3)).toBe("3");
    expect(axisValue("Failed check")).toBe("failed-check");
    expect(axisValue("  9+ ")).toBe("9+");
    expect(variantOf({ state: "on", disabled: false })).toBe("disabled=no;state=on");
  });

  it("is empty for a component without variants, and both attributes are always set", () => {
    expect(variantOf({})).toBe("");
    expect(variantAttributes("divider")).toEqual({
      "data-component": "divider",
      "data-variant": "",
    });
    expect(variantAttributes("badge", { count: "9+" })).toEqual({
      "data-component": "badge",
      "data-variant": "count=9+",
    });
  });

  it("joins class names, dropping the ones a condition switched off", () => {
    expect(cx("a", false, "b", null, undefined, "", "c")).toBe("a b c");
    expect(cx()).toBe("");
  });
});

describe("the field box", () => {
  it("draws Focus as the ring at rest, and only on real focus otherwise", () => {
    const focus = fieldBoxClass("focus").split(" ");
    expect(focus).toContain("outline-focus");
    expect(focus.some((name) => name.startsWith("focus-within:"))).toBe(false);
    const rest = fieldBoxClass("default").split(" ");
    expect(rest).toContain("focus-within:outline-focus");
    expect(rest).not.toContain("outline-focus");
  });

  it("turns the line to the failed colour in Error and fades Disabled, never both lines at once", () => {
    const error = fieldBoxClass("error").split(" ");
    expect(error).toContain("border-failed");
    expect(error).not.toContain("border-surface-line");
    expect(fieldBoxClass("filled").split(" ")).toContain("border-surface-line");
    expect(fieldBoxClass("disabled")).toContain("opacity-[var(--inny-opacity-disabled)]");
    expect(fieldBoxClass("default")).not.toContain("opacity-");
  });

  it("adds the caller's classes and skips the switched-off ones", () => {
    expect(fieldBoxClass("default", "h-8", false, undefined).split(" ")).toContain("h-8");
  });

  it("uses tokens only: no raw colour in the shared classes", () => {
    for (const classes of [
      FIELD_TEXT_CLASS,
      OPTION_CLASS,
      POPUP_SURFACE_CLASS,
      fieldBoxClass("error"),
    ]) {
      expect(classes).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(|oklch\(/i);
    }
  });
});

describe("the gallery's sample content", () => {
  it("comes from three unrelated flows, and its options are distinct", () => {
    expect(new Set(Object.values(FLOWS)).size).toBe(3);
    for (const options of [TYPES, SPACES]) {
      expect(options.length).toBeGreaterThan(2);
      expect(new Set(options.map((option) => option.value)).size).toBe(options.length);
    }
  });
});
