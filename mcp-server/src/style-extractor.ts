/**
 * CSS design token extraction from websites.
 * Multi-strategy extraction with dark-theme preference and CSS-in-JS fallbacks.
 */

import { logger } from "./logger.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

type HSL = [number, number, number];

function hexToHsl(hex: string): HSL | null {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length === 8) h = h.slice(0, 6);
  if (h.length !== 6) return null;
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let hu = 0, s = 0;
  const l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === r) hu = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (mx === g) hu = ((b - r) / d + 2) / 6;
    else hu = ((r - g) / d + 4) / 6;
  }
  return [Math.round(hu * 360 * 10) / 10, Math.round(s * 1000) / 10, Math.round(l * 1000) / 10];
}

function parseColor(val: string): HSL | null {
  val = val.trim().toLowerCase();
  const hexMatch = val.match(/^#([0-9a-f]{3,8})$/);
  if (hexMatch) return hexToHsl(hexMatch[0]);
  const rgbMatch = val.match(/rgba?\(\s*(\d+)\s*[,\s]\s*(\d+)\s*[,\s]\s*(\d+)/);
  if (rgbMatch) {
    const r = parseInt(rgbMatch[1]) / 255, g = parseInt(rgbMatch[2]) / 255, b = parseInt(rgbMatch[3]) / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    let hu = 0, s = 0;
    const l = (mx + mn) / 2;
    if (mx !== mn) {
      const d = mx - mn;
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      if (mx === r) hu = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if (mx === g) hu = ((b - r) / d + 2) / 6;
      else hu = ((r - g) / d + 4) / 6;
    }
    return [Math.round(hu * 360 * 10) / 10, Math.round(s * 1000) / 10, Math.round(l * 1000) / 10];
  }
  const hslMatch = val.match(/hsla?\(\s*([\d.]+)(?:deg)?\s*[,\s]\s*([\d.]+)%?\s*[,\s]\s*([\d.]+)%?/);
  if (hslMatch) return [parseFloat(hslMatch[1]), parseFloat(hslMatch[2]), parseFloat(hslMatch[3])];
  return null;
}

function px(val: string): number | null {
  const m = val.trim().match(/([\d.]+)\s*(?:px|rem|em)?/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (val.includes("rem") || val.includes("em")) n *= 16;
  return n;
}

async function fetchUrl(url: string, timeout = 10000, extraHeaders?: Record<string, string>): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        ...extraHeaders,
      },
      signal: ctrl.signal,
      redirect: "follow",
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    return text.slice(0, 512 * 1024); // 512KB max
  } finally {
    clearTimeout(timer);
  }
}

function findVar(
  varColors: Map<string, HSL>,
  keywords: string[],
  exclude: string[] = [],
  preferDark = true,
): HSL | null {
  const candidates: [string, HSL][] = [];
  for (const [name, hsl] of varColors) {
    const nl = name.toLowerCase();
    if (exclude.some((ex) => nl.includes(ex))) continue;
    if (keywords.some((kw) => nl.includes(kw))) candidates.push([name, hsl]);
  }
  if (candidates.length === 0) return null;
  if (preferDark) {
    const dark = candidates.filter(([, v]) => v[2] < 15);
    if (dark.length > 0) return [...dark[0][1]] as HSL;
  }
  return [...candidates[0][1]] as HSL;
}

const rnd = (v: HSL): HSL => [
  Math.round(v[0] * 10) / 10,
  Math.round(v[1] * 10) / 10,
  Math.round(v[2] * 10) / 10,
];

/**
 * Extract CSS variables from a CSS block, returning name→HSL pairs.
 */
function extractVarColors(css: string): Map<string, HSL> {
  const varColors = new Map<string, HSL>();
  for (const m of css.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\b/g)) {
    const c = parseColor(m[2]);
    if (c) varColors.set(m[1], c);
  }
  for (const m of css.matchAll(/(--[\w-]+)\s*:\s*(rgba?\([^)]+\))/g)) {
    const c = parseColor(m[2]);
    if (c) varColors.set(m[1], c);
  }
  for (const m of css.matchAll(/(--[\w-]+)\s*:\s*(hsla?\([^)]+\))/g)) {
    const c = parseColor(m[2]);
    if (c) varColors.set(m[1], c);
  }
  return varColors;
}

/**
 * Extract CSS content from dark-mode-specific media queries and selectors.
 * Returns { darkCss, lightCss } where lightCss has dark sections removed.
 */
function splitDarkLightCss(css: string): { darkCss: string; lightCss: string } {
  const darkParts: string[] = [];
  // Track ranges to remove from CSS to create "light" version
  const darkRanges: [number, number][] = [];

  // @media (prefers-color-scheme: dark) { ... }
  const mediaPattern = /@media\s*\([^)]*prefers-color-scheme\s*:\s*dark[^)]*\)\s*\{/gi;
  let match;
  while ((match = mediaPattern.exec(css)) !== null) {
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      i++;
    }
    if (depth === 0) {
      darkParts.push(css.slice(start, i - 1));
      darkRanges.push([match.index, i]);
    }
  }

  // [data-theme="dark"], [data-color-mode="dark"], .dark, html.dark, :root.dark
  // Also: Wikipedia uses html.skin-theme-clientpref-night, some use .night, .dark-mode
  const selectorPatterns = [
    /\[data-(?:theme|color-mode|color-scheme|mode)\s*=\s*["']dark["']\]\s*\{([^}]+)\}/gi,
    /(?:html|:root|body)?\.dark\s*\{([^}]+)\}/gi,
    /\.theme-dark\s*\{([^}]+)\}/gi,
    /\[data-dark-theme(?:=["'][^"']*["'])?\]\s*\{([^}]+)\}/gi,
    /\.(?:dark-mode|darkmode|night|skin-theme-clientpref-night|color-scheme-dark)\s*\{([^}]+)\}/gi,
    /(?:html|:root)\.(?:skin-theme-clientpref-night|dark-theme|nightmode)\s*\{([^}]+)\}/gi,
  ];
  for (const pat of selectorPatterns) {
    for (const m of css.matchAll(pat)) {
      darkParts.push(m[1] || m[0]);
      if (m.index !== undefined) {
        darkRanges.push([m.index, m.index + m[0].length]);
      }
    }
  }

  // Build lightCss by removing dark ranges
  if (darkRanges.length === 0) {
    return { darkCss: darkParts.join("\n"), lightCss: css };
  }
  darkRanges.sort((a, b) => a[0] - b[0]);
  const lightParts: string[] = [];
  let pos = 0;
  for (const [start, end] of darkRanges) {
    if (start > pos) lightParts.push(css.slice(pos, start));
    pos = end;
  }
  if (pos < css.length) lightParts.push(css.slice(pos));

  return { darkCss: darkParts.join("\n"), lightCss: lightParts.join("") };
}

/**
 * Detect if the HTML indicates a dark theme preference from the server.
 */
function detectServerDarkHints(html: string): boolean {
  // Check <html> attributes for dark theme indicators
  const htmlTag = html.match(/<html[^>]*>/i)?.[0] || "";
  const darkIndicators = [
    /data-(?:theme|color-mode|color-scheme|mode)\s*=\s*["']dark["']/i,
    /class\s*=\s*["'][^"']*\bdark\b[^"']*["']/i,
    /data-dark/i,
    /style\s*=\s*["'][^"']*(?:background|bg)\s*:\s*(?:#[0-2][0-9a-f]{5}|#[01][0-9a-f]{2}|rgb\(\s*[0-3]\d)/i,
  ];
  for (const pat of darkIndicators) {
    if (pat.test(htmlTag)) return true;
  }

  // Check <body> for dark class
  const bodyTag = html.match(/<body[^>]*>/i)?.[0] || "";
  if (/class\s*=\s*["'][^"']*\bdark\b[^"']*["']/i.test(bodyTag)) return true;

  return false;
}

/**
 * Scan HTML for JSON-LD, inline <script> data, or data attributes that embed brand colors.
 * Many modern sites (especially CSS-in-JS) embed theme config in JSON.
 */
function extractColorsFromScripts(html: string): HSL[] {
  const colors: HSL[] = [];

  // Look for theme/brand color in JSON-like structures in <script> tags
  // e.g. "primaryColor":"#1DB954" or "brand_color": "#FF0000"
  const colorPatterns = [
    /["'](?:primary|brand|accent|theme|main)[-_]?(?:color|Color|colour)["']\s*[:=]\s*["'](#[0-9a-fA-F]{3,6})["']/g,
    /["'](?:color|Color)["']\s*:\s*["'](#[0-9a-fA-F]{6})["']/g,
  ];
  for (const pat of colorPatterns) {
    for (const m of html.matchAll(pat)) {
      const c = parseColor(m[1] || m[2]);
      if (c && c[1] > 30 && c[2] > 15 && c[2] < 85) colors.push(c);
    }
  }

  return colors;
}

/**
 * Extract accent color from commonly-used CSS class patterns.
 * Modern CSS frameworks often use utility classes or component classes
 * that reference brand colors even without CSS variables.
 */
function extractFromClassPatterns(css: string): HSL | null {
  // Button/CTA colors — often the primary brand color
  const btnPatterns = [
    /\.(?:btn|button|cta)[-_]?(?:primary|main|brand)[^{]*\{[^}]*(?:background(?:-color)?|bg)\s*:\s*([^;}\n]+)/gi,
    /\.(?:bg|background)-(?:primary|brand|main|accent)[^{]*\{[^}]*(?:background(?:-color)?)\s*:\s*([^;}\n]+)/gi,
    /a\s*\{[^}]*color\s*:\s*([^;}\n]+)/gi,
  ];
  for (const pat of btnPatterns) {
    for (const m of css.matchAll(pat)) {
      const c = parseColor(m[1].trim());
      if (c && c[1] > 35 && c[2] > 20 && c[2] < 80) return c;
    }
  }
  return null;
}

export async function extractStyle(url: string): Promise<Record<string, unknown>> {
  const html = await fetchUrl(url);

  // Detect server-side dark hints before CSS analysis
  const serverHintsDark = detectServerDarkHints(html);

  // Collect inline CSS
  const cssParts: string[] = [];
  for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    cssParts.push(m[1]);
  }

  // Fetch linked stylesheets (max 4, prefer dark)
  const linkMatches = [...html.matchAll(/href=["']([^"']+\.css[^"']*?)["']/gi)].map((m) => m[1]);
  const darkLinks = linkMatches.filter((l) => l.toLowerCase().includes("dark") && !l.toLowerCase().includes("high_contrast"));
  const otherLinks = linkMatches.filter((l) => !darkLinks.includes(l) && !l.toLowerCase().includes("light"));
  const fetchLinks = [...darkLinks, ...otherLinks].slice(0, 4);

  for (const href of fetchLinks) {
    const absUrl = new URL(href, url).href;
    try {
      cssParts.push(await fetchUrl(absUrl, 5000));
    } catch { /* skip */ }
  }

  const allCss = cssParts.join("\n");

  // ─── DARK / LIGHT CSS SEPARATION ─────────────────────────────────────────
  // Split CSS into light (default) and dark sections.
  // This prevents dark-mode overrides from polluting default theme extraction.
  const { darkCss, lightCss } = splitDarkLightCss(allCss);
  const darkVarColors = extractVarColors(darkCss);
  const hasDarkCss = darkVarColors.size > 3;

  // Extract vars from light CSS only (dark overrides stripped out)
  const allVarColors = extractVarColors(lightCss);

  // We'll determine which var set to use AFTER theme detection.
  // For now, extract tokens from both and decide later.
  // Start with allVarColors for initial extraction (the "default" theme).
  const findVarFrom = (source: Map<string, HSL>, kw: string[], exc: string[] = [], prefDark = true): HSL | null => {
    return findVar(source, kw, exc, prefDark);
  };
  // Helper: search allVarColors first (default theme), not dark vars
  const findVarDefault = (kw: string[], exc: string[] = [], prefDark = true): HSL | null => {
    return findVarFrom(allVarColors, kw, exc, prefDark);
  };

  let bg = findVarDefault(
    ["bg-primary", "bg-default", "background-default", "bg-page", "bgColor-default", "bg-main", "bg-canvas", "color-canvas-default", "color-bg-default"],
    ["hover", "active", "disabled"],
  );
  // Sanity: a real background should be very light or very dark, not vivid/mid
  if (bg && bg[1] > 25 && bg[2] > 25 && bg[2] < 75) bg = null;
  let surface = findVarDefault(
    ["bg-secondary", "bg-subtle", "surface", "card-bg", "bgColor-muted", "bg-overlay", "color-canvas-subtle"],
    ["hover", "active", "border", "text"],
  );
  let accent = findVarDefault(
    ["accent", "primary", "brand", "link-primary", "focus", "btn-primary", "color-accent", "button-primary", "cta", "color-accent-fg", "color-btn-primary-bg"],
    ["text", "bg-primary", "foreground", "muted", "disabled", "hover", "pressed"],
    false,
  );
  let textColor = findVarDefault(
    ["text-primary", "foreground-default", "text-default", "fgColor-default", "color-fg", "textColor", "color-fg-default"],
    ["secondary", "muted", "bg", "border"],
  );
  let text2Color = findVarDefault(
    ["text-secondary", "text-tertiary", "foreground-muted", "fgColor-muted", "text-muted", "text-subtle", "color-fg-muted"],
    ["bg", "border"],
  );
  let borderColor = findVarDefault(
    ["border-primary", "border-default", "borderColor-default", "color-border", "border-muted", "color-border-default", "color-border-muted"],
    ["text", "bg", "focus", "radius"],
  );

  // Strategy 1b: <meta name="theme-color"> — very reliable brand signal.
  // Even if we found an accent from vars, prefer theme-color if the var-accent
  // looks like a fallback (low saturation or default blue hue).
  {
    const themeColor = html.match(/<meta[^>]*name=["']theme-color["'][^>]*content=["']([^"']+)["']/i)
      ?? html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']theme-color["']/i);
    if (themeColor) {
      const c = parseColor(themeColor[1]);
      if (c && c[1] > 15 && c[2] > 10 && c[2] < 90) {
        // Use theme-color if we have no accent OR current accent is weak
        if (!accent || accent[1] < 35 || (accent[0] < 5 && accent[1] < 60)) {
          accent = c;
        }
      }
    }
  }

  // Strategy 1c: msapplication-TileColor
  if (!accent) {
    const msApp = html.match(/<meta[^>]*name=["']msapplication-TileColor["'][^>]*content=["']([^"']+)["']/i);
    if (msApp) {
      const c = parseColor(msApp[1]);
      if (c && c[1] > 15) accent = c;
    }
  }

  // Strategy 1d: Colors from JSON-LD / inline scripts (CSS-in-JS sites)
  if (!accent) {
    const scriptColors = extractColorsFromScripts(html);
    if (scriptColors.length > 0) {
      // Pick most saturated
      scriptColors.sort((a, b) => b[1] - a[1]);
      accent = scriptColors[0];
    }
  }

  // Strategy 2: direct property values from body/html (use lightCss to avoid dark overrides)
  if (!bg) {
    const bodyBg = lightCss.match(/(?:body|html|:root)\s*\{[^}]*background(?:-color)?\s*:\s*([^;}\n]+)/i);
    if (bodyBg) {
      const v = bodyBg[1].trim();
      if (v.startsWith("var(")) {
        const varName = v.match(/var\(\s*(--[\w-]+)/);
        if (varName && allVarColors.has(varName[1])) {
          const candidate = [...allVarColors.get(varName[1])!] as [number, number, number];
          // Same sanity check: reject vivid mid-range colors as bg
          if (!(candidate[1] > 25 && candidate[2] > 25 && candidate[2] < 75)) {
            bg = candidate;
          }
        }
      } else {
        const c = parseColor(v);
        if (c && !(c[1] > 25 && c[2] > 25 && c[2] < 75)) bg = c;
      }
    }
  }

  // Strategy 2b: scan inline style= attributes in HTML for accent colors
  if (!accent) {
    const inlineColors: HSL[] = [];
    for (const m of html.matchAll(/style=["'][^"']*(?:background(?:-color)?|color)\s*:\s*([^;"']+)/gi)) {
      const c = parseColor(m[1].trim());
      if (c && c[1] > 35 && c[2] > 20 && c[2] < 80) inlineColors.push(c);
    }
    inlineColors.sort((a, b) => b[1] - a[1]);
    if (inlineColors.length > 0) accent = inlineColors[0];
  }

  // Strategy 2c: extract from CSS class patterns (button, CTA, link colors)
  if (!accent) {
    accent = extractFromClassPatterns(allCss);
  }

  // Strategy 2d: find SVG fill/stroke colors (logos, icons — often brand colors)
  if (!accent) {
    const svgColors: HSL[] = [];
    for (const m of html.matchAll(/(?:fill|stroke)=["']#([0-9a-fA-F]{6})["']/gi)) {
      const c = hexToHsl("#" + m[1]);
      if (c && c[1] > 40 && c[2] > 20 && c[2] < 80) svgColors.push(c);
    }
    // Also check fill/stroke in style attributes within SVG
    for (const m of html.matchAll(/(?:fill|stroke)\s*:\s*#([0-9a-fA-F]{6})/gi)) {
      const c = hexToHsl("#" + m[1]);
      if (c && c[1] > 40 && c[2] > 20 && c[2] < 80) svgColors.push(c);
    }
    const freq = new Map<string, { count: number; hsl: HSL }>();
    for (const c of svgColors) {
      const key = `${Math.round(c[0] / 15) * 15},${Math.round(c[1] / 10) * 10}`;
      const existing = freq.get(key);
      if (existing) existing.count++;
      else freq.set(key, { count: 1, hsl: c });
    }
    let best: HSL | null = null;
    let bestCount = 0;
    for (const v of freq.values()) {
      if (v.count > bestCount) { bestCount = v.count; best = v.hsl; }
    }
    if (best) accent = best;
  }

  if (!accent) {
    // Strategy 3: most saturated CSS var (from ALL vars, not just dark)
    const satColors = [...allVarColors.entries()]
      .filter(([, v]) => v[1] > 40 && v[2] > 25 && v[2] < 75)
      .sort((a, b) => b[1][1] - a[1][1]);
    if (satColors.length > 0) accent = satColors[0][1];
  }

  if (!accent) {
    // Strategy 4: scan ALL hex+rgb colors in CSS+HTML
    const vivid: HSL[] = [];
    for (const m of (allCss + "\n" + html).matchAll(/#([0-9a-fA-F]{6})\b/g)) {
      const c = hexToHsl("#" + m[1]);
      if (c && c[1] > 35 && c[2] > 20 && c[2] < 80) vivid.push(c);
    }
    for (const m of (allCss + "\n" + html).matchAll(/rgba?\(\s*(\d+)\s*[,\s]\s*(\d+)\s*[,\s]\s*(\d+)/g)) {
      const c = parseColor(`rgb(${m[1]},${m[2]},${m[3]})`);
      if (c && c[1] > 35 && c[2] > 20 && c[2] < 80) vivid.push(c);
    }
    // Count frequency (group by hue bucket)
    const freq = new Map<string, { count: number; hsl: HSL }>();
    for (const c of vivid) {
      const key = `${Math.round(c[0] / 15) * 15}`;
      const existing = freq.get(key);
      if (existing) { existing.count++; if (c[1] > existing.hsl[1]) existing.hsl = c; }
      else freq.set(key, { count: 1, hsl: c });
    }
    let best: HSL | null = null;
    let bestScore = 0;
    for (const v of freq.values()) {
      const score = v.count * v.hsl[1]; // frequency × saturation
      if (score > bestScore) { bestScore = score; best = v.hsl; }
    }
    if (best) accent = best;
  }

  // ─── THEME DETECTION ─────────────────────────────────────────────────────
  // Strategy: detect the DEFAULT theme first, then decide if dark-mode
  // vars should be used instead.
  //
  // "hasDarkCss" means the site SUPPORTS dark mode, NOT that it IS dark.
  // Only use dark vars when server explicitly renders dark (HTML attributes)
  // or when the default bg is already dark.

  const accentIsFallback = !accent || (accent[1] < 25) || (accent[0] < 5 && accent[1] < 60);

  if (!bg) bg = [0, 0, 95];
  if (!surface) surface = [bg[0], Math.min(bg[1] + 2, 15), Math.max(bg[2] - 5, 5)];
  if (!accent) accent = [211, 100, 50];
  if (!textColor) textColor = [0, 0, 15];
  if (!text2Color) text2Color = [textColor[0], Math.min(textColor[1], 10), 50];
  if (!borderColor) borderColor = [bg[0], Math.min(bg[1], 15), 80];

  // Theme detection: the default bg lightness is the primary signal.
  // serverHintsDark is a strong override (server explicitly sent dark HTML).
  // hasDarkCss alone is NOT sufficient — it just means the site supports dark mode.
  let isDark: boolean;

  if (serverHintsDark) {
    // Server explicitly rendered dark (class="dark", data-theme="dark" on <html>/<body>)
    isDark = true;

    // Re-extract tokens from dark CSS vars if available
    if (hasDarkCss) {
      const darkBg = findVarFrom(darkVarColors,
        ["bg-primary", "bg-default", "background-default", "bg-page", "bgColor-default", "bg-main", "bg-canvas", "color-canvas-default", "color-bg-default"],
        ["hover", "active", "disabled"],
      );
      if (darkBg) bg = darkBg;
      const darkSurface = findVarFrom(darkVarColors,
        ["bg-secondary", "bg-subtle", "surface", "card-bg", "bgColor-muted", "color-canvas-subtle"],
        ["hover", "active", "border", "text"],
      );
      if (darkSurface) surface = darkSurface;
      const darkText = findVarFrom(darkVarColors,
        ["text-primary", "foreground-default", "text-default", "fgColor-default", "color-fg", "color-fg-default"],
        ["secondary", "muted", "bg", "border"],
      );
      if (darkText) textColor = darkText;
      const darkBorder = findVarFrom(darkVarColors,
        ["border-primary", "border-default", "borderColor-default", "color-border", "border-muted", "color-border-default"],
        ["text", "bg", "focus", "radius"],
      );
      if (darkBorder) borderColor = darkBorder;
    }
  } else {
    // No server hint → use the bg lightness we already extracted
    isDark = bg[2] < 50;
  }

  // ─── NORMALIZATION ──────────────────────────────────────────────────────
  if (isDark) {
    bg[2] = Math.min(bg[2], 12); bg[1] = Math.min(bg[1], 20);
    surface[2] = Math.min(surface[2], 18); surface[1] = Math.min(surface[1], 20);
    if (textColor[2] < 75) textColor[2] = 90;
    textColor[1] = Math.min(textColor[1], 10);
    if (text2Color[2] < 35) text2Color[2] = 50;
    borderColor[2] = Math.min(Math.max(borderColor[2], 14), 25);
  } else {
    bg[2] = Math.max(bg[2], 92); bg[1] = Math.min(bg[1], 8);
    surface[2] = Math.max(surface[2], 88); surface[1] = Math.min(surface[1], 10);
    if (textColor[2] > 50) textColor[2] = 15;
    textColor[1] = Math.min(textColor[1], 10);
    if (text2Color[2] > 60) text2Color[2] = 45;
    if (text2Color[2] < 30) text2Color[2] = 42;
    text2Color[1] = Math.min(text2Color[1], 10);
    borderColor = [bg[0], Math.min(borderColor[1], 8), Math.min(borderColor[2], 85)];
    if (borderColor[2] > 90) borderColor[2] = 82;
  }

  // Accent vivid
  if (accent[1] < 40) accent[1] = 55;
  if (isDark) {
    if (accent[2] < 30) accent[2] = 45;
    if (accent[2] > 70) accent[2] = 60;
  } else {
    if (accent[2] > 60) accent[2] = 50;
    if (accent[2] < 25) accent[2] = 40;
  }

  // ─── TYPOGRAPHY ─────────────────────────────────────────────────────────
  const SKIP_FONTS = new Set(["inherit", "initial", "unset", "revert", "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "-apple-system", "<value>", "small", "medium", "large", "wide", "narrow", "huge", "normal", "none"]);
  const cleanFont = (f: string): string | null => {
    const first = f.split(",")[0].trim().replace(/['"]/g, "");
    if (first.startsWith("var(") || first.length < 3 || SKIP_FONTS.has(first.toLowerCase()) || first.includes("fallback") || first.includes("icon") || first.includes("webflow")) return null;
    // Skip font names that are clearly CSS symbol/icon fonts
    if (/symbol|icon|glyph|material\s*symbols|fontawesome|fa-/i.test(first)) return null;
    return first;
  };

  let fontFamily = "system-ui, -apple-system, sans-serif";

  // Strategy A: body font-family first (most reliable), then html, then :root
  const fontSelectors = [
    /body\s*\{[^}]*font-family:\s*([^;}\n]+)/i,
    /html\s*\{[^}]*font-family:\s*([^;}\n]+)/i,
    /:root\s*\{[^}]*font-family:\s*([^;}\n]+)/i,
  ];
  for (const pat of fontSelectors) {
    if (fontFamily !== "system-ui, -apple-system, sans-serif") break;
    const fontMatch = allCss.match(pat);
    if (fontMatch) {
      const f = cleanFont(fontMatch[1]);
      if (f) fontFamily = f;
    }
  }

  // Strategy B: CSS variable --font-body or --font-family
  if (fontFamily === "system-ui, -apple-system, sans-serif") {
    for (const m of allCss.matchAll(/(--(?:font[-_]?(?:family|body|sans|text|base)|ff-body|typeface))\s*:\s*([^;}\n]+)/gi)) {
      const f = cleanFont(m[2]);
      if (f) { fontFamily = f; break; }
    }
  }

  // Strategy C: if still generic, use most frequent non-generic font (excluding icon fonts)
  if (fontFamily === "system-ui, -apple-system, sans-serif") {
    const fontCounts = new Map<string, number>();
    for (const m of allCss.matchAll(/font-family\s*:\s*([^;}\n]+)/gi)) {
      const f = cleanFont(m[1]);
      if (f) fontCounts.set(f, (fontCounts.get(f) ?? 0) + 1);
    }
    let bestFont = "";
    let bestCount = 0;
    for (const [f, c] of fontCounts) {
      if (c > bestCount) { bestCount = c; bestFont = f; }
    }
    if (bestFont) fontFamily = bestFont;
  }

  // Strategy D: @font-face declarations — often reveal the primary brand font
  if (fontFamily === "system-ui, -apple-system, sans-serif") {
    const fontFaces: Map<string, number> = new Map();
    for (const m of allCss.matchAll(/@font-face\s*\{[^}]*font-family\s*:\s*["']?([^"';\n}]+)["']?/gi)) {
      const name = m[1].trim();
      if (name.length > 2 && !SKIP_FONTS.has(name.toLowerCase()) && !/icon|symbol|glyph/i.test(name)) {
        fontFaces.set(name, (fontFaces.get(name) ?? 0) + 1);
      }
    }
    // Pick the one with most weight variants (likely the body font)
    let bestFont = "";
    let bestCount = 0;
    for (const [f, c] of fontFaces) {
      if (c > bestCount) { bestCount = c; bestFont = f; }
    }
    if (bestFont) fontFamily = bestFont;
  }

  const fontSizes = [...allCss.matchAll(/font-size\s*:\s*([\d.]+\s*(?:px|rem|em))/gi)]
    .map((m) => px(m[1]))
    .filter((s): s is number => s !== null && s > 8 && s < 80)
    .sort((a, b) => a - b);
  const headingSize = fontSizes.length > 0 ? Math.min(Math.max(Math.round(fontSizes[fontSizes.length - 1]), 18), 42) : 24;
  const bodySize = fontSizes.length > 2 ? Math.min(Math.max(Math.round(fontSizes[Math.floor(fontSizes.length / 4)]), 12), 18) : 14;

  const weights = [...allCss.matchAll(/font-weight\s*:\s*(\d{3,4})/gi)].map((m) => parseInt(m[1]));
  const headingWeight = weights.length > 0 ? Math.max(...weights) : 700;

  const radii = [...allCss.matchAll(/border-radius\s*:\s*([\d.]+\s*(?:px|rem|em))/gi)]
    .map((m) => px(m[1]))
    .filter((r): r is number => r !== null && r >= 0 && r <= 50);
  const radius = radii.length > 0 ? Math.round(radii.reduce((a, b) => a + b, 0) / radii.length) : 8;

  const bws = [...allCss.matchAll(/border(?:-width)?\s*:\s*([\d.]+\s*px)/gi)]
    .map((m) => px(m[1]))
    .filter((b): b is number => b !== null && b >= 0 && b <= 8);
  const borderWidth = bws.length > 0 ? Math.round((bws.reduce((a, b) => a + b, 0) / bws.length) * 10) / 10 : 1;

  const shadows = [...allCss.matchAll(/box-shadow\s*:\s*([^;}\n]+)/gi)];
  const elevation = shadows.length > 0 ? Math.min(70, 20 + shadows.filter((s) => /\d{2,}px/.test(s[1])).length * 8) : 25;

  const lhs = [...allCss.matchAll(/line-height\s*:\s*([\d.]+)/gi)]
    .map((m) => parseFloat(m[1]))
    .filter((v) => v >= 1.0 && v <= 2.5);
  const lineHeight = lhs.length > 0 ? Math.round((lhs.reduce((a, b) => a + b, 0) / lhs.length) * 100) / 100 : 1.5;

  // og:image
  const ogMatch = html.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i)
    ?? html.match(/content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
  let ogImage = ogMatch?.[1]?.replace(/&amp;/g, "&") ?? null;
  if (ogImage?.startsWith("/")) ogImage = new URL(ogImage, url).href;

  // Favicon URL (for client-side color extraction fallback)
  const iconMatch = html.match(/<link[^>]*rel=["'](?:icon|shortcut icon|apple-touch-icon)["'][^>]*href=["']([^"']+)["']/i)
    ?? html.match(/<link[^>]*href=["']([^"']+)["'][^>]*rel=["'](?:icon|shortcut icon|apple-touch-icon)["']/i);
  let faviconUrl = iconMatch?.[1] ?? null;
  if (faviconUrl?.startsWith("/")) faviconUrl = new URL(faviconUrl, url).href;
  if (!faviconUrl) {
    const domain = new URL(url).hostname;
    faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=256`;
  }

  logger.info("style-extractor", `Extracted style from ${url}`, { isDark, accent: rnd(accent), accentIsFallback });

  return {
    bg: rnd(bg), surface: rnd(surface), accent: rnd(accent),
    text: rnd(textColor), text2: rnd(text2Color), border: rnd(borderColor),
    headingSize, headingWeight, bodySize, bodyWeight: 400, lineHeight,
    gridCols: 3, gap: 16, padding: Math.max(12, Math.min(24, Math.round(radius * 1.2))),
    radius, borderWidth, elevation,
    fontFamily, ogImage, faviconUrl, accentIsFallback, isDark,
    name: "Extracted",
  };
}
