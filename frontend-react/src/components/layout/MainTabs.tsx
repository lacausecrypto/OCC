import { useBlobStore } from "../../stores/blob";
import styles from "./AppLayout.module.css";

export type TabId = "dashboard" | "canvas" | "blob" | "settings";

interface MainTabsProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
}

const TABS: { id: TabId; label: string; badge?: string }[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "canvas", label: "Workflow" },
  { id: "blob", label: "The Blob", badge: "EXP" },
  { id: "settings", label: "Settings" },
];

export function MainTabs({ activeTab, onTabChange }: MainTabsProps) {
  const blobSessionId = useBlobStore((s) => s.activeSessionId);
  const blobSessions = useBlobStore((s) => s.sessions);
  const activeBlobName = blobSessionId ? blobSessions.find((s) => s.id === blobSessionId)?.name : null;

  return (
    <div className={styles.mainTabs}>
      {TABS.map((tab) => (
        <button
          key={tab.id}
          className={`${styles.mainTab} ${activeTab === tab.id ? styles.mainTabActive : ""}`}
          onClick={() => onTabChange(tab.id)}
        >
          {tab.id === "blob" && activeBlobName
            ? <>The Blob <span className={styles.tabSessionName}>· {activeBlobName}</span></>
            : tab.label}
          {tab.badge && <span className={styles.tabBadgeExp}>{tab.badge}</span>}
        </button>
      ))}
    </div>
  );
}
