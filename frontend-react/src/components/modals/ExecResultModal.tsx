import { useState, useEffect, useCallback, useMemo } from "react";
import { useServerStore } from "../../stores/server";
import { useMonitorStore } from "../../stores/monitor";
import { fetchExecution } from "../../api/executions";
import { mdToHtml } from "../../utils/markdown";
import { esc } from "../../utils/escape";
import { ModalOverlay } from "./ModalOverlay";
import type { ChainExecution, StepResult } from "../../types/execution";
import styles from "./Modal.module.css";

type ExecTab = "steps" | "result" | "rendered";

interface ExecResultModalProps {
  executionId: string;
  onClose: () => void;
}

function statusColor(status: string): string {
  switch (status) {
    case "done": return "#30d158";
    case "error": return "#ff375f";
    case "running": return "var(--m-accent)";
    case "skipped": return "var(--m-text2)";
    default: return "var(--m-border)";
  }
}

function statusIcon(status: string): string {
  switch (status) {
    case "done": return "\u2713";
    case "error": return "\u2717";
    case "running": return "\u25CC";
    default: return "?";
  }
}

export function ExecResultModal({ executionId, onClose }: ExecResultModalProps) {
  const { serverOnline } = useServerStore();
  const { executions } = useMonitorStore();
  const [exec, setExec] = useState<ChainExecution | null>(null);
  const [activeTab, setActiveTab] = useState<ExecTab>("steps");
  const [copyLabel, setCopyLabel] = useState("Copy");

  // Load full execution from REST or fallback to monitor store
  useEffect(() => {
    let cancelled = false;
    const local = executions.get(executionId);

    if (serverOnline) {
      fetchExecution(executionId)
        .then((data) => {
          if (!cancelled) setExec(data);
        })
        .catch(() => {
          if (!cancelled && local) setExec(local);
        });
    } else if (local) {
      setExec(local);
    }

    return () => { cancelled = true; };
  }, [executionId, serverOnline, executions]);

  // Steps as entries
  const steps = useMemo((): [string, StepResult][] => {
    if (!exec?.steps) return [];
    return Object.entries(exec.steps).map(([id, s]) => [
      s.stepId ?? id,
      s,
    ]);
  }, [exec]);

  // Full text
  const getFullText = useCallback((): string => {
    if (exec?.result) return exec.result;
    return steps
      .filter(([, s]) => s.output)
      .map(([id, s]) => `## ${id}\n\n${s.output}`)
      .join("\n\n---\n\n");
  }, [exec, steps]);

  // Download .md
  const downloadMd = useCallback(() => {
    const blob = new Blob([getFullText()], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${exec?.chainName ?? "result"}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, [getFullText, exec]);

  // Open as HTML
  const openHtml = useCallback(() => {
    const stepsHtml = steps
      .filter(([, s]) => s.output)
      .map(([id, s]) => `<div class="step-sep">${esc(id)}</div>${mdToHtml(s.output ?? "")}`)
      .join("");
    const body = exec?.result ? mdToHtml(exec.result) : stepsHtml;
    const css = `*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display',system-ui,sans-serif;max-width:820px;margin:0 auto;padding:40px 24px 60px;line-height:1.75;color:#e5e5e7;background:#111}h1{font-size:24px;font-weight:700;margin:32px 0 12px;padding-bottom:8px;border-bottom:1px solid #333;color:#fff}h2{font-size:20px;font-weight:600;margin:28px 0 10px;padding-bottom:6px;border-bottom:1px solid #222;color:#fff}h3{font-size:16px;font-weight:600;margin:22px 0 8px;color:#0a84ff}p{margin:10px 0}strong{color:#fff}em{color:#86868b}code{background:rgba(255,255,255,0.08);padding:2px 6px;border-radius:4px;font-family:'SF Mono',monospace;font-size:0.88em;color:#ff9f0a}pre{background:#0a0a0a;padding:16px;border-radius:10px;overflow-x:auto;margin:14px 0;border:1px solid #222}pre code{background:none;padding:0;color:#d4d4d4;font-size:13px}ul,ol{margin:10px 0;padding-left:24px}li{margin:4px 0}blockquote{border-left:3px solid #0a84ff;padding:8px 14px;margin:14px 0;background:rgba(255,255,255,0.02);border-radius:0 6px 6px 0;color:#86868b;font-style:italic}hr{border:none;border-top:1px solid #333;margin:24px 0}table{width:100%;border-collapse:collapse;margin:14px 0;font-size:13px}th{text-align:left;padding:10px 14px;background:rgba(255,255,255,0.06);border:1px solid #333;font-weight:600;color:#fff}td{padding:8px 14px;border:1px solid #222}.step-sep{margin:32px 0 20px;padding:10px 14px;background:rgba(10,132,255,0.08);border-radius:8px;border-left:3px solid #0a84ff;font-weight:600;font-size:13px;color:#0a84ff;text-transform:uppercase;letter-spacing:0.5px}.header{padding:20px 0 16px;margin-bottom:24px;border-bottom:2px solid #0a84ff}.header h1{margin:0;border:none;padding:0}.header .meta{color:#86868b;font-size:13px;margin-top:4px}`;
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(exec?.chainName ?? "")} — OCC Result</title><style>${css}</style></head><body><div class="header"><h1>${esc(exec?.chainName ?? "")}</h1><div class="meta">${esc(exec?.id ?? "")} · ${exec?.durationMs ? (exec.durationMs / 1000).toFixed(1) + "s" : "?"} · ${new Date(exec?.startedAt ?? "").toLocaleString()}</div></div>${body}</body></html>`;
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const blobUrl = URL.createObjectURL(blob);
    window.open(blobUrl, "_blank", "noopener,noreferrer");
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
  }, [exec, steps]);

  // Copy
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(getFullText()).then(() => {
      setCopyLabel("Copied!");
      setTimeout(() => setCopyLabel("Copy"), 1500);
    });
  }, [getFullText]);

  if (!exec) {
    return (
      <ModalOverlay onClose={onClose}>
        <div className={`${styles.modal} ${styles.execModal}`}>
          <div className={styles.header}>
            <h3 className={styles.headerTitle}>Loading...</h3>
            <button className={styles.closeBtn} onClick={onClose}>&times;</button>
          </div>
        </div>
      </ModalOverlay>
    );
  }

  return (
    <ModalOverlay onClose={onClose}>
      <div className={`${styles.modal} ${styles.execModal}`}>
        {/* Header */}
        <div className={styles.header}>
          <h3 className={styles.headerTitle}>
            <span style={{ color: statusColor(exec.status) }}>
              {statusIcon(exec.status)}
            </span>
            {exec.chainName ?? "?"}
            <span style={{ color: "var(--m-text2)", fontSize: "var(--s-xs)", fontWeight: 400 }}>
              {exec.id}
            </span>
          </h3>
          <button className={styles.closeBtn} onClick={onClose}>&times;</button>
        </div>

        {/* Tabs */}
        <div className={styles.execTabs}>
          {(["steps", "result", "rendered"] as ExecTab[]).map((tab) => {
            const label =
              tab === "steps" ? `Steps (${steps.length})`
              : tab === "result" ? "Raw Result"
              : "Rendered";
            return (
              <button
                key={tab}
                className={`${styles.execTab} ${activeTab === tab ? styles.execTabActive : ""}`}
                onClick={() => setActiveTab(tab)}
              >
                {label}
              </button>
            );
          })}
        </div>

        {/* Content */}
        <div className={styles.execContent}>
          {activeTab === "steps" && (
            <>
              {steps.length === 0 ? (
                <div className={styles.emptyState}>No step data available.</div>
              ) : (
                steps.map(([stepId, step]) => {
                  const isError = step.status === "error";
                  const dur = step.durationMs
                    ? `${(step.durationMs / 1000).toFixed(1)}s`
                    : "";
                  const tokens = step.inputTokens
                    ? `${step.inputTokens}\u2192${step.outputTokens ?? 0} tok`
                    : "";

                  return (
                    <div
                      key={stepId}
                      className={`${styles.stepCard} ${isError ? styles.stepCardError : ""}`}
                    >
                      <div className={styles.stepHeader}>
                        <div
                          className={styles.stepStatus}
                          style={{ background: statusColor(step.status) }}
                        />
                        <div className={styles.stepName}>{stepId}</div>
                        <div className={styles.stepMeta}>
                          {step.status}
                          {dur && ` \u00B7 ${dur}`}
                          {tokens && ` \u00B7 ${tokens}`}
                        </div>
                      </div>
                      {step.output && (
                        <div className={styles.stepOutput}>
                          {step.output.slice(0, 3000)}
                          {(step.output.length ?? 0) > 3000 && "\n\n... (truncated)"}
                        </div>
                      )}
                      {step.error && (
                        <div className={styles.stepErrorMsg}>
                          {"\u26A0"} {step.error.slice(0, 200)}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </>
          )}

          {activeTab === "result" && (
            <div className={styles.resultText}>
              {getFullText() || "No output."}
            </div>
          )}

          {activeTab === "rendered" && (
            <div className={styles.rendered}>
              {exec.result ? (
                <div dangerouslySetInnerHTML={{ __html: mdToHtml(exec.result) }} />
              ) : steps.filter(([, s]) => s.output).length > 0 ? (
                steps
                  .filter(([, s]) => s.output)
                  .map(([id, s]) => (
                    <div key={id}>
                      <div className={styles.stepSeparator}>{id}</div>
                      <div dangerouslySetInnerHTML={{ __html: mdToHtml(s.output ?? "") }} />
                    </div>
                  ))
              ) : (
                <p style={{ color: "var(--m-text2)" }}>No output to render.</p>
              )}
            </div>
          )}
        </div>

        {/* Actions footer */}
        <div className={styles.execActions}>
          <span className={styles.footerInfo}>
            {exec.durationMs
              ? `${(exec.durationMs / 1000).toFixed(1)}s`
              : exec.status ?? "..."}
          </span>
          <button className={styles.btn} onClick={downloadMd}>
            Download .md
          </button>
          <button className={styles.btn} onClick={openHtml}>
            Open as HTML
          </button>
          <button className={styles.btn} onClick={handleCopy}>
            {copyLabel}
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}
