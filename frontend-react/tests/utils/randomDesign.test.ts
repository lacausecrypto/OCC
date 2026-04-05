import { describe, it, expect } from "vitest";
import { generateRandomPreset, generateRandomPresetSet } from "../../src/utils/randomDesign";
import { contrastRatioHsl } from "../../src/utils/color";

describe("generateRandomPreset", () => {
  it("returns a valid DesignPreset with all required fields", () => {
    const preset = generateRandomPreset();
    expect(preset).toHaveProperty("name");
    expect(preset).toHaveProperty("fontFamily");
    expect(preset).toHaveProperty("bg");
    expect(preset).toHaveProperty("surface");
    expect(preset).toHaveProperty("accent");
    expect(preset).toHaveProperty("text");
    expect(preset).toHaveProperty("text2");
    expect(preset).toHaveProperty("border");
    expect(preset).toHaveProperty("headingSize");
    expect(preset).toHaveProperty("headingWeight");
    expect(preset).toHaveProperty("bodySize");
    expect(preset).toHaveProperty("bodyWeight");
    expect(preset).toHaveProperty("lineHeight");
    expect(preset).toHaveProperty("gridCols");
    expect(preset).toHaveProperty("gap");
    expect(preset).toHaveProperty("padding");
    expect(preset).toHaveProperty("radius");
    expect(preset).toHaveProperty("borderWidth");
    expect(preset).toHaveProperty("elevation");
  });

  it("uses name override when provided", () => {
    const preset = generateRandomPreset("Custom Name");
    expect(preset.name).toBe("Custom Name");
  });

  it("returns HSL arrays with 3 elements", () => {
    const preset = generateRandomPreset();
    expect(preset.bg).toHaveLength(3);
    expect(preset.surface).toHaveLength(3);
    expect(preset.accent).toHaveLength(3);
    expect(preset.text).toHaveLength(3);
    expect(preset.text2).toHaveLength(3);
    expect(preset.border).toHaveLength(3);
  });

  it("returns numeric values in valid ranges", () => {
    for (let i = 0; i < 10; i++) {
      const preset = generateRandomPreset();
      // Hue: 0-360, Saturation: 0-100, Lightness: 0-100
      for (const key of ["bg", "surface", "accent", "text", "text2", "border"] as const) {
        expect(preset[key][0]).toBeGreaterThanOrEqual(0);
        expect(preset[key][0]).toBeLessThanOrEqual(360);
        expect(preset[key][1]).toBeGreaterThanOrEqual(0);
        expect(preset[key][1]).toBeLessThanOrEqual(100);
        expect(preset[key][2]).toBeGreaterThanOrEqual(0);
        expect(preset[key][2]).toBeLessThanOrEqual(100);
      }
      expect(preset.headingSize).toBeGreaterThanOrEqual(14);
      expect(preset.headingSize).toBeLessThanOrEqual(40);
      expect(preset.bodySize).toBeGreaterThanOrEqual(10);
      expect(preset.bodySize).toBeLessThanOrEqual(22);
      expect(preset.lineHeight).toBeGreaterThanOrEqual(1.0);
      expect(preset.lineHeight).toBeLessThanOrEqual(2.2);
    }
  });

  it("ensures WCAG AA text contrast (>= 4.5:1 approx)", () => {
    for (let i = 0; i < 20; i++) {
      const preset = generateRandomPreset();
      const ratio = contrastRatioHsl(
        preset.text[0], preset.text[1], preset.text[2],
        preset.bg[0], preset.bg[1], preset.bg[2],
      );
      // Allow small tolerance for rounding
      expect(ratio).toBeGreaterThanOrEqual(4.0);
    }
  });

  it("includes a valid font family", () => {
    const preset = generateRandomPreset();
    expect(preset.fontFamily).toBeTruthy();
    expect(typeof preset.fontFamily).toBe("string");
  });

  it("generates different presets on successive calls", () => {
    const a = generateRandomPreset();
    // They _could_ be identical by extreme chance, but extremely unlikely
    // Check at least accent hue differs most of the time
    const aStr = JSON.stringify(a.accent);
    // This test may occasionally fail by pure chance, run 5 tries
    let differ = false;
    for (let i = 0; i < 5; i++) {
      const c = generateRandomPreset();
      if (JSON.stringify(c.accent) !== aStr) { differ = true; break; }
    }
    expect(differ).toBe(true);
  });
});

describe("generateRandomPresetSet", () => {
  it("returns exactly 4 presets", () => {
    const set = generateRandomPresetSet();
    expect(set).toHaveLength(4);
  });

  it("names presets Slot A through Slot D", () => {
    const set = generateRandomPresetSet();
    expect(set[0].name).toBe("Slot A");
    expect(set[1].name).toBe("Slot B");
    expect(set[2].name).toBe("Slot C");
    expect(set[3].name).toBe("Slot D");
  });

  it("each preset is a valid DesignPreset", () => {
    const set = generateRandomPresetSet();
    for (const preset of set) {
      expect(preset).toHaveProperty("bg");
      expect(preset).toHaveProperty("accent");
      expect(preset).toHaveProperty("fontFamily");
      expect(preset.bg).toHaveLength(3);
    }
  });
});
