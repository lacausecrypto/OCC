// ─── Bilinear blend of 4 design presets ──────────────────────────────────────

import type { DesignPreset, BlendResult } from "../types/design";
import { lerp } from "./color";

const SKIP_KEYS = new Set(["name", "fontFamily"]);

/**
 * Hue-aware linear interpolation.
 * Handles the 360° wraparound — e.g., blending 350° and 10° goes through 0°,
 * not the long way through 180°.
 */
function lerpHue(a: number, b: number, t: number): number {
  let diff = b - a;
  // Shortest path around the circle
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  return ((a + diff * t) % 360 + 360) % 360;
}

/**
 * Bilinear interpolation of 4 presets arranged in a 2x2 grid:
 *   presets[0]=TL  presets[1]=TR
 *   presets[2]=BL  presets[3]=BR
 *
 * x: 0..1 (left to right)
 * y: 0..1 (top to bottom)
 */
export function blendPresets(
  x: number,
  y: number,
  presets: DesignPreset[],
): BlendResult {
  const result: Record<string, unknown> = {};
  const keys = Object.keys(presets[0]).filter((k) => !SKIP_KEYS.has(k));

  for (const k of keys) {
    const tl = (presets[0] as unknown as Record<string, unknown>)[k];
    const tr = (presets[1] as unknown as Record<string, unknown>)[k];
    const bl = (presets[2] as unknown as Record<string, unknown>)[k];
    const br = (presets[3] as unknown as Record<string, unknown>)[k];

    if (Array.isArray(tl)) {
      // HSL array: use hue-aware interpolation for index 0 (hue), linear for S/L
      const tlArr = tl as number[];
      const trArr = tr as number[];
      const blArr = bl as number[];
      const brArr = br as number[];

      const out: number[] = [];
      for (let i = 0; i < tlArr.length; i++) {
        if (i === 0) {
          // Hue: circular interpolation
          const topH = lerpHue(tlArr[0], trArr[0], x);
          const botH = lerpHue(blArr[0], brArr[0], x);
          out.push(lerpHue(topH, botH, y));
        } else {
          // Saturation, Lightness: standard linear
          const top = lerp(tlArr[i], trArr[i], x);
          const bot = lerp(blArr[i], brArr[i], x);
          out.push(lerp(top, bot, y));
        }
      }
      result[k] = out;
    } else if (typeof tl === "number") {
      result[k] = lerp(
        lerp(tl, tr as number, x),
        lerp(bl as number, br as number, x),
        y,
      );
    }
  }

  return result as unknown as BlendResult;
}
