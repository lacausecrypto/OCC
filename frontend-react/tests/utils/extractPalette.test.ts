import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { extractPaletteFromImage, extractSiteStyle } from "../../src/utils/extractPalette";

// ─── Canvas / Image mocks ─────────────────────────────────────────────────────

/** Build a fake ImageData with the given pixel colors (RGBA) */
function buildImageData(pixels: [number, number, number, number][]): { data: Uint8ClampedArray } {
  const data = new Uint8ClampedArray(pixels.length * 4);
  for (let i = 0; i < pixels.length; i++) {
    data[i * 4] = pixels[i][0];
    data[i * 4 + 1] = pixels[i][1];
    data[i * 4 + 2] = pixels[i][2];
    data[i * 4 + 3] = pixels[i][3];
  }
  return { data };
}

function makeDarkPixels(count: number): [number, number, number, number][] {
  const pixels: [number, number, number, number][] = [];
  for (let i = 0; i < count; i++) {
    // Mix of dark bg, bright text, and colored accent pixels
    if (i < count * 0.5) {
      // Dark background pixels
      pixels.push([10, 10, 15, 255]);
    } else if (i < count * 0.7) {
      // Bright text-like pixels
      pixels.push([230, 230, 230, 255]);
    } else if (i < count * 0.85) {
      // Saturated accent pixels (blue)
      pixels.push([30, 100, 220, 255]);
    } else {
      // Mid-tone pixels
      pixels.push([100, 100, 100, 255]);
    }
  }
  return pixels;
}

function makeLightPixels(count: number): [number, number, number, number][] {
  const pixels: [number, number, number, number][] = [];
  for (let i = 0; i < count; i++) {
    if (i < count * 0.5) {
      // Light background pixels
      pixels.push([245, 245, 245, 255]);
    } else if (i < count * 0.7) {
      // Dark text-like pixels
      pixels.push([30, 30, 30, 255]);
    } else if (i < count * 0.85) {
      // Saturated accent pixels (green)
      pixels.push([40, 180, 80, 255]);
    } else {
      pixels.push([128, 128, 128, 255]);
    }
  }
  return pixels;
}

let mockCtx: Record<string, unknown>;
let mockImageData: { data: Uint8ClampedArray };

beforeEach(() => {
  mockImageData = buildImageData(makeDarkPixels(48 * 48));
  mockCtx = {
    drawImage: vi.fn(),
    getImageData: vi.fn(() => mockImageData),
  };

  // Mock document.createElement to return a fake canvas
  vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
    if (tag === "canvas") {
      return {
        width: 0,
        height: 0,
        getContext: () => mockCtx,
      } as unknown as HTMLCanvasElement;
    }
    return document.createElement.call(document, tag);
  });

  // Mock global fetch
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/extract-style")) {
      return {
        ok: true,
        json: async () => ({
          name: "Extracted",
          fontFamily: "system-ui",
          bg: [0, 0, 10],
          surface: [0, 0, 15],
          accent: [200, 80, 50],
          text: [0, 0, 90],
          text2: [0, 0, 50],
          border: [0, 0, 20],
          headingSize: 22, headingWeight: 600, bodySize: 14, bodyWeight: 400,
          lineHeight: 1.5, gridCols: 3, gap: 16, padding: 18, radius: 12,
          borderWidth: 1, elevation: 30,
        }),
      } as Response;
    }
    // Default: return a blob for image proxy
    return {
      ok: true,
      blob: async () => new Blob(["x".repeat(200)], { type: "image/png" }),
    } as Response;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Mock Image constructor ───────────────────────────────────────────────────

function setupImageMock(shouldLoad = true) {
  const origImage = globalThis.Image;
  class MockImage {
    crossOrigin = "";
    src = "";
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    width = 100;
    height = 100;

    constructor() {
      // Trigger load/error after src is set
      const self = this;
      setTimeout(() => {
        if (shouldLoad && self.onload) self.onload();
        else if (!shouldLoad && self.onerror) self.onerror();
      }, 0);
    }
  }
  (globalThis as unknown as Record<string, unknown>).Image = MockImage;
  return () => { (globalThis as unknown as Record<string, unknown>).Image = origImage; };
}

// ─── extractPaletteFromImage ──────────────────────────────────────────────────

describe("extractPaletteFromImage", () => {
  it("returns a DesignPreset for a valid dark image (blob URL)", async () => {
    const restore = setupImageMock(true);
    try {
      const result = await extractPaletteFromImage("blob:http://localhost/test");
      expect(result).not.toBeNull();
      expect(result!.name).toBe("Extracted");
      expect(result!.accent).toHaveLength(3);
      expect(result!.bg).toHaveLength(3);
      expect(result!.text).toHaveLength(3);
      // Dark image should have low bg lightness
      expect(result!.bg[2]).toBeLessThan(20);
    } finally {
      restore();
    }
  });

  it("returns a DesignPreset for a light image", async () => {
    mockImageData = buildImageData(makeLightPixels(48 * 48));
    const restore = setupImageMock(true);
    try {
      const result = await extractPaletteFromImage("blob:http://localhost/light");
      expect(result).not.toBeNull();
      // Light image should have high bg lightness
      expect(result!.bg[2]).toBeGreaterThan(80);
    } finally {
      restore();
    }
  });

  it("returns null if fewer than 10 non-transparent pixels", async () => {
    // All transparent pixels
    const transparent: [number, number, number, number][] = Array(48 * 48).fill([0, 0, 0, 0]);
    mockImageData = buildImageData(transparent);
    const restore = setupImageMock(true);
    try {
      const result = await extractPaletteFromImage("blob:http://localhost/empty");
      expect(result).toBeNull();
    } finally {
      restore();
    }
  });

  it("returns null if image fails to load", async () => {
    const restore = setupImageMock(false);
    try {
      const result = await extractPaletteFromImage("blob:http://localhost/broken");
      expect(result).toBeNull();
    } finally {
      restore();
    }
  });

  it("fetches via proxy for external URLs", async () => {
    const restore = setupImageMock(true);
    try {
      await extractPaletteFromImage("https://example.com/image.png");
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/proxy?url="),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    } finally {
      restore();
    }
  });

  it("uses URL directly for data: URLs", async () => {
    const restore = setupImageMock(true);
    try {
      await extractPaletteFromImage("data:image/png;base64,abc");
      // Should NOT call fetch for data: URLs
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("returns null if proxy fetch fails", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("network error"));
    const restore = setupImageMock(true);
    try {
      const result = await extractPaletteFromImage("https://example.com/broken.png");
      expect(result).toBeNull();
    } finally {
      restore();
    }
  });

  it("returns null if fetched blob is too small", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      blob: async () => new Blob(["x"], { type: "image/png" }),
    } as Response);
    const restore = setupImageMock(true);
    try {
      const result = await extractPaletteFromImage("https://example.com/tiny.png");
      expect(result).toBeNull();
    } finally {
      restore();
    }
  });

  it("preset has expected numeric fields with valid ranges", async () => {
    const restore = setupImageMock(true);
    try {
      const result = await extractPaletteFromImage("blob:http://localhost/test");
      expect(result).not.toBeNull();
      expect(result!.headingSize).toBe(22);
      expect(result!.bodySize).toBe(14);
      expect(result!.radius).toBe(12);
      expect(result!.lineHeight).toBe(1.5);
      // Accent saturation is clamped to [45, 100]
      expect(result!.accent[1]).toBeGreaterThanOrEqual(45);
      expect(result!.accent[1]).toBeLessThanOrEqual(100);
      // Accent lightness is clamped to [35, 65]
      expect(result!.accent[2]).toBeGreaterThanOrEqual(35);
      expect(result!.accent[2]).toBeLessThanOrEqual(65);
    } finally {
      restore();
    }
  });
});

// ─── extractSiteStyle ─────────────────────────────────────────────────────────

describe("extractSiteStyle", () => {
  it("fetches and returns a DesignPreset", async () => {
    const result = await extractSiteStyle("https://example.com");
    expect(result).toHaveProperty("bg");
    expect(result).toHaveProperty("accent");
    expect(result).toHaveProperty("fontFamily");
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/extract-style?url="),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("throws on error response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ error: "Failed to extract" }),
    } as Response);

    await expect(extractSiteStyle("https://broken.com")).rejects.toThrow("Failed to extract");
  });
});
