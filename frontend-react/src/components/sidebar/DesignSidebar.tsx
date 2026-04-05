import { useCallback, useMemo, useState } from "react";
import { useDesignStore, DEFAULT_PRESETS } from "../../stores/design";
import { extractPaletteFromImage, extractSiteStyle } from "../../utils/extractPalette";
import { generateRandomPresetSet } from "../../utils/randomDesign";
import { ReferenceSlot } from "./ReferenceSlot";
import { BlendMatrix } from "./BlendMatrix";
import { LiveSliders } from "./LiveSliders";
import { ThemeManager } from "./ThemeManager";
import styles from "./Sidebar.module.css";

/** Dark preset defaults for night mode */
const DARK_OVERRIDE = {
  bg: [0, 0, 5] as [number, number, number],
  surface: [0, 0, 10] as [number, number, number],
  text: [0, 0, 96] as [number, number, number],
  text2: [240, 3, 53] as [number, number, number],
  border: [0, 0, 18] as [number, number, number],
};

/** Light preset defaults for day mode */
const LIGHT_OVERRIDE = {
  bg: [0, 0, 98] as [number, number, number],
  surface: [0, 0, 94] as [number, number, number],
  text: [0, 0, 10] as [number, number, number],
  text2: [0, 0, 45] as [number, number, number],
  border: [0, 0, 82] as [number, number, number],
};

/**
 * Try to extract accent color from images (og:image, favicon, Google favicon).
 * Returns the first successful accent with saturation > threshold.
 */
async function extractAccentFromImages(
  images: (string | null | undefined)[],
  minSaturation = 25,
): Promise<[number, number, number] | null> {
  const candidates = images.filter(Boolean) as string[];
  for (const imageUrl of candidates) {
    try {
      const imgPalette = await extractPaletteFromImage(imageUrl);
      if (imgPalette && imgPalette.accent[1] > minSaturation) {
        return imgPalette.accent;
      }
    } catch { /* try next */ }
  }
  return null;
}

export function DesignSidebar() {
  const { presets, setPreset, applyBlend } = useDesignStore();
  const [slotImages, setSlotImages] = useState<(string | null)[]>([null, null, null, null]);
  const [slotUrls, setSlotUrls] = useState<(string | null)[]>([null, null, null, null]);
  const [isDark, setIsDark] = useState(true);
  const [loadingSlots, setLoadingSlots] = useState<boolean[]>([false, false, false, false]);

  // Check if any reference slot has been loaded
  const hasAnyRef = useMemo(
    () => slotUrls.some((u) => u !== null),
    [slotUrls],
  );

  // Randomize all 4 presets with coherent random designs
  const randomizeDesign = useCallback(() => {
    const randomPresets = generateRandomPresetSet();
    for (let i = 0; i < 4; i++) {
      randomPresets[i].name = DEFAULT_PRESETS[i].name;
      setPreset(i, randomPresets[i]);
    }
    // Detect dark/light from the generated presets
    const avgBgL = randomPresets.reduce((a, p) => a + p.bg[2], 0) / 4;
    setIsDark(avgBgL < 50);
    applyBlend();
  }, [setPreset, applyBlend]);

  // Toggle Day/Night — brute-force override bg/surface/text on ALL presets
  const toggleDayNight = useCallback(() => {
    const goLight = isDark;
    const override = goLight ? LIGHT_OVERRIDE : DARK_OVERRIDE;
    for (let i = 0; i < 4; i++) {
      setPreset(i, {
        ...presets[i],
        ...override,
      });
    }
    setIsDark(!isDark);
    applyBlend();
  }, [isDark, presets, setPreset, applyBlend]);

  const loadSlot = useCallback(
    async (idx: number, rawUrl: string) => {
      setLoadingSlots(prev => { const n = [...prev]; n[idx] = true; return n; });

      const isDirectImage =
        /\.(png|jpg|jpeg|gif|webp|svg|bmp)(\?|#|$)/i.test(rawUrl) ||
        rawUrl.startsWith("blob:") ||
        rawUrl.startsWith("data:");

      let thumbUrl = rawUrl;
      setSlotUrls((prev) => { const n = [...prev]; n[idx] = rawUrl; return n; });

      try {
        if (isDirectImage) {
          if (!rawUrl.startsWith("blob:") && !rawUrl.startsWith("data:")) {
            thumbUrl = `/proxy?url=${encodeURIComponent(rawUrl)}`;
          }
          setSlotImages((prev) => { const n = [...prev]; n[idx] = thumbUrl; return n; });

          const extracted = await extractPaletteFromImage(rawUrl);
          if (extracted) {
            extracted.name = DEFAULT_PRESETS[idx].name;
            setPreset(idx, extracted);
          }
        } else {
          const style = await extractSiteStyle(rawUrl);
          thumbUrl = style.ogImage
            ? `/proxy?url=${encodeURIComponent(style.ogImage)}`
            : `/proxy?url=${encodeURIComponent(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(rawUrl)}&sz=256`)}`;

          setSlotImages((prev) => { const n = [...prev]; n[idx] = thumbUrl; return n; });

          const preset = { ...style, name: DEFAULT_PRESETS[idx].name };
          setPreset(idx, preset);

          // If accent is fallback, try harder with image-based extraction
          const isFallback = style.accentIsFallback || (
            style.accent && (
              (Math.abs(style.accent[0] - 211) < 3 && style.accent[1] > 95) ||
              (Math.abs(style.accent[0]) < 5 && Math.abs(style.accent[1] - 55) < 10) ||
              (style.accent[1] < 30)
            )
          );
          if (isFallback) {
            // Extract domain for Google favicon
            let domain: string;
            try { domain = new URL(rawUrl).hostname; } catch { domain = rawUrl; }

            const betterAccent = await extractAccentFromImages([
              style.ogImage,
              style.faviconUrl,
              `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=256`,
            ]);

            if (betterAccent) {
              preset.accent = betterAccent;
              setPreset(idx, { ...preset });
            }
          }

          // Track if extracted site was dark
          if ((style as unknown as Record<string, unknown>).isDark) setIsDark(true);
        }
      } catch {
        // If extraction failed, still show a thumbnail
        try {
          let domain: string;
          try { domain = new URL(rawUrl).hostname; } catch { domain = rawUrl; }
          thumbUrl = `/proxy?url=${encodeURIComponent(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=256`)}`;
          setSlotImages((prev) => { const n = [...prev]; n[idx] = thumbUrl; return n; });
        } catch { /* nothing we can do */ }
      } finally {
        setLoadingSlots(prev => { const n = [...prev]; n[idx] = false; return n; });
      }
    },
    [setPreset, applyBlend],
  );

  const clearSlot = useCallback(
    (idx: number) => {
      setSlotImages((prev) => {
        const n = [...prev];
        if (n[idx]?.startsWith("blob:")) URL.revokeObjectURL(n[idx]!);
        n[idx] = null;
        return n;
      });
      setSlotUrls((prev) => { const n = [...prev]; n[idx] = null; return n; });
      setPreset(idx, { ...DEFAULT_PRESETS[idx] });
      applyBlend();
    },
    [setPreset, applyBlend],
  );

  return (
    <>
      {/* Reference Styles */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Reference Styles</div>
        <div className={styles.refGrid}>
          {presets.map((p, i) => (
            <ReferenceSlot
              key={i}
              index={i}
              name={p.name}
              loadedUrl={slotUrls[i]}
              imageUrl={slotImages[i]}
              loading={loadingSlots[i]}
              onLoad={loadSlot}
              onClear={clearSlot}
            />
          ))}
        </div>
      </div>

      {/* Randomize button — only visible when no reference loaded */}
      {/* Blend Matrix */}
      <div className={styles.section}>
        <BlendMatrix slotUrls={slotUrls} />
      </div>

      {/* Controls row: Day/Night + Randomize */}
      <div className={styles.section} style={{ padding: "4px 14px" }}>
        <div className={styles.controlsRow}>
          <button
            className={styles.dayNightBtn}
            onClick={toggleDayNight}
            title={isDark ? "Switch to Light mode" : "Switch to Dark mode"}
          >
            <span className={styles.dayNightIcon}>{isDark ? "\u263E" : "\u2600"}</span>
            <span>{isDark ? "Dark" : "Light"}</span>
            <span className={styles.dayNightToggle}>
              <span
                className={styles.dayNightDot}
                style={{ transform: isDark ? "translateX(0)" : "translateX(14px)" }}
              />
            </span>
          </button>
          <ThemeManager />
          {!hasAnyRef && (
            <button
              className={styles.ctrlBtn}
              onClick={randomizeDesign}
              title="Random design"
            >
              <span className={`${styles.ctrlBtnIcon} ${styles.shuffleIcon}`}>&#x2684;</span>
              <span>Shuffle</span>
            </button>
          )}
        </div>
      </div>

      {/* Live Parameters */}
      <div className={styles.section} style={{ paddingBottom: 12 }}>
        <div className={styles.sectionTitle}>Live Parameters</div>
        <LiveSliders />
      </div>
    </>
  );
}
