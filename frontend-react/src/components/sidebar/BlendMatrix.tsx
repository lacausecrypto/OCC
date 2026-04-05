import { useRef, useEffect, useCallback, useMemo } from "react";
import { useDesignStore, DEFAULT_PRESETS, buildEffectivePresets } from "../../stores/design";
import { blendPresets } from "../../utils/blend";
import { hslToRgb, clamp } from "../../utils/color";
import styles from "./Sidebar.module.css";

/** Check if a preset is still the untouched default */
function isDefault(preset: { accent: number[] }, idx: number): boolean {
  const def = DEFAULT_PRESETS[idx];
  return (
    preset.accent[0] === def.accent[0] &&
    preset.accent[1] === def.accent[1] &&
    preset.accent[2] === def.accent[2]
  );
}

function cleanUrl(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "").replace(/\.(com|org|net|io|app|co|dev|so)$/, "");
}

interface BlendMatrixProps {
  slotUrls: (string | null)[];
}

export function BlendMatrix({ slotUrls }: BlendMatrixProps) {
  const { presets, blendX, blendY, setBlendPosition, applyBlend } = useDesignStore();
  const areaRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const draggingRef = useRef(false);

  const loadedCount = presets.filter((p, i) => !isDefault(p, i)).length;

  // Build effective presets (empty slots inherit from loaded ones)
  const effectivePresets = useMemo(
    () => buildEffectivePresets(presets),
    [presets],
  );

  const draw = useCallback(() => {
    const area = areaRef.current;
    const canvas = canvasRef.current;
    if (!area || !canvas) return;

    const rect = area.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const displayW = Math.round(rect.width);
    const displayH = Math.round(rect.height);
    if (displayW < 1 || displayH < 1) return;

    canvas.width = displayW * dpr;
    canvas.height = displayH * dpr;
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Read CSS tokens for theme-aware rendering
    const rs = getComputedStyle(document.documentElement);
    const tint = rs.getPropertyValue("--glass-tint").trim() || "rgba(255,255,255,0.06)";
    const tintSub = rs.getPropertyValue("--glass-tint-subtle").trim() || "rgba(255,255,255,0.03)";
    const text2 = rs.getPropertyValue("--m-text2").trim() || "#86868b";

    if (loadedCount === 0) {
      // ─── Empty: slot indicators ───
      ctx.fillStyle = tintSub;
      ctx.fillRect(0, 0, displayW, displayH);

      ctx.strokeStyle = tint;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(displayW / 2, 0); ctx.lineTo(displayW / 2, displayH);
      ctx.moveTo(0, displayH / 2); ctx.lineTo(displayW, displayH / 2);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.font = "600 11px system-ui, sans-serif";
      ctx.fillStyle = text2;
      ctx.globalAlpha = 0.4;
      ctx.textAlign = "center";
      const pos = [[0.25, 0.3], [0.75, 0.3], [0.25, 0.7], [0.75, 0.7]];
      for (let i = 0; i < 4; i++) {
        ctx.beginPath();
        ctx.arc(displayW * pos[i][0], displayH * pos[i][1], 14, 0, Math.PI * 2);
        ctx.strokeStyle = text2;
        ctx.globalAlpha = 0.25;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.globalAlpha = 0.4;
        ctx.fillText(String(i + 1), displayW * pos[i][0], displayH * pos[i][1] + 4);
      }
      ctx.font = "400 10px system-ui, sans-serif";
      ctx.globalAlpha = 0.5;
      ctx.fillText("Load references to blend", displayW / 2, displayH / 2 + 3);
      ctx.globalAlpha = 1;
      return;
    }

    // ─── Active: gradient from EFFECTIVE presets ───
    const sw = 50, sh = 50;
    const tmpCanvas = document.createElement("canvas");
    tmpCanvas.width = sw; tmpCanvas.height = sh;
    const tmpCtx = tmpCanvas.getContext("2d")!;
    const imgData = tmpCtx.createImageData(sw, sh);

    for (let py = 0; py < sh; py++) {
      for (let px = 0; px < sw; px++) {
        const b = blendPresets(px / (sw - 1), py / (sh - 1), effectivePresets);
        const [r, g, bl] = hslToRgb(b.accent[0], b.accent[1], b.accent[2]);
        const i = (py * sw + px) * 4;
        imgData.data[i] = r; imgData.data[i + 1] = g; imgData.data[i + 2] = bl; imgData.data[i + 3] = 255;
      }
    }
    tmpCtx.putImageData(imgData, 0, 0);

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(tmpCanvas, 0, 0, displayW, displayH);

    // Grid lines (only if 2+ refs for actual blending)
    if (loadedCount >= 2) {
      ctx.strokeStyle = tint;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(displayW / 2, 0); ctx.lineTo(displayW / 2, displayH);
      ctx.moveTo(0, displayH / 2); ctx.lineTo(displayW, displayH / 2);
      ctx.stroke();
    }

    // Corner labels: only for loaded slots
    ctx.font = "500 10px system-ui, sans-serif";
    const corners = [
      { x: 8, y: 16, align: "left" as const },
      { x: displayW - 8, y: 16, align: "right" as const },
      { x: 8, y: displayH - 8, align: "left" as const },
      { x: displayW - 8, y: displayH - 8, align: "right" as const },
    ];
    for (let i = 0; i < 4; i++) {
      const url = slotUrls[i];
      if (!url) continue;
      ctx.textAlign = corners[i].align;
      ctx.fillStyle = text2;
      ctx.globalAlpha = 0.7;
      ctx.fillText(cleanUrl(url), corners[i].x, corners[i].y);
      ctx.globalAlpha = 1;
    }

    if (loadedCount === 1) {
      ctx.font = "400 9px system-ui, sans-serif";
      ctx.fillStyle = text2;
      ctx.globalAlpha = 0.5;
      ctx.textAlign = "center";
      ctx.fillText("Add more references to blend", displayW / 2, displayH - 10);
      ctx.globalAlpha = 1;
    }
  }, [presets, effectivePresets, loadedCount, slotUrls]);

  useEffect(() => {
    draw();
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, [draw]);

  useEffect(() => { draw(); }, [blendX, blendY, draw]);

  const moveBlend = useCallback(
    (e: PointerEvent | React.PointerEvent) => {
      if (loadedCount < 2) return; // need 2+ refs to blend
      const rect = areaRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = clamp((e.clientX - rect.left) / rect.width, 0, 1);
      const y = clamp((e.clientY - rect.top) / rect.height, 0, 1);
      setBlendPosition(x, y);
      applyBlend();
    },
    [setBlendPosition, applyBlend, loadedCount],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      draggingRef.current = true;
      areaRef.current?.setPointerCapture(e.pointerId);
      moveBlend(e);
    },
    [moveBlend],
  );
  const onPointerMove = useCallback(
    (e: React.PointerEvent) => { if (draggingRef.current) moveBlend(e); },
    [moveBlend],
  );
  const onPointerUp = useCallback(() => { draggingRef.current = false; }, []);

  return (
    <>
      <div className={styles.blendHint}>
        {loadedCount === 0
          ? "Load a reference to start"
          : loadedCount === 1
            ? "1 reference loaded"
            : `Drag to blend \u00B7 ${loadedCount}/4 loaded`}
      </div>
      <div
        ref={areaRef}
        className={styles.blendArea}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{ cursor: loadedCount >= 2 ? "crosshair" : "default" }}
      >
        <canvas ref={canvasRef} />
        {loadedCount >= 2 && (
          <div
            className={styles.blendKnob}
            style={{ left: `${blendX * 100}%`, top: `${blendY * 100}%` }}
          />
        )}
      </div>
    </>
  );
}
