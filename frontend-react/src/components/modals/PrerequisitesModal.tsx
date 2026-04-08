import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { api } from "../../api/client";
import styles from "./Prerequisites.module.css";

interface Check {
  id: string;
  label: string;
  required: boolean;
  status: "ok" | "warn" | "fail";
  detail: string;
  hint?: string;
}

interface PrerequisitesResponse {
  checks: Check[];
  allRequiredOk: boolean;
}

const STORAGE_KEY = "occ-prerequisites-dismissed";

// ─── Action config per check ID ──────────────────────────────────────────
interface CheckAction {
  label: string;
  type: "copy" | "link" | "navigate";
  value: string; // command to copy, URL to open, or tab name
}

const CHECK_ACTIONS: Record<string, CheckAction> = {
  claude_cli:  { label: "Copy install command", type: "copy", value: "npm install -g @anthropic-ai/claude-code" },
  claude_auth: { label: "Copy auth command",    type: "copy", value: "claude" },
  ollama:      { label: "Download Ollama",      type: "link", value: "https://ollama.com/download" },
  docker:      { label: "Download Docker",      type: "link", value: "https://www.docker.com/get-started/" },
  providers:   { label: "Go to Settings",       type: "navigate", value: "settings" },
  chains:      { label: "View example chains",  type: "link", value: "https://github.com/lacausecrypto/OCC/tree/main/chains" },
};

// HuggingFace hint detected from detail text
function getExtraAction(check: Check): CheckAction | null {
  if (check.id === "providers" && check.detail.toLowerCase().includes("0 provider")) {
    return { label: "Go to Settings", type: "navigate", value: "settings" };
  }
  return null;
}

export function PrerequisitesModal() {
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [checks, setChecks] = useState<Check[]>([]);
  const [allRequiredOk, setAllRequiredOk] = useState(false);
  const [dontShow, setDontShow] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const autoRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const runChecks = useCallback(async () => {
    setLoading(true);
    setError(null);
    setCheckingId(null);
    try {
      const data = await api.get<PrerequisitesResponse>("/prerequisites", AbortSignal.timeout(30000));
      const list = Array.isArray(data?.checks) ? data.checks : [];
      setChecks(list);
      setAllRequiredOk(data?.allRequiredOk ?? false);
      if (data?.allRequiredOk && localStorage.getItem(STORAGE_KEY) === "true") {
        setVisible(false);
        return;
      }
      setVisible(true);
    } catch {
      setError("Cannot reach OCC backend. Make sure the server is running.");
      setVisible(true);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial check
  useEffect(() => {
    const timer = setTimeout(() => void runChecks(), 300);
    return () => clearTimeout(timer);
  }, [runChecks]);

  // Auto-refresh every 5s when there are failing required checks
  useEffect(() => {
    if (autoRefreshRef.current) {
      clearInterval(autoRefreshRef.current);
      autoRefreshRef.current = null;
    }
    const hasFails = checks.some((c) => c.required && c.status !== "ok");
    if (visible && hasFails && !loading && !error) {
      autoRefreshRef.current = setInterval(async () => {
        try {
          const data = await api.get<PrerequisitesResponse>("/prerequisites", AbortSignal.timeout(10000));
          const list = Array.isArray(data?.checks) ? data.checks : [];
          setChecks(list);
          setAllRequiredOk(data?.allRequiredOk ?? false);
          // Auto-dismiss when everything becomes OK
          if (data?.allRequiredOk && localStorage.getItem(STORAGE_KEY) === "true") {
            setVisible(false);
          }
        } catch { /* silent — will retry on next interval */ }
      }, 5000);
    }
    return () => {
      if (autoRefreshRef.current) clearInterval(autoRefreshRef.current);
    };
  }, [visible, checks, loading, error]);

  // Re-open from Settings event
  useEffect(() => {
    const handler = () => {
      localStorage.removeItem(STORAGE_KEY);
      void runChecks();
    };
    window.addEventListener("occ-recheck-prerequisites", handler);
    return () => window.removeEventListener("occ-recheck-prerequisites", handler);
  }, [runChecks]);

  const handleEnter = () => {
    if (dontShow) localStorage.setItem(STORAGE_KEY, "true");
    setVisible(false);
  };

  const handleRecheck = async () => {
    // Animate each check sequentially
    setCheckingId("_all");
    try {
      const data = await api.get<PrerequisitesResponse>("/prerequisites", AbortSignal.timeout(30000));
      const list = Array.isArray(data?.checks) ? data.checks : [];
      // Reveal checks one by one
      for (let i = 0; i < list.length; i++) {
        setCheckingId(list[i].id);
        setChecks((prev) => {
          const next = [...prev];
          const idx = next.findIndex((c) => c.id === list[i].id);
          if (idx >= 0) next[idx] = list[i];
          else next.push(list[i]);
          return next;
        });
        await new Promise((r) => setTimeout(r, 150));
      }
      setChecks(list);
      setAllRequiredOk(data?.allRequiredOk ?? false);
    } catch {
      setError("Cannot reach OCC backend.");
    }
    setCheckingId(null);
  };

  const handleCopy = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => setCopied(null), 2000);
    } catch { /* clipboard not available */ }
  };

  const handleAction = (check: Check, action: CheckAction) => {
    if (action.type === "copy") {
      void handleCopy(action.value, check.id);
    } else if (action.type === "link") {
      window.open(action.value, "_blank", "noopener");
    } else if (action.type === "navigate") {
      // Dispatch event to switch tab — picked up by AppLayout/useAppStore
      window.dispatchEvent(new CustomEvent("occ-navigate-tab", { detail: action.value }));
      setVisible(false);
    }
  };

  if (!visible) return null;

  const required = checks.filter((c) => c.required);
  const optional = checks.filter((c) => !c.required);
  const isRechecking = checkingId !== null;

  const renderCheck = (c: Check) => {
    const isChecking = checkingId === c.id || checkingId === "_all";
    const action = c.status !== "ok" ? (CHECK_ACTIONS[c.id] || getExtraAction(c)) : null;

    return (
      <div
        key={c.id}
        className={`${styles.checkRow} ${styles[c.status]} ${isChecking && checkingId === c.id ? styles.checking : ""}`}
      >
        <span className={styles.checkIcon}>
          {isChecking && checkingId === c.id ? (
            <span className={styles.miniSpinner} />
          ) : c.status === "ok" ? (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="var(--c-success)" strokeWidth="1.5"/><path d="M5 8l2 2 4-4" stroke="var(--c-success)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
          ) : c.status === "warn" ? (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1.5l6.5 12H1.5L8 1.5z" stroke="var(--c-warning)" strokeWidth="1.3" strokeLinejoin="round"/><line x1="8" y1="6" x2="8" y2="9" stroke="var(--c-warning)" strokeWidth="1.3" strokeLinecap="round"/><circle cx="8" cy="11" r="0.7" fill="var(--c-warning)"/></svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="var(--c-error)" strokeWidth="1.5"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="var(--c-error)" strokeWidth="1.5" strokeLinecap="round"/></svg>
          )}
        </span>
        <div className={styles.checkInfo}>
          <div className={styles.checkLabel}>{c.label}</div>
          <div className={styles.checkDetail}>{c.detail}</div>
          {c.hint && c.status !== "ok" && (
            <div className={styles.hintRow}>
              <code
                className={styles.hintCode}
                onClick={() => void handleCopy(c.hint!, c.id + "_hint")}
                title="Click to copy"
              >
                {c.hint}
              </code>
              {copied === c.id + "_hint" && <span className={styles.copiedBadge}>Copied!</span>}
            </div>
          )}
          {action && (
            <button
              className={styles.actionBtn}
              onClick={() => handleAction(c, action)}
            >
              {action.type === "copy" && (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              )}
              {action.type === "link" && (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
              )}
              {action.type === "navigate" && (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
              )}
              {copied === c.id && action.type === "copy" ? "Copied!" : action.label}
            </button>
          )}
        </div>
      </div>
    );
  };

  return createPortal(
    <div className={styles.overlay}>
      <div className={styles.modal}>
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.headerTitle}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            OCC Setup Check
          </div>
          <span className={styles.version}>{checks.find(c => c.id === "backend")?.detail?.match(/v[\d.]+/)?.[0] ?? ""}</span>
        </div>

        {/* Body */}
        <div className={styles.body}>
          {loading && checks.length === 0 ? (
            <div className={styles.loading}>
              <div className={styles.spinner} />
              Checking prerequisites...
            </div>
          ) : error && checks.length === 0 ? (
            <div className={styles.errorBlock}>
              <div className={styles.errorIcon}>
                <svg width="24" height="24" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="var(--c-error)" strokeWidth="1.5"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="var(--c-error)" strokeWidth="1.5" strokeLinecap="round"/></svg>
              </div>
              <div>
                <div className={styles.errorTitle}>Backend Unreachable</div>
                <div className={styles.errorDetail}>{error}</div>
                <div className={styles.hintRow}>
                  <code
                    className={styles.hintCode}
                    onClick={() => void handleCopy("cd mcp-server && npm run rest", "backend_hint")}
                    title="Click to copy"
                  >
                    cd mcp-server && npm run rest
                  </code>
                  {copied === "backend_hint" && <span className={styles.copiedBadge}>Copied!</span>}
                </div>
              </div>
            </div>
          ) : (
            <>
              {/* Required */}
              <div className={styles.section}>
                <div className={styles.sectionLabel}>Required</div>
                {required.map(renderCheck)}
              </div>

              {/* Optional */}
              <div className={styles.section}>
                <div className={styles.sectionLabel}>Optional</div>
                {optional.map(renderCheck)}
              </div>

              {/* Auto-refresh indicator */}
              {checks.some((c) => c.required && c.status !== "ok") && !isRechecking && (
                <div className={styles.autoRefresh}>
                  <span className={styles.miniSpinner} />
                  Auto-checking every 5s...
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className={styles.footer}>
          {!loading && !error && (
            <label className={styles.dontShowLabel}>
              <input
                type="checkbox"
                checked={dontShow}
                onChange={(e) => setDontShow(e.target.checked)}
                className={styles.dontShowCheck}
              />
              Don't show again
            </label>
          )}
          <div className={styles.footerActions}>
            <button className={styles.btnGlass} onClick={handleRecheck} disabled={isRechecking || loading}>
              {isRechecking ? (
                <><span className={styles.miniSpinner} /> Checking...</>
              ) : "Re-check"}
            </button>
            <button
              className={`${styles.btnGlass} ${styles.btnPrimary}`}
              onClick={handleEnter}
              disabled={isRechecking || loading || (!allRequiredOk && !error)}
            >
              {error ? "Continue anyway" : allRequiredOk ? "Enter Dashboard" : "Fix required items"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
