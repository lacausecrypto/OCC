/**
 * Settings page — comprehensive Apple-like grouped settings.
 * Full CRUD for MCP servers, Schedules, token usage charts.
 */
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useServerStore } from "../../stores/server";
import { ScheduleSection } from "./ScheduleSection";
import { McpSection } from "./McpSection";
import { ProviderSection } from "./ProviderSection";
import styles from "./Settings.module.css";

// ─── Types ──────────────────────────────────────────────────────────────────

interface HealthData {
  ok: boolean;
  version?: string;
  uptime?: number;
  runningExecutions?: number;
  queuedJobs?: number;
  chainsDir?: string;
  pipelinesDir?: string;
  workspaceDir?: string;
  restPort?: number;
  mcpServers?: string[] | number;
  claudeCli?: string;
  nodeVersion?: string;
  queue?: { queued: number; running: number; completed: number; failed: number };
}

interface QueueStats {
  queued?: number;
  running?: number;
  done?: number;
  errored?: number;
  avgWaitMs?: number;
  workers?: number;
}

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface Schedule {
  id: string;
  label: string;
  chainName: string;
  cron: string;
  enabled: boolean;
  input?: Record<string, string>;
  lastRunAt?: string;
  lastRunStatus?: string;
  nextRunAt?: string;
}

interface LLMProvider {
  id: string;
  name: string;
  type: "claude" | "openrouter" | "openai" | "custom";
  apiKey: string;
  baseUrl: string;
  defaultModel?: string;
  enabled: boolean;
  models?: string[];
  createdAt: string;
}

interface ExecSummary {
  id: string;
  chainName: string;
  status: string;
  startedAt: string;
  finishedAt?: number;
  durationMs?: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatUptime(seconds?: number): string {
  if (!seconds) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(path, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

function Toggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button className={`${styles.toggle} ${on ? styles.toggleOn : ""}`} onClick={onToggle} type="button">
      <div className={styles.toggleDot} />
    </button>
  );
}

// ─── Token Chart Component ──────────────────────────────────────────────────

interface DayTokens { date: string; input: number; output: number }

function TokenChart({ data, label }: { data: DayTokens[]; label: string }) {
  if (data.length === 0) return <div className={styles.chartEmpty}>No execution data yet</div>;

  // Pad to at least 7 days so bars have proper width
  const padded = [...data];
  if (padded.length < 7 && padded.length > 0) {
    const lastDate = new Date(padded[padded.length - 1].date);
    while (padded.length < 7) {
      lastDate.setDate(lastDate.getDate() + 1);
      padded.push({ date: lastDate.toISOString().slice(0, 10), input: 0, output: 0 });
    }
  }

  const maxTokens = Math.max(...padded.map((d) => d.input + d.output), 1);
  const totalInput = data.reduce((s, d) => s + d.input, 0);
  const totalOutput = data.reduce((s, d) => s + d.output, 0);
  const total = totalInput + totalOutput;

  // Y-axis scale labels
  const yLabels = [maxTokens, Math.round(maxTokens * 0.5), 0];
  const formatK = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);

  return (
    <div className={styles.chartWrap}>
      {/* Header */}
      <div className={styles.chartHeader}>
        <span className={styles.chartLabel}>{label}</span>
        <div className={styles.chartSummary}>
          <span className={styles.chartSummaryItem}>
            <span className={styles.legendDot} style={{ background: "var(--m-accent)" }} />
            {formatK(totalInput)} in
          </span>
          <span className={styles.chartSummaryItem}>
            <span className={styles.legendDot} style={{ background: "var(--c-purple)" }} />
            {formatK(totalOutput)} out
          </span>
          <span className={styles.chartSummaryTotal}>{formatK(total)}</span>
        </div>
      </div>

      {/* Chart area */}
      <div className={styles.chartArea}>
        {/* Y-axis */}
        <div className={styles.chartYAxis}>
          {yLabels.map((v) => <span key={v} className={styles.chartYLabel}>{formatK(v)}</span>)}
        </div>

        {/* Grid + Bars */}
        <div className={styles.chartGrid}>
          {/* Horizontal grid lines */}
          <div className={styles.chartGridLine} style={{ top: "0%" }} />
          <div className={styles.chartGridLine} style={{ top: "50%" }} />
          <div className={styles.chartGridLine} style={{ top: "100%" }} />

          {/* Bars */}
          <div className={styles.chartBars}>
            {padded.map((d) => {
              const inputH = (d.input / maxTokens) * 100;
              const outputH = (d.output / maxTokens) * 100;
              const dayTotal = d.input + d.output;
              return (
                <div key={d.date} className={styles.chartBar} title={dayTotal > 0 ? `${d.date}\nInput: ${d.input.toLocaleString()}\nOutput: ${d.output.toLocaleString()}\nTotal: ${dayTotal.toLocaleString()}` : d.date}>
                  <div className={styles.chartBarStack}>
                    {outputH > 0 && <div className={styles.chartBarOutput} style={{ height: `${outputH}%` }} />}
                    {inputH > 0 && <div className={styles.chartBarInput} style={{ height: `${inputH}%` }} />}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* X-axis labels */}
      <div className={styles.chartXAxis}>
        {padded.map((d) => (
          <span key={d.date} className={styles.chartXLabel}>{d.date.slice(5)}</span>
        ))}
      </div>
    </div>
  );
}

// ─── Main Settings ──────────────────────────────────────────────────────────

export function Settings() {
  const { occServerUrl, serverOnline, apiKey, setServerUrl, setApiKey, checkHealth } = useServerStore();

  const [urlInput, setUrlInput] = useState(occServerUrl);
  const [keyInput, setKeyInput] = useState(apiKey ?? "");
  const [health, setHealth] = useState<HealthData | null>(null);
  const [queue, setQueue] = useState<QueueStats | null>(null);
  const [mcpServers, setMcpServers] = useState<Record<string, McpServerConfig>>({});
  const [executions, setExecutions] = useState<ExecSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [testResult, setTestResult] = useState<string | null>(null);

  // Provider and schedule state is managed in sub-components
  // Provider and schedule edit state is managed in their sub-components

  // Token chart state
  const [chartMode, setChartMode] = useState<"daily" | "weekly">("daily");

  // Server config (editable)
  interface ServerConfig {
    chainsDir: string; pipelinesDir: string; workspaceDir: string;
    claudeTimeoutMs: string; maxConcurrentExecutions: string;
    corsOrigin: string; logLevel: string; claudeCli: string;
    // Storage
    occDb: string; occQueueDb: string; occStateDb: string;
    occVectorDb: string; occSemanticCacheDb: string; occGraphDb: string;
    // Logging
    logFormat: string;
    // BLOB
    blobDir: string; blobPlanningModel: string; blobChatModel: string;
    blobStepModel: string; blobAutoCheckSec: string;
    // Rate limits
    rateLimitExec: string; rateLimitGen: string;
    // Execution
    executionMaxAgeDays: string; publicHost: string;
    // Email
    resendApiKey: string; resendFrom: string;
  }
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [configDirty, setConfigDirty] = useState(false);

  const updateConfig = (key: keyof ServerConfig, value: string) => {
    if (!config) return;
    setConfig({ ...config, [key]: value });
    setConfigDirty(true);
  };

  const saveConfig = async () => {
    if (!config) return;
    await fetch("/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    }).catch(() => {});
    setConfigDirty(false);
  };

  // Local settings
  const [autoConnect, setAutoConnect] = useState(() => localStorage.getItem("occ-auto-connect") !== "false");
  const [autoScroll, setAutoScroll] = useState(() => localStorage.getItem("occ-auto-scroll") !== "false");
  const [showMinimap, setShowMinimap] = useState(() => localStorage.getItem("occ-show-minimap") !== "false");

  const loadAll = useCallback(async () => {
    setLoading(true);
    const [h, q, , e, , cfg] = await Promise.all([
      fetchJson<HealthData>("/health"),
      fetchJson<QueueStats>("/queue"),
      fetchJson<Schedule[]>("/schedules"),
      fetchJson<ExecSummary[]>("/executions?limit=200"),
      fetchJson<LLMProvider[]>("/providers"),
      fetchJson<ServerConfig>("/config"),
    ]);
    if (cfg) setConfig(cfg);
    setHealth(h);
    setQueue(q);
    setExecutions(Array.isArray(e) ? e : []);

    // Load MCP config - the /mcp-servers endpoint returns tools, we need the raw config
    // Try fetching the config file shape
    const mcpRaw = await fetchJson<Record<string, McpServerConfig>>("/mcp-servers");
    if (mcpRaw && typeof mcpRaw === "object" && !Array.isArray(mcpRaw)) {
      setMcpServers(mcpRaw);
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  // ─── Token chart data — single aggregated endpoint ──────────────
  const [dailyTokens, setDailyTokens] = useState<DayTokens[]>([]);

  useEffect(() => {
    const fetchTokens = async () => {
      // 1. Chain execution tokens (server-side aggregation — no N+1)
      const chainTokens = await fetchJson<DayTokens[]>("/executions/token-usage?days=30");
      const dayMap = new Map<string, { input: number; output: number }>();
      if (Array.isArray(chainTokens)) {
        for (const d of chainTokens) {
          dayMap.set(d.date, { input: d.input, output: d.output });
        }
      }

      // 2. BLOB session tokens
      try {
        const blobs = await fetchJson<Array<{ id: string }>>("/blobs");
        if (Array.isArray(blobs)) {
          for (const blob of blobs.slice(0, 10)) {
            const graph = await fetchJson<{ nodes?: Array<{ type: string; data: { kind: string; inputTokens?: number; outputTokens?: number }; createdAt?: string }> }>(`/blobs/${blob.id}/graph`);
            if (graph?.nodes) {
              for (const node of graph.nodes) {
                if (node.type === "step" && node.data.inputTokens) {
                  const date = (node.createdAt ?? new Date().toISOString()).slice(0, 10);
                  const entry = dayMap.get(date) ?? { input: 0, output: 0 };
                  entry.input += node.data.inputTokens ?? 0;
                  entry.output += node.data.outputTokens ?? 0;
                  dayMap.set(date, entry);
                }
              }
            }
          }
        }
      } catch { /* blob endpoints may not exist */ }

      const sorted = [...dayMap.entries()]
        .map(([date, t]) => ({ date, ...t }))
        .sort((a, b) => a.date.localeCompare(b.date));

      setDailyTokens(sorted);
    };
    fetchTokens();
  }, [executions]);

  const weeklyTokens = useMemo(() => {
    const weekMap = new Map<string, { input: number; output: number }>();
    for (const d of dailyTokens) {
      const dt = new Date(d.date);
      const weekStart = new Date(dt);
      weekStart.setDate(dt.getDate() - dt.getDay());
      const key = weekStart.toISOString().slice(0, 10);
      const entry = weekMap.get(key) ?? { input: 0, output: 0 };
      entry.input += d.input;
      entry.output += d.output;
      weekMap.set(key, entry);
    }
    return [...weekMap.entries()]
      .map(([date, t]) => ({ date, ...t }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [dailyTokens]);

  // ─── Handlers ─────────────────────────────────────────────────

  const handleTestConnection = async () => {
    setTestResult("Testing...");
    const ok = await checkHealth();
    setTestResult(ok ? "Connected" : "Failed");
    if (ok) loadAll();
    setTimeout(() => setTestResult(null), 3000);
  };

  const handleSaveUrl = () => { setServerUrl(urlInput.trim()); handleTestConnection(); };
  const handleSaveApiKey = () => { setApiKey(keyInput.trim() || null); };

  const handlePurgeQueue = async () => {
    if (!confirm("Purge completed/errored jobs older than 7 days?")) return;
    await fetch("/queue/purge?days=7", { method: "DELETE" }).catch(() => {});
    loadAll();
  };

  const toggleLocal = (key: string, value: boolean, setter: (v: boolean) => void) => {
    setter(value);
    localStorage.setItem(key, String(value));
  };

  // Schedule CRUD is handled in ScheduleSection component

  // ─── Table of contents ────────────────────────────────────────
  // TOC must match the EXACT order of sections in the JSX below
  const tocSections = useMemo(() => [
    { id: "server", label: "Server" },
    { id: "execution", label: "Execution" },
    { id: "providers", label: "Providers" },
    { id: "queue", label: "Queue" },
    { id: "schedules", label: "Schedules" },
    { id: "mcp", label: "MCP Servers" },
    { id: "interface", label: "Interface" },
    { id: "paths", label: "Paths & Security" },
    { id: "storage", label: "Storage" },
    { id: "email", label: "Email" },
    { id: "about", label: "About" },
    { id: "tokens", label: "Token Usage" },
    { id: "blob", label: "BLOB" },
    { id: "data", label: "Data" },
    { id: "shortcuts", label: "Shortcuts" },
  ], []);

  const [activeSection, setActiveSection] = useState("server");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    const observer = new IntersectionObserver(
      (entries) => {
        // Find the topmost visible section
        let topId = "";
        let topY = Infinity;
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const y = entry.boundingClientRect.top;
            if (y < topY) { topY = y; topId = entry.target.id; }
          }
        }
        if (topId) setActiveSection(topId);
      },
      { root: container, threshold: [0, 0.1, 0.3], rootMargin: "-10% 0px -60% 0px" }
    );

    for (const s of tocSections) {
      const el = container.querySelector(`#${s.id}`);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [tocSections, loading]);

  const scrollTo = useCallback((id: string) => {
    const el = scrollRef.current?.querySelector(`#${id}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  return (
    <div className={styles.settings} ref={scrollRef}>
      {/* ─── Sticky TOC sidebar ─── */}
      <nav className={styles.toc}>
        {tocSections.map((s) => (
          <button
            key={s.id}
            className={`${styles.tocItem} ${activeSection === s.id ? styles.tocItemActive : ""}`}
            onClick={() => scrollTo(s.id)}
            type="button"
          >
            {s.label}
          </button>
        ))}
      </nav>

      <div className={styles.settingsInner}>
        <h1 className={styles.pageTitle}>Settings</h1>

        {/* ═══ Server Connection ═══ */}
        <div id="server" className={styles.section}>
          <div className={styles.sectionTitle}>Server Connection</div>
          <div className={styles.sectionCard}>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-blue-bg)" }}>S</div>
              <div className={styles.rowBody}>
                <div className={styles.rowLabel}>Server URL</div>
                <div className={styles.rowDesc}>OCC backend address</div>
              </div>
              <input className={`${styles.rowInput} ${styles.rowInputWide}`} value={urlInput} onChange={(e) => setUrlInput(e.target.value)} onBlur={handleSaveUrl} onKeyDown={(e) => e.key === "Enter" && handleSaveUrl()} placeholder="http://localhost:4242" />
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-green-bg)" }}>H</div>
              <div className={styles.rowBody}><div className={styles.rowLabel}>Status</div></div>
              <span className={`${styles.statusDot} ${serverOnline ? styles.statusOnline : styles.statusOffline}`} />
              <span className={styles.rowValue}>{serverOnline ? "Online" : "Offline"}</span>
              <button className={styles.rowBtn} onClick={handleTestConnection}>{testResult ?? "Test"}</button>
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-orange-bg)" }}>K</div>
              <div className={styles.rowBody}>
                <div className={styles.rowLabel}>API Key</div>
                <div className={styles.rowDesc}>OCC_API_KEY authentication</div>
              </div>
              <input className={styles.rowInput} type="password" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} onBlur={handleSaveApiKey} onKeyDown={(e) => e.key === "Enter" && handleSaveApiKey()} placeholder="Optional" />
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-cyan-bg)" }}>A</div>
              <div className={styles.rowBody}>
                <div className={styles.rowLabel}>Auto-connect SSE</div>
                <div className={styles.rowDesc}>Connect to live events on startup</div>
              </div>
              <Toggle on={autoConnect} onToggle={() => toggleLocal("occ-auto-connect", !autoConnect, setAutoConnect)} />
            </div>
          </div>
        </div>

        {/* ═══ Execution ═══ */}
        <div id="execution" className={styles.section}>
          <div className={styles.sectionTitle}>Execution</div>
          <div className={styles.sectionCard}>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-purple-bg)" }}>P</div>
              <div className={styles.rowBody}>
                <div className={styles.rowLabel}>Max Concurrent Executions</div>
                <div className={styles.rowDesc}>Parallel chain execution slots</div>
              </div>
              <input className={styles.rowInput} type="number" min={1} max={20} value={config?.maxConcurrentExecutions ?? "5"} onChange={(e) => updateConfig("maxConcurrentExecutions", e.target.value)} onBlur={saveConfig} style={{ width: 60, textAlign: "center" }} />
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-red-bg)" }}>T</div>
              <div className={styles.rowBody}>
                <div className={styles.rowLabel}>Claude Timeout (ms)</div>
                <div className={styles.rowDesc}>Max duration per LLM call</div>
              </div>
              <input className={styles.rowInput} type="number" step={60000} value={config?.claudeTimeoutMs ?? "1800000"} onChange={(e) => updateConfig("claudeTimeoutMs", e.target.value)} onBlur={saveConfig} style={{ width: 100, textAlign: "center" }} />
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-cyan-bg)" }}>L</div>
              <div className={styles.rowBody}>
                <div className={styles.rowLabel}>Log Level</div>
                <div className={styles.rowDesc}>Server log verbosity</div>
              </div>
              <select className={styles.rowSelect} value={config?.logLevel ?? "info"} onChange={(e) => { updateConfig("logLevel", e.target.value); setTimeout(saveConfig, 0); }}>
                <option value="debug">Debug</option>
                <option value="info">Info</option>
                <option value="warn">Warn</option>
                <option value="error">Error</option>
              </select>
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--m-text2)" }}>F</div>
              <div className={styles.rowBody}>
                <div className={styles.rowLabel}>Log Format</div>
                <div className={styles.rowDesc}>Output format for server logs</div>
              </div>
              <select className={styles.rowSelect} value={config?.logFormat ?? "text"} onChange={(e) => { updateConfig("logFormat", e.target.value); setTimeout(saveConfig, 0); }}>
                <option value="text">Text (colored)</option>
                <option value="json">JSON (structured)</option>
              </select>
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-blue-bg)" }}>C</div>
              <div className={styles.rowBody}>
                <div className={styles.rowLabel}>Claude CLI Path</div>
                <div className={styles.rowDesc}>Binary path for Claude CLI</div>
              </div>
              <input className={styles.rowInput} value={config?.claudeCli ?? "claude"} onChange={(e) => updateConfig("claudeCli", e.target.value)} onBlur={saveConfig} style={{ width: 120 }} />
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-orange-bg)" }}>A</div>
              <div className={styles.rowBody}>
                <div className={styles.rowLabel}>Execution Max Age (days)</div>
                <div className={styles.rowDesc}>Auto-delete old executions</div>
              </div>
              <input className={styles.rowInput} type="number" min={1} max={365} value={config?.executionMaxAgeDays ?? "7"} onChange={(e) => updateConfig("executionMaxAgeDays", e.target.value)} onBlur={saveConfig} style={{ width: 60, textAlign: "center" }} />
            </div>
          </div>
          {configDirty && <div className={styles.sectionHint} style={{ color: "var(--m-accent)" }}>Changes saved — some settings require server restart.</div>}
        </div>

        {/* ═══ LLM Providers (extracted component) ═══ */}
        <div id="providers"><ProviderSection /></div>

        {/* ═══ Job Queue ═══ */}
        <div id="queue" className={styles.section}>
          <div className={styles.sectionTitle}>Job Queue</div>
          <div className={styles.sectionCard}>
            <div className={styles.row}><div className={styles.rowIcon} style={{ background: "var(--icon-cyan-bg)" }}>Q</div><div className={styles.rowBody}><div className={styles.rowLabel}>Queued</div></div><span className={styles.rowValue}>{queue?.queued ?? 0}</span></div>
            <div className={styles.row}><div className={styles.rowIcon} style={{ background: "var(--icon-blue-bg)" }}>R</div><div className={styles.rowBody}><div className={styles.rowLabel}>Running</div></div><span className={styles.rowValue}>{queue?.running ?? 0}</span></div>
            <div className={styles.row}><div className={styles.rowIcon} style={{ background: "var(--icon-green-bg)" }}>D</div><div className={styles.rowBody}><div className={styles.rowLabel}>Completed</div></div><span className={styles.rowValue}>{queue?.done ?? 0}</span></div>
            <div className={styles.row}><div className={styles.rowIcon} style={{ background: "var(--icon-red-bg)" }}>E</div><div className={styles.rowBody}><div className={styles.rowLabel}>Errored</div></div><span className={styles.rowValue}>{queue?.errored ?? 0}</span></div>
            {queue?.avgWaitMs != null && queue.avgWaitMs > 0 && (
              <div className={styles.row}><div className={styles.rowIcon} style={{ background: "var(--icon-orange-bg)" }}>W</div><div className={styles.rowBody}><div className={styles.rowLabel}>Avg Wait</div></div><span className={styles.rowValue}>{(queue.avgWaitMs / 1000).toFixed(1)}s</span></div>
            )}
            <div className={styles.row}>
              <div className={styles.rowBody} />
              <button className={styles.rowBtn} onClick={loadAll}>Refresh</button>
              <button className={`${styles.rowBtn} ${styles.rowBtnDanger}`} onClick={handlePurgeQueue}>Purge Old</button>
            </div>
          </div>
        </div>

        {/* ═══ Schedules (extracted component) ═══ */}
        <div id="schedules"><ScheduleSection /></div>

        {/* ═══ MCP Servers (extracted component) ═══ */}
        <div id="mcp"><McpSection /></div>

        {/* ═══ Interface ═══ */}
        <div id="interface" className={styles.section}>
          <div className={styles.sectionTitle}>Interface</div>
          <div className={styles.sectionCard}>
            <div className={styles.row}><div className={styles.rowIcon} style={{ background: "var(--icon-cyan-bg)" }}>M</div><div className={styles.rowBody}><div className={styles.rowLabel}>Show Minimap</div><div className={styles.rowDesc}>Canvas minimap overlay</div></div><Toggle on={showMinimap} onToggle={() => toggleLocal("occ-show-minimap", !showMinimap, setShowMinimap)} /></div>
            <div className={styles.row}><div className={styles.rowIcon} style={{ background: "var(--icon-purple-bg)" }}>S</div><div className={styles.rowBody}><div className={styles.rowLabel}>Auto-scroll Logs</div><div className={styles.rowDesc}>Scroll to latest log entry</div></div><Toggle on={autoScroll} onToggle={() => toggleLocal("occ-auto-scroll", !autoScroll, setAutoScroll)} /></div>
          </div>
        </div>

        {/* ═══ Paths & Security ═══ */}
        <div id="paths" className={styles.section}>
          <div className={styles.sectionTitle}>Paths & Security</div>
          <div className={styles.sectionCard}>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--m-text2)" }}>C</div>
              <div className={styles.rowBody}><div className={styles.rowLabel}>Chains Directory</div></div>
              <input className={styles.rowInput} value={config?.chainsDir ?? "./chains"} onChange={(e) => updateConfig("chainsDir", e.target.value)} onBlur={saveConfig} style={{ width: 160 }} />
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--m-text2)" }}>P</div>
              <div className={styles.rowBody}><div className={styles.rowLabel}>Pipelines Directory</div></div>
              <input className={styles.rowInput} value={config?.pipelinesDir ?? "./pipelines"} onChange={(e) => updateConfig("pipelinesDir", e.target.value)} onBlur={saveConfig} style={{ width: 160 }} />
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--m-text2)" }}>W</div>
              <div className={styles.rowBody}><div className={styles.rowLabel}>Workspace</div><div className={styles.rowDesc}>File operations sandbox</div></div>
              <input className={styles.rowInput} value={config?.workspaceDir ?? "."} onChange={(e) => updateConfig("workspaceDir", e.target.value)} onBlur={saveConfig} style={{ width: 160 }} />
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-cyan-bg)" }}>O</div>
              <div className={styles.rowBody}><div className={styles.rowLabel}>CORS Origin</div><div className={styles.rowDesc}>Allowed origin (* for all)</div></div>
              <input className={styles.rowInput} value={config?.corsOrigin ?? ""} onChange={(e) => updateConfig("corsOrigin", e.target.value)} onBlur={saveConfig} placeholder="*" style={{ width: 160 }} />
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-green-bg)" }}>H</div>
              <div className={styles.rowBody}><div className={styles.rowLabel}>Public Host</div><div className={styles.rowDesc}>Hostname for approval callbacks</div></div>
              <input className={styles.rowInput} value={config?.publicHost ?? "localhost"} onChange={(e) => updateConfig("publicHost", e.target.value)} onBlur={saveConfig} placeholder="localhost" style={{ width: 160 }} />
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-red-bg)" }}>R</div>
              <div className={styles.rowBody}>
                <div className={styles.rowLabel}>Rate Limiting</div>
                <div className={styles.rowDesc}>Requests per minute</div>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ fontSize: 11, opacity: 0.6 }}>Exec</span>
                <input className={styles.rowInput} type="number" min={1} max={1000} value={config?.rateLimitExec ?? "20"} onChange={(e) => updateConfig("rateLimitExec", e.target.value)} onBlur={saveConfig} style={{ width: 55, textAlign: "center" }} />
                <span style={{ fontSize: 11, opacity: 0.6 }}>Gen</span>
                <input className={styles.rowInput} type="number" min={1} max={100} value={config?.rateLimitGen ?? "5"} onChange={(e) => updateConfig("rateLimitGen", e.target.value)} onBlur={saveConfig} style={{ width: 55, textAlign: "center" }} />
              </div>
            </div>
            <div className={styles.row}><div className={styles.rowIcon} style={{ background: "var(--icon-orange-bg)" }}>S</div><div className={styles.rowBody}><div className={styles.rowLabel}>SSRF Protection</div><div className={styles.rowDesc}>Blocks private IPs</div></div><span className={styles.rowValue}>Enabled</span></div>
          </div>
          {configDirty && <div className={styles.sectionHint} style={{ color: "var(--m-accent)" }}>Saved — restart server to apply path changes.</div>}
        </div>

        {/* ═══ Storage ═══ */}
        <div id="storage" className={styles.section}>
          <div className={styles.sectionTitle}>Storage</div>
          <div className={styles.sectionCard}>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-orange-bg)" }}>M</div>
              <div className={styles.rowBody}><div className={styles.rowLabel}>Main Database</div><div className={styles.rowDesc}>OCC_DB — executions & checkpoints</div></div>
              <input className={styles.rowInput} value={config?.occDb ?? "./occ.db"} onChange={(e) => updateConfig("occDb", e.target.value)} onBlur={saveConfig} style={{ width: 180 }} />
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-cyan-bg)" }}>Q</div>
              <div className={styles.rowBody}><div className={styles.rowLabel}>Queue Database</div><div className={styles.rowDesc}>OCC_QUEUE_DB — job queue</div></div>
              <input className={styles.rowInput} value={config?.occQueueDb ?? "./occ-queue.db"} onChange={(e) => updateConfig("occQueueDb", e.target.value)} onBlur={saveConfig} style={{ width: 180 }} />
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-green-bg)" }}>S</div>
              <div className={styles.rowBody}><div className={styles.rowLabel}>State Database</div><div className={styles.rowDesc}>OCC_STATE_DB — state_save/state_load</div></div>
              <input className={styles.rowInput} value={config?.occStateDb ?? ""} onChange={(e) => updateConfig("occStateDb", e.target.value)} onBlur={saveConfig} placeholder="/tmp/occ-state.db" style={{ width: 180 }} />
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-purple-bg)" }}>V</div>
              <div className={styles.rowBody}><div className={styles.rowLabel}>Vector Database</div><div className={styles.rowDesc}>OCC_VECTOR_DB — embeddings</div></div>
              <input className={styles.rowInput} value={config?.occVectorDb ?? ""} onChange={(e) => updateConfig("occVectorDb", e.target.value)} onBlur={saveConfig} placeholder="/tmp/occ-vectors.db" style={{ width: 180 }} />
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-red-bg)" }}>C</div>
              <div className={styles.rowBody}><div className={styles.rowLabel}>Semantic Cache DB</div></div>
              <input className={styles.rowInput} value={config?.occSemanticCacheDb ?? ""} onChange={(e) => updateConfig("occSemanticCacheDb", e.target.value)} onBlur={saveConfig} placeholder="/tmp/occ-semantic-cache.db" style={{ width: 180 }} />
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--m-text2)" }}>G</div>
              <div className={styles.rowBody}><div className={styles.rowLabel}>Graph Database</div></div>
              <input className={styles.rowInput} value={config?.occGraphDb ?? ""} onChange={(e) => updateConfig("occGraphDb", e.target.value)} onBlur={saveConfig} placeholder="/tmp/occ-graph.db" style={{ width: 180 }} />
            </div>
          </div>
          {configDirty && <div className={styles.sectionHint} style={{ color: "var(--m-accent)" }}>Saved — restart server to apply storage changes.</div>}
        </div>

        {/* ═══ Email (Resend) ═══ */}
        <div id="email" className={styles.section}>
          <div className={styles.sectionTitle}>Email</div>
          <div className={styles.sectionCard}>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-blue-bg)" }}>R</div>
              <div className={styles.rowBody}>
                <div className={styles.rowLabel}>Resend API Key</div>
                <div className={styles.rowDesc}>For email pre-tool notifications</div>
              </div>
              <input className={styles.rowInput} type="password" value={config?.resendApiKey ?? ""} onChange={(e) => updateConfig("resendApiKey", e.target.value)} onBlur={saveConfig} placeholder="re_xxxxx" style={{ width: 180 }} />
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-green-bg)" }}>F</div>
              <div className={styles.rowBody}>
                <div className={styles.rowLabel}>From Address</div>
                <div className={styles.rowDesc}>Sender email address</div>
              </div>
              <input className={styles.rowInput} value={config?.resendFrom ?? ""} onChange={(e) => updateConfig("resendFrom", e.target.value)} onBlur={saveConfig} placeholder="noreply@yourdomain.com" style={{ width: 200 }} />
            </div>
          </div>
          <div className={styles.sectionHint}>Optional — used by the email pre-tool in chains. Provider: Resend.</div>
        </div>

        {/* ═══ About + Token Usage Charts ═══ */}
        <div id="about" className={styles.section}>
          <div className={styles.sectionTitle}>About</div>
          <div className={styles.sectionCard}>
            <div className={styles.statsGrid}>
              <div className={styles.statCell}><span className={styles.statValue}>{health?.version ?? "—"}</span><span className={styles.statLabel}>Version</span></div>
              <div className={styles.statCell}><span className={styles.statValue}>{formatUptime(health?.uptime)}</span><span className={styles.statLabel}>Uptime</span></div>
              <div className={styles.statCell}><span className={styles.statValue}>{health?.restPort ?? 4242}</span><span className={styles.statLabel}>Port</span></div>
              <div className={styles.statCell}><span className={styles.statValue}>{Array.isArray(health?.mcpServers) ? health.mcpServers.length : (health?.mcpServers ?? Object.keys(mcpServers).length)}</span><span className={styles.statLabel}>MCP Servers</span></div>
            </div>
            <div className={styles.row}><div className={styles.rowBody}><div className={styles.rowLabel}>Claude CLI</div></div><span className={styles.rowValue}>{health?.claudeCli ?? "claude"}</span></div>
            <div className={styles.row}><div className={styles.rowBody}><div className={styles.rowLabel}>Node.js</div></div><span className={styles.rowValue}>{health?.nodeVersion ?? "—"}</span></div>
            <div className={styles.row}><div className={styles.rowBody}><div className={styles.rowLabel}>Storage</div></div><span className={styles.rowValue}>SQLite WAL</span></div>
            <div className={styles.row}><div className={styles.rowBody}><div className={styles.rowLabel}>Total Executions</div></div><span className={styles.rowValue}>{executions.length}</span></div>
          </div>
        </div>

        {/* ═══ Token Usage Charts ═══ */}
        <div id="tokens" className={styles.section}>
          <div className={styles.sectionTitle}>
            Token Usage
            <div className={styles.chartModeToggle}>
              <button className={`${styles.chartModeBtn} ${chartMode === "daily" ? styles.chartModeBtnActive : ""}`} onClick={() => setChartMode("daily")}>Daily</button>
              <button className={`${styles.chartModeBtn} ${chartMode === "weekly" ? styles.chartModeBtnActive : ""}`} onClick={() => setChartMode("weekly")}>Weekly</button>
            </div>
          </div>
          <div className={styles.sectionCard}>
            <div style={{ padding: 16 }}>
              <TokenChart
                data={chartMode === "daily" ? dailyTokens.slice(-14) : weeklyTokens.slice(-8)}
                label={chartMode === "daily" ? "Last 14 Days" : "Last 8 Weeks"}
              />
            </div>
          </div>
        </div>

        {/* ═══ BLOB Configuration ═══ */}
        <div id="blob" className={styles.section}>
          <div className={styles.sectionTitle}>BLOB</div>
          <div className={styles.sectionCard}>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-green-bg)" }}>P</div>
              <div className={styles.rowBody}>
                <div className={styles.rowLabel}>Planning Model</div>
                <div className={styles.rowDesc}>LLM for graph planning (fast + cheap)</div>
              </div>
              <input className={styles.rowInput} value={config?.blobPlanningModel ?? "claude-haiku-4-5"} onChange={(e) => updateConfig("blobPlanningModel", e.target.value)} onBlur={saveConfig} style={{ width: 180 }} />
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-blue-bg)" }}>C</div>
              <div className={styles.rowBody}>
                <div className={styles.rowLabel}>Chat Model</div>
                <div className={styles.rowDesc}>LLM for conversational responses</div>
              </div>
              <input className={styles.rowInput} value={config?.blobChatModel ?? "claude-sonnet-4-6"} onChange={(e) => updateConfig("blobChatModel", e.target.value)} onBlur={saveConfig} style={{ width: 180 }} />
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-purple-bg)" }}>E</div>
              <div className={styles.rowBody}>
                <div className={styles.rowLabel}>Step Execution Model</div>
                <div className={styles.rowDesc}>LLM for workflow step execution</div>
              </div>
              <input className={styles.rowInput} value={config?.blobStepModel ?? "claude-sonnet-4-6"} onChange={(e) => updateConfig("blobStepModel", e.target.value)} onBlur={saveConfig} style={{ width: 180 }} />
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-cyan-bg)" }}>T</div>
              <div className={styles.rowBody}>
                <div className={styles.rowLabel}>Autonomous Check Interval</div>
                <div className={styles.rowDesc}>Seconds between autonomous polls</div>
              </div>
              <input className={styles.rowInput} type="number" min={10} max={3600} value={config?.blobAutoCheckSec ?? "60"} onChange={(e) => updateConfig("blobAutoCheckSec", e.target.value)} onBlur={saveConfig} style={{ width: 80, textAlign: "center" }} />
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--m-text2)" }}>D</div>
              <div className={styles.rowBody}>
                <div className={styles.rowLabel}>BLOB Directory</div>
                <div className={styles.rowDesc}>Storage for session graphs</div>
              </div>
              <input className={styles.rowInput} value={config?.blobDir ?? "./blobs"} onChange={(e) => updateConfig("blobDir", e.target.value)} onBlur={saveConfig} style={{ width: 160 }} />
            </div>
          </div>
          {configDirty && <div className={styles.sectionHint} style={{ color: "var(--m-accent)" }}>Saved — restart server to apply BLOB changes.</div>}
        </div>

        {/* ═══ Data Management ═══ */}
        <div id="data" className={styles.section}>
          <div className={styles.sectionTitle}>Data Management</div>

          {/* BLOB data */}
          <div className={styles.sectionCard}>
            <div className={styles.sectionSubtitle}>BLOB</div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-orange-bg)" }}>{"\u{1F9E0}"}</div>
              <div className={styles.rowBody}>
                <div className={styles.rowLabel}>Knowledge Graph</div>
                <div className={styles.rowDesc}>Clear all extracted concepts and facts</div>
              </div>
              <button className={`${styles.rowBtn} ${styles.rowBtnDanger}`} onClick={async () => {
                if (!confirm("Delete ALL knowledge entries? This cannot be undone.")) return;
                await fetch("/knowledge", { method: "DELETE" }).catch(() => {});
                localStorage.removeItem("occ-blob-knowledge");
                alert("Knowledge graph cleared.");
              }}>Clear</button>
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-red-bg)" }}>{"\u{1F5D1}"}</div>
              <div className={styles.rowBody}>
                <div className={styles.rowLabel}>All BLOB Sessions</div>
                <div className={styles.rowDesc}>Delete all sessions, graphs, and messages</div>
              </div>
              <button className={`${styles.rowBtn} ${styles.rowBtnDanger}`} onClick={async () => {
                if (!confirm("Delete ALL blob sessions and their data? This cannot be undone.")) return;
                const sessions = await fetchJson<Array<{ id: string }>>("/blobs");
                if (Array.isArray(sessions)) {
                  for (const s of sessions) {
                    await fetch(`/blobs/${s.id}`, { method: "DELETE" }).catch(() => {});
                    localStorage.removeItem(`occ-blob-${s.id}`);
                  }
                }
                localStorage.removeItem("occ-blob-sessions");
                localStorage.removeItem("occ-blob-active-session");
                localStorage.removeItem("occ-blob-knowledge");
                alert("All BLOB sessions deleted.");
              }}>Delete All</button>
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-green-bg)" }}>{"\u{1F4E4}"}</div>
              <div className={styles.rowBody}>
                <div className={styles.rowLabel}>Export Knowledge</div>
                <div className={styles.rowDesc}>Download knowledge graph as JSON</div>
              </div>
              <button className={styles.rowBtn} onClick={async () => {
                const data = await fetchJson<unknown[]>("/knowledge");
                if (!data) return;
                const b = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
                const u = URL.createObjectURL(b);
                const a = document.createElement("a");
                a.href = u; a.download = `occ-knowledge-${new Date().toISOString().slice(0, 10)}.json`;
                a.click(); URL.revokeObjectURL(u);
              }}>Export</button>
            </div>
          </div>

          {/* Executions data */}
          <div className={styles.sectionCard}>
            <div className={styles.sectionSubtitle}>Executions</div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-blue-bg)" }}>{"\u{1F4CA}"}</div>
              <div className={styles.rowBody}>
                <div className={styles.rowLabel}>Execution History</div>
                <div className={styles.rowDesc}>Clear all chain/pipeline execution records from database</div>
              </div>
              <button className={`${styles.rowBtn} ${styles.rowBtnDanger}`} onClick={async () => {
                if (!confirm("Delete ALL execution history? This cannot be undone.")) return;
                await fetch("/executions", { method: "DELETE" }).catch(() => {});
                alert("Execution history cleared.");
              }}>Clear</button>
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-cyan-bg)" }}>{"\u{1F4CB}"}</div>
              <div className={styles.rowBody}>
                <div className={styles.rowLabel}>Queue</div>
                <div className={styles.rowDesc}>Clear pending and completed queue entries</div>
              </div>
              <button className={`${styles.rowBtn} ${styles.rowBtnDanger}`} onClick={async () => {
                if (!confirm("Clear the execution queue?")) return;
                await fetch("/queue", { method: "DELETE" }).catch(() => {});
                alert("Queue cleared.");
              }}>Clear</button>
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-green-bg)" }}>{"\u{1F4E4}"}</div>
              <div className={styles.rowBody}>
                <div className={styles.rowLabel}>Export Executions</div>
                <div className={styles.rowDesc}>Download execution history as JSON</div>
              </div>
              <button className={styles.rowBtn} onClick={async () => {
                const data = await fetchJson<unknown[]>("/executions?limit=1000");
                if (!data) return;
                const b = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
                const u = URL.createObjectURL(b);
                const a = document.createElement("a");
                a.href = u; a.download = `occ-executions-${new Date().toISOString().slice(0, 10)}.json`;
                a.click(); URL.revokeObjectURL(u);
              }}>Export</button>
            </div>
          </div>

          {/* Schedules data */}
          <div className={styles.sectionCard}>
            <div className={styles.sectionSubtitle}>Schedules</div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-purple-bg)" }}>{"\u{1F4C5}"}</div>
              <div className={styles.rowBody}>
                <div className={styles.rowLabel}>All Schedules</div>
                <div className={styles.rowDesc}>Delete all scheduled jobs</div>
              </div>
              <button className={`${styles.rowBtn} ${styles.rowBtnDanger}`} onClick={async () => {
                if (!confirm("Delete ALL schedules?")) return;
                const scheds = await fetchJson<Array<{ id: string }>>("/schedules");
                if (Array.isArray(scheds)) {
                  for (const s of scheds) await fetch(`/schedules/${s.id}`, { method: "DELETE" }).catch(() => {});
                }
                alert("All schedules deleted.");
              }}>Delete All</button>
            </div>
          </div>

          {/* Local storage */}
          <div className={styles.sectionCard}>
            <div className={styles.sectionSubtitle}>Local Storage</div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--m-text2)" }}>{"\u{1F4BE}"}</div>
              <div className={styles.rowBody}>
                <div className={styles.rowLabel}>All Local Data</div>
                <div className={styles.rowDesc}>Clear all OCC data from browser localStorage</div>
              </div>
              <button className={`${styles.rowBtn} ${styles.rowBtnDanger}`} onClick={() => {
                if (!confirm("Clear ALL local OCC data? This resets UI preferences, BLOB cache, and design presets.")) return;
                Object.keys(localStorage).filter((k) => k.startsWith("occ-")).forEach((k) => localStorage.removeItem(k));
                alert("Local data cleared. Refreshing...");
                setTimeout(() => location.reload(), 500);
              }}>Clear All</button>
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-cyan-bg)" }}>{"\u{1F9EC}"}</div>
              <div className={styles.rowBody}>
                <div className={styles.rowLabel}>BLOB Cache Only</div>
                <div className={styles.rowDesc}>Clear BLOB sessions/graphs from localStorage (keeps backend)</div>
              </div>
              <button className={styles.rowBtn} onClick={() => {
                Object.keys(localStorage).filter((k) => k.startsWith("occ-blob")).forEach((k) => localStorage.removeItem(k));
                alert("BLOB local cache cleared.");
              }}>Clear</button>
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-orange-bg)" }}>{"\u{1F3A8}"}</div>
              <div className={styles.rowBody}>
                <div className={styles.rowLabel}>Design Presets</div>
                <div className={styles.rowDesc}>Reset design space presets and blend position</div>
              </div>
              <button className={styles.rowBtn} onClick={() => {
                Object.keys(localStorage).filter((k) => k.startsWith("occ-design") || k.startsWith("occ-blend")).forEach((k) => localStorage.removeItem(k));
                alert("Design presets reset. Refresh to apply.");
              }}>Reset</button>
            </div>
          </div>

          <div className={styles.sectionHint}>
            Backend data (executions, chains, BLOB) is stored in SQLite and JSON files on the server. Local data is stored in the browser.
          </div>
        </div>

        {/* ═══ Keyboard Shortcuts ═══ */}
        <div id="shortcuts" className={styles.section}>
          <div className={styles.sectionTitle}>Keyboard Shortcuts</div>
          <div className={styles.sectionCard}>
            <div className={styles.row}><div className={styles.rowBody}><div className={styles.rowLabel}>Dashboard</div></div><span className={styles.rowValue}>1</span></div>
            <div className={styles.row}><div className={styles.rowBody}><div className={styles.rowLabel}>Workflow</div></div><span className={styles.rowValue}>2</span></div>
            <div className={styles.row}><div className={styles.rowBody}><div className={styles.rowLabel}>BLOB</div></div><span className={styles.rowValue}>3</span></div>
            <div className={styles.row}><div className={styles.rowBody}><div className={styles.rowLabel}>Settings</div></div><span className={styles.rowValue}>4</span></div>
            <div className={styles.row}><div className={styles.rowBody}><div className={styles.rowLabel}>Toggle Design Space</div></div><span className={styles.rowValue}>[</span></div>
            <div className={styles.row}><div className={styles.rowBody}><div className={styles.rowLabel}>Toggle Live Monitor</div></div><span className={styles.rowValue}>]</span></div>
            <div className={styles.row}><div className={styles.rowBody}><div className={styles.rowLabel}>Delete selected</div></div><span className={styles.rowValue}>Del / Backspace</span></div>
          </div>
        </div>

      </div>
    </div>
  );
}
