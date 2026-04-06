/**
 * HuggingFaceSection — Browse, search, and register HuggingFace models.
 * Scalable: internal scroll, "show more" pagination, collapsible panels.
 */
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import styles from "./Settings.module.css";

// ─── Types ──────────────────────────────────────────────────────────────────

interface HFModel {
  id: string;
  author?: string;
  downloads?: number;
  likes?: number;
  pipeline_tag?: string;
  tags?: string[];
}

type Tier = "free" | "pro";

interface CuratedModel {
  id: string;
  desc: string;
  size: string;
  tags: string[];
  tier: Tier;
}

// ─── Data ───────────────────────────────────────────────────────────────────

// Built from live /v1/models endpoint on router.huggingface.co (118 models available)
const CURATED_MODELS: CuratedModel[] = [
  // ══════════════════════════════════════════════════════════════════════════
  // FREE — Available on HF Router without PRO token
  // ══════════════════════════════════════════════════════════════════════════
  // Meta Llama
  { id: "meta-llama/Llama-3.2-1B-Instruct", desc: "Llama 3.2 1B — ultralight", size: "1B", tags: ["chat", "fast"], tier: "free" },
  { id: "meta-llama/Llama-3.1-8B-Instruct", desc: "Llama 3.1 8B — balanced", size: "8B", tags: ["chat", "general"], tier: "free" },
  { id: "meta-llama/Meta-Llama-3-8B-Instruct", desc: "Llama 3 8B", size: "8B", tags: ["chat", "general"], tier: "free" },
  { id: "meta-llama/Llama-4-Scout-17B-16E-Instruct", desc: "Llama 4 Scout 17B", size: "17B", tags: ["chat", "reasoning"], tier: "free" },
  // Qwen (largest free selection)
  { id: "Qwen/Qwen3-8B", desc: "Qwen 3 8B", size: "8B", tags: ["chat", "general"], tier: "free" },
  { id: "Qwen/Qwen3-14B", desc: "Qwen 3 14B", size: "14B", tags: ["chat", "reasoning"], tier: "free" },
  { id: "Qwen/Qwen3-32B", desc: "Qwen 3 32B", size: "32B", tags: ["reasoning", "large"], tier: "free" },
  { id: "Qwen/Qwen3-30B-A3B", desc: "Qwen 3 30B MoE (3B active)", size: "30B", tags: ["chat", "fast"], tier: "free" },
  { id: "Qwen/Qwen3-4B-Instruct-2507", desc: "Qwen 3 4B Instruct", size: "4B", tags: ["chat", "fast"], tier: "free" },
  { id: "Qwen/Qwen3-4B-Thinking-2507", desc: "Qwen 3 4B Thinking", size: "4B", tags: ["reasoning", "fast"], tier: "free" },
  { id: "Qwen/Qwen2.5-7B-Instruct", desc: "Qwen 2.5 7B", size: "7B", tags: ["chat", "multilingual"], tier: "free" },
  { id: "Qwen/Qwen2.5-72B-Instruct", desc: "Qwen 2.5 72B", size: "72B", tags: ["reasoning", "large"], tier: "free" },
  { id: "Qwen/Qwen2.5-Coder-7B-Instruct", desc: "Qwen 2.5 Coder 7B", size: "7B", tags: ["code"], tier: "free" },
  { id: "Qwen/Qwen2.5-Coder-32B-Instruct", desc: "Qwen 2.5 Coder 32B", size: "32B", tags: ["code", "large"], tier: "free" },
  { id: "Qwen/Qwen2.5-Coder-3B-Instruct", desc: "Qwen 2.5 Coder 3B", size: "3B", tags: ["code", "fast"], tier: "free" },
  { id: "Qwen/Qwen3.5-9B", desc: "Qwen 3.5 9B", size: "9B", tags: ["chat", "general"], tier: "free" },
  { id: "Qwen/Qwen3.5-27B", desc: "Qwen 3.5 27B", size: "27B", tags: ["reasoning", "large"], tier: "free" },
  // Qwen Code
  { id: "Qwen/Qwen3-Coder-30B-A3B-Instruct", desc: "Qwen 3 Coder 30B MoE", size: "30B", tags: ["code", "fast"], tier: "free" },
  // Qwen Vision
  { id: "Qwen/Qwen3-VL-8B-Instruct", desc: "Qwen 3 VL 8B — vision", size: "8B", tags: ["vision"], tier: "free" },
  // Google
  { id: "google/gemma-3-27b-it", desc: "Gemma 3 27B", size: "27B", tags: ["chat", "large"], tier: "free" },
  { id: "google/gemma-3n-E4B-it", desc: "Gemma 3n E4B", size: "4B", tags: ["chat", "fast"], tier: "free" },
  { id: "google/gemma-4-31B-it", desc: "Gemma 4 31B", size: "31B", tags: ["reasoning", "large"], tier: "free" },
  { id: "google/gemma-4-26B-A4B-it", desc: "Gemma 4 26B MoE (4B active)", size: "26B", tags: ["chat", "fast"], tier: "free" },
  // DeepSeek
  { id: "deepseek-ai/DeepSeek-R1", desc: "DeepSeek R1 — reasoning", size: "671B", tags: ["reasoning", "large"], tier: "free" },
  { id: "deepseek-ai/DeepSeek-R1-0528", desc: "DeepSeek R1 0528", size: "671B", tags: ["reasoning", "large"], tier: "free" },
  { id: "deepseek-ai/DeepSeek-V3", desc: "DeepSeek V3", size: "671B", tags: ["chat", "large"], tier: "free" },
  { id: "deepseek-ai/DeepSeek-V3-0324", desc: "DeepSeek V3 0324", size: "671B", tags: ["chat", "large"], tier: "free" },
  { id: "deepseek-ai/DeepSeek-V3.1", desc: "DeepSeek V3.1", size: "671B", tags: ["chat", "large"], tier: "free" },
  { id: "deepseek-ai/DeepSeek-R1-Distill-Qwen-32B", desc: "DeepSeek R1 Distill 32B", size: "32B", tags: ["reasoning"], tier: "free" },
  { id: "deepseek-ai/DeepSeek-R1-Distill-Llama-70B", desc: "DeepSeek R1 Distill Llama 70B", size: "70B", tags: ["reasoning", "large"], tier: "free" },
  { id: "deepseek-ai/DeepSeek-R1-Distill-Llama-8B", desc: "DeepSeek R1 Distill 8B", size: "8B", tags: ["reasoning", "fast"], tier: "free" },
  { id: "deepseek-ai/DeepSeek-R1-Distill-Qwen-7B", desc: "DeepSeek R1 Distill Qwen 7B", size: "7B", tags: ["reasoning", "fast"], tier: "free" },
  { id: "deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B", desc: "DeepSeek R1 Distill 1.5B", size: "1.5B", tags: ["reasoning", "fast"], tier: "free" },
  // NousResearch
  { id: "NousResearch/Hermes-2-Pro-Llama-3-8B", desc: "Hermes 2 Pro Llama 8B", size: "8B", tags: ["chat", "general"], tier: "free" },
  // Community / Other
  { id: "allenai/Olmo-3-7B-Instruct", desc: "OLMo 3 7B", size: "7B", tags: ["chat", "general"], tier: "free" },
  { id: "allenai/Olmo-3.1-32B-Instruct", desc: "OLMo 3.1 32B", size: "32B", tags: ["reasoning", "large"], tier: "free" },
  { id: "allenai/Olmo-3.1-32B-Think", desc: "OLMo 3.1 32B Think", size: "32B", tags: ["reasoning", "large"], tier: "free" },
  { id: "openai/gpt-oss-120b", desc: "GPT OSS 120B (open weights)", size: "120B", tags: ["reasoning", "large"], tier: "free" },
  { id: "openai/gpt-oss-20b", desc: "GPT OSS 20B (open weights)", size: "20B", tags: ["chat", "general"], tier: "free" },
  // Cohere
  { id: "CohereLabs/c4ai-command-a-03-2025", desc: "Command A — 2025", size: "111B", tags: ["chat", "large"], tier: "free" },
  { id: "CohereLabs/c4ai-command-r-08-2024", desc: "Command R", size: "35B", tags: ["chat", "general"], tier: "free" },
  { id: "CohereLabs/c4ai-command-r7b-12-2024", desc: "Command R 7B", size: "7B", tags: ["chat", "fast"], tier: "free" },
  { id: "CohereLabs/aya-expanse-32b", desc: "Aya Expanse 32B", size: "32B", tags: ["multilingual", "large"], tier: "free" },
  // GLM / Zhipu
  { id: "zai-org/GLM-4-32B-0414", desc: "GLM 4 32B", size: "32B", tags: ["reasoning", "large"], tier: "free" },
  { id: "zai-org/GLM-4.5", desc: "GLM 4.5", size: "?", tags: ["chat", "general"], tier: "free" },
  { id: "zai-org/GLM-5", desc: "GLM 5", size: "?", tags: ["reasoning", "large"], tier: "free" },
  // Moonshot
  { id: "moonshotai/Kimi-K2-Instruct", desc: "Kimi K2 Instruct", size: "?", tags: ["chat", "reasoning"], tier: "free" },
  { id: "moonshotai/Kimi-K2.5", desc: "Kimi K2.5", size: "?", tags: ["chat", "reasoning"], tier: "free" },
  // MiniMax
  { id: "MiniMaxAI/MiniMax-M2.5", desc: "MiniMax M2.5", size: "?", tags: ["chat", "general"], tier: "free" },
  // Baidu ERNIE
  { id: "baidu/ERNIE-4.5-21B-A3B-PT", desc: "ERNIE 4.5 21B MoE", size: "21B", tags: ["chat", "fast"], tier: "free" },
  // Xiaomi
  { id: "XiaomiMiMo/MiMo-V2-Flash", desc: "MiMo V2 Flash", size: "?", tags: ["chat", "fast"], tier: "free" },

  // ══════════════════════════════════════════════════════════════════════════
  // PRO — Requires HF PRO token ($9/mo) or may have higher rate limits
  // ══════════════════════════════════════════════════════════════════════════
  { id: "meta-llama/Llama-3.1-70B-Instruct", desc: "Llama 3.1 70B", size: "70B", tags: ["reasoning", "large"], tier: "pro" },
  { id: "meta-llama/Llama-3.3-70B-Instruct", desc: "Llama 3.3 70B", size: "70B", tags: ["reasoning", "large"], tier: "pro" },
  { id: "meta-llama/Llama-4-Maverick-17B-128E-Instruct", desc: "Llama 4 Maverick 128E", size: "17B", tags: ["reasoning", "large"], tier: "pro" },
  { id: "Qwen/Qwen3-235B-A22B", desc: "Qwen 3 235B MoE", size: "235B", tags: ["reasoning", "large"], tier: "pro" },
  { id: "Qwen/Qwen3.5-122B-A10B", desc: "Qwen 3.5 122B MoE", size: "122B", tags: ["reasoning", "large"], tier: "pro" },
  { id: "Qwen/Qwen3.5-397B-A17B", desc: "Qwen 3.5 397B MoE", size: "397B", tags: ["reasoning", "large"], tier: "pro" },
  { id: "Qwen/Qwen3-Coder-480B-A35B-Instruct", desc: "Qwen 3 Coder 480B MoE", size: "480B", tags: ["code", "large"], tier: "pro" },
  { id: "Qwen/Qwen2.5-VL-72B-Instruct", desc: "Qwen 2.5 VL 72B — vision", size: "72B", tags: ["vision", "large"], tier: "pro" },
  { id: "Qwen/Qwen3-VL-235B-A22B-Instruct", desc: "Qwen 3 VL 235B — vision", size: "235B", tags: ["vision", "large"], tier: "pro" },
  { id: "deepseek-ai/DeepSeek-Prover-V2-671B", desc: "DeepSeek Prover V2", size: "671B", tags: ["reasoning", "large"], tier: "pro" },
  { id: "deepcogito/cogito-671b-v2.1", desc: "Cogito 671B v2.1", size: "671B", tags: ["reasoning", "large"], tier: "pro" },
  { id: "CohereLabs/command-a-reasoning-08-2025", desc: "Command A Reasoning", size: "111B", tags: ["reasoning", "large"], tier: "pro" },
  { id: "CohereLabs/command-a-vision-07-2025", desc: "Command A Vision", size: "111B", tags: ["vision", "large"], tier: "pro" },
];

const TAG_COLORS: Record<string, string> = {
  chat: "var(--m-accent)", code: "#bf5af2", fast: "#30d158", reasoning: "#ff9f0a",
  large: "#ff375f", embeddings: "#64d2ff", general: "var(--m-text2)", multilingual: "#ff9f0a",
  edge: "#30d158", vision: "#ff6482", audio: "#ff9500", translation: "#5ac8fa",
  summarization: "#af52de", classification: "#ff2d55", safety: "#ffcc00",
};

const PAGE_SIZE = 12;

function formatDownloads(n?: number): string {
  if (!n) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

// ─── Component ──────────────────────────────────────────────────────────────

export function HuggingFaceSection() {
  const [tokenInput, setTokenInput] = useState("");
  const [tokenSaved, setTokenSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const [showLibrary, setShowLibrary] = useState(false);
  const [showRateLimits, setShowRateLimits] = useState(false);
  const [search, setSearch] = useState("");
  const [filterTag, setFilterTag] = useState<string | null>(null);
  const [tierFilter, setTierFilter] = useState<Tier | null>(null);
  const [searchResults, setSearchResults] = useState<HFModel[]>([]);
  const [searching, setSearching] = useState(false);
  const [registered, setRegistered] = useState(false);
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set());
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [hubVisibleCount, setHubVisibleCount] = useState(PAGE_SIZE);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Load saved token + previously selected models
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/providers");
        const providers = await res.json();
        const hf = (providers as Array<{ id: string; apiKey?: string; models?: string[] }>).find(p => p.id === "huggingface");
        if (hf?.apiKey && hf.apiKey !== "") setTokenSaved(true);
        if (hf?.models?.length) setSelectedModels(new Set(hf.models));
      } catch { /* */ }
    })();
  }, []);

  // Debounced live search
  const handleSearch = useCallback(async (query: string) => {
    if (!query.trim()) { setSearchResults([]); return; }
    setSearching(true);
    try {
      const res = await fetch(`/huggingface/models?search=${encodeURIComponent(query)}&limit=50`);
      if (res.ok) {
        const data = await res.json() as HFModel[];
        setSearchResults(Array.isArray(data) ? data : []);
      }
    } catch { /* */ }
    setSearching(false);
  }, []);

  useEffect(() => {
    if (!search.trim()) { setSearchResults([]); return; }
    const t = setTimeout(() => handleSearch(search), 400);
    return () => clearTimeout(t);
  }, [search, handleSearch]);

  // Reset pagination when filters change
  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [search, filterTag, tierFilter]);
  useEffect(() => { setHubVisibleCount(PAGE_SIZE); }, [search]);

  const handleTest = async () => {
    setTesting(true); setTestResult(null);
    try {
      const res = await fetch("/huggingface/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: tokenInput || undefined }),
      });
      setTestResult(await res.json() as { ok: boolean; error?: string });
    } catch (err) { setTestResult({ ok: false, error: (err as Error).message }); }
    setTesting(false);
  };

  const toggleModel = (modelId: string) => {
    setSelectedModels(prev => {
      const next = new Set(prev);
      if (next.has(modelId)) next.delete(modelId); else next.add(modelId);
      // Auto-save selected models to provider
      const models = [...next];
      fetch("/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "huggingface", name: "HuggingFace", type: "huggingface",
          apiKey: tokenInput || "", baseUrl: "https://router.huggingface.co/v1",
          enabled: true, models,
        }),
      }).then(() => {
        window.dispatchEvent(new Event("occ-providers-changed"));
      }).catch(() => {});
      return next;
    });
  };

  const handleRegisterProvider = async () => {
    // Only register explicitly selected models (not all curated)
    const models = [...selectedModels];
    try {
      await fetch("/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "huggingface", name: "HuggingFace", type: "huggingface",
          apiKey: tokenInput || "", baseUrl: "https://router.huggingface.co/v1",
          enabled: true, models,
        }),
      });
      setRegistered(true); setTokenSaved(!!tokenInput);
      window.dispatchEvent(new Event("occ-providers-changed"));
      setTimeout(() => setRegistered(false), 3000);
    } catch { /* */ }
  };

  // ── Derived data ──

  const filteredCurated = useMemo(() => CURATED_MODELS.filter((m) => {
    if (search && !m.id.toLowerCase().includes(search.toLowerCase()) && !m.desc.toLowerCase().includes(search.toLowerCase())) return false;
    if (filterTag && !m.tags.includes(filterTag)) return false;
    if (tierFilter && m.tier !== tierFilter) return false;
    return true;
  }), [search, filterTag, tierFilter]);

  const allTags = useMemo(() =>
    [...new Set(CURATED_MODELS.flatMap((m) => m.tags))].sort(),
  []);

  const freeCount = useMemo(() => CURATED_MODELS.filter(m => m.tier === "free").length, []);
  const proCount = useMemo(() => CURATED_MODELS.filter(m => m.tier === "pro").length, []);
  const paginatedCurated = filteredCurated.slice(0, visibleCount);
  const hasMoreCurated = visibleCount < filteredCurated.length;
  const paginatedHub = searchResults.slice(0, hubVisibleCount);
  const hasMoreHub = hubVisibleCount < searchResults.length;

  // ── Render helpers ──

  const renderCuratedCard = (m: CuratedModel) => (
    <div key={m.id} className={styles.mcpPresetCard}
      style={{ border: selectedModels.has(m.id) ? "1px solid var(--m-accent)" : undefined }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "var(--m-text)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {m.id.split("/")[1] ?? m.id}
        </span>
        <span style={{
          fontSize: 8, padding: "1px 6px", borderRadius: 4, fontWeight: 700, flexShrink: 0,
          background: m.tier === "free"
            ? "color-mix(in srgb, var(--c-success) 15%, transparent)"
            : "color-mix(in srgb, #5e5ce6 15%, transparent)",
          color: m.tier === "free" ? "var(--c-success)" : "#5e5ce6",
        }}>{m.tier === "free" ? "FREE" : "PRO"}</span>
        <span style={{ fontSize: 9, color: "var(--m-text2)", flexShrink: 0 }}>{m.size}</span>
      </div>
      <div style={{ fontSize: 10, color: "var(--m-text2)", lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.desc}</div>
      <div style={{ display: "flex", gap: 3, flexWrap: "wrap", marginTop: 2 }}>
        {m.tags.map((t) => (
          <span key={t} style={{
            fontSize: 8, padding: "1px 5px", borderRadius: 4, fontWeight: 600,
            background: `color-mix(in srgb, ${TAG_COLORS[t] ?? "var(--m-text2)"} 15%, transparent)`,
            color: TAG_COLORS[t] ?? "var(--m-text2)",
          }}>{t}</span>
        ))}
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 3 }}>
        <span style={{ fontSize: 9, color: "var(--m-text2)", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {m.id.split("/")[0]}
        </span>
        <button onClick={() => toggleModel(m.id)}
          className={styles.schedBtn}
          style={{
            fontSize: 9, padding: "2px 8px", flexShrink: 0,
            background: selectedModels.has(m.id) ? "var(--c-success)" : undefined,
            color: selectedModels.has(m.id) ? "#fff" : undefined,
          }}>
          {selectedModels.has(m.id) ? "\u2713 Added" : "+ Select"}
        </button>
      </div>
    </div>
  );

  const renderHubCard = (m: HFModel) => (
    <div key={m.id} className={styles.mcpPresetCard}
      style={{ border: selectedModels.has(m.id) ? "1px solid var(--m-accent)" : undefined }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: "var(--m-text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {m.id}
      </div>
      <div style={{ fontSize: 10, color: "var(--m-text2)", display: "flex", gap: 8, flexWrap: "wrap" }}>
        {m.downloads != null && <span>{"\u2B07"} {formatDownloads(m.downloads)}</span>}
        {m.likes != null && <span>{"\u2764"} {m.likes}</span>}
        {m.pipeline_tag && (
          <span style={{
            padding: "0 5px", borderRadius: 4, fontSize: 8, fontWeight: 600,
            background: "var(--glass-tint)", color: "var(--m-text2)",
          }}>{m.pipeline_tag}</span>
        )}
      </div>
      <button onClick={() => toggleModel(m.id)}
        className={styles.schedBtn}
        style={{
          fontSize: 10, padding: "3px 10px", marginTop: 4,
          background: selectedModels.has(m.id) ? "var(--c-success)" : undefined,
          color: selectedModels.has(m.id) ? "#fff" : undefined,
        }}>
        {selectedModels.has(m.id) ? "\u2713 Selected" : "+ Add"}
      </button>
    </div>
  );

  const showMoreBtn = (onClick: () => void, remaining: number) => (
    <div style={{ padding: "8px 0", textAlign: "center" }}>
      <button onClick={onClick}
        style={{
          padding: "5px 20px", fontSize: 10, fontWeight: 600, borderRadius: 8, cursor: "pointer",
          background: "var(--glass-tint)", color: "var(--m-accent)", border: "1px solid var(--m-border)",
          transition: "all 0.15s ease",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "color-mix(in srgb, var(--m-accent) 10%, transparent)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "var(--glass-tint)"; }}
      >
        Show more ({remaining} remaining)
      </button>
    </div>
  );

  // ── JSX ──

  return (
    <>
      {/* ── Status bar ── */}
      <div className={styles.schedCard} style={{ gap: 8 }}>
        <span style={{
          width: 28, height: 28, borderRadius: 6, flexShrink: 0,
          background: "var(--glass-tint)",
          display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14,
        }}>{"\u{1F917}"}</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--m-text)" }}>HuggingFace Inference API</div>
          <div style={{ fontSize: 10, color: "var(--m-text2)" }}>
            {tokenSaved ? "Token configured" : "Free tier available — add token for higher limits & gated models"}
            {" \u00b7 "}{CURATED_MODELS.length} curated models
          </div>
        </div>
        <button onClick={handleRegisterProvider} title="Register as LLM provider"
          style={{
            padding: "5px 14px", fontSize: 11, fontWeight: 600, borderRadius: 8, cursor: "pointer",
            background: registered ? "var(--c-success)" : "var(--m-accent)",
            color: "#fff", border: "none", transition: "all 0.2s ease",
          }}
          onMouseEnter={(e) => { if (!registered) e.currentTarget.style.opacity = "0.85"; }}
          onMouseLeave={(e) => { e.currentTarget.style.opacity = "1"; }}
        >
          {registered ? "\u2713 Registered!" : "\u26D3 Use in chains"}
        </button>
      </div>

      {/* ── Rate limits (collapsible) ── */}
      <div className={styles.formCard} style={{ gap: 0, padding: 0, overflow: "hidden" }}>
        <button onClick={() => setShowRateLimits(!showRateLimits)}
          style={{
            width: "100%", padding: "8px 12px", display: "flex", alignItems: "center", gap: 6,
            background: "none", border: "none", cursor: "pointer", textAlign: "left",
          }}>
          <span style={{ fontSize: 10, color: "var(--m-text2)", transition: "transform 0.2s", transform: showRateLimits ? "rotate(90deg)" : "none" }}>{"\u25B6"}</span>
          <span style={{ fontSize: 11, fontWeight: 600, color: "var(--m-text)" }}>Rate Limits</span>
          <span style={{ fontSize: 9, color: "var(--m-text2)" }}>(global per token)</span>
        </button>
        {showRateLimits && (
          <div style={{ padding: "0 12px 10px", borderTop: "1px solid var(--m-border)" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 16px", fontSize: 10, color: "var(--m-text2)", marginTop: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{ width: 6, height: 6, borderRadius: 3, background: "var(--c-success)", flexShrink: 0 }} />
                <strong style={{ color: "var(--m-text)" }}>Free (with token)</strong>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{ width: 6, height: 6, borderRadius: 3, background: "#5e5ce6", flexShrink: 0 }} />
                <strong style={{ color: "var(--m-text)" }}>PRO ($9/mo)</strong>
              </div>
              <div style={{ paddingLeft: 10 }}>~1,000 req/day total</div>
              <div style={{ paddingLeft: 10 }}>Significantly higher limits</div>
              <div style={{ paddingLeft: 10 }}>1-2 concurrent requests</div>
              <div style={{ paddingLeft: 10 }}>Higher concurrency</div>
              <div style={{ paddingLeft: 10 }}>Small/medium models only</div>
              <div style={{ paddingLeft: 10 }}>70B+ models & gated access</div>
              <div style={{ paddingLeft: 10 }}>May queue under load</div>
              <div style={{ paddingLeft: 10 }}>Priority GPU allocation</div>
            </div>
            <div style={{ fontSize: 9, color: "var(--m-text2)", marginTop: 6, fontStyle: "italic" }}>
              Limits are global across all models. Check X-RateLimit-* response headers for live usage.
            </div>
          </div>
        )}
      </div>

      {/* ── Library toggle ── */}
      <div style={{ padding: "10px 16px" }}>
        <button onClick={() => setShowLibrary(!showLibrary)}
          style={{
            width: "100%", padding: "8px 0", fontSize: 12, fontWeight: 600, borderRadius: 8, cursor: "pointer",
            background: showLibrary ? "var(--glass-tint)" : "var(--m-accent)",
            color: showLibrary ? "var(--m-text)" : "#fff",
            border: showLibrary ? "1px solid var(--m-border)" : "none",
            transition: "all 0.2s ease",
          }}
        >
          {showLibrary ? "\u2715 Hide Library" : `\u{1F917} Browse Model Library (${CURATED_MODELS.length})`}
        </button>
      </div>

      {/* ── Library (scrollable) ── */}
      {showLibrary && (
        <div className={styles.marketplace} style={{ display: "flex", flexDirection: "column", maxHeight: 520, overflow: "hidden" }}>

          {/* Sticky header: tier + search + tags */}
          <div style={{ flexShrink: 0, borderBottom: "1px solid var(--m-border)" }}>
            {/* Tier row */}
            <div style={{ padding: "8px 10px", display: "flex", gap: 6, alignItems: "center", borderBottom: "1px solid var(--m-border)" }}>
              {([null, "free", "pro"] as const).map(tier => {
                const label = tier === null ? `All (${CURATED_MODELS.length})` : tier === "free" ? `Free (${freeCount})` : `PRO (${proCount})`;
                const active = tierFilter === tier;
                const bg = active ? (tier === "free" ? "var(--c-success)" : tier === "pro" ? "#5e5ce6" : "var(--m-accent)") : "var(--glass-tint)";
                return (
                  <button key={String(tier)} onClick={() => setTierFilter(tier)}
                    style={{
                      padding: "3px 10px", borderRadius: 10, fontSize: 10, fontWeight: 600,
                      border: "none", cursor: "pointer", background: bg,
                      color: active ? "#fff" : "var(--m-text2)",
                    }}>
                    {label}
                  </button>
                );
              })}
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 9, color: "var(--m-text2)" }}>
                {filteredCurated.length} result{filteredCurated.length !== 1 ? "s" : ""}
              </span>
            </div>

            {/* Search + tags */}
            <div style={{ padding: "8px 10px", display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              <input
                className={styles.formInput}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search models (curated + HuggingFace Hub live)..."
                style={{ flex: 1, minWidth: 140, padding: "4px 8px", fontSize: 11 }}
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
              {filterTag && (
                <button onClick={() => setFilterTag(null)}
                  style={{ padding: "2px 6px", borderRadius: 10, fontSize: 9, border: "none", cursor: "pointer", background: "var(--glass-tint)", color: "var(--c-error)" }}>
                  {"\u2715"}
                </button>
              )}
            </div>
          </div>

          {/* Scrollable body */}
          <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>

            {/* Live HF Hub results */}
            {searching && (
              <div style={{ padding: "10px", fontSize: 10, color: "var(--m-text2)", textAlign: "center" }}>
                Searching HuggingFace Hub...
              </div>
            )}
            {paginatedHub.length > 0 && (
              <div style={{ borderBottom: "1px solid var(--m-border)" }}>
                <div style={{ padding: "8px 10px 4px", fontSize: 10, fontWeight: 600, color: "var(--m-accent)" }}>
                  Hub live results ({searchResults.length})
                </div>
                <div className={styles.marketplaceGrid}>
                  {paginatedHub.map(renderHubCard)}
                </div>
                {hasMoreHub && showMoreBtn(
                  () => setHubVisibleCount(c => c + PAGE_SIZE),
                  searchResults.length - hubVisibleCount,
                )}
              </div>
            )}

            {/* Curated grid */}
            {paginatedCurated.length > 0 ? (
              <>
                {searchResults.length > 0 && (
                  <div style={{ padding: "8px 10px 4px", fontSize: 10, fontWeight: 600, color: "var(--m-text2)" }}>
                    Curated ({filteredCurated.length})
                  </div>
                )}
                <div className={styles.marketplaceGrid}>
                  {paginatedCurated.map(renderCuratedCard)}
                </div>
                {hasMoreCurated && showMoreBtn(
                  () => setVisibleCount(c => c + PAGE_SIZE),
                  filteredCurated.length - visibleCount,
                )}
              </>
            ) : (
              <div style={{ padding: "20px 10px", textAlign: "center", fontSize: 11, color: "var(--m-text2)" }}>
                No models match your filters.{" "}
                <button onClick={() => { setSearch(""); setFilterTag(null); setTierFilter(null); }}
                  style={{ background: "none", border: "none", color: "var(--m-accent)", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>
                  Reset filters
                </button>
              </div>
            )}

            {/* Custom model input */}
            <div style={{ padding: "8px 10px", borderTop: "1px solid var(--m-border)", display: "flex", gap: 6, position: "sticky", bottom: 0, background: "var(--m-bg)" }}>
              <input
                className={styles.formInput}
                placeholder="Custom model ID (e.g. org/model-name)"
                id="hf-custom-model"
                style={{ flex: 1, padding: "4px 8px", fontSize: 11 }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && e.currentTarget.value.trim()) {
                    toggleModel(e.currentTarget.value.trim());
                    e.currentTarget.value = "";
                  }
                }}
              />
              <button className={styles.schedBtn} style={{ fontSize: 10 }}
                onClick={() => {
                  const input = document.getElementById("hf-custom-model") as HTMLInputElement;
                  if (input?.value.trim()) { toggleModel(input.value.trim()); input.value = ""; }
                }}>
                + Add
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Selected custom models ── */}
      {selectedModels.size > 0 && (
        <div className={styles.formCard} style={{ gap: 6 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--m-text)" }}>
            {selectedModels.size} custom model{selectedModels.size > 1 ? "s" : ""} selected
          </div>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {Array.from(selectedModels).map(id => (
              <span key={id} onClick={() => toggleModel(id)}
                style={{
                  padding: "2px 8px", borderRadius: 10, fontSize: 9, fontWeight: 600, cursor: "pointer",
                  background: "color-mix(in srgb, var(--m-accent) 15%, transparent)",
                  color: "var(--m-accent)", transition: "opacity 0.15s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.opacity = "0.7"; }}
                onMouseLeave={(e) => { e.currentTarget.style.opacity = "1"; }}
              >
                {id.split("/").pop()} {"\u2715"}
              </span>
            ))}
          </div>
          <div style={{ fontSize: 9, color: "var(--m-text2)" }}>
            Click "Use in chains" to register all curated + custom models.
          </div>
        </div>
      )}
    </>
  );
}
