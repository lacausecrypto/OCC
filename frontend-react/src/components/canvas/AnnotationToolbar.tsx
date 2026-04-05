/**
 * Annotation toolbar — tools for drawing, shapes, images, sticky notes.
 * Also includes the Blueprint toggle button.
 */
import { useState, useEffect } from "react";
import { useAnnotationStore, type AnnotationTool } from "../../stores/annotations";
import { useWorkflowChatStore } from "../../stores/workflowChat";
import styles from "./CanvasEditor.module.css";

const SPINNER_FRAMES = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];

function ChatSpinner() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => (t + 1) % SPINNER_FRAMES.length), 100);
    return () => clearInterval(id);
  }, []);
  return <>{SPINNER_FRAMES[tick]}</>;
}

function ChatButton({ active, onClick }: { active?: boolean; onClick: () => void }) {
  const streaming = useWorkflowChatStore((s) => s.streaming);
  return (
    <button
      className={`${styles.annBtn} ${active ? styles.annBtnActive : ""}`}
      onClick={onClick}
      title="Workflow Chat"
      style={{ fontSize: 13, fontFamily: streaming ? "monospace" : "inherit", minWidth: 28, textAlign: "center" }}
    >
      {streaming ? <ChatSpinner /> : "\u2728"}
    </button>
  );
}

const TOOLS: { id: AnnotationTool; label: string; icon: string }[] = [
  { id: "select", label: "Select/Move", icon: "\u{1F5D8}" },
  { id: "pencil", label: "Draw", icon: "\u270F\uFE0F" },
  { id: "line", label: "Line", icon: "\u2500" },
  { id: "arrow", label: "Arrow", icon: "\u2794" },
  { id: "rect", label: "Rectangle", icon: "\u25AD" },
  { id: "ellipse", label: "Circle", icon: "\u25EF" },
  { id: "text", label: "Text", icon: "T" },
  { id: "sticky", label: "Sticky Note", icon: "\u{1F4DD}" },
  { id: "eraser", label: "Eraser", icon: "\u{1F9F9}" },
];

function getAnnotationColors(): string[] {
  const v = (name: string, fb: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb;
  return [
    v("--m-accent", "#0a84ff"), v("--icon-red", "#ff375f"), v("--icon-green", "#30d158"),
    v("--icon-orange", "#ff9f0a"), v("--icon-purple", "#bf5af2"),
    v("--m-text", "#f5f5f7"), v("--m-text2", "#86868b"),
  ];
}
const WIDTHS = [1, 2, 4, 6];

interface AnnotationToolbarProps {
  onBlueprintToggle?: () => void;
  blueprintActive?: boolean;
  blueprintCount?: number;
  onChatToggle?: () => void;
  chatActive?: boolean;
}

export function AnnotationToolbar({ onBlueprintToggle, blueprintActive, blueprintCount, onChatToggle, chatActive }: AnnotationToolbarProps) {
  const {
    activeTool, activeColor, activeLineWidth,
    setTool, setColor, setLineWidth,
    clearAll, undo, deleteSelected, selectedId,
  } = useAnnotationStore();

  const isActive = activeTool !== "none";

  const handleExportPNG = () => {
    const canvas = document.querySelector(".canvasWrap canvas") as HTMLCanvasElement | null
      ?? document.querySelector("canvas");
    if (!canvas) return;
    const link = document.createElement("a");
    link.download = "occ-canvas.png";
    link.href = canvas.toDataURL("image/png");
    link.click();
  };

  return (
    <div className={styles.annotationBar}>
      {/* Blueprint toggle */}
      {onBlueprintToggle && (
        <button
          className={`${styles.annBtn} ${blueprintActive ? styles.annBtnActive : ""}`}
          onClick={onBlueprintToggle}
          title={`Blueprints${blueprintCount ? ` (${blueprintCount})` : ""}`}
          style={{ fontSize: 14 }}
        >
          {"\u{1F4CB}"}
        </button>
      )}

      {/* Workflow Chat toggle */}
      {onChatToggle && (
        <ChatButton active={chatActive} onClick={onChatToggle} />
      )}

      <span className={styles.sep} />

      {/* Annotation mode toggle */}
      <button
        className={`${styles.annBtn} ${isActive ? styles.annBtnActive : ""}`}
        onClick={() => setTool(isActive ? "none" : "select")}
        title="Annotation mode"
        style={{ fontSize: 14 }}
      >
        {"\u270F\uFE0F"}
      </button>

      {isActive && (
        <>
          <span className={styles.sep} />

          {TOOLS.map((t) => (
            <button
              key={t.id}
              className={`${styles.annBtn} ${activeTool === t.id ? styles.annBtnActive : ""}`}
              onClick={() => setTool(t.id)}
              title={t.label}
            >
              {t.icon}
            </button>
          ))}

          <span className={styles.sep} />

          {/* Colors */}
          {getAnnotationColors().map((c) => (
            <button
              key={c}
              className={styles.annColor}
              style={{
                background: c,
                outline: activeColor === c ? `2px solid ${c}` : "none",
                outlineOffset: 2,
              }}
              onClick={() => setColor(c)}
            />
          ))}

          <span className={styles.sep} />

          {/* Line widths */}
          {WIDTHS.map((w) => (
            <button
              key={w}
              className={`${styles.annBtn} ${activeLineWidth === w ? styles.annBtnActive : ""}`}
              onClick={() => setLineWidth(w)}
              title={`${w}px`}
              style={{ fontSize: 10, padding: "4px 6px" }}
            >
              {w}
            </button>
          ))}

          <span className={styles.sep} />

          {/* Delete selected */}
          {selectedId && (
            <button className={styles.annBtn} onClick={deleteSelected} title="Delete selected">
              {"\u2716"}
            </button>
          )}

          {/* Undo + Clear + Export */}
          <button className={styles.annBtn} onClick={undo} title="Undo">{"\u21A9"}</button>
          <button className={styles.annBtn} onClick={clearAll} title="Clear all">{"\u2718"}</button>
          <button className={styles.annBtn} onClick={handleExportPNG} title="Export PNG">{"\u{1F4F7}"}</button>
        </>
      )}
    </div>
  );
}
