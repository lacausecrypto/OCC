// ─── Design / theme morphing store ───────────────────────────────────────────

import { create } from "zustand";
import type { DesignPreset, BlendResult, SliderDef } from "../types/design";
import { blendPresets } from "../utils/blend";
import {
  hsl, hslToRgb,
  enforceContrast, enforceAccentContrast, enforceStatusColor,
  contrastRatioHsl,
} from "../utils/color";

// ─── Check if a preset is still untouched default ───────────────────────────
function isDefaultPreset(preset: DesignPreset, idx: number, defaults: DesignPreset[]): boolean {
  const def = defaults[idx];
  return (
    preset.accent[0] === def.accent[0] &&
    preset.accent[1] === def.accent[1] &&
    preset.accent[2] === def.accent[2]
  );
}

/**
 * Build effective presets: empty slots copy nearest loaded slot.
 * Prevents 1 loaded light site from blending with 3 dark defaults → "voile" effect.
 * - 1 loaded → all 4 = same preset (solid)
 * - 2 loaded → empties copy nearest loaded
 * - 4 loaded → all real
 */
export function buildEffectivePresets(presets: DesignPreset[]): DesignPreset[] {
  const loadedIdxs: number[] = [];
  for (let i = 0; i < 4; i++) {
    if (!isDefaultPreset(presets[i], i, DEFAULT_PRESETS)) loadedIdxs.push(i);
  }
  if (loadedIdxs.length === 0 || loadedIdxs.length === 4) return presets;

  const result = [...presets];
  const gridPos = [[0, 0], [1, 0], [0, 1], [1, 1]];
  for (let i = 0; i < 4; i++) {
    if (!isDefaultPreset(presets[i], i, DEFAULT_PRESETS)) continue;
    let nearestIdx = loadedIdxs[0];
    let nearestDist = Infinity;
    for (const li of loadedIdxs) {
      const dx = gridPos[i][0] - gridPos[li][0];
      const dy = gridPos[i][1] - gridPos[li][1];
      const dist = dx * dx + dy * dy;
      if (dist < nearestDist) { nearestDist = dist; nearestIdx = li; }
    }
    result[i] = { ...presets[nearestIdx], name: presets[i].name };
  }
  return result;
}

// ─── Default presets (mirrored from frontend/index.html) ─────────────────────

export const DEFAULT_PRESETS: DesignPreset[] = [
  {
    name: "Apple Dark",
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Display",
    bg: [0, 0, 5],
    surface: [0, 0, 10],
    accent: [211, 100, 50],
    text: [0, 0, 96],
    text2: [240, 3, 53],
    border: [0, 0, 18],
    headingSize: 20,
    headingWeight: 600,
    bodySize: 14,
    bodyWeight: 400,
    lineHeight: 1.47,
    gridCols: 3,
    gap: 16,
    padding: 20,
    radius: 12,
    borderWidth: 1,
    elevation: 30,
  },
  {
    name: "Neon Cyber",
    fontFamily: "Inter, system-ui",
    bg: [270, 30, 4],
    surface: [270, 25, 9],
    accent: [160, 100, 50],
    text: [0, 0, 95],
    text2: [270, 10, 50],
    border: [270, 15, 16],
    headingSize: 26,
    headingWeight: 800,
    bodySize: 13,
    bodyWeight: 400,
    lineHeight: 1.6,
    gridCols: 3,
    gap: 20,
    padding: 22,
    radius: 18,
    borderWidth: 1,
    elevation: 50,
  },
  {
    name: "Warm Earth",
    fontFamily: "Georgia, Cambria, serif",
    bg: [25, 20, 6],
    surface: [25, 18, 10],
    accent: [35, 100, 55],
    text: [30, 10, 90],
    text2: [25, 10, 48],
    border: [25, 12, 18],
    headingSize: 24,
    headingWeight: 500,
    bodySize: 16,
    bodyWeight: 400,
    lineHeight: 1.65,
    gridCols: 2,
    gap: 14,
    padding: 24,
    radius: 6,
    borderWidth: 1,
    elevation: 20,
  },
  {
    name: "Arctic Mono",
    fontFamily: "JetBrains Mono, SF Mono, Consolas, monospace",
    bg: [210, 15, 5],
    surface: [210, 18, 9],
    accent: [200, 100, 60],
    text: [210, 5, 92],
    text2: [210, 10, 50],
    border: [210, 12, 16],
    headingSize: 18,
    headingWeight: 700,
    bodySize: 13,
    bodyWeight: 300,
    lineHeight: 1.5,
    gridCols: 4,
    gap: 10,
    padding: 14,
    radius: 4,
    borderWidth: 2,
    elevation: 15,
  },
];

export const SLIDER_DEFS: SliderDef[] = [
  { key: "bg", label: "bg", type: "color" },
  { key: "surface", label: "surface", type: "color" },
  { key: "accent", label: "accent", type: "color" },
  { key: "text", label: "text", type: "color" },
  { key: "text2", label: "text 2nd", type: "color" },
  { key: "border", label: "border", type: "color" },
  { key: "fontFamily", label: "font", type: "font" },
  { key: "headingSize", label: "heading", min: 14, max: 40, unit: "px" },
  { key: "headingWeight", label: "h.weight", min: 300, max: 900, unit: "" },
  { key: "bodySize", label: "body", min: 10, max: 22, unit: "px" },
  { key: "bodyWeight", label: "b.weight", min: 300, max: 600, unit: "" },
  { key: "lineHeight", label: "leading", min: 1.0, max: 2.2, unit: "", dec: 2 },
  { key: "gridCols", label: "grid", min: 1, max: 4, unit: " cols" },
  { key: "gap", label: "gap", min: 4, max: 32, unit: "px" },
  { key: "padding", label: "padding", min: 8, max: 40, unit: "px" },
  { key: "radius", label: "radius", min: 0, max: 28, unit: "px" },
  { key: "borderWidth", label: "bdr.w", min: 0, max: 4, unit: "px", dec: 1 },
  { key: "elevation", label: "shadow", min: 0, max: 80, unit: "%" },
];

// ─── Store ───────────────────────────────────────────────────────────────────

export interface DesignState {
  presets: DesignPreset[];
  blendX: number;
  blendY: number;
  setPreset: (idx: number, preset: DesignPreset) => void;
  setBlendPosition: (x: number, y: number) => void;
  getBlendResult: () => BlendResult;
  applyBlend: () => void;
}

export const useDesignStore = create<DesignState>((set, get) => ({
  presets: DEFAULT_PRESETS.map((p) => ({ ...p })),
  blendX: 0.5,
  blendY: 0.5,

  setPreset: (idx, preset) => {
    set((s) => {
      const presets = [...s.presets];
      presets[idx] = preset;
      return { presets };
    });
    // Auto-apply blend after preset change (state is now updated synchronously)
    get().applyBlend();
  },

  setBlendPosition: (x, y) => set({ blendX: x, blendY: y }),


  getBlendResult: () => {
    const { presets, blendX, blendY } = get();
    return blendPresets(blendX, blendY, buildEffectivePresets(presets));
  },

  applyBlend: () => {
    const { presets, blendX, blendY } = get();
    const effective = buildEffectivePresets(presets);
    const b = blendPresets(blendX, blendY, effective);
    const r = document.documentElement.style;

    const bg: [number, number, number] = [b.bg[0], b.bg[1], b.bg[2]];
    const surface: [number, number, number] = [b.surface[0], b.surface[1], b.surface[2]];
    const isDark = bg[2] < 50;

    // ─── CONTRAST ENFORCEMENT ─────────────────────────────────────────

    // 0. Surface (cards) must be visually distinct from bg.
    //    Enforce minimum 1.15:1 contrast ratio (subtle but perceptible).
    //    If too close, push surface lighter (light mode) or lighter (dark mode).
    const bgSurfaceRatio = contrastRatioHsl(bg[0], bg[1], bg[2], surface[0], surface[1], surface[2]);
    if (bgSurfaceRatio < 1.15) {
      // Push surface away from bg
      if (isDark) {
        // Dark: surface should be lighter than bg
        surface[2] = Math.min(surface[2] + 6, bg[2] + 8);
      } else {
        // Light: surface should be lighter than bg (closer to white)
        // OR darker — pick whichever creates more separation
        if (surface[2] >= bg[2]) {
          // Surface is same or lighter — can't go much lighter, push down
          surface[2] = Math.max(surface[2] - 6, bg[2] - 8);
        } else {
          surface[2] = Math.max(surface[2] - 4, 80);
        }
      }
    }

    // 1. Primary text must have >= 4.5:1 contrast against bg (WCAG AA)
    const textSafe = enforceContrast(
      [b.text[0], b.text[1], b.text[2]], bg, 4.5,
    );
    // 2. Secondary text must have >= 3.0:1 contrast against bg (WCAG AA large)
    const text2Safe = enforceContrast(
      [b.text2[0], b.text2[1], b.text2[2]], bg, 3.0,
    );

    // 3. Text must be readable on BOTH bg AND surface
    const textOnSurface = enforceContrast(textSafe, surface, 4.5);
    const textFinal = contrastRatioHsl(textOnSurface[0], textOnSurface[1], textOnSurface[2], bg[0], bg[1], bg[2]) >= 4.5
      ? textOnSurface : textSafe;
    // Also enforce text2 on surface
    const text2OnSurface = enforceContrast(text2Safe, surface, 3.0);
    const text2Final = contrastRatioHsl(text2OnSurface[0], text2OnSurface[1], text2OnSurface[2], bg[0], bg[1], bg[2]) >= 3.0
      ? text2OnSurface : text2Safe;

    // 4. Accent: ensure it works as button background with readable text
    const { accent: accentSafe, contrastText: accentContrast } = enforceAccentContrast(
      [b.accent[0], b.accent[1], b.accent[2]], 4.5,
    );
    // 5. Accent must be distinguishable from bg AND surface (>= 3:1)
    let accentFinal = accentSafe;
    if (contrastRatioHsl(accentFinal[0], accentFinal[1], accentFinal[2], bg[0], bg[1], bg[2]) < 3.0) {
      accentFinal = enforceContrast(accentFinal, bg, 3.0);
    }
    if (contrastRatioHsl(accentFinal[0], accentFinal[1], accentFinal[2], surface[0], surface[1], surface[2]) < 2.5) {
      accentFinal = enforceContrast(accentFinal, surface, 2.5);
    }

    // 6. Border must be visible against BOTH bg and surface (>= 1.5:1)
    let borderSafe: [number, number, number] = [b.border[0], b.border[1], b.border[2]];
    if (contrastRatioHsl(borderSafe[0], borderSafe[1], borderSafe[2], bg[0], bg[1], bg[2]) < 1.5) {
      borderSafe = enforceContrast(borderSafe, bg, 1.5);
    }
    if (contrastRatioHsl(borderSafe[0], borderSafe[1], borderSafe[2], surface[0], surface[1], surface[2]) < 1.3) {
      borderSafe = enforceContrast(borderSafe, surface, 1.3);
    }

    // ─── APPLY SAFE COLORS ────────────────────────────────────────────
    r.setProperty("--m-bg", hsl(bg[0], bg[1], bg[2]));
    r.setProperty("--m-surface", hsl(surface[0], surface[1], surface[2]));
    r.setProperty("--m-accent", hsl(accentFinal[0], accentFinal[1], accentFinal[2]));

    const [acR, acG, acB] = hslToRgb(accentFinal[0], accentFinal[1], accentFinal[2]);
    r.setProperty("--m-accent-rgb", `${acR},${acG},${acB}`);

    r.setProperty("--m-text", hsl(textFinal[0], textFinal[1], textFinal[2]));
    r.setProperty("--m-text2", hsl(text2Final[0], text2Final[1], text2Final[2]));
    r.setProperty("--m-border", hsl(borderSafe[0], borderSafe[1], borderSafe[2]));

    // 7. Accent contrast — WCAG-based, not just lightness threshold
    r.setProperty(
      "--m-accent-contrast",
      hsl(accentContrast[0], accentContrast[1], accentContrast[2]),
    );

    // Dominant preset font (by bilinear weight)
    const weights = [
      (1 - blendX) * (1 - blendY),
      blendX * (1 - blendY),
      (1 - blendX) * blendY,
      blendX * blendY,
    ];
    const dominantIdx = weights.indexOf(Math.max(...weights));
    const effectiveFont = effective[dominantIdx].fontFamily;
    if (effectiveFont) r.setProperty("--m-font", effectiveFont + ", system-ui, sans-serif");

    // Typography
    r.setProperty("--m-heading-size", b.headingSize.toFixed(0) + "px");
    r.setProperty("--m-heading-weight", String(Math.round(b.headingWeight)));
    r.setProperty("--m-body-size", b.bodySize.toFixed(0) + "px");
    r.setProperty("--m-body-weight", String(Math.round(b.bodyWeight)));
    r.setProperty("--m-line-height", b.lineHeight.toFixed(2));

    // Layout
    r.setProperty("--m-grid-cols", String(Math.round(b.gridCols)));
    r.setProperty("--m-gap", b.gap.toFixed(0) + "px");
    r.setProperty("--m-padding", b.padding.toFixed(0) + "px");
    r.setProperty("--m-radius", b.radius.toFixed(0) + "px");
    r.setProperty("--m-border-width", b.borderWidth.toFixed(1) + "px");

    // Shadow
    const blur = 2 + b.elevation * 0.3;
    const alpha = 0.15 + b.elevation * 0.006;
    r.setProperty(
      "--m-shadow",
      `0 2px ${blur.toFixed(0)}px rgba(0,0,0,${alpha.toFixed(2)})`,
    );

    // ─── SEMANTIC STATUS COLORS — adaptive to theme ───────────────────
    const STATUS_DARK = {
      success: "#30d158", error: "#ff375f", warning: "#ff9f0a",
      info: "#64d2ff", purple: "#bf5af2", orange: "#ff9f0a", pink: "#ff6482",
    };
    const STATUS_LIGHT = {
      success: "#248a3d", error: "#d70015", warning: "#b25000",
      info: "#0071a4", purple: "#8944ab", orange: "#b25000", pink: "#d30f45",
    };
    const statusBase = isDark ? STATUS_DARK : STATUS_LIGHT;
    for (const [key, hex] of Object.entries(statusBase)) {
      // Enforce against BOTH bg and surface (pills appear inside cards)
      let safe = enforceStatusColor(hex, bg, 3.0);
      safe = enforceStatusColor(safe, surface, 3.0);
      r.setProperty(`--c-${key}`, safe);
    }

    // ─── ICON PALETTE — 7 hue-shifted variants from accent ─────────────
    // Used for settings row icons, node types, status badges, etc.
    // Each color is the accent hue rotated around the wheel, keeping the
    // same saturation/lightness family so they feel cohesive.
    const aH = accentFinal[0], aS = accentFinal[1];
    const iconL = isDark ? 58 : 45;
    const iconBgL = isDark ? 28 : 55;
    const iconPairs = [
      ["blue",   aH],
      ["green",  (aH + 140) % 360],
      ["orange", (aH + 40) % 360],
      ["cyan",   (aH + 180) % 360],
      ["purple", (aH + 270) % 360],
      ["red",    (aH + 200) % 360],
      ["pink",   (aH + 320) % 360],
    ] as const;
    for (const [name, hue] of iconPairs) {
      r.setProperty(`--icon-${name}`, hsl(hue, Math.min(aS, 80), iconL));
      r.setProperty(`--icon-${name}-bg`, hsl(hue, Math.min(aS, 70), iconBgL));
    }

    // Icon sizing — scales with body size
    const iconScale = b.bodySize / 14; // 1.0 at default 14px
    r.setProperty("--icon-sm", `${Math.round(12 * iconScale)}px`);
    r.setProperty("--icon-md", `${Math.round(16 * iconScale)}px`);
    r.setProperty("--icon-lg", `${Math.round(22 * iconScale)}px`);
    r.setProperty("--icon-xl", `${Math.round(32 * iconScale)}px`);

    // ─── GLASS TOKENS — adapt to light/dark theme ─────────────────────
    if (isDark) {
      r.setProperty("--glass-bg", `linear-gradient(135deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.06) 25%, rgba(240,248,255,0.07) 50%, rgba(255,255,255,0.05) 75%, rgba(230,240,255,0.06) 100%)`);
      r.setProperty("--glass-border", "rgba(255, 255, 255, 0.15)");
      r.setProperty("--glass-shadow", "0 4px 16px rgba(0,0,0,0.3), 0 1px 4px rgba(0,0,0,0.15), 0 0 0 0.5px rgba(255,255,255,0.1)");
      r.setProperty("--glass-tint", "rgba(255, 255, 255, 0.06)");
      r.setProperty("--glass-tint-hover", "rgba(255, 255, 255, 0.1)");
      r.setProperty("--glass-tint-subtle", "rgba(255, 255, 255, 0.03)");
    } else {
      r.setProperty("--glass-bg", `linear-gradient(135deg, rgba(0,0,0,0.03) 0%, rgba(0,0,0,0.02) 25%, rgba(0,10,30,0.03) 50%, rgba(0,0,0,0.02) 75%, rgba(0,10,30,0.025) 100%)`);
      r.setProperty("--glass-border", "rgba(0, 0, 0, 0.12)");
      r.setProperty("--glass-shadow", "0 4px 16px rgba(0,0,0,0.06), 0 1px 4px rgba(0,0,0,0.03), 0 0 0 0.5px rgba(0,0,0,0.08)");
      r.setProperty("--glass-tint", "rgba(0, 0, 0, 0.04)");
      r.setProperty("--glass-tint-hover", "rgba(0, 0, 0, 0.08)");
      r.setProperty("--glass-tint-subtle", "rgba(0, 0, 0, 0.02)");
    }

    // ─── SCROLLBAR — adapt to theme ───────────────────────────────────
    const scrollThumb = isDark ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.2)";
    const scrollHover = isDark ? "rgba(255,255,255,0.25)" : "rgba(0,0,0,0.35)";
    r.setProperty("--scrollbar-thumb", scrollThumb);
    r.setProperty("--scrollbar-hover", scrollHover);
  },
}));
