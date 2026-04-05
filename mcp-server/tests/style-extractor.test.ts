/**
 * Tests for style-extractor.ts
 *
 * Since only extractStyle is exported, all internal helpers (hexToHsl, parseColor,
 * px, extractVarColors, splitDarkLightCss, findVar, etc.) are exercised indirectly
 * through crafted HTML/CSS payloads fed via mocked fetch responses.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock logger to avoid noisy output
vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Helper: build a minimal HTML page with optional sections
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
  // Re-import to pick up fresh mocks
  const mod = await import("../src/style-extractor.js");
  extractStyle = mod.extractStyle;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. COLOR PARSING (via CSS variables in <style>)
// ---------------------------------------------------------------------------
describe("Color parsing via CSS variables", () => {
  it("parses 6-digit hex (#1DB954)", async () => {
    const page = html({ styles: ":root { --accent: #1DB954; }" });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    // accent should be extracted (Spotify green) -- HSL hue ~140
    expect(res.accent).toBeDefined();
    const acc = res.accent as number[];
    expect(acc[1]).toBeGreaterThan(40); // saturated
  });

  it("parses 3-digit hex shorthand (#f00 -> red)", async () => {
    const page = html({ styles: ":root { --accent: #f00; }" });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    const acc = res.accent as number[];
    expect(acc[0]).toBeLessThan(5); // red hue ~0
    expect(acc[1]).toBeGreaterThan(50);
  });

  it("parses 8-digit hex (with alpha) by stripping alpha", async () => {
    const page = html({ styles: ":root { --accent: #FF5733FF; }" });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    const acc = res.accent as number[];
    expect(acc[1]).toBeGreaterThan(40);
  });

  it("parses rgb(r,g,b) values", async () => {
    const page = html({ styles: ":root { --accent: rgb(255, 0, 0); }" });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    const acc = res.accent as number[];
    expect(acc[0]).toBeLessThan(5); // red
    expect(acc[1]).toBeGreaterThan(50);
  });

  it("parses rgba(r,g,b,a) values", async () => {
    const page = html({ styles: ":root { --accent: rgba(0, 128, 255, 0.8); }" });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    const acc = res.accent as number[];
    expect(acc[1]).toBeGreaterThan(40);
  });

  it("parses hsl(h,s%,l%) values", async () => {
    const page = html({ styles: ":root { --accent: hsl(270, 80%, 50%); }" });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    const acc = res.accent as number[];
    expect(acc[0]).toBeCloseTo(270, 0);
  });

  it("parses hsla(h,s%,l%,a) values", async () => {
    const page = html({ styles: ":root { --accent: hsla(120, 70%, 45%, 0.9); }" });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    const acc = res.accent as number[];
    expect(acc[0]).toBeCloseTo(120, 0);
  });

  it("ignores malformed hex like #ZZZ (falls back to defaults)", async () => {
    const page = html({ styles: ":root { --accent: #ZZZ; }" });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    // Should still return a result (with fallback accent)
    expect(res.accent).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 2. CSS VARIABLE EXTRACTION
// ---------------------------------------------------------------------------
describe("CSS variable extraction", () => {
  it("extracts bg, surface, accent, text from CSS variables", async () => {
    const styles = `
      :root {
        --bg-primary: #ffffff;
        --bg-secondary: #f5f5f5;
        --accent: #e63946;
        --text-primary: #1d1d1f;
        --text-secondary: #6e6e73;
        --border-primary: #d2d2d7;
      }
    `;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.isDark).toBe(false);
    // bg should be light
    expect((res.bg as number[])[2]).toBeGreaterThan(85);
    // text should be dark
    expect((res.text as number[])[2]).toBeLessThan(25);
  });

  it("extracts variables from fetched external CSS", async () => {
    const page = html({ links: ["https://example.com/styles.css"] });
    const externalCss = `:root { --accent: #0066FF; --bg-primary: #ffffff; --text-primary: #111111; }`;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      text: async () => url.includes(".css") ? externalCss : page,
    })));
    const res = await extractStyle("https://example.com");
    const acc = res.accent as number[];
    expect(acc[1]).toBeGreaterThan(40); // saturated blue
  });
});

// ---------------------------------------------------------------------------
// 3. DARK / LIGHT THEME DETECTION
// ---------------------------------------------------------------------------
describe("Dark/Light theme detection", () => {
  it("detects dark theme from html data-theme='dark'", async () => {
    const page = html({
      htmlAttrs: 'data-theme="dark"',
      styles: `:root { --bg-primary: #1a1a1a; --text-primary: #eeeeee; --accent: #ff6600; }`,
    });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.isDark).toBe(true);
  });

  it("detects dark theme from html class='dark'", async () => {
    const page = html({
      htmlAttrs: 'class="dark"',
      styles: `:root { --bg-primary: #0d0d0d; --text-primary: #f0f0f0; --accent: #00ff88; }`,
    });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.isDark).toBe(true);
  });

  it("detects dark theme from body class='dark'", async () => {
    const page = html({
      bodyAttrs: 'class="dark"',
      styles: `:root { --bg-primary: #111; --text-primary: #eee; --accent: #ff0055; }`,
    });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.isDark).toBe(true);
  });

  it("defaults to light when no dark hints and bg is light", async () => {
    const page = html({
      styles: `body { background-color: #ffffff; } :root { --accent: #3366cc; }`,
    });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.isDark).toBe(false);
  });

  it("splits dark CSS from @media (prefers-color-scheme: dark)", async () => {
    const styles = `
      :root { --bg-primary: #ffffff; --text-primary: #111111; --accent: #0077cc; }
      @media (prefers-color-scheme: dark) {
        :root { --bg-primary: #111111; --text-primary: #ffffff; --accent: #44aaff; }
      }
    `;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    // No server dark hint, so should be light theme (from default vars)
    expect(res.isDark).toBe(false);
    expect((res.bg as number[])[2]).toBeGreaterThan(85);
  });

  it("uses dark CSS vars when server sends dark hints + dark media query", async () => {
    const styles = `
      :root {
        --bg-primary: #ffffff;
        --bg-secondary: #f0f0f0;
        --text-primary: #111111;
        --border-primary: #cccccc;
        --accent: #0077cc;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg-primary: #0a0a0a;
          --bg-secondary: #1a1a1a;
          --text-primary: #f0f0f0;
          --border-primary: #333333;
          --accent: #44aaff;
        }
      }
    `;
    const page = html({ htmlAttrs: 'data-theme="dark"', styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.isDark).toBe(true);
  });

  it("recognizes dark-mode selector patterns like [data-color-mode='dark']", async () => {
    const styles = `
      :root { --bg-primary: #ffffff; --text-primary: #111; --accent: #0066ff; }
      [data-color-mode="dark"] { --bg-primary: #0d1117; --text-primary: #f0f6fc; }
    `;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    // No server hints -> should still be light
    const res = await extractStyle("https://example.com");
    expect(res.isDark).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. TYPOGRAPHY EXTRACTION
// ---------------------------------------------------------------------------
describe("Typography extraction", () => {
  it("extracts font-family from body rule", async () => {
    const styles = `body { font-family: "Inter", sans-serif; }`;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.fontFamily).toBe("Inter");
  });

  it("extracts font-family from html rule when body has none", async () => {
    const styles = `html { font-family: "Roboto", Helvetica, sans-serif; }`;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.fontFamily).toBe("Roboto");
  });

  it("extracts font-family from CSS variable --font-family", async () => {
    const styles = `:root { --font-family: "Nunito Sans"; } body { font-family: var(--font-family); }`;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    // var(...) is skipped by cleanFont, so it should fall back to --font-family var extraction
    expect(res.fontFamily).toBe("Nunito Sans");
  });

  it("falls back to most frequent font when no body/html/root rule", async () => {
    const styles = `
      .heading { font-family: "Open Sans"; }
      .card { font-family: "Open Sans"; }
      .footer { font-family: "Open Sans"; }
      .sidebar { font-family: "Lato"; }
    `;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.fontFamily).toBe("Open Sans");
  });

  it("falls back to @font-face when no other font source", async () => {
    const styles = `
      @font-face { font-family: "Poppins"; src: url(poppins-400.woff2); }
      @font-face { font-family: "Poppins"; src: url(poppins-700.woff2); }
      @font-face { font-family: "MaterialIcons"; src: url(icons.woff2); }
    `;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.fontFamily).toBe("Poppins");
  });

  it("skips icon/symbol fonts", async () => {
    const styles = `
      .icon { font-family: "FontAwesome"; }
      .symbol { font-family: "Material Symbols"; }
      body { font-family: "Georgia", serif; }
    `;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.fontFamily).toBe("Georgia");
  });

  it("extracts font-size range for body and heading", async () => {
    const styles = `
      body { font-size: 16px; }
      h1 { font-size: 36px; }
      h2 { font-size: 28px; }
      .small { font-size: 12px; }
    `;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.headingSize).toBeGreaterThanOrEqual(18);
    expect(res.headingSize).toBeLessThanOrEqual(42);
    expect(res.bodySize).toBeGreaterThanOrEqual(12);
    expect(res.bodySize).toBeLessThanOrEqual(18);
  });

  it("converts rem to px (1rem = 16px)", async () => {
    const styles = `
      body { font-size: 1rem; }
      h1 { font-size: 2.5rem; }
    `;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.headingSize).toBeGreaterThanOrEqual(18);
    expect(res.bodySize).toBeGreaterThanOrEqual(12);
  });

  it("extracts font-weight", async () => {
    const styles = `
      h1 { font-weight: 800; }
      h2 { font-weight: 700; }
      body { font-weight: 400; }
    `;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.headingWeight).toBe(800);
    expect(res.bodyWeight).toBe(400);
  });

  it("extracts line-height", async () => {
    const styles = `
      body { line-height: 1.6; }
      p { line-height: 1.8; }
    `;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.lineHeight).toBeGreaterThanOrEqual(1.0);
    expect(res.lineHeight).toBeLessThanOrEqual(2.5);
  });
});

// ---------------------------------------------------------------------------
// 5. SPACING / BORDER EXTRACTION
// ---------------------------------------------------------------------------
describe("Spacing and border extraction", () => {
  it("extracts border-radius average", async () => {
    const styles = `
      .card { border-radius: 8px; }
      .btn { border-radius: 4px; }
      .avatar { border-radius: 50px; }
    `;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.radius).toBeGreaterThanOrEqual(0);
    expect(res.radius).toBeLessThanOrEqual(50);
  });

  it("extracts border-width average", async () => {
    const styles = `
      .card { border: 1px solid #ccc; }
      .input { border-width: 2px; }
    `;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.borderWidth).toBeGreaterThanOrEqual(0);
    expect(res.borderWidth).toBeLessThanOrEqual(8);
  });

  it("computes elevation from box-shadow count", async () => {
    const styles = `
      .card { box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
      .modal { box-shadow: 0 20px 60px rgba(0,0,0,0.3); }
    `;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.elevation).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 6. META TAG EXTRACTION
// ---------------------------------------------------------------------------
describe("Meta tag and HTML extraction", () => {
  it("extracts accent from <meta name='theme-color'>", async () => {
    const page = html({
      meta: `<meta name="theme-color" content="#E50914">`,
    });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    const acc = res.accent as number[];
    expect(acc[1]).toBeGreaterThan(40); // red, saturated
  });

  it("extracts accent from msapplication-TileColor when no other accent", async () => {
    const page = html({
      meta: `<meta name="msapplication-TileColor" content="#2b5797">`,
    });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    const acc = res.accent as number[];
    expect(acc[1]).toBeGreaterThan(30);
  });

  it("extracts og:image URL", async () => {
    const page = html({
      meta: `<meta property="og:image" content="https://example.com/share.png">`,
    });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.ogImage).toBe("https://example.com/share.png");
  });

  it("resolves relative og:image URL", async () => {
    const page = html({
      meta: `<meta property="og:image" content="/images/share.png">`,
    });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.ogImage).toBe("https://example.com/images/share.png");
  });

  it("extracts favicon URL from link tag", async () => {
    const page = html({
      meta: `<link rel="icon" href="/favicon.ico">`,
    });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.faviconUrl).toBe("https://example.com/favicon.ico");
  });

  it("falls back to Google favicon service when none found", async () => {
    const page = html({});
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.faviconUrl).toContain("google.com/s2/favicons");
    expect(res.faviconUrl).toContain("example.com");
  });
});

// ---------------------------------------------------------------------------
// 7. INLINE STYLE AND SCRIPT COLOR EXTRACTION
// ---------------------------------------------------------------------------
describe("Inline style and script color extraction", () => {
  it("extracts accent from inline style= background-color", async () => {
    const page = html({
      body: `<div style="background-color: #e63946;">Brand</div>`,
    });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    const acc = res.accent as number[];
    expect(acc[1]).toBeGreaterThan(40);
  });

  it("extracts brand color from JSON-LD scripts", async () => {
    const page = html({
      scripts: `<script type="application/ld+json">{"primaryColor":"#1DB954"}</script>`,
    });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    const acc = res.accent as number[];
    expect(acc[1]).toBeGreaterThan(40);
  });

  it("extracts accent from SVG fill attributes", async () => {
    const page = html({
      body: `
        <svg><path fill="#FF6600" d="M0 0h10v10z"/></svg>
        <svg><path fill="#FF6600" d="M0 0h10v10z"/></svg>
        <svg><path fill="#FF6600" d="M0 0h10v10z"/></svg>
      `,
    });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    const acc = res.accent as number[];
    expect(acc[1]).toBeGreaterThan(40);
  });

  it("extracts accent from .btn-primary CSS class pattern", async () => {
    const styles = `.btn-primary { background-color: #0066FF; color: white; }`;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    const acc = res.accent as number[];
    expect(acc[1]).toBeGreaterThan(40);
  });
});

// ---------------------------------------------------------------------------
// 8. EDGE CASES
// ---------------------------------------------------------------------------
describe("Edge cases", () => {
  it("handles empty CSS gracefully", async () => {
    const page = html({ styles: "" });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    // Should return valid defaults
    expect(res.bg).toBeDefined();
    expect(res.accent).toBeDefined();
    expect(res.text).toBeDefined();
    expect(res.fontFamily).toBeDefined();
    expect(res.radius).toBeDefined();
  });

  it("returns all expected fields in output", async () => {
    const page = html({});
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    const expectedKeys = [
      "bg", "surface", "accent", "text", "text2", "border",
      "headingSize", "headingWeight", "bodySize", "bodyWeight", "lineHeight",
      "gridCols", "gap", "padding", "radius", "borderWidth", "elevation",
      "fontFamily", "ogImage", "faviconUrl", "accentIsFallback", "isDark", "name",
    ];
    for (const key of expectedKeys) {
      expect(res).toHaveProperty(key);
    }
    expect(res.name).toBe("Extracted");
  });

  it("handles very large CSS by truncation (512KB limit in fetchUrl)", async () => {
    // The fetch mock returns whatever we give it, but the real fetchUrl truncates at 512KB
    // Test that style extraction does not crash with large input
    const bigCss = "body { color: #111; }\n".repeat(50000);
    const page = html({ styles: bigCss });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res).toBeDefined();
    expect(res.bg).toBeDefined();
  });

  it("handles fetch failure (HTTP error) gracefully for external CSS", async () => {
    const page = html({ links: ["https://example.com/broken.css"] });
    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      callCount++;
      if (url.includes(".css")) {
        return { ok: false, status: 404, text: async () => "Not Found" };
      }
      return { ok: true, status: 200, text: async () => page };
    }));
    const res = await extractStyle("https://example.com");
    expect(res).toBeDefined();
    expect(res.bg).toBeDefined();
  });

  it("limits external CSS fetches to 4 stylesheets", async () => {
    const links = Array.from({ length: 8 }, (_, i) => `https://example.com/style${i}.css`);
    const page = html({ links });
    const fetched: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      fetched.push(url);
      if (url.includes(".css")) {
        return { ok: true, status: 200, text: async () => "body { color: #000; }" };
      }
      return { ok: true, status: 200, text: async () => page };
    }));
    await extractStyle("https://example.com");
    const cssFetches = fetched.filter((u) => u.includes(".css"));
    expect(cssFetches.length).toBeLessThanOrEqual(4);
  });

  it("prefers dark CSS links when present", async () => {
    const links = [
      "https://example.com/light.css",
      "https://example.com/dark-theme.css",
      "https://example.com/main.css",
    ];
    const page = html({ links });
    const fetched: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      fetched.push(url);
      return { ok: true, status: 200, text: async () => url.includes(".css") ? "body {}" : page };
    }));
    await extractStyle("https://example.com");
    const cssFetches = fetched.filter((u) => u.includes(".css"));
    // dark link should come first
    expect(cssFetches[0]).toContain("dark");
  });

  it("normalizes accent vividity (boosts low saturation)", async () => {
    const styles = `:root { --accent: hsl(200, 20%, 50%); }`;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    const acc = res.accent as number[];
    // Normalization boosts saturation < 40 to 55
    expect(acc[1]).toBeGreaterThanOrEqual(40);
  });

  it("provides sensible defaults for completely empty page", async () => {
    vi.stubGlobal("fetch", mockFetch("<html><head></head><body></body></html>"));
    const res = await extractStyle("https://example.com");
    expect(res.gridCols).toBe(3);
    expect(res.gap).toBe(16);
    expect(res.bodyWeight).toBe(400);
    expect(res.headingSize).toBe(24); // default
    expect(res.bodySize).toBe(14);    // default
  });

  it("handles body background-color with var() reference", async () => {
    const styles = `
      :root { --bg-main: #fafafa; }
      body { background-color: var(--bg-main); }
    `;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect((res.bg as number[])[2]).toBeGreaterThan(85);
  });
});

// ---------------------------------------------------------------------------
// 9. ACCENT FALLBACK STRATEGIES
// ---------------------------------------------------------------------------
describe("Accent fallback strategies", () => {
  it("Strategy 3: picks most saturated CSS var when no direct accent var", async () => {
    const styles = `
      :root {
        --color-one: hsl(0, 0%, 50%);
        --color-two: hsl(220, 80%, 50%);
        --color-three: hsl(100, 60%, 60%);
      }
    `;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    const acc = res.accent as number[];
    expect(acc[1]).toBeGreaterThan(40);
  });

  it("Strategy 4: scans all hex colors in CSS+HTML for vivid fallback", async () => {
    // No CSS vars, no meta tags, just raw hex in CSS
    const styles = `
      .logo { color: #FF4500; }
      .hero { color: #FF4500; }
      .cta { color: #FF4500; }
    `;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    const acc = res.accent as number[];
    expect(acc[1]).toBeGreaterThan(40);
  });

  it("marks accentIsFallback when accent is default blue", async () => {
    const page = html({}); // no styles at all
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    expect(res.accentIsFallback).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10. findVar logic (exclude, preferDark)
// ---------------------------------------------------------------------------
describe("findVar keyword matching and exclusions", () => {
  it("excludes hover/active/disabled variants", async () => {
    const styles = `
      :root {
        --bg-primary-hover: #1DB954;
        --bg-primary: #ffffff;
        --text-primary: #111111;
      }
    `;
    const page = html({ styles });
    vi.stubGlobal("fetch", mockFetch(page));
    const res = await extractStyle("https://example.com");
    // bg should be white, not the green hover variant
    expect((res.bg as number[])[2]).toBeGreaterThan(85);
  });
});
