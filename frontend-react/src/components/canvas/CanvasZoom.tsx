import { useCanvasExecStore } from "../../stores/canvasExec";
import styles from "./CanvasEditor.module.css";

interface CanvasZoomProps {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomFit: () => void;
}

export function CanvasZoom({ onZoomIn, onZoomOut, onZoomFit }: CanvasZoomProps) {
  const hasExecState = useCanvasExecStore((s) => s.nodeExecState.size > 0);

  return (
    <div className={styles.zoomControls}>
      <button className={styles.zbtn} onClick={onZoomIn}>+</button>
      <button className={styles.zbtn} onClick={onZoomOut}>&minus;</button>
      <button className={styles.zbtn} onClick={onZoomFit} style={{ fontSize: 11 }}>
        Fit
      </button>
      {hasExecState && (
        <button
          className={styles.zbtn}
          onClick={() => useCanvasExecStore.getState().clearExecState()}
          style={{ fontSize: 9 }}
          title="Clear execution overlays"
        >
          Clear
        </button>
      )}
    </div>
  );
}
