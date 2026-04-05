// ─── Image palette extraction & site style extraction ────────────────────────

import { clamp } from "./color";
import type { DesignPreset } from "../types/design";

type HSL = [number, number, number];

/**
 * k-means-inspired clustering: group pixels by hue+saturation into k clusters,
 * return sorted by cluster size. Much better than naive top-20%/bottom-20% splitting.
 */
function clusterColors(pixels: HSL[], k = 5): { center: HSL; count: number }[] {
  if (pixels.length === 0) return [];

  // Initialize centers spread across hue spectrum
  const centers: HSL[] = [];
  for (let i = 0; i < k; i++) {
    centers.push(pixels[Math.floor((i / k) * pixels.length)]);
  }

  const assignments = new Array(pixels.length).fill(0);
  const MAX_ITER = 8;

  for (let iter = 0; iter < MAX_ITER; iter++) {
    let changed = false;

    // Assign each pixel to nearest center (using hue-aware distance)
    for (let i = 0; i < pixels.length; i++) {
      let bestDist = Infinity;
      let bestJ = 0;
      for (let j = 0; j < k; j++) {
        const dh = Math.min(Math.abs(pixels[i][0] - centers[j][0]), 360 - Math.abs(pixels[i][0] - centers[j][0]));
        const ds = Math.abs(pixels[i][1] - centers[j][1]);
        const dl = Math.abs(pixels[i][2] - centers[j][2]);
        const dist = dh * 0.5 + ds + dl;
        if (dist < bestDist) { bestDist = dist; bestJ = j; }
      }
      if (assignments[i] !== bestJ) { assignments[i] = bestJ; changed = true; }
    }

    if (!changed) break;

    // Recompute centers
    for (let j = 0; j < k; j++) {
      let sumS = 0, sumL = 0, count = 0;
      // Use circular mean for hue
      let sinH = 0, cosH = 0;
      for (let i = 0; i < pixels.length; i++) {
        if (assignments[i] !== j) continue;
        const hRad = (pixels[i][0] / 360) * 2 * Math.PI;
        sinH += Math.sin(hRad);
        cosH += Math.cos(hRad);
        sumS += pixels[i][1];
        sumL += pixels[i][2];
        count++;
      }
      if (count > 0) {
        const meanHRad = Math.atan2(sinH / count, cosH / count);
        const meanH = ((meanHRad * 360) / (2 * Math.PI) + 360) % 360;
        centers[j] = [meanH, sumS / count, sumL / count];
      }
    }
  }

  // Build cluster results
  const clusters: { center: HSL; count: number }[] = [];
  for (let j = 0; j < k; j++) {
    let count = 0;
    for (let i = 0; i < pixels.length; i++) {
      if (assignments[i] === j) count++;
    }
    if (count > 0) clusters.push({ center: centers[j], count });
  }

  clusters.sort((a, b) => b.count - a.count);
  return clusters;
}

/**
 * Extract a DesignPreset from an image by sampling pixel colors.
 * Uses a 48x48 thumbnail canvas for better accuracy than 32x32.
 * Employs k-means clustering for robust color extraction.
 */
export function extractPaletteFromImage(url: string): Promise<DesignPreset | null> {
  let blobUrl = url;

  const prepareUrl = async (): Promise<string> => {
    if (url.startsWith("blob:") || url.startsWith("data:")) return url;
    const fetchUrl = url.startsWith("/proxy?")
      ? url
      : `/proxy?url=${encodeURIComponent(url)}`;
    const resp = await fetch(fetchUrl, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) throw new Error("fetch failed");
    const blob = await resp.blob();
    if (blob.size < 100) throw new Error("too small");
    return URL.createObjectURL(blob);
  };

  return prepareUrl()
    .then((prepared) => {
      blobUrl = prepared;
      return new Promise<DesignPreset | null>((resolve) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
          try {
            const SIZE = 48;
            const c = document.createElement("canvas");
            c.width = SIZE;
            c.height = SIZE;
            const ctx = c.getContext("2d")!;
            ctx.drawImage(img, 0, 0, SIZE, SIZE);
            const d = ctx.getImageData(0, 0, SIZE, SIZE).data;

            const pixels: HSL[] = [];
            for (let i = 0; i < d.length; i += 4) {
              const a = d[i + 3];
              if (a < 128) continue; // skip transparent pixels
              const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
              const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
              let h = 0, s = 0;
              const l = (mx + mn) / 2;
              if (mx !== mn) {
                const dd = mx - mn;
                s = l > 0.5 ? dd / (2 - mx - mn) : dd / (mx + mn);
                if (mx === r) h = ((g - b) / dd + (g < b ? 6 : 0)) / 6;
                else if (mx === g) h = ((b - r) / dd + 2) / 6;
                else h = ((r - g) / dd + 4) / 6;
              }
              pixels.push([h * 360, s * 100, l * 100]);
            }

            if (pixels.length < 10) { resolve(null); return; }

            // Cluster the pixels
            const clusters = clusterColors(pixels, 6);

            // Find darkest cluster (bg candidate)
            const darkClusters = clusters.filter(c => c.center[2] < 30)
              .sort((a, b) => a.center[2] - b.center[2]);
            const bgCluster = darkClusters[0] || clusters[clusters.length - 1];

            // Find brightest cluster (text candidate)
            const brightClusters = clusters.filter(c => c.center[2] > 70)
              .sort((a, b) => b.center[2] - a.center[2]);
            const textCluster = brightClusters[0] || clusters[0];

            // Find most saturated cluster (accent candidate)
            const accentCandidates = clusters
              .filter(c => c.center[1] > 25 && c.center[2] > 15 && c.center[2] < 85)
              .sort((a, b) => (b.center[1] * b.count) - (a.center[1] * a.count));
            const accentCluster = accentCandidates[0] || clusters[0];

            // Find mid-lightness, low-saturation cluster (text2 candidate)
            const midClusters = clusters
              .filter(c => c.center[2] > 30 && c.center[2] < 70 && c.center[1] < 30)
              .sort((a, b) => a.center[1] - b.center[1]);
            const text2Cluster = midClusters[0] || bgCluster;

            const dark = bgCluster.center;
            const bright = textCluster.center;
            const accent = accentCluster.center;
            const mid = text2Cluster.center;

            // Determine if image is predominantly dark or light
            const avgL = pixels.reduce((a, p) => a + p[2], 0) / pixels.length;
            const imgIsDark = avgL < 50;

            const preset: DesignPreset = {
              name: "Extracted",
              fontFamily: "system-ui, -apple-system, sans-serif",
              bg: imgIsDark
                ? [dark[0], clamp(dark[1], 0, 20), clamp(dark[2], 3, 12)]
                : [bright[0], clamp(bright[1], 0, 8), clamp(bright[2], 90, 98)],
              surface: imgIsDark
                ? [dark[0], clamp(dark[1], 0, 22), clamp(dark[2] + 4, 6, 16)]
                : [bright[0], clamp(bright[1], 0, 10), clamp(bright[2] - 4, 86, 94)],
              accent: [accent[0], clamp(accent[1], 45, 100), clamp(accent[2], 35, 65)],
              text: imgIsDark
                ? [bright[0], clamp(bright[1], 0, 10), clamp(bright[2], 85, 96)]
                : [dark[0], clamp(dark[1], 0, 10), clamp(dark[2], 5, 15)],
              text2: [mid[0], clamp(mid[1], 0, 15), imgIsDark ? clamp(mid[2], 40, 60) : clamp(mid[2], 35, 55)],
              border: imgIsDark
                ? [dark[0], clamp(dark[1], 0, 15), clamp(dark[2] + 10, 14, 25)]
                : [bright[0], clamp(bright[1], 0, 8), clamp(bright[2] - 12, 78, 88)],
              headingSize: 22, headingWeight: 600, bodySize: 14, bodyWeight: 400,
              lineHeight: 1.5, gridCols: 3, gap: 16, padding: 18, radius: 12,
              borderWidth: 1, elevation: 30,
            };

            resolve(preset);
          } catch {
            resolve(null);
          }
        };
        img.onerror = () => resolve(null);
        img.src = blobUrl;
      });
    })
    .catch(() => null);
}

/**
 * Extract real CSS design tokens from a website via the /extract-style endpoint.
 */
export async function extractSiteStyle(url: string): Promise<DesignPreset> {
  const resp = await fetch(`/extract-style?url=${encodeURIComponent(url)}`, {
    signal: AbortSignal.timeout(15000),
  });
  const data = await resp.json();
  if (data.error) throw new Error(data.error);
  return data as DesignPreset;
}
