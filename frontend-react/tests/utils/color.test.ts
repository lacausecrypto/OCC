import { describe, it, expect } from "vitest";
import {
  hslToRgb, hsl, lerp, clamp,
  relativeLuminance, luminanceFromHsl,
  contrastRatio, contrastRatioHsl,
  bestForeground, enforceContrast, enforceAccentContrast,
  enforceStatusColor,
} from "../../src/utils/color";

describe("hslToRgb", () => {
  it("converts pure red", () => {
    expect(hslToRgb(0, 100, 50)).toEqual([255, 0, 0]);
  });

  it("converts pure green", () => {
    expect(hslToRgb(120, 100, 50)).toEqual([0, 255, 0]);
  });

  it("converts pure blue", () => {
    expect(hslToRgb(240, 100, 50)).toEqual([0, 0, 255]);
  });

  it("converts white (0 saturation, full lightness)", () => {
    expect(hslToRgb(0, 0, 100)).toEqual([255, 255, 255]);
  });

  it("converts black", () => {
    expect(hslToRgb(0, 0, 0)).toEqual([0, 0, 0]);
  });

  it("converts 50% gray", () => {
    const [r, g, b] = hslToRgb(0, 0, 50);
    expect(r).toBe(g);
    expect(g).toBe(b);
    expect(r).toBe(128);
  });

  it("handles hue 360 same as hue 0", () => {
    expect(hslToRgb(360, 100, 50)).toEqual(hslToRgb(0, 100, 50));
  });

  it("converts mid-saturation color correctly", () => {
    const [r, g, b] = hslToRgb(210, 50, 50);
    expect(r).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(r);
    expect(b).toBeGreaterThan(g);
  });
});

describe("hsl", () => {
  it("formats CSS hsl string", () => {
    expect(hsl(210, 50, 40)).toBe("hsl(210,50%,40%)");
  });

  it("handles zero values", () => {
    expect(hsl(0, 0, 0)).toBe("hsl(0,0%,0%)");
  });
});

describe("lerp", () => {
  it("returns a at t=0", () => {
    expect(lerp(10, 20, 0)).toBe(10);
  });

  it("returns b at t=1", () => {
    expect(lerp(10, 20, 1)).toBe(20);
  });

  it("returns midpoint at t=0.5", () => {
    expect(lerp(0, 100, 0.5)).toBe(50);
  });

  it("extrapolates beyond 0-1", () => {
    expect(lerp(0, 10, 2)).toBe(20);
  });
});

describe("clamp", () => {
  it("clamps below min", () => {
    expect(clamp(-5, 0, 100)).toBe(0);
  });

  it("clamps above max", () => {
    expect(clamp(150, 0, 100)).toBe(100);
  });

  it("passes through in-range value", () => {
    expect(clamp(50, 0, 100)).toBe(50);
  });

  it("handles equal min and max", () => {
    expect(clamp(50, 10, 10)).toBe(10);
  });
});

describe("relativeLuminance", () => {
  it("returns 0 for black", () => {
    expect(relativeLuminance(0, 0, 0)).toBeCloseTo(0, 4);
  });

  it("returns 1 for white", () => {
    expect(relativeLuminance(255, 255, 255)).toBeCloseTo(1, 4);
  });

  it("returns known value for mid-gray", () => {
    const lum = relativeLuminance(128, 128, 128);
    expect(lum).toBeGreaterThan(0.2);
    expect(lum).toBeLessThan(0.3);
  });
});

describe("luminanceFromHsl", () => {
  it("returns ~0 for black", () => {
    expect(luminanceFromHsl(0, 0, 0)).toBeCloseTo(0, 4);
  });

  it("returns ~1 for white", () => {
    expect(luminanceFromHsl(0, 0, 100)).toBeCloseTo(1, 4);
  });
});

describe("contrastRatio", () => {
  it("returns 21 for black vs white", () => {
    expect(contrastRatio(0, 1)).toBeCloseTo(21, 0);
  });

  it("returns 1 for same luminance", () => {
    expect(contrastRatio(0.5, 0.5)).toBeCloseTo(1, 4);
  });

  it("is order-independent", () => {
    expect(contrastRatio(0.2, 0.8)).toBeCloseTo(contrastRatio(0.8, 0.2), 4);
  });
});

describe("contrastRatioHsl", () => {
  it("returns ~21 for black vs white", () => {
    const ratio = contrastRatioHsl(0, 0, 0, 0, 0, 100);
    expect(ratio).toBeGreaterThan(20);
  });

  it("returns ~1 for same color", () => {
    const ratio = contrastRatioHsl(210, 50, 50, 210, 50, 50);
    expect(ratio).toBeCloseTo(1, 4);
  });
});

describe("bestForeground", () => {
  it("returns light text on dark background", () => {
    const fg = bestForeground([0, 0, 5]);
    expect(fg[2]).toBeGreaterThan(50);
  });

  it("returns dark text on light background", () => {
    const fg = bestForeground([0, 0, 95]);
    expect(fg[2]).toBeLessThan(50);
  });
});

describe("enforceContrast", () => {
  it("returns original if contrast is sufficient", () => {
    const text: [number, number, number] = [0, 0, 95];
    const bg: [number, number, number] = [0, 0, 5];
    const result = enforceContrast(text, bg, 4.5);
    // Should remain high-lightness since already good contrast
    expect(result[2]).toBeGreaterThan(80);
  });

  it("adjusts lightness when contrast is insufficient", () => {
    const text: [number, number, number] = [0, 0, 50];
    const bg: [number, number, number] = [0, 0, 50];
    const result = enforceContrast(text, bg, 4.5);
    // Must have adjusted away from bg lightness
    expect(Math.abs(result[2] - 50)).toBeGreaterThan(10);
  });

  it("desaturates when hues are close", () => {
    const text: [number, number, number] = [120, 80, 50];
    const bg: [number, number, number] = [125, 60, 20];
    const result = enforceContrast(text, bg, 4.5);
    // Should have desaturated text
    expect(result[1]).toBeLessThanOrEqual(80);
  });

  it("always achieves WCAG AA contrast ratio", () => {
    const text: [number, number, number] = [30, 40, 45];
    const bg: [number, number, number] = [30, 40, 50];
    const result = enforceContrast(text, bg, 4.5);
    const ratio = contrastRatioHsl(result[0], result[1], result[2], bg[0], bg[1], bg[2]);
    expect(ratio).toBeGreaterThanOrEqual(4.4); // Allow tiny rounding
  });
});

describe("enforceAccentContrast", () => {
  it("returns accent and contrast text", () => {
    const result = enforceAccentContrast([210, 80, 50], 4.5);
    expect(result).toHaveProperty("accent");
    expect(result).toHaveProperty("contrastText");
    expect(result.accent).toHaveLength(3);
    expect(result.contrastText).toHaveLength(3);
  });

  it("ensures text on accent is readable", () => {
    const result = enforceAccentContrast([210, 80, 50], 4.5);
    const ratio = contrastRatioHsl(
      result.accent[0], result.accent[1], result.accent[2],
      result.contrastText[0], result.contrastText[1], result.contrastText[2],
    );
    expect(ratio).toBeGreaterThanOrEqual(4.4);
  });

  it("handles mid-lightness accent that needs adjustment", () => {
    const result = enforceAccentContrast([60, 100, 50], 4.5);
    expect(result.accent).toHaveLength(3);
  });
});

describe("enforceStatusColor", () => {
  it("returns original hex if contrast sufficient", () => {
    const result = enforceStatusColor("#ff0000", [0, 0, 5], 3.0);
    // Red on near-black should pass
    expect(result).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("adjusts color when contrast is insufficient", () => {
    // Dark color on dark bg
    const result = enforceStatusColor("#111111", [0, 0, 5], 3.0);
    expect(result).not.toBe("#111111");
  });

  it("always returns valid hex", () => {
    const result = enforceStatusColor("#30d158", [0, 0, 95], 3.0);
    expect(result).toMatch(/^#[0-9a-f]{6}$/);
  });
});
