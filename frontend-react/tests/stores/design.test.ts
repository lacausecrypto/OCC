import { describe, it, expect, beforeEach, vi } from "vitest";
import { useDesignStore, DEFAULT_PRESETS, buildEffectivePresets, SLIDER_DEFS } from "../../src/stores/design";

// Mock document.documentElement.style.setProperty
const setPropertySpy = vi.fn();
Object.defineProperty(document.documentElement, "style", {
  value: { setProperty: setPropertySpy },
  writable: true,
});

describe("useDesignStore", () => {
  beforeEach(() => {
    useDesignStore.setState({
      presets: DEFAULT_PRESETS.map((p) => ({ ...p })),
      blendX: 0.5,
      blendY: 0.5,
    });
    setPropertySpy.mockClear();
  });

  it("has correct initial state", () => {
    const s = useDesignStore.getState();
    expect(s.presets).toHaveLength(4);
    expect(s.blendX).toBe(0.5);
    expect(s.blendY).toBe(0.5);
  });

  it("setPreset updates a specific preset", () => {
    const custom = { ...DEFAULT_PRESETS[0], name: "Custom", accent: [300, 80, 60] as [number, number, number] };
    useDesignStore.getState().setPreset(0, custom);
    expect(useDesignStore.getState().presets[0].name).toBe("Custom");
    expect(useDesignStore.getState().presets[0].accent).toEqual([300, 80, 60]);
  });

  it("setBlendPosition updates position", () => {
    useDesignStore.getState().setBlendPosition(0.2, 0.8);
    expect(useDesignStore.getState().blendX).toBe(0.2);
    expect(useDesignStore.getState().blendY).toBe(0.8);
  });

  it("getBlendResult returns a BlendResult", () => {
    const result = useDesignStore.getState().getBlendResult();
    expect(result).toHaveProperty("bg");
    expect(result).toHaveProperty("accent");
    expect(result).toHaveProperty("text");
    expect(result).toHaveProperty("headingSize");
    expect(result.bg).toHaveLength(3);
  });

  it("applyBlend sets CSS custom properties", () => {
    useDesignStore.getState().applyBlend();
    expect(setPropertySpy).toHaveBeenCalled();
    const calls = setPropertySpy.mock.calls.map((c: unknown[]) => c[0]);
    expect(calls).toContain("--m-bg");
    expect(calls).toContain("--m-surface");
    expect(calls).toContain("--m-accent");
    expect(calls).toContain("--m-text");
    expect(calls).toContain("--m-text2");
    expect(calls).toContain("--m-border");
    expect(calls).toContain("--m-font");
    expect(calls).toContain("--m-heading-size");
    expect(calls).toContain("--m-body-size");
    expect(calls).toContain("--m-radius");
    expect(calls).toContain("--m-shadow");
  });

  it("applyBlend sets semantic status colors", () => {
    useDesignStore.getState().applyBlend();
    const calls = setPropertySpy.mock.calls.map((c: unknown[]) => c[0]);
    expect(calls).toContain("--c-success");
    expect(calls).toContain("--c-error");
    expect(calls).toContain("--c-warning");
    expect(calls).toContain("--c-info");
  });

  it("applyBlend sets icon palette", () => {
    useDesignStore.getState().applyBlend();
    const calls = setPropertySpy.mock.calls.map((c: unknown[]) => c[0]);
    expect(calls).toContain("--icon-blue");
    expect(calls).toContain("--icon-green");
    expect(calls).toContain("--icon-orange");
  });

  it("applyBlend sets glass tokens", () => {
    useDesignStore.getState().applyBlend();
    const calls = setPropertySpy.mock.calls.map((c: unknown[]) => c[0]);
    expect(calls).toContain("--glass-bg");
    expect(calls).toContain("--glass-border");
    expect(calls).toContain("--glass-shadow");
  });
});

describe("buildEffectivePresets", () => {
  it("returns same presets when all are defaults", () => {
    const result = buildEffectivePresets([...DEFAULT_PRESETS]);
    expect(result).toEqual(DEFAULT_PRESETS);
  });

  it("returns same presets when all are loaded (non-default)", () => {
    const custom = DEFAULT_PRESETS.map((p) => ({
      ...p,
      accent: [(p.accent[0] + 30) % 360, p.accent[1], p.accent[2]] as [number, number, number],
    }));
    const result = buildEffectivePresets(custom);
    expect(result).toEqual(custom);
  });

  it("copies single loaded preset to all empty slots", () => {
    const presets = DEFAULT_PRESETS.map((p) => ({ ...p }));
    // Change slot 0 to make it non-default
    presets[0] = { ...presets[0], accent: [999, 50, 50] as [number, number, number] };
    const result = buildEffectivePresets(presets);
    // All slots should copy from slot 0
    expect(result[1].accent[0]).toBe(999);
    expect(result[2].accent[0]).toBe(999);
    expect(result[3].accent[0]).toBe(999);
  });
});

describe("DEFAULT_PRESETS", () => {
  it("has exactly 4 presets", () => {
    expect(DEFAULT_PRESETS).toHaveLength(4);
  });

  it("each preset has required fields", () => {
    for (const p of DEFAULT_PRESETS) {
      expect(p.name).toBeTruthy();
      expect(p.fontFamily).toBeTruthy();
      expect(p.bg).toHaveLength(3);
      expect(p.accent).toHaveLength(3);
      expect(p.text).toHaveLength(3);
    }
  });
});

describe("SLIDER_DEFS", () => {
  it("has 18 slider definitions", () => {
    expect(SLIDER_DEFS).toHaveLength(18);
  });

  it("includes color and non-color sliders", () => {
    const colorSliders = SLIDER_DEFS.filter((s) => s.type === "color");
    const fontSliders = SLIDER_DEFS.filter((s) => s.type === "font");
    expect(colorSliders.length).toBeGreaterThan(0);
    expect(fontSliders.length).toBeGreaterThan(0);
  });
});
