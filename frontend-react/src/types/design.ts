// ─── Design system types for the morphable theme engine ──────────────────────

/** HSL triplet: [hue (0-360), saturation (0-100), lightness (0-100)] */
export type HSL = [number, number, number];

export interface DesignPreset {
  name: string;
  fontFamily: string;
  bg: HSL;
  surface: HSL;
  accent: HSL;
  text: HSL;
  text2: HSL;
  border: HSL;
  headingSize: number;
  headingWeight: number;
  bodySize: number;
  bodyWeight: number;
  lineHeight: number;
  gridCols: number;
  gap: number;
  padding: number;
  radius: number;
  borderWidth: number;
  elevation: number;
  /** Open Graph image URL (returned by /extract-style server endpoint) */
  ogImage?: string;
  /** Favicon URL for image-based color extraction */
  faviconUrl?: string;
  /** True if accent color is a fallback (no real accent found in CSS) */
  accentIsFallback?: boolean;
}

export interface SliderDef {
  key: string;
  label: string;
  type?: "color" | "font";
  min?: number;
  max?: number;
  unit?: string;
  dec?: number;
}

/** A saved theme snapshot — 4 presets + blend position + metadata */
export interface SavedTheme {
  id: string;
  name: string;
  createdAt: number;
  presets: DesignPreset[];
  blendX: number;
  blendY: number;
}

/** Numeric-only result of blending 4 presets (no name/fontFamily) */
export interface BlendResult {
  bg: HSL;
  surface: HSL;
  accent: HSL;
  text: HSL;
  text2: HSL;
  border: HSL;
  headingSize: number;
  headingWeight: number;
  bodySize: number;
  bodyWeight: number;
  lineHeight: number;
  gridCols: number;
  gap: number;
  padding: number;
  radius: number;
  borderWidth: number;
  elevation: number;
}
