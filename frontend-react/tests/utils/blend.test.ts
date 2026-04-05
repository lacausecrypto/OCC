import { describe, it, expect } from "vitest";
import { blendPresets } from "../../src/utils/blend";
import type { DesignPreset } from "../../src/types/design";

function makePreset(overrides: Partial<DesignPreset> = {}): DesignPreset {
  return {
    name: "Test",
    fontFamily: "Inter, sans-serif",
    bg: [0, 0, 5],
    surface: [0, 0, 10],
    accent: [210, 80, 50],
    text: [0, 0, 95],
    text2: [0, 0, 60],
    border: [0, 0, 20],
    headingSize: 20,
    headingWeight: 600,
    bodySize: 14,
    bodyWeight: 400,
    lineHeight: 1.5,
    gridCols: 3,
    gap: 16,
    padding: 20,
    radius: 12,
    borderWidth: 1,
    elevation: 30,
    ...overrides,
  };
}

describe("blendPresets", () => {
  const presets = [
    makePreset({ name: "TL", bg: [0, 0, 0], headingSize: 10, accent: [0, 100, 50] }),
    makePreset({ name: "TR", bg: [0, 0, 100], headingSize: 20, accent: [90, 100, 50] }),
    makePreset({ name: "BL", bg: [0, 0, 0], headingSize: 30, accent: [180, 100, 50] }),
    makePreset({ name: "BR", bg: [0, 0, 100], headingSize: 40, accent: [270, 100, 50] }),
  ];

  it("returns top-left preset at (0, 0)", () => {
    const result = blendPresets(0, 0, presets);
    expect(result.headingSize).toBeCloseTo(10, 1);
    expect(result.bg[2]).toBeCloseTo(0, 1);
  });

  it("returns top-right preset at (1, 0)", () => {
    const result = blendPresets(1, 0, presets);
    expect(result.headingSize).toBeCloseTo(20, 1);
    expect(result.bg[2]).toBeCloseTo(100, 1);
  });

  it("returns bottom-left preset at (0, 1)", () => {
    const result = blendPresets(0, 1, presets);
    expect(result.headingSize).toBeCloseTo(30, 1);
  });

  it("returns bottom-right preset at (1, 1)", () => {
    const result = blendPresets(1, 1, presets);
    expect(result.headingSize).toBeCloseTo(40, 1);
  });

  it("blends at center (0.5, 0.5)", () => {
    const result = blendPresets(0.5, 0.5, presets);
    expect(result.headingSize).toBeCloseTo(25, 0);
  });

  it("blends numeric properties bilinearly", () => {
    const result = blendPresets(0.5, 0, presets);
    expect(result.headingSize).toBeCloseTo(15, 0);
  });

  it("blends HSL arrays with hue-aware interpolation", () => {
    const result = blendPresets(0, 0, presets);
    expect(result.accent).toHaveLength(3);
    expect(result.accent[0]).toBeCloseTo(0, 0); // TL accent hue = 0
  });

  it("handles hue wraparound (350 -> 10 goes through 0)", () => {
    const wrapPresets = [
      makePreset({ accent: [350, 100, 50] }),
      makePreset({ accent: [10, 100, 50] }),
      makePreset({ accent: [350, 100, 50] }),
      makePreset({ accent: [10, 100, 50] }),
    ];
    const result = blendPresets(0.5, 0, wrapPresets);
    // Should go through 0, not through 180
    expect(result.accent[0]).toBeLessThan(20);
  });

  it("skips name and fontFamily keys", () => {
    const result = blendPresets(0.5, 0.5, presets);
    expect(result).not.toHaveProperty("name");
    expect(result).not.toHaveProperty("fontFamily");
  });

  it("returns all expected BlendResult keys", () => {
    const result = blendPresets(0.5, 0.5, presets);
    expect(result).toHaveProperty("bg");
    expect(result).toHaveProperty("surface");
    expect(result).toHaveProperty("accent");
    expect(result).toHaveProperty("text");
    expect(result).toHaveProperty("text2");
    expect(result).toHaveProperty("border");
    expect(result).toHaveProperty("headingSize");
    expect(result).toHaveProperty("headingWeight");
    expect(result).toHaveProperty("bodySize");
    expect(result).toHaveProperty("bodyWeight");
    expect(result).toHaveProperty("lineHeight");
    expect(result).toHaveProperty("gridCols");
    expect(result).toHaveProperty("gap");
    expect(result).toHaveProperty("padding");
    expect(result).toHaveProperty("radius");
    expect(result).toHaveProperty("borderWidth");
    expect(result).toHaveProperty("elevation");
  });
});
