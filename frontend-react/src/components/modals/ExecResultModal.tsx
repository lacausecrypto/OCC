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
    case "skipped": return "\u2014";
    default: return "?";
  }
}

/** Detect if text is JSON and pretty-print it */
function tryFormatJson(text: string): { isJson: boolean; formatted: string } {
  const trimmed = text.trim();
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      const parsed = JSON.parse(trimmed);
      return { isJson: true, formatted: JSON.stringify(parsed, null, 2) };
    } catch { /* not valid JSON */ }
  }
  return { isJson: false, formatted: text };
}

/** Extract image URLs from output (JSON, /images/ paths, /tmp/ paths, markdown syntax) */
function extractImageUrls(text: string): string[] {
  const urls: string[] = [];
  // JSON with image_url or url field
  try {
    const parsed = JSON.parse(text);
    if (parsed.image_url) urls.push(parsed.image_url);
    if (parsed.url && /\.(png|jpg|jpeg|webp|gif)/i.test(parsed.url)) urls.push(parsed.url);
    if (parsed.path && /\.(png|jpg|jpeg|webp|gif)/i.test(parsed.path)) {
      // Local path → serve via /download endpoint
      urls.push(`/download?path=${encodeURIComponent(parsed.path)}`);
    }
  } catch { /* not JSON */ }
  // /images/img_ patterns (served by backend)
  const imgServerMatches = text.match(/\/images\/img_[^\s"']+/g);
  if (imgServerMatches) urls.push(...imgServerMatches);
  // /tmp/ image paths → serve via /download
  const tmpImgMatches = text.match(/\/tmp\/[^\s"']*\.(png|jpg|jpeg|webp|gif)/gi);
  if (tmpImgMatches) {
    for (const p of tmpImgMatches) urls.push(`/download?path=${encodeURIComponent(p)}`);
  }
  // Markdown image syntax: ![alt](url)
  const mdImgMatches = text.match(/!\[.*?\]\((.+?)\)/g);
  if (mdImgMatches) {
    for (const m of mdImgMatches) {
      const urlMatch = m.match(/\((.+?)\)/);
      if (urlMatch) urls.push(urlMatch[1]);
    }
  }
  return [...new Set(urls)];
}

/** Extract file paths from output (PDF, CSV, etc.) for download links */
function extractFileLinks(text: string): Array<{ path: string; name: string; type: string }> {
  const files: Array<{ path: string; name: string; type: string }> = [];
  // JSON with path field
  try {
    const parsed = JSON.parse(text);
    if (parsed.path && typeof parsed.path === "string" && !(/\.(png|jpg|jpeg|webp|gif)/i.test(parsed.path))) {
      const name = parsed.path.split("/").pop() ?? parsed.path;
      const ext = name.split(".").pop()?.toLowerCase() ?? "";
      files.push({ path: parsed.path, name, type: ext });
    }
    if (parsed.output_path) {
      const name = parsed.output_path.split("/").pop() ?? parsed.output_path;
      const ext = name.split(".").pop()?.toLowerCase() ?? "";
      files.push({ path: parsed.output_path, name, type: ext });
    }
  } catch { /* not JSON */ }
  // /tmp/ file paths (pdf, csv, txt, html, etc.)
  const fileMatches = text.match(/\/tmp\/[^\s"']*\.(pdf|csv|txt|html|xml|xlsx|docx|zip|tar|gz)/gi);
  if (fileMatches) {
    for (const p of fileMatches) {
      const name = p.split("/").pop() ?? p;
      const ext = name.split(".").pop()?.toLowerCase() ?? "";
      if (!files.some(f => f.path === p)) files.push({ path: p, name, type: ext });
    }
  }
  return files;
}

/** Detect if text is CSV (has header + rows with consistent columns) */
function detectCsv(text: string): { isCsv: boolean; headers: string[]; rows: string[][] } {
  const lines = text.trim().split("\n").filter(l => l.trim());
  if (lines.length < 2) return { isCsv: false, headers: [], rows: [] };
  // Check if first line has commas or tabs
  const sep = lines[0].includes("\t") ? "\t" : ",";
  const headers = lines[0].split(sep).map(h => h.trim());
  if (headers.length < 2 || headers.length > 30) return { isCsv: false, headers: [], rows: [] };
  // Check if subsequent lines have same column count
  const rows = lines.slice(1).map(l => l.split(sep).map(c => c.trim()));
  const consistent = rows.filter(r => r.length === headers.length).length;
  if (consistent / rows.length < 0.8) return { isCsv: false, headers: [], rows: [] };
  return { isCsv: true, headers, rows };
}

/** Detect raw HTML */
function isHtmlContent(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("<!DOCTYPE") || trimmed.startsWith("<html") || (trimmed.startsWith("<") && trimmed.endsWith(">") && trimmed.length > 100);
}

const fileTypeIcons: Record<string, string> = {
  pdf: "\u{1F4C4}", csv: "\u{1F4CA}", txt: "\u{1F4DD}", html: "\u{1F310}",
  xml: "\u{1F4C3}", xlsx: "\u{1F4CA}", zip: "\u{1F4E6}", gz: "\u{1F4E6}",
  docx: "\u{1F4C4}", default: "\u{1F4CE}",
};

/** Render step output with proper formatting: markdown, JSON, images, files, CSV, HTML */
function StepOutputRenderer({ output, expanded }: { output: string; expanded: boolean }) {
  const displayText = expanded ? output : output.slice(0, 3000);
  const isTruncated = !expanded && output.length > 3000;

  const imageUrls = extractImageUrls(output);
  const fileLinks = extractFileLinks(output);
  const { isJson, formatted } = tryFormatJson(output);
  const csv = !isJson ? detectCsv(output) : { isCsv: false, headers: [], rows: [] };
  const isHtml = !isJson && !csv.isCsv && isHtmlContent(output);

  return (
    <>
      {/* Images */}
      {imageUrls.length > 0 && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
          {imageUrls.map((url, i) => (
            <a key={i} href={url} target="_blank" rel="noopener noreferrer" style={{ display: "block" }}>
              <img
                src={url} alt={`Generated image ${i + 1}`}
                style={{ maxWidth: 280, maxHeight: 200, borderRadius: 6, border: "1px solid var(--m-border)", cursor: "zoom-in" }}
                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
              />
            </a>
          ))}
        </div>
      )}

      {/* File download links */}
      {fileLinks.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
          {fileLinks.map((f, i) => (
            <a key={i} href={`/download?path=${encodeURIComponent(f.path)}`}
              download={f.name} target="_blank" rel="noopener noreferrer"
              style={{
                display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 10px",
                borderRadius: 6, fontSize: 10, fontWeight: 600, textDecoration: "none",
                background: "var(--glass-tint)", color: "var(--m-accent)", border: "1px solid var(--m-border)",
              }}>
              {fileTypeIcons[f.type] ?? fileTypeIcons.default} {f.name}
            </a>
          ))}
        </div>
      )}

      {/* CSV table */}
      {csv.isCsv ? (
        <div style={{ overflowX: "auto", marginBottom: 4 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
            <thead>
              <tr>
                {csv.headers.map((h, i) => (
                  <th key={i} style={{ textAlign: "left", padding: "4px 8px", background: "rgba(255,255,255,0.06)", border: "1px solid var(--m-border)", fontWeight: 600, color: "var(--m-text)" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(expanded ? csv.rows : csv.rows.slice(0, 20)).map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j} style={{ padding: "3px 8px", border: "1px solid var(--m-border)", color: "var(--m-text2)", fontSize: 10 }}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {!expanded && csv.rows.length > 20 && (
            <div style={{ fontSize: 9, color: "var(--m-text2)", marginTop: 4 }}>Showing 20/{csv.rows.length} rows</div>
          )}
        </div>
      ) : isHtml ? (
        /* Raw HTML — render in sandboxed iframe */
        <div style={{ border: "1px solid var(--m-border)", borderRadius: 6, overflow: "hidden", marginBottom: 4 }}>
          <div style={{ fontSize: 9, padding: "2px 8px", background: "var(--glass-tint)", color: "var(--m-text2)", borderBottom: "1px solid var(--m-border)" }}>HTML Output</div>
          <iframe
            srcDoc={expanded ? output : output.slice(0, 10000)}
            sandbox="allow-same-origin"
            style={{ width: "100%", height: 200, border: "none", background: "#fff" }}
            title="HTML output"
          />
        </div>
      ) : isJson ? (
        <pre style={{ background: "rgba(0,0,0,0.2)", padding: "8px 10px", borderRadius: 6, fontSize: 10, overflowX: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all", color: "var(--m-text2)" }}>
          {expanded ? formatted : formatted.slice(0, 3000)}
        </pre>
      ) : (
        <div className={styles.stepOutput}>
          {displayText}
          {isTruncated && "\n\n... (truncated)"}
        </div>
      )}
    </>
  );
}

export function ExecResultModal({ executionId, onClose }: ExecResultModalProps) {
  const { serverOnline } = useServerStore();
  const { executions } = useMonitorStore();
  const [exec, setExec] = useState<ChainExecution | null>(null);
  const [activeTab, setActiveTab] = useState<ExecTab>("steps");
  const [copyLabel, setCopyLabel] = useState("Copy");
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());

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

  // Token totals
  const tokenTotals = useMemo(() => {
    let input = 0;
    let output = 0;
    for (const [, s] of steps) {
      input += s.inputTokens ?? 0;
      output += s.outputTokens ?? 0;
    }
    return { input, output, total: input + output };
  }, [steps]);

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
      .map(([id, s]) => {
        // Render images inline
        const imageUrls = extractImageUrls(s.output ?? "");
        const imagesHtml = imageUrls.map(u => `<img src="${esc(u)}" style="max-width:100%;border-radius:8px;margin:8px 0;" />`).join("");
        return `<div class="step-sep">${esc(id)}</div>${imagesHtml}${mdToHtml(s.output ?? "")}`;
      })
      .join("");
    const body = exec?.result ? mdToHtml(exec.result) : stepsHtml;
    const css = `*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display',system-ui,sans-serif;max-width:820px;margin:0 auto;padding:40px 24px 60px;line-height:1.75;color:#e5e5e7;background:#111}h1{font-size:24px;font-weight:700;margin:32px 0 12px;padding-bottom:8px;border-bottom:1px solid #333;color:#fff}h2{font-size:20px;font-weight:600;margin:28px 0 10px;padding-bottom:6px;border-bottom:1px solid #222;color:#fff}h3{font-size:16px;font-weight:600;margin:22px 0 8px;color:#0a84ff}p{margin:10px 0}strong{color:#fff}em{color:#86868b}code{background:rgba(255,255,255,0.08);padding:2px 6px;border-radius:4px;font-family:'SF Mono',monospace;font-size:0.88em;color:#ff9f0a}pre{background:#0a0a0a;padding:16px;border-radius:10px;overflow-x:auto;margin:14px 0;border:1px solid #222}pre code{background:none;padding:0;color:#d4d4d4;font-size:13px}ul,ol{margin:10px 0;padding-left:24px}li{margin:4px 0}blockquote{border-left:3px solid #0a84ff;padding:8px 14px;margin:14px 0;background:rgba(255,255,255,0.02);border-radius:0 6px 6px 0;color:#86868b;font-style:italic}hr{border:none;border-top:1px solid #333;margin:24px 0}table{width:100%;border-collapse:collapse;margin:14px 0;font-size:13px}th{text-align:left;padding:10px 14px;background:rgba(255,255,255,0.06);border:1px solid #333;font-weight:600;color:#fff}td{padding:8px 14px;border:1px solid #222}img{max-width:100%;border-radius:8px;margin:8px 0}.step-sep{margin:32px 0 20px;padding:10px 14px;background:rgba(10,132,255,0.08);border-radius:8px;border-left:3px solid #0a84ff;font-weight:600;font-size:13px;color:#0a84ff;text-transform:uppercase;letter-spacing:0.5px}.header{padding:20px 0 16px;margin-bottom:24px;border-bottom:2px solid #0a84ff}.header h1{margin:0;border:none;padding:0}.header .meta{color:#86868b;font-size:13px;margin-top:4px}.tokens{display:inline-block;background:rgba(255,255,255,0.06);padding:2px 8px;border-radius:4px;font-size:12px;color:#86868b;margin-left:8px}`;
    const tokenInfo = tokenTotals.total > 0 ? `<span class="tokens">${tokenTotals.input}\u2192${tokenTotals.output} tokens (${tokenTotals.total} total)</span>` : "";
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(exec?.chainName ?? "")} — OCC Result</title><style>${css}</style></head><body><div class="header"><h1>${esc(exec?.chainName ?? "")}${tokenInfo}</h1><div class="meta">${esc(exec?.id ?? "")} \u00B7 ${exec?.durationMs ? (exec.durationMs / 1000).toFixed(1) + "s" : "?"} \u00B7 ${new Date(exec?.startedAt ?? "").toLocaleString()}</div></div>${body}</body></html>`;
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const blobUrl = URL.createObjectURL(blob);
    window.open(blobUrl, "_blank", "noopener,noreferrer");
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
  }, [exec, steps, tokenTotals]);

  // Copy
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(getFullText()).then(() => {
      setCopyLabel("Copied!");
      setTimeout(() => setCopyLabel("Copy"), 1500);
    });
  }, [getFullText]);

  // Download images
  const allImageUrls = useMemo(() => {
    const urls: string[] = [];
    for (const [, s] of steps) {
      if (s.output) urls.push(...extractImageUrls(s.output));
    }
    return urls;
  }, [steps]);

  const toggleExpand = useCallback((stepId: string) => {
    setExpandedSteps(prev => {
      const next = new Set(prev);
      if (next.has(stepId)) next.delete(stepId);
      else next.add(stepId);
      return next;
    });
  }, []);

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
                  const isExpanded = expandedSteps.has(stepId);
                  const isLong = (step.output?.length ?? 0) > 3000;

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
                        <>
                          <StepOutputRenderer output={step.output} expanded={isExpanded} />
                          {isLong && (
                            <button
                              onClick={() => toggleExpand(stepId)}
                              style={{
                                background: "none", border: "none", color: "var(--m-accent)",
                                cursor: "pointer", fontSize: 10, padding: "4px 0", fontWeight: 600,
                              }}
                            >
                              {isExpanded ? "Show less" : `Show all (${(step.output.length / 1000).toFixed(0)}K chars)`}
                            </button>
                          )}
                        </>
                      )}
                      {step.error && (
                        <div className={styles.stepErrorMsg}>
                          {"\u26A0"} {step.error.slice(0, 500)}
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
              {/* Render images from all steps */}
              {allImageUrls.length > 0 && (
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12, padding: "8px 0", borderBottom: "1px solid var(--m-border)" }}>
                  {allImageUrls.map((url, i) => (
                    <a key={i} href={url} target="_blank" rel="noopener noreferrer">
                      <img src={url} alt={`Generated ${i + 1}`}
                        style={{ maxWidth: 300, maxHeight: 220, borderRadius: 8, border: "1px solid var(--m-border)", cursor: "zoom-in" }}
                        onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                      />
                    </a>
                  ))}
                </div>
              )}

              {exec.result ? (
                <div dangerouslySetInnerHTML={{ __html: mdToHtml(exec.result) }} />
              ) : steps.filter(([, s]) => s.output).length > 0 ? (
                steps
                  .filter(([, s]) => s.output)
                  .map(([id, s]) => {
                    const stepImages = extractImageUrls(s.output ?? "");
                    return (
                      <div key={id}>
                        <div className={styles.stepSeparator}>{id}</div>
                        {stepImages.length > 0 && (
                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "8px 0" }}>
                            {stepImages.map((url, i) => (
                              <a key={i} href={url} target="_blank" rel="noopener noreferrer">
                                <img src={url} alt={`${id} image ${i + 1}`}
                                  style={{ maxWidth: 300, borderRadius: 6, border: "1px solid var(--m-border)" }}
                                  onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                                />
                              </a>
                            ))}
                          </div>
                        )}
                        <div dangerouslySetInnerHTML={{ __html: mdToHtml(s.output ?? "") }} />
                      </div>
                    );
                  })
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
            {tokenTotals.total > 0 && (
              <span style={{ marginLeft: 8, opacity: 0.7, fontSize: 10 }}
                title={`Input: ${tokenTotals.input} tokens\nOutput: ${tokenTotals.output} tokens\nTotal: ${tokenTotals.total} tokens`}>
                {tokenTotals.input}\u2192{tokenTotals.output} tok ({tokenTotals.total})
              </span>
            )}
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
