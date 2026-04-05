import styles from "./AppLayout.module.css";

interface CollapseButtonProps {
  side: "left" | "right";
  collapsed: boolean;
  onClick: () => void;
  title?: string;
}

export function CollapseButton({
  side,
  collapsed,
  onClick,
  title,
}: CollapseButtonProps) {
  const className = [
    styles.collapseBtn,
    side === "left" ? styles.collapseBtnLeft : styles.collapseBtnRight,
    collapsed ? styles.collapsedChevron : "",
  ]
    .filter(Boolean)
    .join(" ");

  // Left chevron: points left (collapse left sidebar) / right when collapsed
  // Right chevron: points right (collapse right sidebar) / left when collapsed
  const points =
    side === "left" ? "15 6 9 12 15 18" : "9 6 15 12 9 18";

  return (
    <button className={className} onClick={onClick} title={title}>
      <svg viewBox="0 0 24 24">
        <polyline points={points} />
      </svg>
    </button>
  );
}
