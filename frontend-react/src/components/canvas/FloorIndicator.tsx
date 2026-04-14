/**
 * Floor tab bar — bottom-left of canvas.
 * Shows colored pills for each floor. Click to switch, + to create.
 * Right-click for rename/delete. Active floor has glow.
 */
import { useState, useRef } from "react";
import { useFloorsStore } from "../../stores/floors";
import styles from "./CanvasEditor.module.css";

export function FloorIndicator() {
  const floorsMap = useFloorsStore((s) => s.floors);
  const floors = [...floorsMap.values()];
  const activeId = useFloorsStore((s) => s.activeFloorId);
  const switchFloor = useFloorsStore((s) => s.switchFloor);
  const createFloor = useFloorsStore((s) => s.createFloor);
  const deleteFloor = useFloorsStore((s) => s.deleteFloor);
  const renameFloor = useFloorsStore((s) => s.renameFloor);
  const stackViewOpen = useFloorsStore((s) => s.stackViewOpen);
  const toggleStackView = useFloorsStore((s) => s.toggleStackView);

  const [ctxFloorId, setCtxFloorId] = useState<string | null>(null);
  const [ctxPos, setCtxPos] = useState({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  const handleCreate = () => {
    const name = window.prompt("Floor name:", `Floor ${floors.length + 1}`);
    if (name) createFloor(name);
  };

  const handleRightClick = (e: React.MouseEvent, floorId: string) => {
    e.preventDefault();
    setCtxFloorId(floorId);
    setCtxPos({ x: e.clientX, y: e.clientY });
  };

  const handleRename = () => {
    if (!ctxFloorId) return;
    const floor = floors.find((f) => f.id === ctxFloorId);
    const name = window.prompt("Rename floor:", floor?.name ?? "");
    if (name) renameFloor(ctxFloorId, name);
    setCtxFloorId(null);
  };

  const handleDelete = () => {
    if (!ctxFloorId) return;
    const floor = floors.find((f) => f.id === ctxFloorId);
    if (floor && confirm(`Delete floor "${floor.name}"? All content will be lost.`)) {
      deleteFloor(ctxFloorId);
    }
    setCtxFloorId(null);
  };

  return (
    <>
      <div ref={containerRef} className={styles.floorBar}>
        {/* Overview toggle */}
        <button
          className={`${styles.floorBtn} ${stackViewOpen ? styles.floorBtnActive : ""}`}
          onClick={toggleStackView}
          title="Floor Overview"
        >
          {"\u2630"}
        </button>

        <div className={styles.floorDivider} />

        {/* Floor tabs */}
        {floors.map((floor) => {
          const isActive = floor.id === activeId;
          return (
            <button
              key={floor.id}
              className={`${styles.floorPill} ${isActive ? styles.floorPillActive : ""}`}
              onClick={() => switchFloor(floor.id)}
              onContextMenu={(e) => handleRightClick(e, floor.id)}
              title={floor.name}
              style={{
                "--floor-color": floor.color,
              } as React.CSSProperties}
            >
              <span className={styles.floorDot} style={{ background: floor.color }} />
              <span className={styles.floorName}>{floor.name}</span>
              {isActive && <span className={styles.floorActiveGlow} style={{ background: floor.color }} />}
            </button>
          );
        })}

        <div className={styles.floorDivider} />

        {/* Add floor */}
        <button className={styles.floorBtn} onClick={handleCreate} title="New Floor">
          +
        </button>
      </div>

      {/* Context menu for floor */}
      {ctxFloorId && (
        <>
          <div
            className={styles.floorCtxBackdrop}
            onClick={() => setCtxFloorId(null)}
          />
          <div
            className={styles.floorCtxMenu}
            style={{ left: ctxPos.x, top: ctxPos.y - 80 }}
          >
            <div className={styles.floorCtxItem} onClick={handleRename}>
              {"\u270E"} Rename
            </div>
            {ctxFloorId !== "main" && (
              <div
                className={`${styles.floorCtxItem} ${styles.floorCtxDanger}`}
                onClick={handleDelete}
              >
                {"\u2716"} Delete
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
