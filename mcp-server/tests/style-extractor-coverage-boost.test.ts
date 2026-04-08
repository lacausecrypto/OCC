/**
 * Additional coverage tests for style-extractor.ts
 *
 * Targets uncovered lines: gradient extraction, font detection edge cases,
 * color palette parsing, error handling for malformed CSS, extractStyle
 * with various HTML inputs, parseColorFromRgb, headless fallback path,
 * and extractStyleHeadless browser integration.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock logger to avoid noisy output
vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function html(opts: {
  styles?: string;
  meta?: string;
  body?: string;
  links?: string[];
  htmlAttrs?: string;
  bodyAttrs?: string;
  scripts?: string;
} = {}): string {
  const linkTags = (opts.links ?? []).map((l) => `<link rel="stylesheet" href="${l}">`).join("\n");
  return `<!DOCTYPE html>
<html ${opts.htmlAttrs ?? ""}>
<head>
  ${opts.meta ?? ""}
  ${linkTags}
  <style>${opts.styles ?? ""}</style>
</head>
<body ${opts.bodyAttrs ?? ""}>
  ${opts.body ?? "<p>Hello</p>"}
  ${opts.scripts ?? ""}
</body>
</html>`;
}

function mockFetch(primaryHtml: string, cssMap: Record<string, string> = {}) {
  return vi.fn(async (url: string) => {
    const text = cssMap[url] ?? primaryHtml;
    return {
      ok: true,
      status: 200,
      text: async () => text,
    };
  });
}

let extractStyle: (url: string) => Promise<Record<string, unknown>>;

beforeEach(async () => {
  vi.restoreAllMocks();
  const mod = await import("../src/style-extractor.js");
  extractStyle = mod.extractStyle;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// CSS gradient extraction
// ---------------------------------------------------------------------------
describe("CSS gradient edge cases", () => {
  it("handles linear-gradient background without crashing", async () => {
    const styles = `
      body { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
      :root { --accent: #667eea; }
    `;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res).toBeDefined();
    expect(res.accent).toBeDefined();
  });

  it("handles radial-gradient background", async () => {
    const styles = `
      body { background: radial-gradient(circle, #ff0000, #0000ff); }
    `;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res).toBeDefined();
    expect(res.bg).toBeDefined();
  });

  it("handles conic-gradient background", async () => {
    const styles = `
      .hero { background: conic-gradient(from 90deg, #ff0000, #00ff00, #0000ff); }
    `;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Font detection edge cases
// ---------------------------------------------------------------------------
describe("Font detection edge cases", () => {
  it("extracts font from :root rule when body and html have none", async () => {
    const styles = `:root { font-family: "Fira Code", monospace; }`;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.fontFamily).toBe("Fira Code");
  });

  it("skips var() references in font-family (falls back to CSS var extraction)", async () => {
    const styles = `
      :root { --ff-body: "Montserrat"; }
      body { font-family: var(--ff-body), sans-serif; }
    `;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.fontFamily).toBe("Montserrat");
  });

  it("skips generic font names (inherit, initial, unset)", async () => {
    const styles = `
      body { font-family: inherit; }
      html { font-family: initial; }
    `;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    // Should use fallback strategy, not "inherit"
    expect(res.fontFamily).not.toBe("inherit");
    expect(res.fontFamily).not.toBe("initial");
  });

  it("handles font-family with multiple quoted names", async () => {
    const styles = `body { font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif; }`;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.fontFamily).toBe("Segoe UI");
  });

  it("picks most frequent @font-face when no other font source", async () => {
    const styles = `
      @font-face { font-family: "WorkSans"; src: url(ws-400.woff2); }
      @font-face { font-family: "WorkSans"; src: url(ws-600.woff2); }
      @font-face { font-family: "WorkSans"; src: url(ws-700.woff2); }
      @font-face { font-family: "JetBrains Mono"; src: url(jb.woff2); }
    `;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.fontFamily).toBe("WorkSans");
  });

  it("uses CSS variable --font-body for font extraction", async () => {
    const styles = `
      :root { --font-body: "Source Sans Pro"; }
      body { font-family: var(--font-body); }
    `;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.fontFamily).toBe("Source Sans Pro");
  });

  it("uses CSS variable --typeface for font extraction", async () => {
    const styles = `
      :root { --typeface: "Playfair Display"; }
    `;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.fontFamily).toBe("Playfair Display");
  });
});

// ---------------------------------------------------------------------------
// Color palette and var extraction
// ---------------------------------------------------------------------------
describe("Color palette and var extraction", () => {
  it("extracts HSL variables from CSS", async () => {
    const styles = `
      :root {
        --bg-primary: hsl(0, 0%, 100%);
        --text-primary: hsl(0, 0%, 10%);
        --accent: hsl(210, 100%, 50%);
        --border-primary: hsl(0, 0%, 80%);
      }
    `;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.bg).toBeDefined();
    expect(res.text).toBeDefined();
    expect(res.accent).toBeDefined();
    const acc = res.accent as number[];
    expect(acc[0]).toBeCloseTo(210, 0);
  });

  it("extracts rgba variables", async () => {
    const styles = `
      :root {
        --accent: rgba(255, 99, 71, 1);
        --bg-primary: rgba(255, 255, 255, 1);
        --text-primary: rgba(0, 0, 0, 1);
      }
    `;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    const acc = res.accent as number[];
    expect(acc[1]).toBeGreaterThan(40);
  });

  it("extracts surface color from bg-secondary variable", async () => {
    const styles = `
      :root {
        --bg-primary: #ffffff;
        --bg-secondary: #f0f0f0;
        --text-primary: #111111;
        --accent: #0066ff;
      }
    `;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.surface).toBeDefined();
    const surface = res.surface as number[];
    expect(surface[2]).toBeGreaterThan(85);
  });

  it("extracts border color from border-default variable", async () => {
    const styles = `
      :root {
        --bg-primary: #ffffff;
        --border-default: #cccccc;
        --text-primary: #111111;
      }
    `;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.border).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Dark mode with dark CSS vars
// ---------------------------------------------------------------------------
describe("Dark mode var re-extraction", () => {
  it("re-extracts dark CSS vars when server hints dark + dark CSS available", async () => {
    const styles = `
      :root {
        --bg-primary: #ffffff;
        --bg-secondary: #f5f5f5;
        --text-primary: #111111;
        --border-primary: #cccccc;
        --accent: #0066ff;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg-primary: #0a0a0a;
          --bg-secondary: #1a1a1a;
          --text-primary: #eeeeee;
          --border-primary: #333333;
          --accent: #4488ff;
        }
      }
    `;
    const page = html({ htmlAttrs: 'data-theme="dark"', styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.isDark).toBe(true);
    // bg should be dark (low lightness)
    const bg = res.bg as number[];
    expect(bg[2]).toBeLessThan(15);
  });

  it("detects dark via [data-color-mode='dark'] selector patterns", async () => {
    const styles = `
      :root { --bg-primary: #ffffff; --text-primary: #111; --accent: #0066ff; }
      [data-color-mode="dark"] { --bg-primary: #0d1117; --text-primary: #f0f6fc; }
    `;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    // No server hints -> should be light
    expect(res.isDark).toBe(false);
  });

  it("detects dark via .dark-mode selector", async () => {
    const styles = `
      :root { --bg-primary: #ffffff; --text-primary: #111; --accent: #ff0000; }
      .dark-mode { --bg-primary: #111111; --text-primary: #ffffff; }
    `;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    // No server hints -> light
    expect(res.isDark).toBe(false);
  });

  it("detects dark via body dark class as server hint", async () => {
    const styles = `
      :root { --accent: #ff5500; --bg-primary: #111; --text-primary: #eee; }
    `;
    const page = html({ bodyAttrs: 'class="dark-theme dark"', styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.isDark).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tailwind dark: detection
// ---------------------------------------------------------------------------
describe("Tailwind dark mode detection", () => {
  it("detects dark-first design from heavy dark: prefix usage", async () => {
    const darkPrefixes = Array(25).fill('dark:bg-gray-900').join(' ');
    const page = html({
      body: `<div class="${darkPrefixes}">Content</div>`,
      styles: `:root { --bg-primary: #0a0a0a; --text-primary: #eee; --accent: #00ff88; }`,
    });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.isDark).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// meta theme-color with dark media query
// ---------------------------------------------------------------------------
describe("meta theme-color with dark media query", () => {
  it("uses dark theme-color when server hints dark", async () => {
    const page = html({
      htmlAttrs: 'data-theme="dark"',
      meta: `
        <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
        <meta name="theme-color" content="#0a0a0a" media="(prefers-color-scheme: dark)">
      `,
      styles: `:root { --bg-primary: #0a0a0a; --text-primary: #eee; }`,
    });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.isDark).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------
describe("Error handling", () => {
  it("handles fetch throwing an error for the main URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("DNS resolution failed");
    }));
    await expect(extractStyle("https://nonexistent.example.com")).rejects.toThrow();
  });

  it("handles HTTP error for main URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 503,
      text: async () => "Service Unavailable",
    })));
    await expect(extractStyle("https://example.com")).rejects.toThrow("HTTP 503");
  });

  it("handles malformed HTML gracefully (no <style> tags)", async () => {
    vi.stubGlobal("fetch", mockFetch("<html><body>Just text, no styles</body></html>"));
    const res = await extractStyle("https://example.com");
    expect(res).toBeDefined();
    expect(res.bg).toBeDefined();
    expect(res.accent).toBeDefined();
  });

  it("handles CSS with only comments", async () => {
    const page = html({ styles: "/* This is just a comment */" });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res).toBeDefined();
    expect(res.fontFamily).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Headless browser fallback (mocked Playwright)
// ---------------------------------------------------------------------------
describe("Headless browser fallback", () => {
  it("attempts headless extraction when accent is fallback (Playwright not available)", async () => {
    // With no accent found, it should try headless and fail gracefully
    const page = html({});
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    // Should still return results (headless will fail silently since playwright is not installed)
    expect(res).toBeDefined();
    expect(res.accentIsFallback).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Normalization rules
// ---------------------------------------------------------------------------
describe("Normalization rules", () => {
  it("normalizes light theme: bg lightness >= 92, text lightness <= 15", async () => {
    const styles = `
      :root {
        --bg-primary: hsl(0, 0%, 85%);
        --text-primary: hsl(0, 0%, 60%);
        --accent: hsl(200, 80%, 50%);
      }
    `;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.isDark).toBe(false);
    const bg = res.bg as number[];
    expect(bg[2]).toBeGreaterThanOrEqual(92);
    const text = res.text as number[];
    expect(text[2]).toBeLessThanOrEqual(15);
  });

  it("normalizes dark theme: bg lightness <= 12, text lightness >= 75", async () => {
    const styles = `
      :root {
        --bg-primary: hsl(0, 0%, 20%);
        --text-primary: hsl(0, 0%, 40%);
        --accent: hsl(150, 80%, 50%);
      }
    `;
    const page = html({ htmlAttrs: 'data-theme="dark"', styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.isDark).toBe(true);
    const bg = res.bg as number[];
    expect(bg[2]).toBeLessThanOrEqual(12);
    const text = res.text as number[];
    expect(text[2]).toBeGreaterThanOrEqual(75);
  });

  it("normalizes accent: boosts saturation below 40 to 55", async () => {
    const styles = `:root { --accent: hsl(200, 15%, 50%); }`;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    const acc = res.accent as number[];
    expect(acc[1]).toBeGreaterThanOrEqual(40);
  });

  it("normalizes accent lightness for dark theme", async () => {
    const styles = `
      :root {
        --bg-primary: #0a0a0a;
        --text-primary: #eeeeee;
        --accent: hsl(200, 80%, 20%);
      }
    `;
    const page = html({ htmlAttrs: 'class="dark"', styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    const acc = res.accent as number[];
    // Dark theme: accent lightness should be >= 30
    expect(acc[2]).toBeGreaterThanOrEqual(30);
  });

  it("clamps text2 lightness in light theme", async () => {
    const styles = `
      :root {
        --bg-primary: #ffffff;
        --text-primary: #111111;
        --text-secondary: hsl(0, 0%, 80%);
        --accent: hsl(200, 80%, 50%);
      }
    `;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    const text2 = res.text2 as number[];
    // text2 in light theme should be clamped (not above 60, not below 30)
    expect(text2[2]).toBeLessThanOrEqual(60);
    expect(text2[2]).toBeGreaterThanOrEqual(30);
  });
});

// ---------------------------------------------------------------------------
// extractStyle main function with various inputs
// ---------------------------------------------------------------------------
describe("extractStyle — various HTML patterns", () => {
  it("extracts from HTML with multiple inline style tags", async () => {
    const page = `<!DOCTYPE html>
<html>
<head>
  <style>:root { --accent: #FF5733; }</style>
  <style>body { font-family: "Roboto"; font-size: 16px; }</style>
</head>
<body><p>Multi-style</p></body>
</html>`;
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.fontFamily).toBe("Roboto");
    const acc = res.accent as number[];
    expect(acc[1]).toBeGreaterThan(40);
  });

  it("extracts og:image in reverse attribute order", async () => {
    const page = html({
      meta: `<meta content="https://example.com/img.png" property="og:image">`,
    });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.ogImage).toBe("https://example.com/img.png");
  });

  it("extracts apple-touch-icon as favicon", async () => {
    const page = html({
      meta: `<link rel="apple-touch-icon" href="/apple-icon.png">`,
    });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.faviconUrl).toBe("https://example.com/apple-icon.png");
  });

  it("handles bg from body with var() reference to CSS variable", async () => {
    const styles = `
      :root { --main-bg: #f8f9fa; }
      body { background-color: var(--main-bg); }
    `;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    const bg = res.bg as number[];
    expect(bg[2]).toBeGreaterThan(85);
  });

  it("rejects vivid mid-range color as background", async () => {
    const styles = `
      :root { --bg-primary: hsl(120, 80%, 50%); --text-primary: #111; --accent: #0066ff; }
    `;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    // Vivid green should be rejected as bg; fallback should be used
    const bg = res.bg as number[];
    expect(bg[2]).toBeGreaterThan(85); // light fallback after normalization
  });

  it("handles body direct background-color (not var)", async () => {
    const styles = `body { background-color: #fafafa; }`;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    const bg = res.bg as number[];
    expect(bg[2]).toBeGreaterThan(85);
  });

  it("handles body bg with vivid color (rejected)", async () => {
    const styles = `body { background-color: hsl(200, 80%, 50%); }`;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    // Vivid mid-range should be rejected as bg
    const bg = res.bg as number[];
    // After normalization, should be light
    expect(bg[2]).toBeGreaterThanOrEqual(92);
  });
});

// ---------------------------------------------------------------------------
// Spacing and layout extraction
// ---------------------------------------------------------------------------
describe("Spacing and layout edge cases", () => {
  it("extracts padding based on radius", async () => {
    const styles = `
      .card { border-radius: 20px; }
    `;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.padding).toBeGreaterThanOrEqual(12);
    expect(res.padding).toBeLessThanOrEqual(24);
  });

  it("computes elevation from large box-shadows", async () => {
    const styles = `
      .card { box-shadow: 0 25px 50px rgba(0,0,0,0.25); }
      .modal { box-shadow: 0 30px 60px rgba(0,0,0,0.3); }
      .overlay { box-shadow: 0 40px 80px rgba(0,0,0,0.4); }
    `;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.elevation).toBeGreaterThan(20);
  });

  it("returns default elevation when no box-shadow found", async () => {
    const page = html({ styles: "body { color: #000; }" });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.elevation).toBe(25);
  });

  it("returns default radius when no border-radius found", async () => {
    const page = html({ styles: "body { color: #000; }" });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.radius).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// SVG fill/stroke accent extraction
// ---------------------------------------------------------------------------
describe("SVG fill/stroke accent extraction", () => {
  it("extracts accent from style attribute fill colors in SVG", async () => {
    const page = html({
      body: `
        <svg><path style="fill: #E74C3C" d="M0 0h10"/></svg>
        <svg><path style="fill: #E74C3C" d="M0 0h10"/></svg>
        <svg><path style="fill: #E74C3C" d="M0 0h10"/></svg>
      `,
    });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    const acc = res.accent as number[];
    expect(acc[1]).toBeGreaterThan(40);
  });

  it("extracts accent from stroke attribute in SVG", async () => {
    const page = html({
      body: `
        <svg><circle stroke="#2ECC71" cx="50" cy="50" r="40"/></svg>
        <svg><circle stroke="#2ECC71" cx="50" cy="50" r="40"/></svg>
        <svg><circle stroke="#2ECC71" cx="50" cy="50" r="40"/></svg>
      `,
    });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    const acc = res.accent as number[];
    expect(acc[1]).toBeGreaterThan(40);
  });
});

// ---------------------------------------------------------------------------
// Strategy 4: scan all hex+rgb colors
// ---------------------------------------------------------------------------
describe("Strategy 4 — hex+rgb color scanning", () => {
  it("finds accent from rgb() values in CSS when no other strategy works", async () => {
    const styles = `
      .logo { color: rgb(255, 87, 34); }
      .badge { color: rgb(255, 87, 34); }
      .cta { background: rgb(255, 87, 34); }
    `;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    const acc = res.accent as number[];
    expect(acc[1]).toBeGreaterThan(40);
  });
});

// ---------------------------------------------------------------------------
// og:image with &amp; entity
// ---------------------------------------------------------------------------
describe("og:image entity decoding", () => {
  it("decodes &amp; in og:image URL", async () => {
    const page = html({
      meta: `<meta property="og:image" content="https://example.com/img?w=600&amp;h=400">`,
    });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.ogImage).toBe("https://example.com/img?w=600&h=400");
  });
});

// ---------------------------------------------------------------------------
// Link tag for favicon — reverse attribute order
// ---------------------------------------------------------------------------
describe("Favicon extraction edge cases", () => {
  it("extracts favicon from link with reversed attributes", async () => {
    const page = html({
      meta: `<link href="/favicon-32x32.png" rel="icon">`,
    });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.faviconUrl).toBe("https://example.com/favicon-32x32.png");
  });

  it("extracts shortcut icon", async () => {
    const page = html({
      meta: `<link rel="shortcut icon" href="/shortcut.ico">`,
    });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.faviconUrl).toBe("https://example.com/shortcut.ico");
  });
});

// ---------------------------------------------------------------------------
// External CSS URL resolution
// ---------------------------------------------------------------------------
describe("External CSS URL resolution", () => {
  it("resolves relative CSS URLs to absolute", async () => {
    const page = html({ links: ["/styles/main.css"] });
    const fetched: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      fetched.push(url);
      if (url.includes(".css")) {
        return { ok: true, status: 200, text: async () => "body { color: #000; }" };
      }
      return { ok: true, status: 200, text: async () => page };
    }));
    await extractStyle("https://example.com/page");
    const cssFetches = fetched.filter(u => u.includes(".css"));
    expect(cssFetches[0]).toBe("https://example.com/styles/main.css");
  });
});

// ---------------------------------------------------------------------------
// splitDarkLightCss — .theme-dark selector
// ---------------------------------------------------------------------------
describe("splitDarkLightCss — dark selector patterns", () => {
  it("strips .theme-dark selector from light CSS", async () => {
    const styles = `
      :root { --bg-primary: #fff; --text-primary: #111; --accent: #0066ff; }
      .theme-dark { --bg-primary: #111; --text-primary: #fff; }
    `;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.isDark).toBe(false);
    const bg = res.bg as number[];
    expect(bg[2]).toBeGreaterThan(85);
  });
});

// ---------------------------------------------------------------------------
// body font-weight extraction
// ---------------------------------------------------------------------------
describe("Font weight defaults", () => {
  it("returns default bodyWeight=400", async () => {
    const page = html({ styles: "body { font-size: 16px; }" });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.bodyWeight).toBe(400);
  });

  it("extracts headingWeight as max weight in CSS", async () => {
    const styles = `
      h1 { font-weight: 900; }
      h2 { font-weight: 700; }
      body { font-weight: 400; }
    `;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.headingWeight).toBe(900);
  });

  it("returns default headingWeight=700 when no weights in CSS", async () => {
    const page = html({ styles: "body { color: #000; }" });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.headingWeight).toBe(700);
  });
});

// ---------------------------------------------------------------------------
// Line height extraction
// ---------------------------------------------------------------------------
describe("Line height", () => {
  it("returns default lineHeight=1.5 when none found", async () => {
    const page = html({ styles: "body { color: #000; }" });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.lineHeight).toBe(1.5);
  });

  it("computes average lineHeight from multiple rules", async () => {
    const styles = `
      body { line-height: 1.4; }
      p { line-height: 1.6; }
      .content { line-height: 1.8; }
    `;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    const lh = res.lineHeight as number;
    expect(lh).toBeGreaterThan(1.3);
    expect(lh).toBeLessThan(1.9);
  });
});

// ---------------------------------------------------------------------------
// Headless browser path with mocked Playwright
// ---------------------------------------------------------------------------
describe("Headless browser path with mocked Playwright", () => {
  it("uses Playwright headless results when accent is fallback", async () => {
    // Mock playwright-core to return computed styles
    vi.doMock("playwright-core", () => ({
      chromium: {
        launch: vi.fn(async () => ({
          newContext: vi.fn(async () => ({
            newPage: vi.fn(async () => ({
              goto: vi.fn(async () => {}),
              waitForTimeout: vi.fn(async () => {}),
              evaluate: vi.fn(async () => ({
                bgColor: "rgb(10, 10, 10)",
                textColor: "rgb(240, 240, 240)",
                accentColor: "rgb(255, 100, 50)",
              })),
            })),
          })),
          close: vi.fn(async () => {}),
        })),
      },
    }));

    // Re-import to pick up the mock
    vi.resetModules();
    vi.doMock("../src/logger.js", () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));
    const mod2 = await import("../src/style-extractor.js");

    // Page with no accent (will trigger headless fallback)
    const page = html({});
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await mod2.extractStyle("https://example.com");
    expect(res).toBeDefined();
    // Headless should have provided an accent
    expect(res.accentIsFallback).toBe(false);

    vi.doUnmock("playwright-core");
  });

  it("handles Playwright returning null result", async () => {
    vi.doMock("playwright-core", () => ({
      chromium: {
        launch: vi.fn(async () => ({
          newContext: vi.fn(async () => ({
            newPage: vi.fn(async () => ({
              goto: vi.fn(async () => {}),
              waitForTimeout: vi.fn(async () => {}),
              evaluate: vi.fn(async () => null),
            })),
          })),
          close: vi.fn(async () => {}),
        })),
      },
    }));

    vi.resetModules();
    vi.doMock("../src/logger.js", () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));
    const mod2 = await import("../src/style-extractor.js");

    const page = html({});
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await mod2.extractStyle("https://example.com");
    expect(res).toBeDefined();
    // Should still return fallback accent
    expect(res.accentIsFallback).toBe(true);

    vi.doUnmock("playwright-core");
  });

  it("handles Playwright returning result with no accent or bg (returns null)", async () => {
    vi.doMock("playwright-core", () => ({
      chromium: {
        launch: vi.fn(async () => ({
          newContext: vi.fn(async () => ({
            newPage: vi.fn(async () => ({
              goto: vi.fn(async () => {}),
              waitForTimeout: vi.fn(async () => {}),
              evaluate: vi.fn(async () => ({
                bgColor: null,
                textColor: null,
                accentColor: null,
              })),
            })),
          })),
          close: vi.fn(async () => {}),
        })),
      },
    }));

    vi.resetModules();
    vi.doMock("../src/logger.js", () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));
    const mod2 = await import("../src/style-extractor.js");

    const page = html({});
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await mod2.extractStyle("https://example.com");
    expect(res).toBeDefined();
    expect(res.accentIsFallback).toBe(true);

    vi.doUnmock("playwright-core");
  });

  it("parseColorFromRgb handles achromatic colors (gray)", async () => {
    vi.doMock("playwright-core", () => ({
      chromium: {
        launch: vi.fn(async () => ({
          newContext: vi.fn(async () => ({
            newPage: vi.fn(async () => ({
              goto: vi.fn(async () => {}),
              waitForTimeout: vi.fn(async () => {}),
              evaluate: vi.fn(async () => ({
                bgColor: "rgb(128, 128, 128)", // gray — max === min path
                textColor: "rgb(200, 200, 200)",
                accentColor: "rgb(0, 150, 255)", // blue accent
              })),
            })),
          })),
          close: vi.fn(async () => {}),
        })),
      },
    }));

    vi.resetModules();
    vi.doMock("../src/logger.js", () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));
    const mod2 = await import("../src/style-extractor.js");

    const page = html({});
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await mod2.extractStyle("https://example.com");
    expect(res).toBeDefined();
    expect(res.accentIsFallback).toBe(false);

    vi.doUnmock("playwright-core");
  });

  it("parseColorFromRgb falls back to parseColor for non-rgb strings", async () => {
    vi.doMock("playwright-core", () => ({
      chromium: {
        launch: vi.fn(async () => ({
          newContext: vi.fn(async () => ({
            newPage: vi.fn(async () => ({
              goto: vi.fn(async () => {}),
              waitForTimeout: vi.fn(async () => {}),
              evaluate: vi.fn(async () => ({
                bgColor: "#0a0a0a", // hex, not rgb() — triggers parseColor fallback
                textColor: "#f0f0f0",
                accentColor: "#FF5733",
              })),
            })),
          })),
          close: vi.fn(async () => {}),
        })),
      },
    }));

    vi.resetModules();
    vi.doMock("../src/logger.js", () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));
    const mod2 = await import("../src/style-extractor.js");

    const page = html({});
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await mod2.extractStyle("https://example.com");
    expect(res).toBeDefined();
    expect(res.accentIsFallback).toBe(false);

    vi.doUnmock("playwright-core");
  });

  it("parseColorFromRgb handles green-dominant and blue-dominant rgb", async () => {
    vi.doMock("playwright-core", () => ({
      chromium: {
        launch: vi.fn(async () => ({
          newContext: vi.fn(async () => ({
            newPage: vi.fn(async () => ({
              goto: vi.fn(async () => {}),
              waitForTimeout: vi.fn(async () => {}),
              evaluate: vi.fn(async () => ({
                bgColor: "rgb(20, 20, 20)",
                textColor: "rgb(0, 200, 100)", // green dominant
                accentColor: "rgb(50, 50, 255)", // blue dominant
              })),
            })),
          })),
          close: vi.fn(async () => {}),
        })),
      },
    }));

    vi.resetModules();
    vi.doMock("../src/logger.js", () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));
    const mod2 = await import("../src/style-extractor.js");

    const page = html({});
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await mod2.extractStyle("https://example.com");
    expect(res).toBeDefined();

    vi.doUnmock("playwright-core");
  });

  it("headless isDark triggers re-normalization", async () => {
    vi.doMock("playwright-core", () => ({
      chromium: {
        launch: vi.fn(async () => ({
          newContext: vi.fn(async () => ({
            newPage: vi.fn(async () => ({
              goto: vi.fn(async () => {}),
              waitForTimeout: vi.fn(async () => {}),
              evaluate: vi.fn(async () => ({
                bgColor: "rgb(5, 5, 5)",
                textColor: "rgb(240, 240, 240)",
                accentColor: "rgb(255, 100, 0)",
              })),
            })),
          })),
          close: vi.fn(async () => {}),
        })),
      },
    }));

    vi.resetModules();
    vi.doMock("../src/logger.js", () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));
    const mod2 = await import("../src/style-extractor.js");

    const page = html({});
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await mod2.extractStyle("https://example.com");
    expect(res).toBeDefined();
    // Headless detected dark (bg lightness < 50)
    expect(res.isDark).toBe(true);
    const bg = res.bg as number[];
    expect(bg[2]).toBeLessThanOrEqual(12);

    vi.doUnmock("playwright-core");
  });
});

// ---------------------------------------------------------------------------
// findVar keyword matching — preferDark behavior
// ---------------------------------------------------------------------------
describe("findVar preferDark behavior", () => {
  it("bg vars prefer dark candidates (lightness < 15)", async () => {
    const styles = `
      :root {
        --bg-primary: hsl(0, 0%, 10%);
        --text-primary: hsl(0, 0%, 90%);
        --accent: hsl(200, 80%, 50%);
      }
    `;
    const page = html({ htmlAttrs: 'data-theme="dark"', styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.isDark).toBe(true);
    const bg = res.bg as number[];
    expect(bg[2]).toBeLessThanOrEqual(12);
  });
});
