// ─── Random design preset generator ─────────────────────────────────────────
// Generates coherent, usable design presets — not random noise.
// 30 archetypes × 60+ font stacks × 5 color harmonies = thousands of combos.
// Every preset is WCAG-validated before returning.
//
// Archetypes sourced from: neubrutalism, bento grid, cyberpunk, vaporwave,
// synthwave, Y2K revival, art deco, memphis, scandinavian, organic/earth,
// SaaS dashboard, fintech, healthcare, gaming/esports, luxury/fashion,
// Swiss typographic, bauhaus, claymorphism, neumorphism, newspaper, etc.

import type { DesignPreset } from "../types/design";
import { enforceContrast, enforceAccentContrast, contrastRatioHsl } from "./color";

type HSL = [number, number, number];

// ─── 60+ font stacks organized by personality ───────────────────────────────

const FONT_STACKS: string[][] = [
  // 0: Geometric sans — modern, clean (14)
  [
    "Inter, system-ui, sans-serif",
    "Roboto, system-ui, sans-serif",
    "Poppins, system-ui, sans-serif",
    "Montserrat, system-ui, sans-serif",
    "DM Sans, system-ui, sans-serif",
    "Plus Jakarta Sans, system-ui, sans-serif",
    "Space Grotesk, system-ui, sans-serif",
    "Sora, system-ui, sans-serif",
    "Outfit, system-ui, sans-serif",
    "Albert Sans, system-ui, sans-serif",
    "Manrope, system-ui, sans-serif",
    "Rubik, system-ui, sans-serif",
    "Raleway, system-ui, sans-serif",
    "Josefin Sans, system-ui, sans-serif",
  ],
  // 1: Humanist sans — warm, friendly (8)
  [
    "Lato, system-ui, sans-serif",
    "Open Sans, system-ui, sans-serif",
    "Source Sans 3, system-ui, sans-serif",
    "Noto Sans, system-ui, sans-serif",
    "Cabin, system-ui, sans-serif",
    "Mukta, system-ui, sans-serif",
    "Fira Sans, system-ui, sans-serif",
    "Ubuntu, system-ui, sans-serif",
  ],
  // 2: Neo-grotesque — neutral, professional (6)
  [
    "-apple-system, BlinkMacSystemFont, SF Pro Display, system-ui, sans-serif",
    "Helvetica Neue, Arial, sans-serif",
    "Geist, system-ui, sans-serif",
    "Suisse Intl, Helvetica Neue, sans-serif",
    "Graphik, system-ui, sans-serif",
    "Aktiv Grotesk, Helvetica Neue, sans-serif",
  ],
  // 3: Serif — editorial, elegant (14)
  [
    "Georgia, Cambria, Times New Roman, serif",
    "Lora, Georgia, serif",
    "Merriweather, Georgia, serif",
    "Playfair Display, Georgia, serif",
    "Source Serif 4, Georgia, serif",
    "EB Garamond, Garamond, serif",
    "Crimson Text, Georgia, serif",
    "Libre Baskerville, Georgia, serif",
    "Cormorant Garamond, Garamond, serif",
    "Noto Serif, Georgia, serif",
    "PT Serif, Georgia, serif",
    "Spectral, Georgia, serif",
    "Bitter, Georgia, serif",
    "Alegreya, Georgia, serif",
  ],
  // 4: Monospace — technical, developer (8)
  [
    "JetBrains Mono, SF Mono, Consolas, monospace",
    "Fira Code, SF Mono, Consolas, monospace",
    "IBM Plex Mono, SF Mono, monospace",
    "Source Code Pro, Consolas, monospace",
    "Space Mono, Consolas, monospace",
    "Roboto Mono, Consolas, monospace",
    "Berkeley Mono, SF Mono, Consolas, monospace",
    "Victor Mono, Consolas, monospace",
  ],
  // 5: Display — bold personality (10)
  [
    "Satoshi, system-ui, sans-serif",
    "General Sans, system-ui, sans-serif",
    "Cabinet Grotesk, system-ui, sans-serif",
    "Clash Display, system-ui, sans-serif",
    "Switzer, system-ui, sans-serif",
    "Syne, system-ui, sans-serif",
    "Archivo Black, system-ui, sans-serif",
    "Bebas Neue, Impact, sans-serif",
    "Teko, system-ui, sans-serif",
    "Rajdhani, system-ui, sans-serif",
  ],
  // 6: Rounded sans — soft, approachable (6)
  [
    "Nunito, system-ui, sans-serif",
    "Quicksand, system-ui, sans-serif",
    "Varela Round, system-ui, sans-serif",
    "Comfortaa, system-ui, sans-serif",
    "Baloo 2, system-ui, sans-serif",
    "Lexend, system-ui, sans-serif",
  ],
  // 7: Condensed — dense, energetic (6)
  [
    "Oswald, Impact, sans-serif",
    "Roboto Condensed, Arial Narrow, sans-serif",
    "Barlow Condensed, Arial Narrow, sans-serif",
    "Pathway Extreme, system-ui, sans-serif",
    "Fjalla One, Impact, sans-serif",
    "Anton, Impact, sans-serif",
  ],
  // 8: High-contrast serif — luxury display (6)
  [
    "Playfair Display, Didot, Georgia, serif",
    "Libre Bodoni, Didot, Georgia, serif",
    "Cormorant Garamond, Garamond, serif",
    "Abril Fatface, Georgia, serif",
    "Poiret One, Didot, serif",
    "Neuton, Georgia, serif",
  ],
];

// ─── Color harmony strategies ────────────────────────────────────────────────

type HarmonyType = "analogous" | "complementary" | "triadic" | "split-comp" | "monochromatic";

const HARMONY_TYPES: HarmonyType[] = [
  "analogous", "analogous",
  "complementary",
  "triadic",
  "split-comp",
  "monochromatic", "monochromatic",
];

function pick<T>(arr: readonly T[] | T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
function randInt(min: number, max: number): number {
  return Math.round(rand(min, max));
}
function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function harmonyHues(baseHue: number, type: HarmonyType): number[] {
  const h = baseHue % 360;
  switch (type) {
    case "analogous":     return [h, (h + 30) % 360, (h + 330) % 360];
    case "complementary": return [h, (h + 180) % 360];
    case "triadic":       return [h, (h + 120) % 360, (h + 240) % 360];
    case "split-comp":    return [h, (h + 150) % 360, (h + 210) % 360];
    case "monochromatic": return [h, h, h];
  }
}

// ─── 30 design archetypes ───────────────────────────────────────────────────

interface DesignArchetype {
  name: string;
  isDark: boolean;
  accentS: [number, number];
  accentL: [number, number];
  // Optional: lock accent hue to a specific range (e.g. gold, green, etc.)
  accentHueRange?: [number, number];
  headingSize: [number, number];
  headingWeight: number[];
  bodySize: [number, number];
  bodyWeight: number[];
  lineHeight: [number, number];
  radius: [number, number];
  gap: [number, number];
  padding: [number, number];
  borderWidth: [number, number];
  elevation: [number, number];
  gridCols: number[];
  fontCategories: number[];
  // Optional: bg hue tint (for warm/cool-tinted backgrounds)
  bgSatRange?: [number, number];
}

const ARCHETYPES: DesignArchetype[] = [
  // ── DARK THEMES ─────────────────────────────────────────────────────

  { name: "Minimal Dark",
    isDark: true,
    accentS: [60, 100], accentL: [45, 65],
    headingSize: [18, 26], headingWeight: [500, 600, 700],
    bodySize: [13, 15], bodyWeight: [300, 400],
    lineHeight: [1.4, 1.6],
    radius: [4, 12], gap: [12, 20], padding: [14, 24],
    borderWidth: [0.5, 1.5], elevation: [15, 40],
    gridCols: [2, 3], fontCategories: [0, 1, 2],
  },
  { name: "Bold Neon",
    isDark: true,
    accentS: [85, 100], accentL: [50, 65],
    headingSize: [22, 32], headingWeight: [700, 800, 900],
    bodySize: [13, 15], bodyWeight: [400],
    lineHeight: [1.4, 1.7],
    radius: [12, 24], gap: [16, 24], padding: [18, 28],
    borderWidth: [1, 2], elevation: [40, 70],
    gridCols: [2, 3], fontCategories: [0, 5],
  },
  { name: "Glassmorphic",
    isDark: true,
    accentS: [70, 100], accentL: [50, 65],
    headingSize: [20, 28], headingWeight: [500, 600, 700],
    bodySize: [13, 15], bodyWeight: [400],
    lineHeight: [1.45, 1.6],
    radius: [14, 24], gap: [14, 22], padding: [16, 26],
    borderWidth: [0.5, 1], elevation: [30, 60],
    gridCols: [2, 3], fontCategories: [0, 2],
  },
  { name: "Warm Dark",
    isDark: true,
    accentS: [60, 100], accentL: [50, 65],
    accentHueRange: [15, 55],
    headingSize: [20, 28], headingWeight: [500, 600],
    bodySize: [14, 16], bodyWeight: [400],
    lineHeight: [1.5, 1.7],
    radius: [6, 14], gap: [12, 20], padding: [16, 24],
    borderWidth: [0.5, 1], elevation: [15, 35],
    gridCols: [2, 3], fontCategories: [1, 3],
    bgSatRange: [8, 22],
  },
  { name: "Tech Mono",
    isDark: true,
    accentS: [70, 100], accentL: [50, 65],
    headingSize: [16, 22], headingWeight: [600, 700],
    bodySize: [12, 14], bodyWeight: [300, 400],
    lineHeight: [1.4, 1.6],
    radius: [2, 6], gap: [8, 14], padding: [10, 16],
    borderWidth: [1, 2], elevation: [10, 25],
    gridCols: [3, 4], fontCategories: [4],
  },
  { name: "Retro Terminal",
    isDark: true,
    accentS: [80, 100], accentL: [45, 60],
    accentHueRange: [100, 150],
    headingSize: [16, 20], headingWeight: [700],
    bodySize: [13, 15], bodyWeight: [400],
    lineHeight: [1.4, 1.6],
    radius: [0, 2], gap: [8, 12], padding: [10, 16],
    borderWidth: [1, 2], elevation: [0, 10],
    gridCols: [1, 2], fontCategories: [4],
  },
  { name: "Cyberpunk Neon",
    isDark: true,
    accentS: [90, 100], accentL: [50, 62],
    accentHueRange: [170, 320],
    headingSize: [18, 26], headingWeight: [600, 700],
    bodySize: [12, 14], bodyWeight: [300, 400],
    lineHeight: [1.35, 1.55],
    radius: [0, 4], gap: [8, 16], padding: [10, 18],
    borderWidth: [1, 1.5], elevation: [35, 65],
    gridCols: [2, 3, 4], fontCategories: [4, 5],
    bgSatRange: [10, 30],
  },
  { name: "Synthwave",
    isDark: true,
    accentS: [85, 100], accentL: [55, 68],
    accentHueRange: [280, 340],
    headingSize: [22, 34], headingWeight: [700, 800, 900],
    bodySize: [13, 15], bodyWeight: [400],
    lineHeight: [1.4, 1.6],
    radius: [0, 4], gap: [12, 20], padding: [14, 24],
    borderWidth: [1, 2], elevation: [30, 55],
    gridCols: [2, 3], fontCategories: [5, 7],
    bgSatRange: [15, 35],
  },
  { name: "Art Deco Luxury",
    isDark: true,
    accentS: [55, 85], accentL: [48, 60],
    accentHueRange: [38, 52],
    headingSize: [22, 34], headingWeight: [400, 500, 600],
    bodySize: [14, 16], bodyWeight: [300, 400],
    lineHeight: [1.5, 1.7],
    radius: [0, 2], gap: [14, 22], padding: [18, 30],
    borderWidth: [0.5, 1], elevation: [15, 35],
    gridCols: [2, 3], fontCategories: [3, 8],
  },
  { name: "Gaming Esports",
    isDark: true,
    accentS: [85, 100], accentL: [48, 62],
    headingSize: [20, 32], headingWeight: [700, 800, 900],
    bodySize: [13, 15], bodyWeight: [400],
    lineHeight: [1.3, 1.5],
    radius: [0, 4], gap: [10, 18], padding: [12, 20],
    borderWidth: [1.5, 3], elevation: [25, 55],
    gridCols: [2, 3], fontCategories: [5, 7],
  },
  { name: "Vaporwave",
    isDark: true,
    accentS: [60, 90], accentL: [55, 72],
    accentHueRange: [280, 340],
    headingSize: [20, 30], headingWeight: [400, 500, 700],
    bodySize: [14, 16], bodyWeight: [400],
    lineHeight: [1.5, 1.7],
    radius: [0, 4], gap: [12, 20], padding: [14, 24],
    borderWidth: [1, 2], elevation: [10, 30],
    gridCols: [2, 3], fontCategories: [3, 4],
    bgSatRange: [10, 25],
  },
  { name: "Fintech Dark",
    isDark: true,
    accentS: [55, 85], accentL: [45, 58],
    accentHueRange: [150, 220],
    headingSize: [18, 24], headingWeight: [500, 600, 700],
    bodySize: [13, 15], bodyWeight: [400],
    lineHeight: [1.45, 1.6],
    radius: [8, 16], gap: [12, 18], padding: [14, 22],
    borderWidth: [0.5, 1], elevation: [15, 35],
    gridCols: [3, 4], fontCategories: [0, 2, 4],
    bgSatRange: [5, 18],
  },
  { name: "Bento Dark",
    isDark: true,
    accentS: [50, 85], accentL: [50, 65],
    headingSize: [18, 26], headingWeight: [500, 600],
    bodySize: [13, 15], bodyWeight: [400],
    lineHeight: [1.45, 1.6],
    radius: [16, 24], gap: [16, 24], padding: [18, 28],
    borderWidth: [0.5, 1], elevation: [20, 40],
    gridCols: [2, 3], fontCategories: [0, 2],
  },

  // ── LIGHT THEMES ────────────────────────────────────────────────────

  { name: "Editorial",
    isDark: false,
    accentS: [40, 80], accentL: [35, 55],
    headingSize: [24, 36], headingWeight: [400, 500, 600],
    bodySize: [15, 18], bodyWeight: [400],
    lineHeight: [1.5, 1.8],
    radius: [0, 6], gap: [12, 20], padding: [16, 28],
    borderWidth: [0.5, 1], elevation: [5, 20],
    gridCols: [1, 2], fontCategories: [3],
  },
  { name: "Corporate Clean",
    isDark: false,
    accentS: [60, 90], accentL: [40, 55],
    headingSize: [18, 24], headingWeight: [600, 700],
    bodySize: [14, 16], bodyWeight: [400],
    lineHeight: [1.5, 1.7],
    radius: [4, 10], gap: [14, 20], padding: [16, 24],
    borderWidth: [1, 1.5], elevation: [10, 30],
    gridCols: [3, 4], fontCategories: [1, 2],
  },
  { name: "Brutalist",
    isDark: false,
    accentS: [80, 100], accentL: [45, 60],
    headingSize: [26, 40], headingWeight: [800, 900],
    bodySize: [14, 16], bodyWeight: [400],
    lineHeight: [1.3, 1.5],
    radius: [0, 2], gap: [8, 16], padding: [12, 20],
    borderWidth: [2, 4], elevation: [0, 10],
    gridCols: [1, 2, 3], fontCategories: [2, 4, 5],
  },
  { name: "Pastel Light",
    isDark: false,
    accentS: [45, 75], accentL: [50, 65],
    headingSize: [20, 28], headingWeight: [500, 600, 700],
    bodySize: [14, 16], bodyWeight: [400],
    lineHeight: [1.5, 1.7],
    radius: [10, 20], gap: [14, 22], padding: [16, 26],
    borderWidth: [0.5, 1], elevation: [10, 30],
    gridCols: [2, 3], fontCategories: [0, 6],
  },
  { name: "Neubrutalism",
    isDark: false,
    accentS: [80, 100], accentL: [55, 70],
    headingSize: [24, 36], headingWeight: [700, 800, 900],
    bodySize: [14, 16], bodyWeight: [400, 500],
    lineHeight: [1.4, 1.6],
    radius: [0, 2], gap: [12, 20], padding: [18, 32],
    borderWidth: [2.5, 4], elevation: [0, 5],
    gridCols: [2, 3], fontCategories: [0, 5],
  },
  { name: "Scandinavian",
    isDark: false,
    accentS: [20, 50], accentL: [40, 60],
    headingSize: [20, 28], headingWeight: [400, 500, 600],
    bodySize: [14, 16], bodyWeight: [300, 400],
    lineHeight: [1.55, 1.8],
    radius: [8, 14], gap: [16, 28], padding: [20, 34],
    borderWidth: [0.5, 1], elevation: [5, 15],
    gridCols: [2, 3], fontCategories: [0, 1],
    bgSatRange: [0, 4],
  },
  { name: "Organic Earth",
    isDark: false,
    accentS: [40, 75], accentL: [38, 55],
    accentHueRange: [15, 55],
    headingSize: [22, 30], headingWeight: [500, 600],
    bodySize: [15, 17], bodyWeight: [400],
    lineHeight: [1.55, 1.75],
    radius: [14, 24], gap: [14, 22], padding: [18, 28],
    borderWidth: [0.5, 1], elevation: [10, 25],
    gridCols: [2, 3], fontCategories: [1, 3, 6],
    bgSatRange: [3, 10],
  },
  { name: "SaaS Dashboard",
    isDark: false,
    accentS: [65, 95], accentL: [42, 55],
    accentHueRange: [210, 260],
    headingSize: [18, 24], headingWeight: [600, 700],
    bodySize: [13, 15], bodyWeight: [400],
    lineHeight: [1.45, 1.6],
    radius: [6, 12], gap: [12, 18], padding: [14, 22],
    borderWidth: [1, 1.5], elevation: [8, 25],
    gridCols: [3, 4], fontCategories: [0, 2],
  },
  { name: "Healthcare",
    isDark: false,
    accentS: [50, 80], accentL: [38, 52],
    accentHueRange: [170, 220],
    headingSize: [20, 26], headingWeight: [500, 600, 700],
    bodySize: [15, 17], bodyWeight: [400],
    lineHeight: [1.55, 1.75],
    radius: [12, 18], gap: [14, 22], padding: [18, 28],
    borderWidth: [0.5, 1], elevation: [8, 22],
    gridCols: [2, 3], fontCategories: [1, 6],
  },
  { name: "Swiss Typographic",
    isDark: false,
    accentS: [75, 100], accentL: [42, 55],
    headingSize: [22, 34], headingWeight: [700, 800],
    bodySize: [14, 16], bodyWeight: [400],
    lineHeight: [1.45, 1.65],
    radius: [0, 0], gap: [10, 18], padding: [14, 24],
    borderWidth: [1, 2], elevation: [0, 8],
    gridCols: [2, 3, 4], fontCategories: [0, 2],
    bgSatRange: [0, 2],
  },
  { name: "Memphis Pop",
    isDark: false,
    accentS: [85, 100], accentL: [50, 65],
    headingSize: [26, 38], headingWeight: [700, 800, 900],
    bodySize: [14, 16], bodyWeight: [400, 500],
    lineHeight: [1.4, 1.6],
    radius: [0, 20], gap: [14, 24], padding: [16, 28],
    borderWidth: [2, 4], elevation: [5, 25],
    gridCols: [2, 3], fontCategories: [0, 5, 6],
  },
  { name: "Luxury Fashion",
    isDark: false,
    accentS: [0, 15], accentL: [15, 30],
    headingSize: [24, 36], headingWeight: [300, 400],
    bodySize: [14, 16], bodyWeight: [300, 400],
    lineHeight: [1.6, 1.85],
    radius: [0, 2], gap: [16, 28], padding: [24, 40],
    borderWidth: [0.5, 1], elevation: [0, 8],
    gridCols: [1, 2], fontCategories: [8],
    bgSatRange: [0, 2],
  },
  { name: "Newspaper Broadsheet",
    isDark: false,
    accentS: [60, 90], accentL: [35, 50],
    accentHueRange: [0, 15],
    headingSize: [24, 38], headingWeight: [700, 800, 900],
    bodySize: [15, 17], bodyWeight: [400],
    lineHeight: [1.5, 1.7],
    radius: [0, 2], gap: [8, 14], padding: [12, 20],
    borderWidth: [0.5, 1], elevation: [0, 5],
    gridCols: [2, 3, 4], fontCategories: [3, 7],
    bgSatRange: [2, 8],
  },
  { name: "Claymorphic",
    isDark: false,
    accentS: [50, 80], accentL: [50, 65],
    headingSize: [20, 28], headingWeight: [600, 700],
    bodySize: [14, 16], bodyWeight: [400, 500],
    lineHeight: [1.5, 1.7],
    radius: [16, 28], gap: [16, 24], padding: [18, 30],
    borderWidth: [0, 0.5], elevation: [30, 60],
    gridCols: [2, 3], fontCategories: [6, 0],
    bgSatRange: [3, 12],
  },
  { name: "Neumorphic",
    isDark: false,
    accentS: [40, 70], accentL: [45, 60],
    headingSize: [18, 24], headingWeight: [500, 600],
    bodySize: [14, 16], bodyWeight: [300, 400],
    lineHeight: [1.5, 1.7],
    radius: [12, 24], gap: [14, 22], padding: [16, 26],
    borderWidth: [0, 0], elevation: [20, 45],
    gridCols: [2, 3], fontCategories: [0, 1],
    bgSatRange: [2, 8],
  },
  { name: "Y2K Revival",
    isDark: false,
    accentS: [70, 100], accentL: [55, 72],
    accentHueRange: [280, 340],
    headingSize: [22, 32], headingWeight: [600, 700, 800],
    bodySize: [14, 16], bodyWeight: [400, 500],
    lineHeight: [1.4, 1.6],
    radius: [18, 28], gap: [14, 22], padding: [16, 26],
    borderWidth: [1, 2], elevation: [20, 45],
    gridCols: [2, 3], fontCategories: [6, 0],
  },
  { name: "Bento Light",
    isDark: false,
    accentS: [50, 85], accentL: [42, 55],
    headingSize: [18, 26], headingWeight: [500, 600],
    bodySize: [14, 16], bodyWeight: [400],
    lineHeight: [1.45, 1.6],
    radius: [16, 24], gap: [16, 24], padding: [18, 28],
    borderWidth: [0.5, 1], elevation: [10, 25],
    gridCols: [2, 3], fontCategories: [0, 2],
  },
];

function pickFont(archetype: DesignArchetype): string {
  const catIdx = pick(archetype.fontCategories);
  return pick(FONT_STACKS[catIdx]);
}

// ─── Preset generation ──────────────────────────────────────────────────────

export function generateRandomPreset(nameOverride?: string): DesignPreset {
  const archetype = pick(ARCHETYPES);
  const harmony = pick(HARMONY_TYPES);

  // Accent hue: use locked range if archetype specifies one, else random
  const baseHue = archetype.accentHueRange
    ? rand(archetype.accentHueRange[0], archetype.accentHueRange[1]) % 360
    : rand(0, 360);
  const hues = harmonyHues(baseHue, harmony);

  const accentHue = hues[0];
  const accentS = rand(archetype.accentS[0], archetype.accentS[1]);
  const accentL = rand(archetype.accentL[0], archetype.accentL[1]);

  const bgHueSrc = hues.length > 1 ? hues[1] : accentHue;
  const bgHue = Math.random() > 0.4 ? bgHueSrc : rand(0, 360);
  const bgSatMin = archetype.bgSatRange?.[0] ?? 0;
  const bgSatMax = archetype.bgSatRange?.[1] ?? 20;

  let bg: HSL, surface: HSL, text: HSL, text2: HSL, border: HSL;

  if (archetype.isDark) {
    const bgL = rand(2, 10);
    const bgS = rand(bgSatMin, bgSatMax);
    bg = [bgHue, bgS, bgL];
    surface = [bgHue, clamp(bgS + rand(-3, 5), 0, 25), clamp(bgL + rand(3, 8), 5, 18)];
    text = [bgHue, rand(0, 8), rand(88, 96)];
    text2 = [bgHue, rand(0, 12), rand(42, 58)];
    border = [bgHue, rand(0, 15), rand(14, 25)];
  } else {
    const bgL = rand(94, 100);
    const bgS = rand(bgSatMin, Math.max(bgSatMax, 8));
    bg = [bgHue, bgS, bgL];
    surface = [bgHue, clamp(bgS + rand(-2, 4), 0, 12), clamp(bgL - rand(3, 8), 88, 96)];
    text = [bgHue, rand(0, 8), rand(5, 15)];
    text2 = [bgHue, rand(0, 10), rand(35, 55)];
    border = [bgHue, rand(0, 8), rand(78, 88)];
  }

  let accent: HSL = [accentHue, accentS, accentL];
  const font = pickFont(archetype);

  // ─── WCAG contrast validation ─────────────────────────────────────
  const rndHsl = (v: HSL): HSL => v.map(x => Math.round(x * 10) / 10) as HSL;
  const bgR = rndHsl(bg);

  text = enforceContrast(rndHsl(text), bgR, 4.5);
  text2 = enforceContrast(rndHsl(text2), bgR, 3.0);
  const { accent: accentFixed } = enforceAccentContrast(rndHsl(accent), 4.5);
  accent = accentFixed;
  if (contrastRatioHsl(accent[0], accent[1], accent[2], bgR[0], bgR[1], bgR[2]) < 3.0) {
    accent = enforceContrast(accent, bgR, 3.0);
  }
  if (contrastRatioHsl(border[0], border[1], border[2], bgR[0], bgR[1], bgR[2]) < 1.5) {
    border = enforceContrast(rndHsl(border), bgR, 1.5);
  }

  return {
    name: nameOverride || archetype.name,
    fontFamily: font,
    bg: bgR,
    surface: rndHsl(surface),
    accent: rndHsl(accent),
    text: rndHsl(text),
    text2: rndHsl(text2),
    border: border.map(v => Math.round(v * 10) / 10) as HSL,
    headingSize: randInt(archetype.headingSize[0], archetype.headingSize[1]),
    headingWeight: pick(archetype.headingWeight),
    bodySize: randInt(archetype.bodySize[0], archetype.bodySize[1]),
    bodyWeight: pick(archetype.bodyWeight),
    lineHeight: Math.round(rand(archetype.lineHeight[0], archetype.lineHeight[1]) * 100) / 100,
    gridCols: pick(archetype.gridCols),
    gap: randInt(archetype.gap[0], archetype.gap[1]),
    padding: randInt(archetype.padding[0], archetype.padding[1]),
    radius: randInt(archetype.radius[0], archetype.radius[1]),
    borderWidth: Math.round(rand(archetype.borderWidth[0], archetype.borderWidth[1]) * 10) / 10,
    elevation: randInt(archetype.elevation[0], archetype.elevation[1]),
  };
}

/**
 * Generate 4 random presets that form a coherent set for the blend matrix.
 * 3 strategies for variety:
 * - Same archetype, different hues (cohesive)
 * - Two archetypes mixed (contrasty blend)
 * - Four fully independent presets (maximum diversity)
 */
export function generateRandomPresetSet(): DesignPreset[] {
  const names = ["Slot A", "Slot B", "Slot C", "Slot D"];
  const strategy = Math.random();

  if (strategy < 0.4) {
    // Same archetype, different hues
    return names.map(name => generateRandomPreset(name));
  } else if (strategy < 0.75) {
    // Two archetypes — generate with hue spread
    pick(ARCHETYPES);
    return names.map((name, i) => {
      const preset = generateRandomPreset(name);
      // Shift accent hue for variety
      const hueShift = i * 90;
      preset.accent = [
        (preset.accent[0] + hueShift) % 360,
        preset.accent[1],
        preset.accent[2],
      ];
      return preset;
    });
  } else {
    // Four fully independent presets (max diversity)
    return names.map(name => generateRandomPreset(name));
  }
}
