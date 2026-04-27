/**
 * Floor palette — derived from the live design space tokens.
 *
 * Each floor stores a `colorSlot: 0..6` that points into this palette. At
 * render time we resolve the slot to a real hex via getComputedStyle, so when
 * the user changes the design space (accent, dark/light mode, theme), every
 * floor's color updates without us touching the floor records.
 *
 * The 7 slots mirror the 7 hue-shifted icon vars produced by `applyBlend`
 * in design.ts — they are guaranteed to be cohesive with the active palette.
 */
import { useDesignStore } from "../stores/design";

export const FLOOR_COLOR_VARS = [
  "--icon-blue",
  "--icon-green",
  "--icon-orange",
  "--icon-purple",
  "--icon-red",
  "--icon-cyan",
  "--icon-pink",
] as const;

export const FLOOR_SLOT_COUNT = FLOOR_COLOR_VARS.length;

/** Hex fallback if CSS var lookup fails (e.g. SSR, very early boot). */
const FALLBACK_HEX = [
  "#0a84ff", "#30d158", "#ff9f0a", "#bf5af2",
  "#ff375f", "#64d2ff", "#ff6482",
];

function readVar(name: string): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || "";
  } catch {
    return "";
  }
}

/** HSL string → hex (#rrggbb). Returns "" if input isn't HSL. */
function hslStringToHex(hsl: string): string {
  const m = hsl.match(/hsl\s*\(\s*([\d.]+)\s*,?\s*([\d.]+)%\s*,?\s*([\d.]+)%/i);
  if (!m) return "";
  const h = parseFloat(m[1]) / 360;
  const s = parseFloat(m[2]) / 100;
  const l = parseFloat(m[3]) / 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * c).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** Resolve a slot index to a hex color (#rrggbb). Always usable for SVG, opacity concat, etc. */
export function resolveFloorColor(slot: number): string {
  const idx = ((slot % FLOOR_SLOT_COUNT) + FLOOR_SLOT_COUNT) % FLOOR_SLOT_COUNT;
  const raw = readVar(FLOOR_COLOR_VARS[idx]);
  if (!raw) return FALLBACK_HEX[idx];
  if (raw.startsWith("#")) return raw;
  if (raw.startsWith("hsl")) {
    const hex = hslStringToHex(raw);
    return hex || FALLBACK_HEX[idx];
  }
  return FALLBACK_HEX[idx];
}

/**
 * Map a legacy hex color to the closest slot in the static fallback palette.
 * Used to migrate floors persisted before the slot system existed.
 */
export function inferSlotFromHex(hex: string): number {
  const h = hex.trim().toLowerCase();
  for (let i = 0; i < FALLBACK_HEX.length; i++) {
    if (FALLBACK_HEX[i].toLowerCase() === h) return i;
  }
  // Default to accent slot if unknown
  return 0;
}

/**
 * React hook — returns a fresh palette of 7 hex colors and re-runs whenever
 * the design space changes (presets / blend position).
 */
export function useFloorPalette(): string[] {
  // Subscribing to these fields means the component re-renders on any design
  // tweak, after which getComputedStyle reads the just-applied CSS vars.
  const presets = useDesignStore((s) => s.presets);
  const blendX = useDesignStore((s) => s.blendX);
  const blendY = useDesignStore((s) => s.blendY);
  // Touch them so eslint-no-unused-vars stays happy and the subscription holds.
  void presets; void blendX; void blendY;
  return FLOOR_COLOR_VARS.map((_, i) => resolveFloorColor(i));
}
