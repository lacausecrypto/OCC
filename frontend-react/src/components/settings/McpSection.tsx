/**
 * MCP Server management — dynamic registry, favorites, install/configure.
 */
import { useState, useEffect, useCallback } from "react";
import { ItemListManager } from "./ItemListManager";
import { CollapsibleSection } from "./Collapsible";
import styles from "./Settings.module.css";

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpResult {
  id: string;
  name: string;
  description: string;
  icon: string;
  command: string;
  args: string[];
  envKeys: string[];
  requiredEnvKeys: string[];
  tags: Array<{ tag: string; color: string }>;
  repoUrl?: string;
}

// ─── Tag inference ──────────────────────────────────────────────────────────

const TAG_RULES: Array<{ tag: string; color: string; keywords: string[] }> = [
  { tag: "Database", color: "var(--icon-blue)", keywords: ["database", "postgres", "mysql", "sqlite", "mongo", "redis", "supabase", "sql", "dynamodb"] },
  { tag: "AI", color: "var(--icon-purple)", keywords: ["ai", "llm", "openai", "anthropic", "embedding", "vector", "rag", "gpt", "claude"] },
  { tag: "Code", color: "var(--icon-green)", keywords: ["code", "git", "github", "gitlab", "filesystem", "file", "docker", "kubernetes"] },
  { tag: "Data", color: "var(--icon-orange)", keywords: ["api", "fetch", "http", "scrape", "crawl", "browser", "puppeteer", "web"] },
  { tag: "Comms", color: "var(--icon-red)", keywords: ["slack", "discord", "email", "gmail", "telegram", "sms", "chat", "teams"] },
  { tag: "Cloud", color: "var(--icon-cyan)", keywords: ["aws", "gcp", "azure", "cloud", "s3", "vercel", "cloudflare"] },
  { tag: "Search", color: "var(--c-warning)", keywords: ["search", "brave", "exa", "tavily"] },
  { tag: "Finance", color: "var(--icon-green)", keywords: ["finance", "crypto", "trading", "market", "stock", "bitcoin"] },
];

function inferTags(name: string, desc: string): Array<{ tag: string; color: string }> {
  const text = `${name} ${desc}`.toLowerCase();
  return TAG_RULES.filter((r) => r.keywords.some((kw) => text.includes(kw))).slice(0, 2);
}

// ─── Quick topics ───────────────────────────────────────────────────────────

interface QuickTopic { label: string; query: string; icon: string }

const DEFAULT_TOPICS: QuickTopic[] = [
  { label: "GitHub", query: "github", icon: "\u{1F4BB}" },
  { label: "Database", query: "database", icon: "\u{1F4BE}" },
  { label: "Search", query: "search", icon: "\u{1F50D}" },
  { label: "Slack", query: "slack", icon: "\u{1F4AC}" },
  { label: "AI / LLM", query: "ai", icon: "\u{1F916}" },
  { label: "Cloud", query: "cloud aws", icon: "\u2601\uFE0F" },
  { label: "File", query: "filesystem file", icon: "\u{1F4C1}" },
  { label: "Finance", query: "finance crypto", icon: "\u{1F4B0}" },
  { label: "Email", query: "email gmail", icon: "\u{1F4E7}" },
  { label: "Notion", query: "notion obsidian", icon: "\u{1F4DD}" },
];

const EMOJI_PICKER = ["\u{1F4BB}", "\u{1F4BE}", "\u{1F50D}", "\u{1F4AC}", "\u{1F916}", "\u2601\uFE0F", "\u{1F4C1}", "\u{1F4B0}", "\u{1F4E7}", "\u{1F4DD}", "\u{1F4E6}", "\u{1F310}", "\u26A1", "\u{1F527}", "\u{1F3AE}", "\u{1F3B5}", "\u{1F4F7}", "\u{1F6E1}\uFE0F", "\u{1F9EA}", "\u{1F4CA}"];

function loadTopics(): QuickTopic[] {
  try { const r = localStorage.getItem("occ-mcp-topics"); if (r) return JSON.parse(r); } catch { /* ignore */ } return DEFAULT_TOPICS;
}

// ─── Registry fetch ─────────────────────────────────────────────────────────

function parseRegistry(data: unknown): McpResult[] {
  const raw = data as { servers?: Array<{ server: { name?: string; description?: string; repository?: { url?: string }; packages?: Array<{ registryType?: string; identifier?: string; environmentVariables?: Array<{ name: string; isRequired?: boolean }> }> } }> };
  return (raw?.servers ?? []).map((entry) => {
    const s = entry.server;
    const pkg = s.packages?.[0];
    const pkgId = pkg?.identifier ?? s.name ?? "unknown";
    const isPython = pkg?.registryType === "pypi";
    const allEnv = pkg?.environmentVariables ?? [];
    const shortName = (s.name ?? "").split("/").pop() ?? "Unknown";
    const desc = s.description?.slice(0, 100) ?? "";
    return {
      id: shortName.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
      name: shortName,
      description: desc,
      icon: isPython ? "\u{1F40D}" : "\u{1F4E6}",
      command: isPython ? "uvx" : "npx",
      args: isPython ? [pkgId] : ["-y", pkgId],
      envKeys: allEnv.map((e) => e.name),
      requiredEnvKeys: allEnv.filter((e) => e.isRequired).map((e) => e.name),
      tags: inferTags(shortName, desc),
      repoUrl: s.repository?.url,
    };
  });
}

async function fetchRegistry(query: string): Promise<McpResult[]> {
  try {
    const url = `https://registry.modelcontextprotocol.io/v0.1/servers?search=${encodeURIComponent(query)}&limit=30&version=latest`;
    const res = await fetch(`/proxy?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    return parseRegistry(await res.json());
  } catch { return []; }
}

// ─── Component ──────────────────────────────────────────────────────────────

export function McpSection() {
  const [installed, setInstalled] = useState<Record<string, McpServerConfig>>({});
  const [loading, setLoading] = useState(true);
  const [showMarketplace, setShowMarketplace] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<McpResult[]>([]);
  const [trending, setTrending] = useState<McpResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [envValues, setEnvValues] = useState<Record<string, string>>({});
  const [customAdding, setCustomAdding] = useState(false);
  const [customForm, setCustomForm] = useState({ name: "", command: "", args: "", env: "" });
  const [editingServer, setEditingServer] = useState<string | null>(null);
  const [editServerForm, setEditServerForm] = useState({ command: "", args: "", env: "" });
  const [saveStatus, setSaveStatus] = useState<string | null>(null);

  const saveMcpToBackend = async (config: Record<string, McpServerConfig>) => {
    try {
      const res = await fetch("/mcp-servers", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(config) });
      if (!res.ok) { const err = await res.text(); setSaveStatus(`Error: ${err}`); return false; }
      setSaveStatus("Saved & reloaded");
      setTimeout(() => setSaveStatus(null), 3000);
      return true;
    } catch (err) {
      setSaveStatus(`Error: ${err}`);
      return false;
    }
  };
  const [topics, setTopics] = useState<QuickTopic[]>(loadTopics);
  const [editingTopics, setEditingTopics] = useState(false);
  const [newTopic, setNewTopic] = useState({ label: "", query: "", icon: "\u{1F4E6}" });
  const [showFavsOnly, setShowFavsOnly] = useState(false);

  // Favorites — stored as full McpResult objects so they persist across sessions
  const [favorites, setFavorites] = useState<Map<string, McpResult>>(() => {
    try { const r = localStorage.getItem("occ-mcp-favorites-v2"); return r ? new Map(JSON.parse(r)) : new Map(); } catch { return new Map(); }
  });
  const saveFavorites = (f: Map<string, McpResult>) => { setFavorites(f); localStorage.setItem("occ-mcp-favorites-v2", JSON.stringify([...f])); };
  const toggleFavorite = (preset: McpResult) => {
    const updated = new Map(favorites);
    if (updated.has(preset.id)) updated.delete(preset.id); else updated.set(preset.id, preset);
    saveFavorites(updated);
  };

  const updateTopics = (t: QuickTopic[]) => { setTopics(t); localStorage.setItem("occ-mcp-topics", JSON.stringify(t)); };

  const loadInstalled = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/mcp-servers", { signal: AbortSignal.timeout(5000) }).catch(() => null);
    if (res?.ok) { const d = await res.json(); if (d && typeof d === "object" && !Array.isArray(d)) setInstalled(d); }
    setLoading(false);
  }, []);

  const loadTrending = useCallback(async () => {
    if (trending.length > 0) return;
    const [r1, r2, r3, r4] = await Promise.all([fetchRegistry("github"), fetchRegistry("database"), fetchRegistry("search"), fetchRegistry("filesystem")]);
    const seen = new Set<string>(); const all: McpResult[] = [];
    for (const r of [...r1, ...r2, ...r3, ...r4]) { if (!seen.has(r.id)) { seen.add(r.id); all.push(r); } }
    setTrending(all.slice(0, 24));
  }, [trending.length]);

  useEffect(() => { loadInstalled(); }, [loadInstalled]);
  useEffect(() => { if (showMarketplace) loadTrending(); }, [showMarketplace, loadTrending]);

  const installedIds = new Set(Object.keys(installed));

  const handleSearch = async () => {
    if (!query.trim()) { setResults([]); return; }
    setSearching(true); setResults(await fetchRegistry(query)); setSearching(false);
  };

  const handleInstall = async (preset: McpResult) => {
    const env: Record<string, string> = {};
    for (const key of preset.envKeys) { const v = envValues[`${preset.id}_${key}`]; if (v) env[key] = v; }
    if (preset.requiredEnvKeys.some((k) => !env[k])) { setInstalling(preset.id); return; }
    const cfg: McpServerConfig = { command: preset.command, args: preset.args, ...(Object.keys(env).length > 0 ? { env } : {}) };
    const updated = { ...installed, [preset.id]: cfg };
    if (await saveMcpToBackend(updated)) { setInstalled(updated); }
    setInstalling(null); setEnvValues({});
  };

  const handleRemove = async (name: string) => {
    if (!confirm(`Remove "${name}"?`)) return;
    const updated = { ...installed }; delete updated[name];
    if (await saveMcpToBackend(updated)) { setInstalled(updated); }
  };

  const handleEditSave = async (name: string) => {
    const envObj: Record<string, string> = {};
    editServerForm.env.split("\n").forEach((l) => { const eq = l.indexOf("="); if (eq > 0) envObj[l.slice(0, eq).trim()] = l.slice(eq + 1).trim(); });
    const updated = { ...installed, [name]: { command: editServerForm.command, args: editServerForm.args.split(/\s+/).filter(Boolean), ...(Object.keys(envObj).length > 0 ? { env: envObj } : {}) } };
    if (await saveMcpToBackend(updated)) { setInstalled(updated); }
    setEditingServer(null);
  };

  const handleCustomSave = async () => {
    const envObj: Record<string, string> = {};
    customForm.env.split("\n").forEach((l) => { const eq = l.indexOf("="); if (eq > 0) envObj[l.slice(0, eq).trim()] = l.slice(eq + 1).trim(); });
    const updated = { ...installed, [customForm.name]: { command: customForm.command, args: customForm.args.split(/\s+/).filter(Boolean), ...(Object.keys(envObj).length > 0 ? { env: envObj } : {}) } };
    if (await saveMcpToBackend(updated)) { setInstalled(updated); }
    setCustomAdding(false); setCustomForm({ name: "", command: "", args: "", env: "" });
  };

  // Display: favorites mode shows saved favorites, otherwise search results or trending
  const displayList = showFavsOnly ? [...favorites.values()] : (results.length > 0 ? results : trending);

  const renderCard = (preset: McpResult) => {
    const isInstalled = installedIds.has(preset.id);
    const isInstalling = installing === preset.id;
    const isFav = favorites.has(preset.id);

    return (
      <div key={preset.id} className={`${styles.mcpPresetCard} ${isInstalled ? styles.mcpPresetInstalled : ""}`}>
        <div className={styles.mcpPresetRow}>
          <span className={styles.mcpPresetIcon}>{preset.icon}</span>
          <div className={styles.mcpPresetInfo}>
            <div className={styles.mcpPresetName}>
              {preset.name}
              {preset.tags.map((t) => <span key={t.tag} className={styles.mcpTag} style={{ background: `${t.color}20`, color: t.color, borderColor: `${t.color}40` }}>{t.tag}</span>)}
            </div>
            <div className={styles.mcpPresetDesc}>
              {preset.description}
              {preset.repoUrl && <a href={preset.repoUrl} target="_blank" rel="noopener noreferrer" className={styles.mcpRepoLink} onClick={(e) => e.stopPropagation()}>{"\u2197"}</a>}
            </div>
          </div>
          <button className={styles.favBtn} onClick={() => toggleFavorite(preset)} title={isFav ? "Remove from favorites" : "Add to favorites"} style={{ color: isFav ? "#ffd60a" : undefined }}>
            {isFav ? "\u2605" : "\u2606"}
          </button>
          {isInstalled ? (
            <span className={styles.installedBadge}>Installed</span>
          ) : !isInstalling ? (
            <button className={`${styles.rowBtn} ${styles.rowBtnPrimary}`} onClick={() => handleInstall(preset)} style={{ flexShrink: 0, fontSize: 9, padding: "3px 10px" }}>
              {preset.requiredEnvKeys.length > 0 ? "Configure" : "Install"}
            </button>
          ) : null}
        </div>
        {!isInstalled && isInstalling && (
          <div className={styles.mcpEnvForm}>
            {preset.envKeys.map((key) => (
              <input key={key} className={styles.mcpEnvInput} type={preset.requiredEnvKeys.includes(key) ? "password" : "text"} value={envValues[`${preset.id}_${key}`] ?? ""} onChange={(e) => setEnvValues({ ...envValues, [`${preset.id}_${key}`]: e.target.value })} placeholder={`${key}${preset.requiredEnvKeys.includes(key) ? " (required)" : " (optional)"}`} />
            ))}
            <div className={styles.mcpEnvActions}>
              <button className={styles.rowBtn} onClick={() => setInstalling(null)}>Cancel</button>
              <button className={`${styles.rowBtn} ${styles.rowBtnPrimary}`} onClick={() => handleInstall(preset)}>Install</button>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <CollapsibleSection
      id="mcp"
      title="MCP Servers"
      badge={(
        <>
          <span>{Object.keys(installed).length}</span>
          {saveStatus && <span style={{ marginLeft: 6, color: saveStatus.startsWith("Error") ? "var(--c-error)" : "var(--c-success)" }}>{saveStatus}</span>}
        </>
      )}
    >
      <div className={styles.sectionCard}>
        {loading && <div className={styles.loadingRow}>Loading...</div>}

        {/* Installed servers — card style like Schedules */}
        {Object.entries(installed).map(([name, cfg]) => (
          <div key={name} className={styles.schedCard}>
            <span className={`${styles.statusDot} ${styles.statusOnline}`} style={{ width: 8, height: 8, flexShrink: 0 }} />
            <div className={styles.schedInfo}>
              <div className={styles.schedLabel}>{name}</div>
              <div className={styles.schedMeta}>
                {cfg.command} {cfg.args?.join(" ") ?? ""}
                {cfg.env && Object.keys(cfg.env).length > 0 && <> · {Object.keys(cfg.env).length} env vars</>}
              </div>
            </div>
            <button className={styles.rowBtn} onClick={() => {
              if (editingServer === name) { setEditingServer(null); return; }
              setEditingServer(name);
              setEditServerForm({ command: cfg.command, args: cfg.args?.join(" ") ?? "", env: cfg.env ? Object.entries(cfg.env).map(([k, v]) => `${k}=${v}`).join("\n") : "" });
            }} title="Configure">{"\u2699"}</button>
            <button className={`${styles.rowBtn} ${styles.rowBtnDanger}`} onClick={() => handleRemove(name)} title="Remove">{"\u2716"}</button>
          </div>
        ))}

        {/* Edit form inline */}
        {editingServer && installed[editingServer] && (
          <div className={styles.formCard}>
            <div className={styles.formTitle}>Configure: {editingServer}</div>
            <div className={styles.formRow}><label className={styles.formLabel}>Command</label><input className={styles.formInput} value={editServerForm.command} onChange={(e) => setEditServerForm({ ...editServerForm, command: e.target.value })} /></div>
            <div className={styles.formRow}><label className={styles.formLabel}>Arguments</label><input className={styles.formInput} value={editServerForm.args} onChange={(e) => setEditServerForm({ ...editServerForm, args: e.target.value })} /></div>
            <div className={styles.formRow}><label className={styles.formLabel}>Env (KEY=VALUE per line)</label><textarea className={styles.formTextarea} value={editServerForm.env} onChange={(e) => setEditServerForm({ ...editServerForm, env: e.target.value })} rows={3} placeholder="API_KEY=..." /></div>
            <div className={styles.formActions}>
              <button className={styles.rowBtn} onClick={() => setEditingServer(null)}>Cancel</button>
              <button className={`${styles.rowBtn} ${styles.rowBtnPrimary}`} onClick={() => handleEditSave(editingServer)}>Save</button>
            </div>
          </div>
        )}

        {!loading && Object.keys(installed).length === 0 && !showMarketplace && (
          <div className={styles.emptyCard}>
            <div className={styles.emptyIcon}>{"\u{1F4E6}"}</div>
            <div className={styles.emptyText}>No MCP servers installed</div>
            <div className={styles.emptyHint}>Browse the marketplace to add tools</div>
          </div>
        )}

        <div className={styles.row}>
          <div className={styles.rowBody} />
          <button className={styles.rowBtn} onClick={() => setShowMarketplace(!showMarketplace)}>{showMarketplace ? "Hide Marketplace" : "Marketplace"}</button>
          <button className={styles.rowBtn} onClick={() => { setCustomAdding(!customAdding); setShowMarketplace(false); }}>+ Custom</button>
        </div>

        {customAdding && (
          <div className={styles.formCard}>
            <div className={styles.formTitle}>Add Custom MCP Server</div>
            <div className={styles.formRow}><label className={styles.formLabel}>Name</label><input className={styles.formInput} value={customForm.name} onChange={(e) => setCustomForm({ ...customForm, name: e.target.value })} placeholder="my-server" /></div>
            <div className={styles.formRow}><label className={styles.formLabel}>Command</label><input className={styles.formInput} value={customForm.command} onChange={(e) => setCustomForm({ ...customForm, command: e.target.value })} placeholder="npx" /></div>
            <div className={styles.formRow}><label className={styles.formLabel}>Arguments</label><input className={styles.formInput} value={customForm.args} onChange={(e) => setCustomForm({ ...customForm, args: e.target.value })} placeholder="-y @scope/server-name" /></div>
            <div className={styles.formRow}><label className={styles.formLabel}>Env Variables</label><textarea className={styles.formTextarea} value={customForm.env} onChange={(e) => setCustomForm({ ...customForm, env: e.target.value })} placeholder="API_KEY=..." rows={2} /></div>
            <div className={styles.formActions}>
              <button className={styles.rowBtn} onClick={() => setCustomAdding(false)}>Cancel</button>
              <button className={`${styles.rowBtn} ${styles.rowBtnPrimary}`} onClick={handleCustomSave} disabled={!customForm.name || !customForm.command}>Add</button>
            </div>
          </div>
        )}
      </div>

      {/* Server Presets */}
      <ItemListManager storageKey="occ-mcp-lists" allItemIds={Object.keys(installed)} label="Server Presets" description="Group servers into switchable configurations" />

      {/* ─── Marketplace ─── */}
      {showMarketplace && (
        <div className={styles.marketplace}>
          <div className={styles.marketplaceHeader}>
            <span className={styles.marketplaceTitle}>MCP Registry</span>
            <input className={styles.marketplaceSearch} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleSearch()} placeholder="Search 1000+ servers..." autoFocus />
            <button className={styles.catBtn} onClick={handleSearch} disabled={searching}>{searching ? "..." : "Search"}</button>
            {results.length > 0 && <button className={styles.catBtn} onClick={() => { setResults([]); setQuery(""); }}>Clear</button>}
            <button className={`${styles.favFilterBtn} ${showFavsOnly ? styles.favFilterBtnActive : ""}`} onClick={() => setShowFavsOnly(!showFavsOnly)} title="Favorites">
              {"\u2605"} {favorites.size}
            </button>
          </div>

          {/* Quick topic pills + editor */}
          <div className={styles.quickTopics}>
            {topics.map((t, i) => (
              <button key={`${t.query}-${i}`} className={styles.quickTopicBtn} onClick={() => { setShowFavsOnly(false); setQuery(t.query); setSearching(true); fetchRegistry(t.query).then((r) => { setResults(r); setSearching(false); }); }}>
                <span>{t.icon}</span> {t.label}
              </button>
            ))}
            <button className={styles.quickTopicEdit} onClick={() => setEditingTopics(!editingTopics)} title="Edit categories">{editingTopics ? "\u2713" : "\u270E"}</button>
          </div>

          {editingTopics && (
            <div className={styles.topicEditor}>
              {topics.map((t, i) => (
                <div key={i} className={styles.topicEditorRow}>
                  <select className={styles.topicEmojiSelect} value={t.icon} onChange={(e) => { const u = [...topics]; u[i] = { ...t, icon: e.target.value }; updateTopics(u); }}>{EMOJI_PICKER.map((em) => <option key={em} value={em}>{em}</option>)}</select>
                  <input className={styles.topicInput} value={t.label} onChange={(e) => { const u = [...topics]; u[i] = { ...t, label: e.target.value }; updateTopics(u); }} placeholder="Label" />
                  <input className={styles.topicInput} value={t.query} onChange={(e) => { const u = [...topics]; u[i] = { ...t, query: e.target.value }; updateTopics(u); }} placeholder="Query" style={{ flex: 1 }} />
                  <button className={styles.topicRemoveBtn} onClick={() => updateTopics(topics.filter((_, j) => j !== i))}>{"\u2716"}</button>
                </div>
              ))}
              <div className={styles.topicEditorRow}>
                <select className={styles.topicEmojiSelect} value={newTopic.icon} onChange={(e) => setNewTopic({ ...newTopic, icon: e.target.value })}>{EMOJI_PICKER.map((em) => <option key={em} value={em}>{em}</option>)}</select>
                <input className={styles.topicInput} value={newTopic.label} onChange={(e) => setNewTopic({ ...newTopic, label: e.target.value })} placeholder="New label" />
                <input className={styles.topicInput} value={newTopic.query} onChange={(e) => setNewTopic({ ...newTopic, query: e.target.value })} placeholder="Keywords" style={{ flex: 1 }} />
                <button className={`${styles.rowBtn} ${styles.rowBtnPrimary}`} onClick={() => { if (newTopic.label && newTopic.query) { updateTopics([...topics, { ...newTopic }]); setNewTopic({ label: "", query: "", icon: "\u{1F4E6}" }); } }} disabled={!newTopic.label || !newTopic.query} style={{ fontSize: 9, padding: "2px 8px" }}>Add</button>
              </div>
              <div className={styles.topicEditorActions}><button className={styles.rowBtn} onClick={() => updateTopics(DEFAULT_TOPICS)} style={{ fontSize: 9 }}>Reset defaults</button></div>
            </div>
          )}

          {displayList.length === 0 && !searching && !showFavsOnly && <div className={styles.loadingRow}>Loading trending servers...</div>}
          {displayList.length === 0 && showFavsOnly && <div className={styles.loadingRow}>No favorites yet — click the star on any server</div>}
          {query && !searching && results.length === 0 && !showFavsOnly && <div className={styles.loadingRow}>No results for "{query}"</div>}

          <div className={styles.marketplaceGrid}>{displayList.map(renderCard)}</div>
        </div>
      )}
    </CollapsibleSection>
  );
}
