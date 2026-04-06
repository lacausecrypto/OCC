/**
 * Settings page — comprehensive Apple-like grouped settings.
 * Full CRUD for MCP servers, Schedules, token usage charts.
 */
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { useServerStore } from "../../stores/server";
import { ScheduleSection } from "./ScheduleSection";
import { McpSection } from "./McpSection";
import { ProviderSection } from "./ProviderSection";
import { OllamaSection } from "./OllamaSection";
import { useShortcutStore, formatCombo } from "../../stores/shortcuts";
import type { ShortcutAction, KeyCombo } from "../../stores/shortcuts";
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
  platform?: string;
  arch?: string;
  pid?: number;
  memoryMB?: number;
  heapUsedMB?: number;
  heapTotalMB?: number;
  chainCount?: number;
  pipelineCount?: number;
  dbSizes?: Record<string, number>;
  dbTotalBytes?: number;
  blobBytes?: number;
  blobSessionCount?: number;
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

function formatBytes(bytes?: number): string {
  if (!bytes || bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

function formatUptime(seconds?: number): string {
  if (!seconds) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ─── Info tooltip component ─────────────────────────────────────────────────

function InfoTip({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (btnRef.current?.contains(e.target as Node)) return;
      if (bubbleRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const handleToggle = () => {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      const bubbleW = 320;
      let left = rect.left + rect.width / 2 - bubbleW / 2;
      if (left < 8) left = 8;
      if (left + bubbleW > window.innerWidth - 8) left = window.innerWidth - bubbleW - 8;
      setPos({ top: rect.top - 8, left });
    }
    setOpen(!open);
  };

  return (
    <>
      <button ref={btnRef} className={styles.infoTipBtn} onClick={handleToggle} type="button" aria-label="Info">i</button>
      {open && createPortal(
        <div ref={bubbleRef} className={styles.infoTipBubble} style={{ top: pos.top, left: pos.left }}>
          {text}
        </div>,
        document.body,
      )}
    </>
  );
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

// ─── Token Usage Dashboard ──────────────────────────────────────────────────

interface SourceTokens { input: number; output: number; count: number }
interface DayDetailed {
  date: string;
  chains: SourceTokens;
  pipelines: SourceTokens;
  blob: SourceTokens;
}
interface TokenUsageDetailed {
  days: number;
  totals: { input: number; output: number; executions: number };
  daily: DayDetailed[];
  topChains: Array<{ name: string; input: number; output: number; count: number; total: number }>;
}

const SOURCE_COLORS = {
  chains: "var(--m-accent)",
  pipelines: "var(--c-purple, #bf5af2)",
  blob: "var(--icon-green, #30d158)",
};
const SOURCE_LABELS = { chains: "Chains", pipelines: "Pipelines", blob: "The Blob" };

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

function TokenDashboard({ data, mode }: { data: TokenUsageDetailed | null; mode: "daily" | "weekly" }) {
  // Aggregate daily → weekly if needed (hook must be called unconditionally)
  const chartData = useMemo(() => {
    if (!data || data.daily.length === 0) return [];
    if (mode === "daily") return data.daily.slice(-14);
    const weekMap = new Map<string, DayDetailed>();
    for (const d of data.daily) {
      const dt = new Date(d.date);
      const weekStart = new Date(dt);
      weekStart.setDate(dt.getDate() - dt.getDay());
      const key = weekStart.toISOString().slice(0, 10);
      const existing = weekMap.get(key) ?? { date: key, chains: { input: 0, output: 0, count: 0 }, pipelines: { input: 0, output: 0, count: 0 }, blob: { input: 0, output: 0, count: 0 } };
      for (const src of ["chains", "pipelines", "blob"] as const) {
        existing[src].input += d[src].input;
        existing[src].output += d[src].output;
        existing[src].count += d[src].count;
      }
      weekMap.set(key, existing);
    }
    return [...weekMap.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-8);
  }, [data, mode]);

  if (!data || chartData.length === 0) return <div className={styles.chartEmpty}>No execution data yet</div>;

  // Pad to at least 7 entries
  const padded = [...chartData];
  while (padded.length < 7 && padded.length > 0) {
    const lastDate = new Date(padded[padded.length - 1].date);
    lastDate.setDate(lastDate.getDate() + (mode === "weekly" ? 7 : 1));
    padded.push({ date: lastDate.toISOString().slice(0, 10), chains: { input: 0, output: 0, count: 0 }, pipelines: { input: 0, output: 0, count: 0 }, blob: { input: 0, output: 0, count: 0 } });
  }

  const maxTokens = Math.max(...padded.map((d) => {
    let total = 0;
    for (const src of ["chains", "pipelines", "blob"] as const) total += d[src].input + d[src].output;
    return total;
  }), 1);
  const yLabels = [maxTokens, Math.round(maxTokens * 0.5), 0];

  // Source totals for legend
  const sourceTotals = { chains: 0, pipelines: 0, blob: 0 };
  for (const d of data.daily) {
    for (const src of ["chains", "pipelines", "blob"] as const) {
      sourceTotals[src] += d[src].input + d[src].output;
    }
  }
  const activeSources = (["chains", "pipelines", "blob"] as const).filter((s) => sourceTotals[s] > 0);

  return (
    <div className={styles.chartWrap}>
      {/* ── Summary cards ── */}
      <div className={styles.tokenSummaryRow}>
        <div className={styles.tokenSummaryCard}>
          <div className={styles.tokenSummaryValue}>{formatTokens(data.totals.input + data.totals.output)}</div>
          <div className={styles.tokenSummaryLabel}>Total tokens</div>
        </div>
        <div className={styles.tokenSummaryCard}>
          <div className={styles.tokenSummaryValue}>{formatTokens(data.totals.input)}</div>
          <div className={styles.tokenSummaryLabel}>Input</div>
        </div>
        <div className={styles.tokenSummaryCard}>
          <div className={styles.tokenSummaryValue}>{formatTokens(data.totals.output)}</div>
          <div className={styles.tokenSummaryLabel}>Output</div>
        </div>
        <div className={styles.tokenSummaryCard}>
          <div className={styles.tokenSummaryValue}>{data.totals.executions}</div>
          <div className={styles.tokenSummaryLabel}>Executions</div>
        </div>
      </div>

      {/* ── Source breakdown legend ── */}
      <div className={styles.chartHeader}>
        <span className={styles.chartLabel}>{mode === "daily" ? "Last 14 Days" : "Last 8 Weeks"}</span>
        <div className={styles.chartSummary}>
          {activeSources.map((src) => (
            <span key={src} className={styles.chartSummaryItem}>
              <span className={styles.legendDot} style={{ background: SOURCE_COLORS[src] }} />
              {SOURCE_LABELS[src]} {formatTokens(sourceTotals[src])}
            </span>
          ))}
        </div>
      </div>

      {/* ── Stacked bar chart ── */}
      <div className={styles.chartArea}>
        <div className={styles.chartYAxis}>
          {yLabels.map((v) => <span key={v} className={styles.chartYLabel}>{formatTokens(v)}</span>)}
        </div>
        <div className={styles.chartGrid}>
          <div className={styles.chartGridLine} style={{ top: "0%" }} />
          <div className={styles.chartGridLine} style={{ top: "50%" }} />
          <div className={styles.chartGridLine} style={{ top: "100%" }} />
          <div className={styles.chartBars}>
            {padded.map((d) => {
              const chainH = ((d.chains.input + d.chains.output) / maxTokens) * 100;
              const pipeH = ((d.pipelines.input + d.pipelines.output) / maxTokens) * 100;
              const blobH = ((d.blob.input + d.blob.output) / maxTokens) * 100;
              const dayTotal = d.chains.input + d.chains.output + d.pipelines.input + d.pipelines.output + d.blob.input + d.blob.output;
              return (
                <div key={d.date} className={styles.chartBar} title={dayTotal > 0 ? `${d.date}\nChains: ${(d.chains.input + d.chains.output).toLocaleString()}\nPipelines: ${(d.pipelines.input + d.pipelines.output).toLocaleString()}\nBlob: ${(d.blob.input + d.blob.output).toLocaleString()}\nTotal: ${dayTotal.toLocaleString()}` : d.date}>
                  <div className={styles.chartBarStack}>
                    {blobH > 0 && <div className={styles.chartBarSegment} style={{ height: `${blobH}%`, background: SOURCE_COLORS.blob }} />}
                    {pipeH > 0 && <div className={styles.chartBarSegment} style={{ height: `${pipeH}%`, background: SOURCE_COLORS.pipelines }} />}
                    {chainH > 0 && <div className={styles.chartBarSegment} style={{ height: `${chainH}%`, background: SOURCE_COLORS.chains }} />}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <div className={styles.chartXAxis}>
        {padded.map((d) => (
          <span key={d.date} className={styles.chartXLabel}>{d.date.slice(5)}</span>
        ))}
      </div>

      {/* ── Top chains table ── */}
      {data.topChains.length > 0 && (
        <div className={styles.tokenTable}>
          <div className={styles.tokenTableHeader}>
            <span>Chain / Source</span>
            <span style={{ textAlign: "right" }}>Runs</span>
            <span style={{ textAlign: "right" }}>Input</span>
            <span style={{ textAlign: "right" }}>Output</span>
            <span style={{ textAlign: "right" }}>Total</span>
          </div>
          {data.topChains.map((c) => {
            const pct = data.totals.input + data.totals.output > 0 ? ((c.total / (data.totals.input + data.totals.output)) * 100) : 0;
            const isBlob = c.name.startsWith("blob_");
            return (
              <div key={c.name} className={styles.tokenTableRow}>
                <span className={styles.tokenTableName}>
                  <span className={styles.legendDot} style={{ background: isBlob ? SOURCE_COLORS.blob : SOURCE_COLORS.chains }} />
                  {isBlob ? "Blob session" : c.name}
                </span>
                <span className={styles.tokenTableNum}>{c.count}</span>
                <span className={styles.tokenTableNum}>{formatTokens(c.input)}</span>
                <span className={styles.tokenTableNum}>{formatTokens(c.output)}</span>
                <span className={styles.tokenTableNum}>
                  {formatTokens(c.total)}
                  <span className={styles.tokenTablePct}>{pct.toFixed(0)}%</span>
                </span>
              </div>
            );
          })}
        </div>
      )}
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

  // Keyboard shortcut editing
  const shortcutStore = useShortcutStore();
  const [editingShortcut, setEditingShortcut] = useState<ShortcutAction | null>(null);

  useEffect(() => {
    if (!editingShortcut) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") { setEditingShortcut(null); return; }
      // Ignore standalone modifier keys
      if (["Control", "Meta", "Shift", "Alt"].includes(e.key)) return;
      const isMod = e.metaKey || e.ctrlKey;
      // Only record shift if mod is also pressed (for Cmd+Shift+Z type combos)
      // For standalone keys, shift is often just keyboard layout (Shift+6 = &)
      const combo: KeyCombo = {
        key: e.key.length === 1 ? e.key.toLowerCase() : e.key,
        ...(isMod ? { mod: true } : {}),
        ...(isMod && e.shiftKey ? { shift: true } : {}),
      };
      shortcutStore.setCombo(editingShortcut, combo);
      setEditingShortcut(null);
    };
    window.addEventListener("keydown", handler, true); // capture phase
    return () => window.removeEventListener("keydown", handler, true);
  }, [editingShortcut, shortcutStore]);

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
    // Context management
    maxContextChars: string; maxChatContextChars: string;
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

  // ─── Token usage data — detailed breakdown ──────────────
  const [tokenData, setTokenData] = useState<TokenUsageDetailed | null>(null);

  useEffect(() => {
    fetchJson<TokenUsageDetailed>("/executions/token-usage-detailed?days=30").then((d) => {
      if (d && d.daily) setTokenData(d);
    });
  }, [executions]);

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
    { id: "ollama", label: "Ollama" },
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
                <div className={styles.rowLabel}>Server URL <InfoTip text={"The address of the OCC backend REST server.\n\nDefault: http://localhost:4242\n\nThe frontend connects to this URL for all API calls (chains, executions, BLOB, SSE events). Change this if your server runs on a different host or port."} /></div>
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
                <div className={styles.rowLabel}>API Key <InfoTip text={"Optional authentication key for the OCC backend.\n\nSet via OCC_API_KEY env var on the server. When set, all API requests must include this key in the Authorization header.\n\nLeave empty for local development. Required for production/exposed servers to prevent unauthorized access."} /></div>
                <div className={styles.rowDesc}>OCC_API_KEY authentication</div>
              </div>
              <input className={styles.rowInput} type="password" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} onBlur={handleSaveApiKey} onKeyDown={(e) => e.key === "Enter" && handleSaveApiKey()} placeholder="Optional" />
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-cyan-bg)" }}>A</div>
              <div className={styles.rowBody}>
                <div className={styles.rowLabel}>Auto-connect SSE <InfoTip text={"Automatically open a Server-Sent Events connection on page load.\n\nWhen enabled, the Live Monitor receives real-time execution events without manual refresh. Disable to reduce network traffic or if you experience connection issues.\n\nDefault: enabled. Stored in browser localStorage."} /></div>
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
                <div className={styles.rowLabel}>Max Concurrent Executions <InfoTip text={"How many chains/pipelines can run at the same time.\n\nMin: 1 | Max: 20 | Default: 5\n\nHigher values speed up pipelines with parallel chains but increase CPU/memory usage. Each slot holds one Claude CLI process. Set to 1 for sequential-only execution."} /></div>
                <div className={styles.rowDesc}>Parallel chain execution slots</div>
              </div>
              <input className={styles.rowInput} type="number" min={1} max={20} value={config?.maxConcurrentExecutions ?? "5"} onChange={(e) => updateConfig("maxConcurrentExecutions", e.target.value)} onBlur={saveConfig} style={{ width: 60, textAlign: "center" }} />
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-red-bg)" }}>T</div>
              <div className={styles.rowBody}>
                <div className={styles.rowLabel}>Claude Timeout (ms) <InfoTip text={"Maximum time (in milliseconds) a single Claude CLI call can run before being killed.\n\nDefault: 1800000 (30 min) | Min: 10000\n\n60000 = 1 min, 300000 = 5 min, 1800000 = 30 min.\nComplex steps (deep research, long code generation) need higher values. Steps that hit this limit will fail with a timeout error and can be retried."} /></div>
                <div className={styles.rowDesc}>Max duration per LLM call</div>
              </div>
              <input className={styles.rowInput} type="number" step={60000} value={config?.claudeTimeoutMs ?? "1800000"} onChange={(e) => updateConfig("claudeTimeoutMs", e.target.value)} onBlur={saveConfig} style={{ width: 100, textAlign: "center" }} />
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-cyan-bg)" }}>L</div>
              <div className={styles.rowBody}>
                <div className={styles.rowLabel}>Log Level <InfoTip text={"Controls what the server logs to stdout.\n\nDebug: everything (verbose, for development)\nInfo: normal operations + warnings + errors\nWarn: warnings + errors only\nError: only errors\n\nDefault: info. Requires server restart."} /></div>
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
                <div className={styles.rowLabel}>Log Format <InfoTip text={"How server logs are formatted.\n\nText: colored human-readable output (for terminal)\nJSON: structured key-value format (for log aggregators like ELK, Datadog)\n\nDefault: text. Requires server restart."} /></div>
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
                <div className={styles.rowLabel}>Claude CLI Path <InfoTip text={"Path to the Claude CLI binary on the server.\n\nDefault: \"claude\" (uses PATH lookup)\n\nExamples: claude, /usr/local/bin/claude, /home/user/.local/bin/claude\n\nThe binary must support: claude -p \"prompt\" --output-format stream-json. Requires server restart."} /></div>
                <div className={styles.rowDesc}>Binary path for Claude CLI</div>
              </div>
              <input className={styles.rowInput} value={config?.claudeCli ?? "claude"} onChange={(e) => updateConfig("claudeCli", e.target.value)} onBlur={saveConfig} style={{ width: 120 }} />
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-orange-bg)" }}>A</div>
              <div className={styles.rowBody}>
                <div className={styles.rowLabel}>Execution Max Age (days) <InfoTip text={"Executions older than this are automatically deleted from the SQLite database on server startup.\n\nMin: 1 | Max: 365 | Default: 7\n\nLower values save disk space. Higher values keep history longer for debugging. Running executions are never deleted."} /></div>
                <div className={styles.rowDesc}>Auto-delete old executions</div>
              </div>
              <input className={styles.rowInput} type="number" min={1} max={365} value={config?.executionMaxAgeDays ?? "7"} onChange={(e) => updateConfig("executionMaxAgeDays", e.target.value)} onBlur={saveConfig} style={{ width: 60, textAlign: "center" }} />
            </div>
          </div>
          <div className={styles.sectionCard}>
            <div className={styles.sectionSubtitle}>Context Budget</div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-cyan-bg)" }}>{"\u{1F9E0}"}</div>
              <div className={styles.rowBody}>
                <div className={styles.rowLabel}>Chain Context Budget <InfoTip text={"Maximum total characters across all step variables in a chain execution.\n\nWhen exceeded, older step outputs are auto-summarized via Haiku (15s timeout, fallback to truncation at 1000 chars). The 3 most recent outputs and all input.* variables are always protected.\n\nMin: 0 (disabled) | Default: 50000\n\nRecommended: 30000-80000. Lower = cheaper but may lose context. Higher = more context but costs more tokens. Can be overridden per chain via max_context_chars in YAML."} /></div>
                <div className={styles.rowDesc}>Max chars in chain vars before auto-summarize (0 = disabled)</div>
              </div>
              <input className={styles.rowInput} type="number" step={5000} min={0} value={config?.maxContextChars ?? "50000"} onChange={(e) => updateConfig("maxContextChars", e.target.value)} onBlur={saveConfig} style={{ width: 80, textAlign: "center" }} />
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-green-bg)" }}>{"\u{1F4AC}"}</div>
              <div className={styles.rowBody}>
                <div className={styles.rowLabel}>Chat Context Budget <InfoTip text={"Maximum total characters for BLOB chat conversation history sent to the LLM.\n\nWhen exceeded, the oldest messages are dropped until under budget. If a single message is still too long, it gets truncated.\n\nMin: 0 (unlimited) | Default: 8000\n\nRecommended: 5000-15000. Prevents accidentally sending huge outputs pasted in chat to Haiku. Higher values give the chat more memory of past conversation."} /></div>
                <div className={styles.rowDesc}>Max chars for BLOB chat conversation history (0 = unlimited)</div>
              </div>
              <input className={styles.rowInput} type="number" step={1000} min={0} value={config?.maxChatContextChars ?? "8000"} onChange={(e) => updateConfig("maxChatContextChars", e.target.value)} onBlur={saveConfig} style={{ width: 80, textAlign: "center" }} />
            </div>
          </div>
          {configDirty && <div className={styles.sectionHint} style={{ color: "var(--m-accent)" }}>Changes saved — some settings require server restart.</div>}
        </div>

        {/* ═══ LLM Providers (extracted component) ═══ */}
        <div id="providers"><ProviderSection /></div>

        {/* ═══ Ollama (local models) ═══ */}
        <div id="ollama" className={styles.section}>
          <div className={styles.sectionTitle}>Ollama — Local Models</div>
          <div className={styles.sectionCard}>
            <OllamaSection />
          </div>
        </div>

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
            <div className={styles.row}><div className={styles.rowIcon} style={{ background: "var(--icon-cyan-bg)" }}>M</div><div className={styles.rowBody}><div className={styles.rowLabel}>Show Minimap <InfoTip text={"Show a small navigation minimap in the bottom-left corner of the Workflow canvas.\n\nHelps orient yourself in large workflows. The minimap shows all nodes and your current viewport position.\n\nDefault: enabled. Hidden automatically on screens < 480px wide."} /></div><div className={styles.rowDesc}>Canvas minimap overlay</div></div><Toggle on={showMinimap} onToggle={() => toggleLocal("occ-show-minimap", !showMinimap, setShowMinimap)} /></div>
            <div className={styles.row}><div className={styles.rowIcon} style={{ background: "var(--icon-purple-bg)" }}>S</div><div className={styles.rowBody}><div className={styles.rowLabel}>Auto-scroll Logs <InfoTip text={"Automatically scroll the Live Monitor log to the latest entry as events arrive.\n\nDisable to freeze the view while reading older entries. Can also be toggled directly in the monitor panel.\n\nDefault: enabled."} /></div><div className={styles.rowDesc}>Scroll to latest log entry</div></div><Toggle on={autoScroll} onToggle={() => toggleLocal("occ-auto-scroll", !autoScroll, setAutoScroll)} /></div>
          </div>
        </div>

        {/* ═══ Paths & Security ═══ */}
        <div id="paths" className={styles.section}>
          <div className={styles.sectionTitle}>Paths & Security</div>
          <div className={styles.sectionCard}>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--m-text2)" }}>C</div>
              <div className={styles.rowBody}><div className={styles.rowLabel}>Chains Directory <InfoTip text={"Filesystem path where chain YAML definitions are stored.\n\nDefault: ./chains\n\nThe server reads all .yaml files from this directory. Each file defines one chain with its steps, prompts, and configuration. Use an absolute path for production.\n\nRequires server restart."} /></div></div>
              <input className={styles.rowInput} value={config?.chainsDir ?? "./chains"} onChange={(e) => updateConfig("chainsDir", e.target.value)} onBlur={saveConfig} style={{ width: 160 }} />
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--m-text2)" }}>P</div>
              <div className={styles.rowBody}><div className={styles.rowLabel}>Pipelines Directory <InfoTip text={"Filesystem path where pipeline YAML definitions are stored.\n\nDefault: ./pipelines\n\nPipelines orchestrate multiple chains in sequence or parallel. Each .yaml file defines one pipeline with chain references, dependencies, and input mappings.\n\nRequires server restart."} /></div></div>
              <input className={styles.rowInput} value={config?.pipelinesDir ?? "./pipelines"} onChange={(e) => updateConfig("pipelinesDir", e.target.value)} onBlur={saveConfig} style={{ width: 160 }} />
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--m-text2)" }}>W</div>
              <div className={styles.rowBody}><div className={styles.rowLabel}>Workspace <InfoTip text={"Root directory for file operations (read_file, write_file pre-tools).\n\nDefault: . (current working directory)\n\nPre-tools with file access are sandboxed to this directory. Paths outside it are blocked. Use a dedicated folder for security in production.\n\nRequires server restart."} /></div><div className={styles.rowDesc}>File operations sandbox</div></div>
              <input className={styles.rowInput} value={config?.workspaceDir ?? "."} onChange={(e) => updateConfig("workspaceDir", e.target.value)} onBlur={saveConfig} style={{ width: 160 }} />
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-cyan-bg)" }}>O</div>
              <div className={styles.rowBody}><div className={styles.rowLabel}>CORS Origin <InfoTip text={"Which origins are allowed to call the REST API (Access-Control-Allow-Origin header).\n\nDefault: empty (same-origin only)\n\n* = allow all origins (dev only, insecure). For production, set your frontend URL (e.g. https://my-app.com).\n\nRequires server restart."} /></div><div className={styles.rowDesc}>Allowed origin (* for all)</div></div>
              <input className={styles.rowInput} value={config?.corsOrigin ?? ""} onChange={(e) => updateConfig("corsOrigin", e.target.value)} onBlur={saveConfig} placeholder="*" style={{ width: 160 }} />
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-green-bg)" }}>H</div>
              <div className={styles.rowBody}><div className={styles.rowLabel}>Public Host <InfoTip text={"Public hostname used for gate approval callback URLs.\n\nDefault: localhost\n\nWhen a gate step waits for human approval, it generates an approval link using this hostname. Set to your actual domain/IP if the server is remote.\n\nRequires server restart."} /></div><div className={styles.rowDesc}>Hostname for approval callbacks</div></div>
              <input className={styles.rowInput} value={config?.publicHost ?? "localhost"} onChange={(e) => updateConfig("publicHost", e.target.value)} onBlur={saveConfig} placeholder="localhost" style={{ width: 160 }} />
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-red-bg)" }}>R</div>
              <div className={styles.rowBody}>
                <div className={styles.rowLabel}>Rate Limiting <InfoTip text={"Limits API requests per minute per IP address.\n\nExec: max chain/pipeline execution requests (Default: 20/min)\nGen: max AI generation requests like /generate-chain (Default: 5/min)\n\nProtects against accidental loops and abuse. Set higher for automated pipelines. Requires server restart."} /></div>
                <div className={styles.rowDesc}>Requests per minute</div>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ fontSize: 11, opacity: 0.6 }}>Exec</span>
                <input className={styles.rowInput} type="number" min={1} max={1000} value={config?.rateLimitExec ?? "20"} onChange={(e) => updateConfig("rateLimitExec", e.target.value)} onBlur={saveConfig} style={{ width: 55, textAlign: "center" }} />
                <span style={{ fontSize: 11, opacity: 0.6 }}>Gen</span>
                <input className={styles.rowInput} type="number" min={1} max={100} value={config?.rateLimitGen ?? "5"} onChange={(e) => updateConfig("rateLimitGen", e.target.value)} onBlur={saveConfig} style={{ width: 55, textAlign: "center" }} />
              </div>
            </div>
            <div className={styles.row}><div className={styles.rowIcon} style={{ background: "var(--icon-orange-bg)" }}>S</div><div className={styles.rowBody}><div className={styles.rowLabel}>SSRF Protection <InfoTip text={"Blocks HTTP requests to private/internal IP addresses from pre-tools (http_fetch, web_search, etc.).\n\nAlways enabled. Prevents Server-Side Request Forgery attacks. Blocked ranges: 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, ::1, fc00::/7."} /></div><div className={styles.rowDesc}>Blocks private IPs</div></div><span className={styles.rowValue}>Enabled</span></div>
          </div>
          {configDirty && <div className={styles.sectionHint} style={{ color: "var(--m-accent)" }}>Saved — restart server to apply path changes.</div>}
        </div>

        {/* ═══ Storage ═══ */}
        <div id="storage" className={styles.section}>
          <div className={styles.sectionTitle}>Storage</div>
          <div className={styles.sectionCard}>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-orange-bg)" }}>M</div>
              <div className={styles.rowBody}><div className={styles.rowLabel}>Main Database <InfoTip text={"SQLite database for execution history and step checkpoints.\n\nDefault: ./occ.db\n\nStores all chain/pipeline executions, step results, tokens, and timing data. Uses WAL mode for concurrent reads. Can grow to several hundred MB with heavy usage.\n\nRequires server restart."} /></div><div className={styles.rowDesc}>OCC_DB — executions & checkpoints</div></div>
              <input className={styles.rowInput} value={config?.occDb ?? "./occ.db"} onChange={(e) => updateConfig("occDb", e.target.value)} onBlur={saveConfig} style={{ width: 180 }} />
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-cyan-bg)" }}>Q</div>
              <div className={styles.rowBody}><div className={styles.rowLabel}>Queue Database <InfoTip text={"SQLite database for the job queue (queued, running, completed, errored jobs).\n\nDefault: ./occ-queue.db\n\nSeparated from the main DB for performance. Queue entries are purged automatically. Requires server restart."} /></div><div className={styles.rowDesc}>OCC_QUEUE_DB — job queue</div></div>
              <input className={styles.rowInput} value={config?.occQueueDb ?? "./occ-queue.db"} onChange={(e) => updateConfig("occQueueDb", e.target.value)} onBlur={saveConfig} style={{ width: 180 }} />
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-green-bg)" }}>S</div>
              <div className={styles.rowBody}><div className={styles.rowLabel}>State Database <InfoTip text={"SQLite database for the state_save/state_load pre-tools.\n\nDefault: empty (uses temp directory)\n\nAllows chain steps to persist key-value state between executions. Useful for caching API tokens, tracking progress, or storing intermediate results.\n\nRequires server restart."} /></div><div className={styles.rowDesc}>OCC_STATE_DB — state_save/state_load</div></div>
              <input className={styles.rowInput} value={config?.occStateDb ?? ""} onChange={(e) => updateConfig("occStateDb", e.target.value)} onBlur={saveConfig} placeholder="/tmp/occ-state.db" style={{ width: 180 }} />
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-purple-bg)" }}>V</div>
              <div className={styles.rowBody}><div className={styles.rowLabel}>Vector Database <InfoTip text={"SQLite database for vector embeddings (semantic search pre-tool).\n\nDefault: empty (uses temp directory)\n\nStores text embeddings for similarity search. Used by the semantic_search and vector_store pre-tools. Requires server restart."} /></div><div className={styles.rowDesc}>OCC_VECTOR_DB — embeddings</div></div>
              <input className={styles.rowInput} value={config?.occVectorDb ?? ""} onChange={(e) => updateConfig("occVectorDb", e.target.value)} onBlur={saveConfig} placeholder="/tmp/occ-vectors.db" style={{ width: 180 }} />
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-red-bg)" }}>C</div>
              <div className={styles.rowBody}><div className={styles.rowLabel}>Semantic Cache DB <InfoTip text={"SQLite database for semantic caching of LLM responses.\n\nDefault: empty (disabled)\n\nWhen set, similar prompts can return cached responses instead of calling Claude again. Reduces costs for repetitive queries. Requires server restart."} /></div></div>
              <input className={styles.rowInput} value={config?.occSemanticCacheDb ?? ""} onChange={(e) => updateConfig("occSemanticCacheDb", e.target.value)} onBlur={saveConfig} placeholder="/tmp/occ-semantic-cache.db" style={{ width: 180 }} />
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--m-text2)" }}>G</div>
              <div className={styles.rowBody}><div className={styles.rowLabel}>Graph Database <InfoTip text={"SQLite database for knowledge graph triples (knowledge_graph pre-tool).\n\nDefault: empty (disabled)\n\nStores subject-predicate-object triples for structured knowledge queries. Used by the triples_query pre-tool. Requires server restart."} /></div></div>
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
                <div className={styles.rowLabel}>Resend API Key <InfoTip text={"API key for the Resend email service (resend.com).\n\nRequired for the send_email pre-tool. Get a key from resend.com/api-keys.\n\nFormat: re_xxxxxxxxx. Leave empty to disable email features. Stored encrypted on disk.\n\nRequires server restart."} /></div>
                <div className={styles.rowDesc}>For email pre-tool notifications</div>
              </div>
              <input className={styles.rowInput} type="password" value={config?.resendApiKey ?? ""} onChange={(e) => updateConfig("resendApiKey", e.target.value)} onBlur={saveConfig} placeholder="re_xxxxx" style={{ width: 180 }} />
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-green-bg)" }}>F</div>
              <div className={styles.rowBody}>
                <div className={styles.rowLabel}>From Address <InfoTip text={"The sender email address for outgoing emails.\n\nMust be a verified domain in your Resend account. Example: noreply@yourdomain.com, alerts@company.io.\n\nEmails sent by the send_email pre-tool will appear from this address.\n\nRequires server restart."} /></div>
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
              <div className={styles.statCell}><span className={styles.statValue}>{health?.pid ?? "—"}</span><span className={styles.statLabel}>PID</span></div>
            </div>
            <div className={styles.statsGrid}>
              <div className={styles.statCell}><span className={styles.statValue}>{health?.chainCount ?? 0}</span><span className={styles.statLabel}>Chains</span></div>
              <div className={styles.statCell}><span className={styles.statValue}>{health?.pipelineCount ?? 0}</span><span className={styles.statLabel}>Pipelines</span></div>
              <div className={styles.statCell}><span className={styles.statValue}>{Array.isArray(health?.mcpServers) ? health.mcpServers.length : (health?.mcpServers ?? Object.keys(mcpServers).length)}</span><span className={styles.statLabel}>MCP Servers</span></div>
              <div className={styles.statCell}><span className={styles.statValue}>{health?.blobSessionCount ?? 0}</span><span className={styles.statLabel}>BLOB Sessions</span></div>
            </div>
            <div className={styles.statsGrid}>
              <div className={styles.statCell}><span className={styles.statValue}>{health?.memoryMB ?? "—"}<span style={{ fontSize: "0.6em", opacity: 0.5 }}> MB</span></span><span className={styles.statLabel}>Memory (RSS)</span></div>
              <div className={styles.statCell}><span className={styles.statValue}>{health?.heapUsedMB ?? "—"}<span style={{ fontSize: "0.6em", opacity: 0.5 }}> / {health?.heapTotalMB ?? "—"}</span></span><span className={styles.statLabel}>Heap Used / Total</span></div>
              <div className={styles.statCell}><span className={styles.statValue}>{formatBytes(health?.dbTotalBytes)}</span><span className={styles.statLabel}>Databases</span></div>
              <div className={styles.statCell}><span className={styles.statValue}>{formatBytes(health?.blobBytes)}</span><span className={styles.statLabel}>BLOB Data</span></div>
            </div>
            <div className={styles.row}><div className={styles.rowBody}><div className={styles.rowLabel}>Platform</div></div><span className={styles.rowValue}>{health?.platform ?? "—"} / {health?.arch ?? "—"}</span></div>
            <div className={styles.row}><div className={styles.rowBody}><div className={styles.rowLabel}>Node.js</div></div><span className={styles.rowValue}>{health?.nodeVersion ?? "—"}</span></div>
            <div className={styles.row}><div className={styles.rowBody}><div className={styles.rowLabel}>Claude CLI</div></div><span className={styles.rowValue}>{health?.claudeCli ?? "claude"}</span></div>
            <div className={styles.row}><div className={styles.rowBody}><div className={styles.rowLabel}>Storage</div></div><span className={styles.rowValue}>SQLite WAL</span></div>
            <div className={styles.row}><div className={styles.rowBody}><div className={styles.rowLabel}>Executions</div></div><span className={styles.rowValue}>{executions.length}</span></div>
            {health?.dbSizes && Object.keys(health.dbSizes).length > 0 && (<>
              <div className={styles.row} style={{ opacity: 0.6 }}><div className={styles.rowBody}><div className={styles.rowLabel} style={{ fontSize: "var(--s-xs)", textTransform: "uppercase", letterSpacing: "0.5px" }}>Database Breakdown</div></div></div>
              {Object.entries(health.dbSizes).map(([name, size]) => (
                <div key={name} className={styles.row}><div className={styles.rowBody}><div className={styles.rowLabel} style={{ paddingLeft: 12 }}>{name}</div></div><span className={styles.rowValue}>{formatBytes(size)}</span></div>
              ))}
            </>)}
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
              <TokenDashboard data={tokenData} mode={chartMode} />
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
                <div className={styles.rowLabel}>Planning Model <InfoTip text={"The LLM used to plan BLOB graph structure (branches, steps, forks).\n\nDefault: claude-sonnet-4-6\n\nThis model receives the user message, existing branches, knowledge graph, and MCP servers. It outputs a JSON plan. Use a capable model (Sonnet+) for accurate graph planning. Haiku works for simple prompts but may produce weaker step breakdowns.\n\nRequires server restart."} /></div>
                <div className={styles.rowDesc}>LLM for graph planning (fast + cheap)</div>
              </div>
              <input className={styles.rowInput} value={config?.blobPlanningModel ?? "claude-haiku-4-5"} onChange={(e) => updateConfig("blobPlanningModel", e.target.value)} onBlur={saveConfig} style={{ width: 180 }} />
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-blue-bg)" }}>C</div>
              <div className={styles.rowBody}>
                <div className={styles.rowLabel}>Chat Model <InfoTip text={"The LLM used for BLOB conversational chat responses.\n\nDefault: claude-haiku-4-5\n\nThis model handles direct Q&A in the BLOB chat. It receives the system prompt, knowledge graph context, and conversation history. Haiku is fast and cheap for chat. Use Sonnet for more nuanced responses.\n\nRequires server restart."} /></div>
                <div className={styles.rowDesc}>LLM for conversational responses</div>
              </div>
              <input className={styles.rowInput} value={config?.blobChatModel ?? "claude-sonnet-4-6"} onChange={(e) => updateConfig("blobChatModel", e.target.value)} onBlur={saveConfig} style={{ width: 180 }} />
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-purple-bg)" }}>E</div>
              <div className={styles.rowBody}>
                <div className={styles.rowLabel}>Step Execution Model <InfoTip text={"The LLM used to execute individual BLOB step nodes.\n\nDefault: claude-sonnet-4-6\n\nEach step receives its prompt + previous step outputs (max 5, truncated at 2000 chars each) + relevant knowledge. Use Sonnet for quality, Haiku for speed/cost. Can be overridden per step in the BLOB planner.\n\nRequires server restart."} /></div>
                <div className={styles.rowDesc}>LLM for workflow step execution</div>
              </div>
              <input className={styles.rowInput} value={config?.blobStepModel ?? "claude-sonnet-4-6"} onChange={(e) => updateConfig("blobStepModel", e.target.value)} onBlur={saveConfig} style={{ width: 180 }} />
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-cyan-bg)" }}>T</div>
              <div className={styles.rowBody}>
                <div className={styles.rowLabel}>Autonomous Check Interval <InfoTip text={"How often (in seconds) the autonomous BLOB engine checks for knowledge gaps and generates exploration plans.\n\nMin: 10 | Max: 3600 | Default: 60\n\nThe engine won't run more than 10 times per hour regardless of this value. Minimum enforced interval is 6 minutes between actual runs.\n\nRequires server restart."} /></div>
                <div className={styles.rowDesc}>Seconds between autonomous polls</div>
              </div>
              <input className={styles.rowInput} type="number" min={10} max={3600} value={config?.blobAutoCheckSec ?? "60"} onChange={(e) => updateConfig("blobAutoCheckSec", e.target.value)} onBlur={saveConfig} style={{ width: 80, textAlign: "center" }} />
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--m-text2)" }}>D</div>
              <div className={styles.rowBody}>
                <div className={styles.rowLabel}>BLOB Directory <InfoTip text={"Filesystem path where BLOB session data is stored (graphs, knowledge, autonomous plans).\n\nDefault: ./blobs\n\nEach session creates files: {sessionId}.json (graph), knowledge.json (shared), index.json (session list). Use an absolute path for production.\n\nRequires server restart."} /></div>
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

          {/* Context & Cache */}
          <div className={styles.sectionCard}>
            <div className={styles.sectionSubtitle}>Context & Cache</div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-cyan-bg)" }}>{"\u{1F9F9}"}</div>
              <div className={styles.rowBody}>
                <div className={styles.rowLabel}>Step Result Cache <InfoTip text={"Filesystem cache of LLM step results. When a step with caching enabled runs with an identical prompt + model, the cached response is returned instead of calling Claude.\n\nClearing forces all cached steps to re-execute from scratch on next run. Useful after changing chain prompts or models.\n\nStored in: {chains_dir}/../cache/"} /></div>
                <div className={styles.rowDesc}>Cached LLM responses for chain steps (avoids re-running identical prompts)</div>
              </div>
              <button className={`${styles.rowBtn} ${styles.rowBtnDanger}`} onClick={async () => {
                if (!confirm("Clear all step result caches? Steps will re-run from scratch.")) return;
                const r = await fetch("/cache/steps", { method: "DELETE" }).then(r => r.json()).catch(() => null);
                alert(r ? `Cleared ${r.cleared} cached step results.` : "Failed to clear cache.");
              }}>Clear</button>
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-purple-bg)" }}>{"\u26A1"}</div>
              <div className={styles.rowBody}>
                <div className={styles.rowLabel}>Pre-Tool Cache <InfoTip text={"In-memory cache of pre-tool results (web_search, http_fetch, api_call, etc.).\n\nMax 1000 entries. Each entry has a TTL set by the pre-tool's cache_ttl_minutes field. Clearing is instant.\n\nThis cache resets automatically on server restart. Clear it to force fresh API calls / web searches."} /></div>
                <div className={styles.rowDesc}>In-memory cache for web searches, API calls, file reads (resets on server restart)</div>
              </div>
              <button className={`${styles.rowBtn} ${styles.rowBtnDanger}`} onClick={async () => {
                if (!confirm("Clear pre-tool cache?")) return;
                const r = await fetch("/cache/pretools", { method: "DELETE" }).then(r => r.json()).catch(() => null);
                alert(r ? `Cleared ${r.cleared} cached pre-tool results.` : "Failed to clear cache.");
              }}>Clear</button>
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-orange-bg)" }}>{"\u{1F525}"}</div>
              <div className={styles.rowBody}>
                <div className={styles.rowLabel}>Clear All Caches <InfoTip text={"Clears everything in one click:\n\n1. Step result cache (filesystem)\n2. Pre-tool cache (in-memory)\n3. BLOB local cache (browser localStorage)\n\nUse this for a clean slate. Does not affect execution history, knowledge graph, or chain/pipeline definitions."} /></div>
                <div className={styles.rowDesc}>Step cache + pre-tool cache + BLOB local cache in one click</div>
              </div>
              <button className={`${styles.rowBtn} ${styles.rowBtnDanger}`} onClick={async () => {
                if (!confirm("Clear ALL caches (step results, pre-tools, BLOB local)?")) return;
                const [r1, r2] = await Promise.all([
                  fetch("/cache/steps", { method: "DELETE" }).then(r => r.json()).catch(() => ({ cleared: 0 })),
                  fetch("/cache/pretools", { method: "DELETE" }).then(r => r.json()).catch(() => ({ cleared: 0 })),
                ]);
                Object.keys(localStorage).filter((k) => k.startsWith("occ-blob")).forEach((k) => localStorage.removeItem(k));
                alert(`Cleared: ${r1.cleared} step caches, ${r2.cleared} pre-tool caches, browser BLOB cache.`);
              }}>Clear All</button>
            </div>
          </div>

          {/* BLOB data */}
          <div className={styles.sectionCard}>
            <div className={styles.sectionSubtitle}>BLOB</div>
            <div className={styles.row}>
              <div className={styles.rowIcon} style={{ background: "var(--icon-orange-bg)" }}>{"\u{1F9E0}"}</div>
              <div className={styles.rowBody}>
                <div className={styles.rowLabel}>Knowledge Graph <InfoTip text={"The BLOB knowledge graph stores concepts and facts extracted from step outputs.\n\nClearing deletes all entries from knowledge.json on the server AND localStorage. The BLOB will start learning from scratch. Previously generated plans are not affected."} /></div>
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
                <div className={styles.rowLabel}>All BLOB Sessions <InfoTip text={"Permanently deletes ALL BLOB sessions from both server and browser.\n\nThis removes: session index, all graph JSON files, all messages, all step outputs, and localStorage cache. Knowledge graph is also cleared.\n\nThis action is irreversible."} /></div>
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
                <div className={styles.rowLabel}>Export Knowledge <InfoTip text={"Downloads the entire knowledge graph as a JSON file.\n\nContains all concepts, facts, access counts, and related concept links. Useful for backup, migration, or analysis in external tools."} /></div>
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
                <div className={styles.rowLabel}>Execution History <InfoTip text={"Deletes ALL execution records from the SQLite database (occ.db).\n\nThis removes: execution metadata, step checkpoints, token counts, timing data. The Token Usage chart will be empty after clearing.\n\nDoes not affect chain/pipeline definitions or BLOB data. Irreversible."} /></div>
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
                <div className={styles.rowLabel}>Queue <InfoTip text={"Clears all entries from the job queue database (occ-queue.db).\n\nRemoves: pending, running, completed, and errored jobs. Running jobs will be orphaned (no crash, but no tracking). Use 'Purge Old' in the Job Queue section for safer cleanup."} /></div>
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
                <div className={styles.rowLabel}>Export Executions <InfoTip text={"Downloads up to 1000 most recent executions as a JSON file.\n\nContains: execution IDs, chain names, status, step results, tokens, timing. Useful for billing analysis, debugging, or migrating to another server."} /></div>
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
                <div className={styles.rowLabel}>All Schedules <InfoTip text={"Deletes ALL scheduled jobs (cron-based recurring chain executions).\n\nEach schedule is deleted individually via the API. Active schedules will stop firing immediately. Does not cancel already-running executions spawned by schedules.\n\nIrreversible."} /></div>
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
                <div className={styles.rowLabel}>All Local Data <InfoTip text={"Removes ALL keys starting with 'occ-' from browser localStorage.\n\nThis resets: BLOB session cache, design presets, blend position, auto-connect preference, minimap toggle, scroll preference.\n\nBackend data is NOT affected. Page will reload after clearing."} /></div>
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
                <div className={styles.rowLabel}>BLOB Cache Only <InfoTip text={"Clears only BLOB-related data from browser localStorage.\n\nRemoves: cached session lists, graph data, active session ID. Backend data (server-side graphs, knowledge) is untouched.\n\nUseful when localStorage is out of sync with the server. No page reload needed."} /></div>
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
                <div className={styles.rowLabel}>Design Presets <InfoTip text={"Resets the 4 design space color presets and the blend matrix position to factory defaults.\n\nAffects: accent colors, backgrounds, surfaces, text colors, font sizes, border radius. The current theme will revert on next page refresh.\n\nOnly affects localStorage — no server data."} /></div>
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

        {/* ═══ Keyboard Shortcuts (configurable) ═══ */}
        <div id="shortcuts" className={styles.section}>
          <div className={styles.sectionTitle}>
            Keyboard Shortcuts
            <button className={styles.chartModeBtn} style={{ marginLeft: "auto" }} onClick={() => { shortcutStore.resetAll(); setEditingShortcut(null); }}>Reset All</button>
          </div>

          {(["Navigation", "Workflow Canvas", "The Blob", "Global"] as const).map((cat) => (
            <div key={cat} className={styles.sectionCard}>
              <div className={styles.sectionSubtitle}>{cat}</div>
              {shortcutStore.shortcuts.filter((s) => s.category === cat).map((s) => (
                <div key={s.action} className={styles.row}>
                  <div className={styles.rowBody}>
                    <div className={styles.rowLabel}>{s.label}</div>
                  </div>
                  {editingShortcut === s.action ? (
                    <div className={styles.shortcutCapture}>
                      Press new key...
                      <button className={styles.bpBtn} onClick={() => setEditingShortcut(null)} style={{ marginLeft: 8, fontSize: 9 }}>Cancel</button>
                    </div>
                  ) : (
                    <button
                      className={styles.shortcutKey}
                      onClick={() => setEditingShortcut(s.action)}
                      title="Click to change"
                    >
                      {formatCombo(s.combo)}
                    </button>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>

      </div>
    </div>
  );
}
