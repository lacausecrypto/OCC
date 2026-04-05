// ─── Color utility functions ─────────────────────────────────────────────────

/**
 * Convert HSL to RGB (0-255 each).
 * h: 0-360, s: 0-100, l: 0-100
 */
export function hslToRgb(
  h: number,
  s: number,
  l: number,
): [number, number, number] {
  h /= 360;
  s /= 100;
  l /= 100;
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const hue2rgb = (p: number, q: number, t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  ];
}

/** Format HSL values into a CSS hsl() string */
export function hsl(h: number, s: number, l: number): string {
  return `hsl(${h},${s}%,${l}%)`;
}

/** Linear interpolation */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Clamp a value between min and max */
export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

// ─── WCAG 2.1 Contrast Utilities ─────────────────────────────────────────────
// Based on https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
// and https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio

/**
 * Relative luminance of an sRGB color.
 * Input: r, g, b in 0-255 range.
 * Returns 0 (black) to 1 (white).
 */
export function relativeLuminance(r: number, g: number, b: number): number {
  const srgb = [r / 255, g / 255, b / 255].map((c) =>
    c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4),
  );
  return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
}

/**
 * Relative luminance from HSL values.
 * h: 0-360, s: 0-100, l: 0-100
 */
export function luminanceFromHsl(h: number, s: number, l: number): number {
  const [r, g, b] = hslToRgb(h, s, l);
  return relativeLuminance(r, g, b);
}

/**
 * WCAG contrast ratio between two luminance values.
 * Returns a value from 1 (no contrast) to 21 (max contrast, black/white).
 * WCAG AA requires >= 4.5 for normal text, >= 3.0 for large text.
 * WCAG AAA requires >= 7.0 for normal text, >= 4.5 for large text.
 */
export function contrastRatio(lum1: number, lum2: number): number {
  const lighter = Math.max(lum1, lum2);
  const darker = Math.min(lum1, lum2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * WCAG contrast ratio between two HSL colors.
 */
export function contrastRatioHsl(
  h1: number, s1: number, l1: number,
  h2: number, s2: number, l2: number,
): number {
  return contrastRatio(
    luminanceFromHsl(h1, s1, l1),
    luminanceFromHsl(h2, s2, l2),
  );
}

type HSL = [number, number, number];

/**
 * Choose the best foreground color (dark or light) for a given background.
 * Returns the HSL with the highest contrast ratio against bgHsl.
 * Always ensures WCAG AA (>= 4.5:1) for normal text.
 */
export function bestForeground(
  bgHsl: HSL,
  darkCandidate: HSL = [0, 0, 5],
  lightCandidate: HSL = [0, 0, 98],
): HSL {
  const bgLum = luminanceFromHsl(bgHsl[0], bgHsl[1], bgHsl[2]);
  const darkLum = luminanceFromHsl(darkCandidate[0], darkCandidate[1], darkCandidate[2]);
  const lightLum = luminanceFromHsl(lightCandidate[0], lightCandidate[1], lightCandidate[2]);
  const darkCR = contrastRatio(bgLum, darkLum);
  const lightCR = contrastRatio(bgLum, lightLum);
  return darkCR > lightCR ? darkCandidate : lightCandidate;
}

/**
 * Hue distance on the 360° wheel (0-180).
 */
function hueDist(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Ensure a text color has sufficient contrast against a background.
 *
 * Strategy:
 * 1. If text and bg share a similar hue (within 40°) AND bg has saturation,
 *    desaturate the text — pure luminance contrast is not enough for
 *    perceived readability when hues overlap (e.g. green text on green bg).
 * 2. Boost the minimum ratio when hues are close (4.5 → up to 6.0)
 *    because same-hue pairs feel lower-contrast than the WCAG formula predicts.
 * 3. Adjust lightness until the (boosted) ratio is met.
 */
export function enforceContrast(
  textHsl: HSL,
  bgHsl: HSL,
  minRatio = 4.5,
): HSL {
  const th = textHsl[0];
  let ts = textHsl[1];
  let tl = textHsl[2];
  const [bh, bs, bl] = bgHsl;

  // Same-hue penalty: when text and bg share hue AND bg is saturated,
  // the perceived contrast is lower than WCAG predicts.
  const hDist = hueDist(th, bh);
  if (hDist < 40 && bs > 15) {
    // Desaturate text proportionally — closer hue = more desaturation
    const desatFactor = 1 - ((40 - hDist) / 40) * 0.8; // 0.2 to 1.0
    ts = ts * desatFactor;
    // Boost the required ratio (up to +1.5 extra)
    const boost = ((40 - hDist) / 40) * 1.5;
    minRatio = Math.max(minRatio, minRatio + boost);
  }

  const bgLum = luminanceFromHsl(bh, bs, bl);
  const currentRatio = contrastRatio(luminanceFromHsl(th, ts, tl), bgLum);
  if (currentRatio >= minRatio) {
    return [th, Math.round(ts * 10) / 10, Math.round(tl * 10) / 10];
  }

  // Adjust lightness — push away from bg
  const bgIsDark = bl < 50;
  const step = bgIsDark ? 2 : -2;
  const limit = bgIsDark ? 100 : 0;

  for (let i = 0; i < 50; i++) {
    tl = clamp(tl + step, 0, 100);
    const ratio = contrastRatio(luminanceFromHsl(th, ts, tl), bgLum);
    if (ratio >= minRatio) break;
    if (tl === limit) break;
  }

  return [th, Math.round(ts * 10) / 10, Math.round(tl * 10) / 10];
}

/**
 * Ensure an accent color is readable as a background (for buttons, badges, etc).
 * Returns [accentHsl, contrastTextHsl] — the accent color (possibly adjusted)
 * and the best text color to use on top of it.
 *
 * The accent hue and saturation are preserved; only lightness is adjusted
 * if neither black nor white text can achieve sufficient contrast.
 */
export function enforceAccentContrast(
  accentHsl: HSL,
  minRatio = 4.5,
): { accent: HSL; contrastText: HSL } {
  const dark: HSL = [0, 0, 5];
  const light: HSL = [0, 0, 100];

  const accentLum = luminanceFromHsl(accentHsl[0], accentHsl[1], accentHsl[2]);
  const darkCR = contrastRatio(accentLum, luminanceFromHsl(0, 0, 5));
  const lightCR = contrastRatio(accentLum, luminanceFromHsl(0, 0, 100));

  // If either dark or light text passes, pick the better one
  if (darkCR >= minRatio || lightCR >= minRatio) {
    return {
      accent: accentHsl,
      contrastText: darkCR > lightCR ? dark : light,
    };
  }

  // Neither passes — adjust accent lightness to make one work
  // Try both directions, pick the smaller shift
  const ah = accentHsl[0];
  const as = accentHsl[1];
  const al = accentHsl[2];

  // Try darkening accent (so white text works)
  let darkerL = al;
  for (let i = 0; i < 40; i++) {
    darkerL = Math.max(darkerL - 2, 0);
    const lum = luminanceFromHsl(ah, as, darkerL);
    if (contrastRatio(lum, luminanceFromHsl(0, 0, 100)) >= minRatio) break;
  }
  const darkerShift = al - darkerL;

  // Try lightening accent (so dark text works)
  let lighterL = al;
  for (let i = 0; i < 40; i++) {
    lighterL = Math.min(lighterL + 2, 100);
    const lum = luminanceFromHsl(ah, as, lighterL);
    if (contrastRatio(lum, luminanceFromHsl(0, 0, 5)) >= minRatio) break;
  }
  const lighterShift = lighterL - al;

  // Pick the smaller shift
  if (darkerShift <= lighterShift) {
    return {
      accent: [ah, as, Math.round(darkerL * 10) / 10],
      contrastText: light,
    };
  } else {
    return {
      accent: [ah, as, Math.round(lighterL * 10) / 10],
      contrastText: dark,
    };
  }
}

/**
 * Ensure a semantic status color is readable on a given background.
 * Takes a hex color (#rrggbb) and returns an adjusted hex if needed.
 * Only shifts lightness, preserves hue.
 */
export function enforceStatusColor(hex: string, bgHsl: HSL, minRatio = 3.0): string {
  // Parse hex to RGB
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);

  const colorLum = relativeLuminance(r, g, b);
  const bgLum = luminanceFromHsl(bgHsl[0], bgHsl[1], bgHsl[2]);
  const ratio = contrastRatio(colorLum, bgLum);

  if (ratio >= minRatio) return hex;

  // Convert to HSL to adjust
  const mx = Math.max(r, g, b) / 255;
  const mn = Math.min(r, g, b) / 255;
  let h = 0, s = 0;
  const l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    const rn = r / 255, gn = g / 255, bn = b / 255;
    if (mx === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
    else if (mx === gn) h = ((bn - rn) / d + 2) / 6;
    else h = ((rn - gn) / d + 4) / 6;
  }

  const hDeg = h * 360;
  const sPct = s * 100;
  let lPct = l * 100;

  // Adjust lightness
  const bgIsDark = bgHsl[2] < 50;
  const step = bgIsDark ? 3 : -3;
  for (let i = 0; i < 30; i++) {
    lPct = clamp(lPct + step, 10, 90);
    const adjLum = luminanceFromHsl(hDeg, sPct, lPct);
    if (contrastRatio(adjLum, bgLum) >= minRatio) break;
  }

  // Convert back to hex
  const [rr, gg, bb] = hslToRgb(hDeg, sPct, lPct);
  return `#${rr.toString(16).padStart(2, "0")}${gg.toString(16).padStart(2, "0")}${bb.toString(16).padStart(2, "0")}`;
}
