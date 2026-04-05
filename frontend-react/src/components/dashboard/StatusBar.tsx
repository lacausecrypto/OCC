import { useCallback, useState, type KeyboardEvent } from "react";
import { useServerStore } from "../../stores/server";
import styles from "./Dashboard.module.css";

interface StatusBarProps {
  onRefresh: () => void;
}

export function StatusBar({ onRefresh }: StatusBarProps) {
  const { serverOnline, occServerUrl, setServerUrl } = useServerStore();
  const [urlInput, setUrlInput] = useState(occServerUrl);

  const applyUrl = useCallback(() => {
    const clean = urlInput.trim().replace(/\/+$/, "");
    setServerUrl(clean);
    onRefresh();
  }, [urlInput, setServerUrl, onRefresh]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Enter") applyUrl();
    },
    [applyUrl],
  );

  return (
    <div className={styles.statusBar}>
      <span
        className={`${styles.statusDot} ${serverOnline ? styles.online : ""}`}
      />
      <span className={styles.statusText}>
        {serverOnline
          ? `${occServerUrl} - connected`
          : "OCC server offline"}
      </span>
      <input
        className={styles.statusUrlInput}
        value={urlInput}
        onChange={(e) => setUrlInput(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="http://localhost:4242"
      />
      <button
        className={`${styles.btn} ${styles.btnSmall}`}
        style={{ padding: "4px 10px", fontSize: "11px" }}
        onClick={applyUrl}
      >
        Refresh
      </button>
    </div>
  );
}
