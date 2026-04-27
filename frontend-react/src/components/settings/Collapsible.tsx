/**
 * CollapsibleSection — animated foldable wrapper used across Settings.
 * Persisted state lives in `./collapse-state` (pure helpers, no React).
 */
import { useSectionCollapsed } from "./collapse-state";
import styles from "./Settings.module.css";

interface CollapsibleSectionProps {
  id: string;
  title: React.ReactNode;
  badge?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export function CollapsibleSection({ id, title, badge, children, className }: CollapsibleSectionProps) {
  const [collapsed, toggle] = useSectionCollapsed(id);
  return (
    <div id={id} className={`${styles.section} ${collapsed ? styles.sectionCollapsed : ""} ${className ?? ""}`}>
      <button
        type="button"
        className={styles.sectionTitleCollapsible}
        onClick={toggle}
        data-open={!collapsed}
        aria-expanded={!collapsed}
      >
        <span className={styles.sectionChevron} />
        <span>{title}</span>
        {badge && <span className={styles.sectionBadge}>{badge}</span>}
      </button>
      <div className={collapsed ? styles.sectionBodyHidden : ""}>{children}</div>
    </div>
  );
}
