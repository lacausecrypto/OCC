/**
 * Birds-eye view of all floors as miniature canvas previews.
 * Glass panel that slides up from the floor bar.
 * Click a floor card to navigate to it.
 */
import { useFloorsStore } from "../../stores/floors";
import type { FloorData } from "../../stores/floors";
import styles from "./CanvasEditor.module.css";

function FloorCard({ floor, isActive, onClick }: {
  floor: FloorData;
  isActive: boolean;
  onClick: () => void;
}) {
  const nodeCount = floor.nodes.size;
  const edgeCount = floor.edges.size;

  return (
    <div
      className={`${styles.floorCard} ${isActive ? styles.floorCardActive : ""}`}
      onClick={onClick}
      style={{ "--floor-color": floor.color } as React.CSSProperties}
    >
      {/* Mini canvas preview */}
      <div className={styles.floorCardPreview}>
        <svg viewBox="-50 -50 500 300" className={styles.floorCardSvg}>
          {/* Draw mini nodes */}
          {[...floor.nodes.values()].slice(0, 20).map((n) => (
            <rect
              key={n.id}
              x={n.x * 0.3}
              y={n.y * 0.3}
              width={Math.max(8, n.w * 0.3)}
              height={Math.max(4, n.h * 0.3)}
              rx={2}
              fill={floor.color + "80"}
              stroke={floor.color}
              strokeWidth={0.5}
            />
          ))}
          {/* Draw mini edges */}
          {[...floor.edges.values()].slice(0, 20).map((e) => {
            const from = floor.nodes.get(e.from);
            const to = floor.nodes.get(e.to);
            if (!from || !to) return null;
            return (
              <line
                key={e.id}
                x1={(from.x + from.w / 2) * 0.3}
                y1={(from.y + from.h) * 0.3}
                x2={(to.x + to.w / 2) * 0.3}
                y2={to.y * 0.3}
                stroke={floor.color + "40"}
                strokeWidth={0.5}
              />
            );
          })}
          {nodeCount === 0 && (
            <text x="100" y="75" textAnchor="middle" fill="rgba(255,255,255,0.2)" fontSize="14">
              Empty
            </text>
          )}
        </svg>
      </div>

      {/* Floor info */}
      <div className={styles.floorCardInfo}>
        <div className={styles.floorCardName}>
          <span className={styles.floorDot} style={{ background: floor.color }} />
          {floor.name}
          {isActive && <span className={styles.floorCardBadge}>Active</span>}
        </div>
        <div className={styles.floorCardMeta}>
          {nodeCount} node{nodeCount !== 1 ? "s" : ""} · {edgeCount} edge{edgeCount !== 1 ? "s" : ""}
        </div>
      </div>
    </div>
  );
}

export function FloorOverview() {
  const floorsMap = useFloorsStore((s) => s.floors);
  const floors = [...floorsMap.values()];
  const activeId = useFloorsStore((s) => s.activeFloorId);
  const switchFloor = useFloorsStore((s) => s.switchFloor);
  const setOverviewOpen = useFloorsStore((s) => s.setOverviewOpen);

  const handleSelect = (id: string) => {
    switchFloor(id);
    setOverviewOpen(false);
  };

  return (
    <div className={styles.floorOverview}>
      <div className={styles.floorOverviewHeader}>
        <span>Floor Overview</span>
        <button className={styles.floorBtn} onClick={() => setOverviewOpen(false)}>
          {"\u2715"}
        </button>
      </div>
      <div className={styles.floorOverviewGrid}>
        {floors.map((floor) => (
          <FloorCard
            key={floor.id}
            floor={floor}
            isActive={floor.id === activeId}
            onClick={() => handleSelect(floor.id)}
          />
        ))}
      </div>
    </div>
  );
}
