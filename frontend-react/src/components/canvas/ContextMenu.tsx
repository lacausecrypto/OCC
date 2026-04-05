import { useEffect, useCallback, useState, useRef } from "react";
import { createPortal } from "react-dom";
import styles from "./CanvasEditor.module.css";

export interface ContextMenuItem {
  icon?: string;
  label: string;
  action?: () => void;
  sub?: ContextMenuItem[];
  disabled?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: (ContextMenuItem | "---")[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const [openSub, setOpenSub] = useState<number | null>(null);
  const itemRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelClose = () => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
  };

  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpenSub(null), 150);
  };

  useEffect(() => () => cancelClose(), []);

  const onClickOutside = useCallback(
    (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(`.${styles.ctxMenu}`) && !target.closest(`.${styles.ctxSubmenu}`)) onClose();
    },
    [onClose],
  );

  useEffect(() => {
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [onClickOutside]);

  // Clamp position to viewport
  const menuX = Math.min(x, window.innerWidth - 220);
  const menuY = Math.min(y, window.innerHeight - items.length * 32 - 20);

  // Calculate submenu position from the parent item's bounding rect
  const getSubPos = (index: number) => {
    const el = itemRefs.current.get(index);
    if (!el) return { x: menuX + 200, y: menuY };
    const rect = el.getBoundingClientRect();
    return { x: rect.right + 4, y: rect.top - 4 };
  };

  const subPos = openSub !== null ? getSubPos(openSub) : null;
  const openSubItem = openSub !== null ? items[openSub] : null;
  const subItems = openSubItem && openSubItem !== "---" && openSubItem.sub ? openSubItem.sub : null;

  return (
    <>
      <div className={styles.ctxMenu} style={{ left: menuX, top: menuY }}>
        {items.map((item, i) => {
          if (item === "---") {
            return <div key={i} className={styles.ctxSep} />;
          }

          const hasSub = item.sub && item.sub.length > 0;

          return (
            <div
              key={i}
              ref={(el) => { if (el) itemRefs.current.set(i, el); }}
              className={`${styles.ctxItem} ${item.disabled ? styles.ctxDisabled : ""}`}
              onClick={() => {
                if (item.disabled) return;
                if (hasSub) { setOpenSub(openSub === i ? null : i); return; }
                item.action?.();
                onClose();
              }}
              onMouseEnter={() => { if (hasSub) { cancelClose(); setOpenSub(i); } }}
              onMouseLeave={() => { if (hasSub) scheduleClose(); }}
            >
              {item.icon && <span className={styles.ctxIcon}>{item.icon}</span>}
              <span style={{ flex: 1 }}>{item.label}</span>
              {hasSub && <span className={styles.ctxArrow}>{"\u25B8"}</span>}
            </div>
          );
        })}
      </div>

      {/* Submenu rendered via portal — outside parent's backdrop-filter */}
      {subItems && subPos && createPortal(
        <div
          className={styles.ctxSubmenu}
          style={{ left: subPos.x, top: subPos.y }}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          {subItems.map((sub, j) => (
            <div
              key={j}
              className={styles.ctxItem}
              onClick={(e) => {
                e.stopPropagation();
                sub.action?.();
                onClose();
              }}
            >
              {sub.icon && <span className={styles.ctxIcon}>{sub.icon}</span>}
              {sub.label}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
