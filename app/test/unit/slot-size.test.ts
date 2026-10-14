// The corner drag's snapping (Slot, ux-writing "drag a corner to resize"): a place's new width,
// as a fraction of its board, becomes the nearest of S (4 of 12 columns), M (6) and L (12).
import { describe, expect, it } from "vitest";
import { sizeForWidth } from "../../src/ui/components/organisms/Slot";

describe("sizeForWidth", () => {
  it("snaps to S below 5 of 12 columns, to M below 9, and to L from there", () => {
    expect(sizeForWidth(0)).toBe("S");
    expect(sizeForWidth(4 / 12)).toBe("S");
    expect(sizeForWidth(5 / 12 - 1e-9)).toBe("S");
    expect(sizeForWidth(5 / 12)).toBe("M");
    expect(sizeForWidth(6 / 12)).toBe("M");
    expect(sizeForWidth(9 / 12 - 1e-9)).toBe("M");
    expect(sizeForWidth(9 / 12)).toBe("L");
    expect(sizeForWidth(1)).toBe("L");
    expect(sizeForWidth(1.4)).toBe("L");
    expect(sizeForWidth(-0.2)).toBe("S");
  });
});
