import { useState, useEffect, useCallback } from "react";
import { useServerStore } from "../../stores/server";
import css from "./Monitor.module.css";

interface PendingApproval {
  executionId: string;
  stepId: string;
  chainName: string;
  title?: string;
  description?: string;
  createdAt: string;
  expiresAt?: string;
  actions?: string[];
}

export function GateApprovalPanel() {
  const { occServerUrl, apiKey } = useServerStore();
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState<Record<string, string>>({});

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const fetchApprovals = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${occServerUrl}/approvals`, {
        headers, signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = await res.json();
        setApprovals(Array.isArray(data) ? data : []);
      }
    } catch {
      // Server might be offline
    } finally {
      setLoading(false);
    }
  }, [occServerUrl, apiKey]);

  // Poll every 10s
  useEffect(() => {
    fetchApprovals();
    const interval = setInterval(fetchApprovals, 10000);
    return () => clearInterval(interval);
  }, [fetchApprovals]);

  const handleAction = useCallback(async (
    executionId: string, stepId: string, action: "approve" | "reject", reason?: string,
  ) => {
    const key = `${executionId}:${stepId}`;
    setActionInProgress(key);
    try {
      const res = await fetch(
        `${occServerUrl}/executions/${encodeURIComponent(executionId)}/approve/${encodeURIComponent(stepId)}`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ action, reason }),
        },
      );
      if (res.ok) {
        setApprovals((prev) => prev.filter(
          (a) => !(a.executionId === executionId && a.stepId === stepId),
        ));
      }
    } catch {
      // Error handled silently
    } finally {
      setActionInProgress(null);
    }
  }, [occServerUrl, apiKey]);

  if (approvals.length === 0 && !loading) return null;

  return (
    <div style={{
      margin: "8px 12px", padding: 12,
      background: "rgba(255, 159, 10, 0.06)",
      border: "1px solid rgba(255, 159, 10, 0.2)",
      borderRadius: 10,
    }}>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        marginBottom: 10,
      }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: "#ff9f0a" }}>
          Pending Approvals ({approvals.length})
        </span>
        <button
          className={css.connectBtn}
          style={{ padding: "2px 8px", fontSize: 10 }}
          onClick={fetchApprovals}
          disabled={loading}
        >
          {loading ? "..." : "Refresh"}
        </button>
      </div>

      {approvals.map((approval) => {
        const key = `${approval.executionId}:${approval.stepId}`;
        const isProcessing = actionInProgress === key;
        const timeAgo = getTimeAgo(approval.createdAt);
        const expired = approval.expiresAt && new Date(approval.expiresAt) < new Date();

        return (
          <div key={key} style={{
            padding: "10px 12px", marginBottom: 8,
            background: "rgba(255,255,255,0.03)",
            border: "1px solid var(--m-border, #333)",
            borderRadius: 8, opacity: expired ? 0.5 : 1,
          }}>
            {/* Title row */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: "var(--m-text)" }}>
                {approval.title || `Gate: ${approval.stepId}`}
              </span>
              <span style={{ fontSize: 10, color: "var(--m-text2)" }}>{timeAgo}</span>
            </div>

            {/* Chain + step info */}
            <div style={{ fontSize: 11, color: "var(--m-text2)", marginBottom: 6 }}>
              {approval.chainName} &middot; {approval.stepId}
            </div>

            {/* Description */}
            {approval.description && (
              <div style={{ fontSize: 11, color: "var(--m-text2)", marginBottom: 8, lineHeight: 1.4 }}>
                {approval.description}
              </div>
            )}

            {/* Rejection reason input */}
            <input
              style={{
                width: "100%", padding: "4px 8px", fontSize: 11, marginBottom: 8,
                background: "var(--m-bg2, #1a1a1a)", border: "1px solid var(--m-border, #333)",
                borderRadius: 6, color: "var(--m-text)", outline: "none",
              }}
              placeholder="Rejection reason (optional)..."
              value={rejectionReason[key] ?? ""}
              onChange={(e) => setRejectionReason((prev) => ({ ...prev, [key]: e.target.value }))}
            />

            {/* Action buttons */}
            <div style={{ display: "flex", gap: 6 }}>
              {(approval.actions ?? ["approve", "reject"]).includes("approve") && (
                <button
                  disabled={isProcessing || !!expired}
                  onClick={() => handleAction(approval.executionId, approval.stepId, "approve")}
                  style={{
                    flex: 1, padding: "5px 0", fontSize: 11, fontWeight: 600,
                    border: "none", borderRadius: 6, cursor: isProcessing ? "wait" : "pointer",
                    background: "rgba(48, 209, 88, 0.15)", color: "#30d158",
                  }}
                >
                  {isProcessing ? "..." : "Approve"}
                </button>
              )}
              {(approval.actions ?? ["approve", "reject"]).includes("reject") && (
                <button
                  disabled={isProcessing || !!expired}
                  onClick={() => handleAction(
                    approval.executionId, approval.stepId, "reject", rejectionReason[key],
                  )}
                  style={{
                    flex: 1, padding: "5px 0", fontSize: 11, fontWeight: 600,
                    border: "none", borderRadius: 6, cursor: isProcessing ? "wait" : "pointer",
                    background: "rgba(255, 55, 95, 0.15)", color: "#ff375f",
                  }}
                >
                  {isProcessing ? "..." : "Reject"}
                </button>
              )}
            </div>

            {expired && (
              <div style={{ fontSize: 10, color: "#ff375f", marginTop: 4, textAlign: "center" }}>
                Expired
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function getTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
