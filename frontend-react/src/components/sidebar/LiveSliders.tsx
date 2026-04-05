import { useMemo } from "react";
import { useDesignStore, SLIDER_DEFS } from "../../stores/design";
import { hsl, clamp } from "../../utils/color";
import type { HSL } from "../../types/design";
import styles from "./Sidebar.module.css";

/** Group definitions for visual sections */
const GROUPS = [
  { label: "Colors", keys: ["bg", "surface", "accent", "text", "text2", "border"] },
  { label: "Typography", keys: ["fontFamily", "headingSize", "headingWeight", "bodySize", "bodyWeight", "lineHeight"] },
  { label: "Layout", keys: ["gridCols", "gap", "padding", "radius", "borderWidth", "elevation"] },
];

export function LiveSliders() {
  const { presets, blendX, blendY, getBlendResult } = useDesignStore();
  const blend = getBlendResult();

  // Dominant font (by bilinear weight)
  const domFont = useMemo(() => {
    const weights = [
      (1 - blendX) * (1 - blendY),
      blendX * (1 - blendY),
      (1 - blendX) * blendY,
      blendX * blendY,
    ];
    const domIdx = weights.indexOf(Math.max(...weights));
    return presets[domIdx].fontFamily || "system-ui";
  }, [presets, blendX, blendY]);

  // Accent contrast preview
  const accentColor = hsl(blend.accent[0], blend.accent[1], blend.accent[2]);
  const bgColor = hsl(blend.bg[0], blend.bg[1], blend.bg[2]);

  const renderSlider = (key: string) => {
    const d = SLIDER_DEFS.find((s) => s.key === key);
    if (!d) return null;

    const value = (blend as unknown as Record<string, unknown>)[key];

    if (d.type === "color" && Array.isArray(value)) {
      const v = value as HSL;
      const color = hsl(v[0], v[1], v[2]);
      return (
        <div key={key} className={styles.sliderRow}>
          <div className={styles.sliderLabel}>{d.label}</div>
          <div className={styles.sliderSwatch} style={{ background: color }} />
          <div className={styles.sliderVal}>
            {Math.round(v[0])}&deg; {Math.round(v[1])}% {Math.round(v[2])}%
          </div>
        </div>
      );
    }

    if (d.type === "font") {
      const short = domFont.split(",")[0].trim().replace(/['"]/g, "");
      return (
        <div key={key} className={`${styles.sliderRow} ${styles.sliderRowFont}`}>
          <div className={styles.sliderLabel}>{d.label}</div>
          <div className={styles.sliderVal} style={{ fontFamily: domFont }}>
            {short}
          </div>
        </div>
      );
    }

    // Numeric slider
    if (typeof value === "number" && d.min !== undefined && d.max !== undefined) {
      const pct = clamp(((value - d.min) / (d.max - d.min)) * 100, 0, 100);
      const display = d.dec ? value.toFixed(d.dec) : String(Math.round(value));
      return (
        <div key={key} className={styles.sliderRow}>
          <div className={styles.sliderLabel}>{d.label}</div>
          <div className={styles.sliderTrack}>
            <div className={styles.sliderFill} style={{ width: `${pct}%` }} />
          </div>
          <div className={styles.sliderVal}>
            {display}
            {d.unit ?? ""}
          </div>
        </div>
      );
    }

    return null;
  };

  return (
    <div className={styles.sliderList}>
      {/* Theme preview mini-bar */}
      <div className={styles.themePreview}>
        <div className={styles.themePreviewBar} style={{ background: bgColor }}>
          <span style={{ color: hsl(blend.text[0], blend.text[1], blend.text[2]) }}>Aa</span>
          <span
            className={styles.themePreviewAccent}
            style={{ background: accentColor }}
          />
          <span style={{ color: hsl(blend.text2[0], blend.text2[1], blend.text2[2]), fontSize: 8 }}>Abc</span>
        </div>
      </div>

      {/* Grouped sliders */}
      {GROUPS.map((group) => (
        <div key={group.label}>
          <div className={styles.sliderGroupLabel}>{group.label}</div>
          {group.keys.map(renderSlider)}
        </div>
      ))}
    </div>
  );
}
