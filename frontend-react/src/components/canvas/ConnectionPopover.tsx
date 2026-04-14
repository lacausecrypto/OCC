/**
 * Popover that appears when an edge is selected.
 * Shows source → target info, data flow, and delete button.
 */
import { useMemo } from "react";
import { useCanvasStore } from "../../stores/canvas";
import { edgeMidpoint } from "./connectionHit";
import styles from "./CanvasEditor.module.css";

export function ConnectionPopover() {
  const selectedEdgeId = useCanvasStore((s) => s.selectedEdgeId);
  const edges = useCanvasStore((s) => s.edges);
  const nodes = useCanvasStore((s) => s.nodes);
  const camera = useCanvasStore((s) => s.camera);

  const edge = selectedEdgeId ? edges.get(selectedEdgeId) : null;

  const info = useMemo(() => {
    if (!edge) return null;
    const fromNode = nodes.get(edge.from);
    const toNode = nodes.get(edge.to);
    if (!fromNode || !toNode) return null;
    const mid = edgeMidpoint(edge, nodes);
    return { fromNode, toNode, mid };
  }, [edge, nodes]);

  if (!edge || !info || !info.mid) return null;

  // Convert canvas midpoint to screen coords
  const screenX = info.mid.x * camera.zoom + camera.x;
  const screenY = info.mid.y * camera.zoom + camera.y;

  const handleDelete = () => {
    const store = useCanvasStore.getState();
    store.pushUndo();
    store.removeEdge(edge.id);
  };

  const handleResetCurve = () => {
    useCanvasStore.getState().updateEdge(edge.id, { cp1: undefined, cp2: undefined });
  };

  return (
    <div
      className={styles.connectionPopover}
      style={{
        position: "absolute",
        left: screenX,
        top: screenY - 60,
        transform: "translateX(-50%)",
        zIndex: 25,
      }}
    >
      <div className={styles.connectionPopoverRow}>
        <span className={styles.connectionPopoverLabel}>
          {info.fromNode.label}
        </span>
        <span className={styles.connectionPopoverArrow}>{"\u2192"}</span>
        <span className={styles.connectionPopoverLabel}>
          {info.toNode.label}
        </span>
      </div>
      <div className={styles.connectionPopoverMeta}>
        {info.fromNode.outputVar && (
          <span>{`{${info.fromNode.outputVar}}`}</span>
        )}
      </div>
      <div className={styles.connectionPopoverActions}>
        {(edge.cp1 || edge.cp2) && (
          <button onClick={handleResetCurve} title="Reset curve">
            {"\u21BA"}
          </button>
        )}
        <button onClick={handleDelete} title="Delete connection">
          {"\u2716"}
        </button>
      </div>
    </div>
  );
}
