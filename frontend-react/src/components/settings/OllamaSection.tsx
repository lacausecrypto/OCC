/**
 * OllamaSection — Browse, pull, and manage local Ollama models.
 * UI pattern mirrors McpSection (registry-style marketplace grid).
 */
import { useState, useEffect, useCallback } from "react";
import styles from "./Settings.module.css";

interface OllamaModel {
  name: string;
  model: string;
  size: number;
  details?: {
    parameter_size?: string;
    quantization_level?: string;
    family?: string;
    format?: string;
  };
}

interface OllamaStatus {
  online: boolean;
  models: number;
  host: string;
}

// Popular models with metadata (curated — Ollama doesn't have a public registry API)
const POPULAR_MODELS = [
  { name: "llama3.2", desc: "Meta's latest Llama 3.2", size: "2B", family: "llama", tags: ["chat", "general"] },
  { name: "llama3.2:1b", desc: "Llama 3.2 1B — ultralight", size: "1B", family: "llama", tags: ["fast", "edge"] },
  { name: "llama3.1:8b", desc: "Llama 3.1 8B — balanced", size: "8B", family: "llama", tags: ["chat", "general"] },
  { name: "llama3.1:70b", desc: "Llama 3.1 70B — powerful", size: "70B", family: "llama", tags: ["reasoning", "large"] },
  { name: "mistral", desc: "Mistral 7B — fast & capable", size: "7B", family: "mistral", tags: ["chat", "code"] },
  { name: "mixtral", desc: "Mixtral 8x7B — MoE architecture", size: "47B", family: "mistral", tags: ["reasoning", "large"] },
  { name: "codellama", desc: "Meta Code Llama — code gen", size: "7B", family: "llama", tags: ["code"] },
  { name: "deepseek-coder-v2", desc: "DeepSeek Coder V2", size: "16B", family: "deepseek", tags: ["code"] },
  { name: "phi3", desc: "Microsoft Phi-3 — small & smart", size: "3.8B", family: "phi", tags: ["chat", "fast"] },
  { name: "gemma2", desc: "Google Gemma 2", size: "9B", family: "gemma", tags: ["chat", "general"] },
  { name: "qwen2.5", desc: "Alibaba Qwen 2.5", size: "7B", family: "qwen", tags: ["chat", "multilingual"] },
  { name: "qwen2.5-coder", desc: "Qwen 2.5 Coder", size: "7B", family: "qwen", tags: ["code"] },
  { name: "nomic-embed-text", desc: "Nomic text embeddings", size: "137M", family: "nomic", tags: ["embeddings"] },
  { name: "starcoder2", desc: "BigCode StarCoder 2", size: "3B", family: "starcoder", tags: ["code"] },
  { name: "command-r", desc: "Cohere Command R — RAG optimized", size: "35B", family: "command", tags: ["rag", "large"] },
  { name: "llava", desc: "LLaVA — vision + language", size: "7B", family: "llava", tags: ["vision", "multimodal"] },
];

const TAG_COLORS: Record<string, string> = {
  chat: "var(--m-accent)", code: "#bf5af2", fast: "#30d158", reasoning: "#ff9f0a",
  large: "#ff375f", embeddings: "#64d2ff", vision: "#ff6482", rag: "#5e5ce6",
  general: "var(--m-text2)", multilingual: "#ff9f0a", edge: "#30d158", multimodal: "#ff6482",
};

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function OllamaSection() {
  const [status, setStatus] = useState<OllamaStatus | null>(null);
  const [installed, setInstalled] = useState<OllamaModel[]>([]);
  const [pulling, setPulling] = useState<string | null>(null);
  const [pullProgress, setPullProgress] = useState("");
  const [showMarketplace, setShowMarketplace] = useState(false);
  const [search, setSearch] = useState("");
  const [filterTag, setFilterTag] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch("/ollama/status");
      const data = await res.json() as OllamaStatus;
      setStatus(data);
    } catch { setStatus({ online: false, models: 0, host: "http://localhost:11434" }); }
  }, []);

  const loadModels = useCallback(async () => {
    try {
      const res = await fetch("/ollama/models");
      if (res.ok) {
        const data = await res.json() as OllamaModel[];
        setInstalled(Array.isArray(data) ? data : []);
      }
    } catch { /* offline */ }
  }, []);

  useEffect(() => { loadStatus(); loadModels(); }, [loadStatus, loadModels]);

  const handlePull = async (model: string) => {
    setPulling(model);
    setPullProgress("Starting download...");
    try {
      const res = await fetch("/ollama/pull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
      });
      if (!res.ok || !res.body) { setPullProgress("Error"); return; }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const evt = JSON.parse(line) as { status?: string; total?: number; completed?: number };
            if (evt.total && evt.completed) {
              const pct = ((evt.completed / evt.total) * 100).toFixed(0);
              setPullProgress(`${evt.status ?? "Downloading"} ${pct}%`);
            } else {
              setPullProgress(evt.status ?? "...");
            }
          } catch { /* skip */ }
        }
      }
      setPullProgress("Done!");
      await loadModels();
      await loadStatus();
    } catch (err) {
      setPullProgress(`Error: ${(err as Error).message}`);
    } finally {
      setTimeout(() => { setPulling(null); setPullProgress(""); }, 2000);
    }
  };

  const handleDelete = async (model: string) => {
    if (!confirm(`Delete model "${model}"? This frees disk space but requires re-download.`)) return;
    try {
      await fetch(`/ollama/models/${encodeURIComponent(model)}`, { method: "DELETE" });
      await loadModels();
      await loadStatus();
    } catch { /* */ }
  };

  // Register Ollama as provider if not already
  const handleRegisterProvider = async () => {
    try {
      await fetch("/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "ollama",
          name: "Ollama (Local)",
          type: "ollama",
          apiKey: "",
          baseUrl: status?.host ?? "http://localhost:11434",
          enabled: true,
          models: installed.map((m) => m.name),
        }),
      });
    } catch { /* already exists */ }
  };

  const installedNames = new Set(installed.map((m) => m.name.split(":")[0]));

  const filteredPopular = POPULAR_MODELS.filter((m) => {
    if (search && !m.name.includes(search.toLowerCase()) && !m.desc.toLowerCase().includes(search.toLowerCase())) return false;
    if (filterTag && !m.tags.includes(filterTag)) return false;
    return true;
  });

  const allTags = [...new Set(POPULAR_MODELS.flatMap((m) => m.tags))].sort();

  return (
    <>
      {/* Status bar */}
      <div className={styles.schedCard} style={{ gap: 8 }}>
        <span style={{
          width: 8, height: 8, borderRadius: 4, flexShrink: 0,
          background: status?.online ? "var(--c-success)" : "var(--c-error)",
        }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--m-text)" }}>
            Ollama {status?.online ? "Connected" : "Offline"}
          </div>
          <div style={{ fontSize: 10, color: "var(--m-text2)" }}>
            {status?.host} {status?.online ? `· ${status.models} model${status.models !== 1 ? "s" : ""} installed` : "· Start with: ollama serve"}
          </div>
        </div>
        {status?.online && (
          <button onClick={handleRegisterProvider} title="Register as LLM provider"
            style={{
              padding: "5px 14px", fontSize: 11, fontWeight: 600, borderRadius: 8, cursor: "pointer",
              background: "var(--m-accent)", color: "#fff", border: "none",
              transition: "opacity 0.15s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.opacity = "0.85"; }}
            onMouseLeave={(e) => { e.currentTarget.style.opacity = "1"; }}
          >
            {"\u26D3"} Use in chains
          </button>
        )}
      </div>

      {/* Installed models */}
      {installed.length > 0 && installed.map((m) => (
        <div key={m.name} className={styles.schedCard}>
          <div style={{
            width: 32, height: 32, borderRadius: 8, flexShrink: 0,
            background: "var(--glass-tint)", display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 14,
          }}>
            {"\u{1F9E0}"}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--m-text)" }}>{m.name}</div>
            <div style={{ fontSize: 10, color: "var(--m-text2)", display: "flex", gap: 8, marginTop: 2 }}>
              <span>{formatSize(m.size)}</span>
              {m.details?.parameter_size && (
                <span style={{
                  padding: "0 5px", borderRadius: 4, fontSize: 9, fontWeight: 600,
                  background: "var(--glass-tint)", color: "var(--m-text2)",
                }}>{m.details.parameter_size}</span>
              )}
              {m.details?.quantization_level && (
                <span style={{
                  padding: "0 5px", borderRadius: 4, fontSize: 9,
                  background: "var(--glass-tint)", color: "var(--m-text2)",
                }}>{m.details.quantization_level}</span>
              )}
              {m.details?.family && <span>{m.details.family}</span>}
            </div>
          </div>
          <button onClick={() => handleDelete(m.name)}
            style={{
              padding: "4px 10px", fontSize: 10, fontWeight: 500, borderRadius: 6, cursor: "pointer",
              background: "rgba(255,55,95,0.08)", color: "var(--c-error)",
              border: "1px solid rgba(255,55,95,0.15)",
              transition: "background 0.15s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,55,95,0.15)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(255,55,95,0.08)"; }}
          >
            {"\u2715"} Remove
          </button>
        </div>
      ))}

      {/* Pull progress */}
      {pulling && (
        <div className={styles.formCard} style={{ borderLeft: "3px solid var(--m-accent)" }}>
          <div style={{ fontSize: 11, color: "var(--m-accent)", fontWeight: 600 }}>
            {"\u2B07"} Pulling: {pulling}
          </div>
          <div style={{ fontSize: 10, color: "var(--m-text2)", marginTop: 2 }}>{pullProgress}</div>
          <div style={{ height: 3, borderRadius: 2, background: "var(--m-border)", marginTop: 4, overflow: "hidden" }}>
            <div style={{
              height: "100%", borderRadius: 2, background: "var(--m-accent)",
              width: pullProgress.includes("%") ? pullProgress.match(/(\d+)%/)?.[1] + "%" : "30%",
              transition: "width 0.3s ease",
            }} />
          </div>
        </div>
      )}

      {/* Marketplace toggle */}
      <div style={{ padding: "10px 16px" }}>
        <button onClick={() => setShowMarketplace(!showMarketplace)}
          style={{
            width: "100%", padding: "8px 0", fontSize: 12, fontWeight: 600, borderRadius: 8, cursor: "pointer",
            background: showMarketplace ? "var(--glass-tint)" : "var(--m-accent)",
            color: showMarketplace ? "var(--m-text)" : "#fff",
            border: showMarketplace ? "1px solid var(--m-border)" : "none",
            transition: "all 0.2s ease",
          }}
        >
          {showMarketplace ? "\u2715 Hide Library" : "\u{1F4E6} Browse Model Library"}
        </button>
      </div>

      {/* Marketplace */}
      {showMarketplace && (
        <div className={styles.marketplace}>
          {/* Search + tags */}
          <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--m-border)", display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <input
              className={styles.formInput}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search models..."
              style={{ flex: 1, minWidth: 120, padding: "4px 8px", fontSize: 11 }}
            />
            {allTags.map((t) => (
              <button key={t} onClick={() => setFilterTag(filterTag === t ? null : t)}
                style={{
                  padding: "2px 8px", borderRadius: 10, fontSize: 9, fontWeight: 600, border: "none", cursor: "pointer",
                  background: filterTag === t ? (TAG_COLORS[t] ?? "var(--m-accent)") : "var(--glass-tint)",
                  color: filterTag === t ? "#fff" : "var(--m-text2)",
                }}>
                {t}
              </button>
            ))}
          </div>

          {/* Grid */}
          <div className={styles.marketplaceGrid}>
            {filteredPopular.map((m) => {
              const isInstalled = installedNames.has(m.name.split(":")[0]);
              return (
                <div key={m.name} className={styles.mcpPresetCard}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: "var(--m-text)", flex: 1 }}>{m.name}</span>
                    <span style={{ fontSize: 9, color: "var(--m-text2)" }}>{m.size}</span>
                  </div>
                  <div style={{ fontSize: 10, color: "var(--m-text2)", lineHeight: 1.3 }}>{m.desc}</div>
                  <div style={{ display: "flex", gap: 3, flexWrap: "wrap", marginTop: 2 }}>
                    {m.tags.map((t) => (
                      <span key={t} style={{
                        fontSize: 8, padding: "1px 5px", borderRadius: 4, fontWeight: 600,
                        background: `color-mix(in srgb, ${TAG_COLORS[t] ?? "var(--m-text2)"} 15%, transparent)`,
                        color: TAG_COLORS[t] ?? "var(--m-text2)",
                      }}>{t}</span>
                    ))}
                  </div>
                  <div style={{ marginTop: 4 }}>
                    {isInstalled ? (
                      <span style={{ fontSize: 9, color: "var(--c-success)", fontWeight: 600 }}>{"\u2713"} Installed</span>
                    ) : (
                      <button onClick={() => handlePull(m.name)} disabled={!!pulling}
                        className={styles.schedBtn}
                        style={{ fontSize: 10, padding: "3px 10px" }}>
                        {pulling === m.name ? pullProgress : "Pull"}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Custom pull */}
          <div style={{ padding: "8px 10px", borderTop: "1px solid var(--m-border)", display: "flex", gap: 6 }}>
            <input
              className={styles.formInput}
              placeholder="Custom model name (e.g. wizardcoder:7b)"
              id="ollama-custom-pull"
              style={{ flex: 1, padding: "4px 8px", fontSize: 11 }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const input = e.currentTarget;
                  if (input.value.trim()) { handlePull(input.value.trim()); input.value = ""; }
                }
              }}
            />
            <button className={styles.schedBtn} style={{ fontSize: 10 }}
              onClick={() => {
                const input = document.getElementById("ollama-custom-pull") as HTMLInputElement;
                if (input?.value.trim()) { handlePull(input.value.trim()); input.value = ""; }
              }}>
              Pull
            </button>
          </div>
        </div>
      )}
    </>
  );
}
