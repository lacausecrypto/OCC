/**
 * LLM Provider management — preset cards for quick setup + full CRUD.
 * Non-devs can 1-click add OpenRouter, OpenAI, etc.
 * Claude CLI models are always present as built-in.
 */
import { useState, useEffect, useCallback } from "react";
import { ItemListManager } from "./ItemListManager";
import styles from "./Settings.module.css";

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

// ─── Provider presets for 1-click setup ─────────────────────────────────────

interface ProviderPreset {
  id: string;
  name: string;
  type: LLMProvider["type"];
  description: string;
  icon: string;
  color: string;
  baseUrl: string;
  keyPlaceholder: string;
  keyHint: string;
  defaultModels: string[];
}

const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "openrouter", name: "OpenRouter", type: "openrouter",
    description: "Access 200+ models via one API — GPT-4o, Gemini, Llama, Mistral, DeepSeek...",
    icon: "\u{1F310}", color: "var(--icon-purple-bg)",
    baseUrl: "https://openrouter.ai/api/v1",
    keyPlaceholder: "sk-or-v1-...",
    keyHint: "Get your key at openrouter.ai/keys",
    defaultModels: [
      "anthropic/claude-sonnet-4", "openai/gpt-4o", "openai/gpt-4o-mini",
      "google/gemini-2.5-pro", "google/gemini-2.5-flash",
      "deepseek/deepseek-r1", "deepseek/deepseek-chat",
      "meta-llama/llama-4-maverick",
      "mistralai/mistral-large", "qwen/qwen3-235b-a22b",
    ],
  },
  {
    id: "openai", name: "OpenAI", type: "openai",
    description: "GPT-4o, GPT-4o mini, o3-mini and more",
    icon: "\u{1F916}", color: "var(--icon-green-bg)",
    baseUrl: "https://api.openai.com/v1",
    keyPlaceholder: "sk-...",
    keyHint: "Get your key at platform.openai.com/api-keys",
    defaultModels: ["gpt-4o", "gpt-4o-mini", "o3-mini", "o4-mini"],
  },
  {
    id: "groq", name: "Groq", type: "custom",
    description: "Ultra-fast inference — Llama, Mixtral at lightning speed",
    icon: "\u26A1", color: "var(--icon-orange-bg)",
    baseUrl: "https://api.groq.com/openai/v1",
    keyPlaceholder: "gsk_...",
    keyHint: "Get your key at console.groq.com",
    defaultModels: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "mixtral-8x7b-32768"],
  },
  {
    id: "together", name: "Together AI", type: "custom",
    description: "Open-source models — Llama, Qwen, DeepSeek",
    icon: "\u{1F91D}", color: "var(--icon-cyan-bg)",
    baseUrl: "https://api.together.xyz/v1",
    keyPlaceholder: "...",
    keyHint: "Get your key at api.together.xyz",
    defaultModels: ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "deepseek-ai/DeepSeek-R1", "Qwen/Qwen2.5-72B-Instruct-Turbo"],
  },
  {
    id: "mistral", name: "Mistral AI", type: "custom",
    description: "Mistral Large, Codestral, Pixtral",
    icon: "\u{1F32A}", color: "var(--icon-red-bg)",
    baseUrl: "https://api.mistral.ai/v1",
    keyPlaceholder: "...",
    keyHint: "Get your key at console.mistral.ai",
    defaultModels: ["mistral-large-latest", "codestral-latest", "mistral-small-latest"],
  },
];

function Toggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button className={`${styles.toggle} ${on ? styles.toggleOn : ""}`} onClick={onToggle} type="button">
      <div className={styles.toggleDot} />
    </button>
  );
}

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(path, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

export function ProviderSection() {
  const [providers, setProviders] = useState<LLMProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [setupId, setSetupId] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [testResults, setTestResults] = useState<Record<string, string>>({});
  const [showAddPreset, setShowAddPreset] = useState(false);

  // Advanced edit
  const [editing, setEditing] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ name: "", apiKey: "", baseUrl: "", defaultModel: "", models: "" });

  const BUILTIN_CLAUDE: LLMProvider = {
    id: "claude",
    name: "Anthropic (Claude CLI)",
    type: "claude",
    apiKey: "",
    baseUrl: "",
    defaultModel: "claude-sonnet-4-6",
    enabled: true,
    models: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"],
    createdAt: "",
  };

  const loadProviders = useCallback(async () => {
    setLoading(true);
    const data = await fetchJson<LLMProvider[]>("/providers");
    if (Array.isArray(data) && data.length > 0) {
      setProviders(data);
    } else {
      // Fallback: always show Claude CLI even if backend hasn't been rebuilt
      setProviders([BUILTIN_CLAUDE]);
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadProviders(); }, [loadProviders]);

  const installedIds = new Set(providers.map((p) => p.id));

  const handleQuickInstall = async (preset: ProviderPreset) => {
    if (!apiKeyInput.trim()) return;
    await fetch("/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: preset.id,
        name: preset.name,
        type: preset.type,
        apiKey: apiKeyInput.trim(),
        baseUrl: preset.baseUrl,
        enabled: true,
        models: preset.defaultModels,
      }),
    });
    setSetupId(null);
    setApiKeyInput("");
    loadProviders();
  };

  const handleToggle = async (p: LLMProvider) => {
    await fetch(`/providers/${p.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !p.enabled }),
    });
    loadProviders();
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this provider? This will remove the API key.")) return;
    await fetch(`/providers/${id}`, { method: "DELETE" });
    loadProviders();
  };

  const handleTest = async (id: string) => {
    setTestResults((r) => ({ ...r, [id]: "Testing..." }));
    const result = await fetch(`/providers/${id}/test`, { method: "POST" }).then((r) => r.json()).catch(() => ({ ok: false, error: "Network error" }));
    if (result.ok) {
      setTestResults((r) => ({ ...r, [id]: `OK (${result.models?.length ?? 0} models)` }));
      if (result.models?.length > 0) {
        await fetch(`/providers/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ models: result.models }),
        });
        loadProviders();
      }
    } else {
      setTestResults((r) => ({ ...r, [id]: result.error ?? "Failed" }));
    }
    setTimeout(() => setTestResults((r) => { const n = { ...r }; delete n[id]; return n; }), 5000);
  };

  const handleEditSave = async () => {
    if (!editing) return;
    const body: Record<string, unknown> = {
      name: editForm.name,
      baseUrl: editForm.baseUrl,
      defaultModel: editForm.defaultModel || undefined,
      models: editForm.models.split(",").map((m) => m.trim()).filter(Boolean),
    };
    if (editForm.apiKey) body.apiKey = editForm.apiKey;
    await fetch(`/providers/${editing}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setEditing(null);
    loadProviders();
  };

  const typeColors: Record<string, string> = { claude: "var(--icon-blue-bg)", openrouter: "var(--icon-purple-bg)", openai: "var(--icon-green-bg)", custom: "var(--icon-orange-bg)" };

  return (
    <div className={styles.section}>
      <div className={styles.sectionTitle}>LLM Providers ({providers.length})</div>
      <div className={styles.sectionCard}>
        {loading && <div className={styles.loadingRow}>Loading...</div>}

        {/* Installed providers */}
        {providers.map((p) => (
          <div key={p.id} className={styles.providerCard}>
            <div className={styles.providerHeader}>
              <div className={styles.rowIcon} style={{ background: typeColors[p.type] ?? "#86868b" }}>
                {p.name.slice(0, 2).toUpperCase()}
              </div>
              <div className={styles.providerInfo}>
                <div className={styles.providerName}>
                  {p.name}
                  {p.id === "claude" && <span className={styles.builtinBadge}>Built-in</span>}
                </div>
                <div className={styles.providerMeta}>
                  {p.type} · {p.apiKey ? "Key set" : (p.id === "claude" ? "CLI" : "No key")} · {p.models?.length ?? 0} models
                </div>
              </div>
              <Toggle on={p.enabled} onToggle={() => handleToggle(p)} />
            </div>

            {/* Models */}
            {p.enabled && p.models && p.models.length > 0 && (
              <div className={styles.providerModels}>
                {p.models.slice(0, 6).map((m) => <span key={m} className={styles.mcpToolPill}>{m}</span>)}
                {p.models.length > 6 && <span className={styles.mcpToolPill}>+{p.models.length - 6}</span>}
              </div>
            )}

            <div className={styles.providerActions}>
              <button className={styles.rowBtn} onClick={() => handleTest(p.id)}>
                {testResults[p.id] ?? "Test"}
              </button>
              <button className={styles.rowBtn} onClick={() => {
                setEditing(p.id);
                setEditForm({
                  name: p.name,
                  apiKey: "",
                  baseUrl: p.baseUrl,
                  defaultModel: p.defaultModel ?? "",
                  models: p.models?.join(", ") ?? "",
                });
              }}>{"\u270E"}</button>
              {p.id !== "claude" && (
                <button className={`${styles.rowBtn} ${styles.rowBtnDanger}`} onClick={() => handleDelete(p.id)}>{"\u2716"}</button>
              )}
            </div>

            {/* Edit form (inline) */}
            {editing === p.id && (
              <div className={styles.providerEditInline}>
                <div className={styles.formRow}>
                  <label className={styles.formLabel}>Name</label>
                  <input className={styles.formInput} value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} />
                </div>
                {p.id !== "claude" && (
                  <div className={styles.formRow}>
                    <label className={styles.formLabel}>API Key (leave empty to keep current)</label>
                    <input className={styles.formInput} type="password" value={editForm.apiKey} onChange={(e) => setEditForm({ ...editForm, apiKey: e.target.value })} placeholder="(unchanged)" />
                  </div>
                )}
                <div className={styles.formRow}>
                  <label className={styles.formLabel}>Models (comma-separated)</label>
                  <textarea className={styles.formTextarea} value={editForm.models} onChange={(e) => setEditForm({ ...editForm, models: e.target.value })} rows={2} />
                  <span className={styles.formHint}>Click "Test" to auto-discover models from the API</span>
                </div>
                <div className={styles.formActions}>
                  <button className={styles.rowBtn} onClick={() => setEditing(null)}>Cancel</button>
                  <button className={`${styles.rowBtn} ${styles.rowBtnPrimary}`} onClick={handleEditSave}>Save</button>
                </div>
              </div>
            )}
          </div>
        ))}

        {/* Add provider button */}
        <div className={styles.row}>
          <div className={styles.rowBody} />
          <button className={`${styles.rowBtn} ${styles.rowBtnPrimary}`} onClick={() => setShowAddPreset(!showAddPreset)}>
            {showAddPreset ? "Hide" : "+ Add Provider"}
          </button>
        </div>
      </div>

      {/* ─── Quick-add preset cards ─── */}
      {showAddPreset && (
        <div className={styles.presetGrid}>
          {PROVIDER_PRESETS.filter((p) => !installedIds.has(p.id)).map((preset) => (
            <div key={preset.id} className={styles.presetCard}>
              <div className={styles.presetCardHeader}>
                <span className={styles.presetIcon} style={{ background: preset.color }}>{preset.icon}</span>
                <div>
                  <div className={styles.presetName}>{preset.name}</div>
                  <div className={styles.presetDesc}>{preset.description}</div>
                </div>
              </div>

              {setupId === preset.id ? (
                <div className={styles.presetSetup}>
                  <input
                    className={styles.formInput}
                    type="password"
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                    placeholder={preset.keyPlaceholder}
                    onKeyDown={(e) => e.key === "Enter" && handleQuickInstall(preset)}
                    autoFocus
                  />
                  <span className={styles.formHint}>{preset.keyHint}</span>
                  <div className={styles.formActions}>
                    <button className={styles.rowBtn} onClick={() => { setSetupId(null); setApiKeyInput(""); }}>Cancel</button>
                    <button className={`${styles.rowBtn} ${styles.rowBtnPrimary}`} onClick={() => handleQuickInstall(preset)} disabled={!apiKeyInput.trim()}>
                      Connect
                    </button>
                  </div>
                </div>
              ) : (
                <button className={`${styles.rowBtn} ${styles.rowBtnPrimary}`} style={{ alignSelf: "flex-start", marginTop: 6 }} onClick={() => { setSetupId(preset.id); setApiKeyInput(""); }}>
                  Set Up
                </button>
              )}

              <div className={styles.presetModels}>
                {preset.defaultModels.slice(0, 4).map((m) => <span key={m} className={styles.mcpToolPill}>{m}</span>)}
                {preset.defaultModels.length > 4 && <span className={styles.mcpToolPill}>+{preset.defaultModels.length - 4}</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Provider Lists */}
      <ItemListManager
        storageKey="occ-provider-lists"
        allItemIds={providers.map((p) => p.id)}
        label="Provider Presets"
        description="Group providers into switchable configurations"
        itemLabel={(id) => {
          const p = providers.find((pr) => pr.id === id);
          return p ? p.name : id;
        }}
      />

      <div className={styles.sectionHint}>
        Each step can use any model from any enabled provider. Set <code>model: "openrouter/gpt-4o"</code> or select in Workflow editor.
      </div>
    </div>
  );
}
