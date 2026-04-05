import { useCallback, useRef } from "react";
import styles from "./AppLayout.module.css";

interface ResizeHandleProps {
  side: "left" | "right";
  onResize: (width: number) => void;
  hidden?: boolean;
}

export function ResizeHandle({ side, onResize, hidden }: ResizeHandleProps) {
  const activeRef = useRef(false);
  const handleRef = useRef<HTMLDivElement>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      activeRef.current = true;
      handleRef.current?.classList.add("active");
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const onMove = (ev: PointerEvent) => {
        if (!activeRef.current) return;
        if (side === "left") {
          onResize(Math.max(200, Math.min(600, ev.clientX)));
        } else {
          onResize(
            Math.max(240, Math.min(600, window.innerWidth - ev.clientX)),
          );
        }
      };

      const onUp = () => {
        activeRef.current = false;
        handleRef.current?.classList.remove("active");
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
      };

      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    },
    [side, onResize],
  );

  const className = [
    styles.resizeHandle,
    side === "left" ? styles.resizeHandleLeft : styles.resizeHandleRight,
  ].join(" ");

  // Always render in DOM to preserve grid column count.
  // When hidden, CSS rules on parent (.leftCollapsed / .rightCollapsed) set width:0.
  return (
    <div
      ref={handleRef}
      className={className}
      onPointerDown={hidden ? undefined : onPointerDown}
      style={hidden ? { pointerEvents: "none" } : undefined}
    />
  );
}
