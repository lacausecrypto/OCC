/**
 * WorkflowChat — Conversational chain builder panel.
 * Two-stage: chat (architect) -> plan (creates canvas nodes).
 * Configurable prompts, models, and animated Unicode loader.
 */
import { useState, useRef, useEffect, useCallback } from "react";
import { useWorkflowChatStore, type WFMessage } from "../../stores/workflowChat";

// ─── Unicode Thinking Loader ─────────────────────────────────────────────────

const THINKING_PHASES: Array<{ frames: string[]; label: string }> = [
  { frames: ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"], label: "Analyzing your request..." },
  { frames: ["\u2590", "\u258C", "\u2590", "\u258C", "\u2588", "\u2584", "\u2580", "\u2588"], label: "Designing architecture..." },
  { frames: ["\u25F0", "\u25F3", "\u25F2", "\u25F1"], label: "Mapping dependencies..." },
  { frames: ["\u2591", "\u2592", "\u2593", "\u2588", "\u2593", "\u2592"], label: "Evaluating step types..." },
  { frames: ["\u22EF", "\u22F0", "\u22EF", "\u22F1"], label: "Orchestrating flow..." },
  { frames: ["\u2802", "\u2804", "\u2820", "\u2810", "\u2808", "\u2801"], label: "Selecting optimal models..." },
  { frames: ["\u25CB", "\u25D4", "\u25D1", "\u25D5", "\u25CF", "\u25D5", "\u25D1", "\u25D4"], label: "Wiring connections..." },
  { frames: ["\u2581", "\u2583", "\u2585", "\u2587", "\u2588", "\u2587", "\u2585", "\u2583"], label: "Configuring pre-tools..." },
  { frames: ["\u2190", "\u2196", "\u2191", "\u2197", "\u2192", "\u2198", "\u2193", "\u2199"], label: "Resolving graph topology..." },
  { frames: ["\u2654", "\u265A", "\u2655", "\u265B"], label: "Planning strategy..." },
  { frames: ["\u25E2", "\u25E3", "\u25E4", "\u25E5"], label: "Composing prompts..." },
  { frames: ["\u2680", "\u2681", "\u2682", "\u2683", "\u2684", "\u2685"], label: "Weighing alternatives..." },
  { frames: ["\u2669", "\u266A", "\u266B", "\u266C"], label: "Harmonizing workflow..." },
  { frames: ["\u25A0", "\u25A1", "\u25A3", "\u25A1"], label: "Building chain structure..." },
  { frames: ["\u2234", "\u2235", "\u2237", "\u2238"], label: "Validating constraints..." },
];

function ThinkingLoader({ startedAt }: { startedAt: number }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 120);
    return () => clearInterval(id);
  }, []);

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
  const phaseIdx = Math.floor(tick / 25) % THINKING_PHASES.length;
  const phase = THINKING_PHASES[phaseIdx];
  const frameIdx = tick % phase.frames.length;

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10, padding: "10px 14px",
      background: "rgba(10, 132, 255, 0.04)", borderRadius: 10,
      border: "1px solid rgba(10, 132, 255, 0.1)",
    }}>
      <span style={{ fontSize: 18, fontFamily: "monospace", width: 20, textAlign: "center", color: "var(--m-accent)" }}>
        {phase.frames[frameIdx]}
      </span>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12, color: "var(--m-text)", fontWeight: 500 }}>
          {phase.label}
        </div>
        <div style={{ fontSize: 10, color: "var(--m-text2)", marginTop: 2 }}>
          {elapsed}s elapsed
        </div>
      </div>
    </div>
  );
}

// ─── Config Panel ────────────────────────────────────────────────────────────

interface ProviderModel { provider: string; providerName: string; model: string; }

function ConfigPanel({ allModels }: { allModels: ProviderModel[] }) {
  const {
    chatModel, plannerModel, chatSystemPrompt, plannerSystemPrompt,
    setChatModel, setPlannerModel, setChatSystemPrompt, setPlannerSystemPrompt,
    setConfigOpen,
  } = useWorkflowChatStore();

  const [tab, setTab] = useState<"chat" | "planner">("chat");

  const modelOptions = allModels.length > 0
    ? allModels
    : [
      { model: "claude-haiku-4-5", providerName: "Anthropic" },
      { model: "claude-sonnet-4-6", providerName: "Anthropic" },
      { model: "claude-opus-4-6", providerName: "Anthropic" },
    ].map((m) => ({ ...m, provider: "claude" }));

  return (
    <div style={{
      position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
      background: "var(--m-bg, #111)", zIndex: 10, display: "flex", flexDirection: "column",
    }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "12px 14px", borderBottom: "1px solid var(--m-border, #333)",
      }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--m-text)" }}>Workflow Chat Config</span>
        <button onClick={() => setConfigOpen(false)}
          style={{ background: "none", border: "none", color: "var(--m-text2)", cursor: "pointer", fontSize: 16 }}>
          &times;
        </button>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", borderBottom: "1px solid var(--m-border, #333)" }}>
        {(["chat", "planner"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            style={{
              flex: 1, padding: "8px 0", fontSize: 12, fontWeight: tab === t ? 700 : 400,
              border: "none", borderBottom: tab === t ? "2px solid var(--m-accent)" : "2px solid transparent",
              background: "none", color: tab === t ? "var(--m-accent)" : "var(--m-text2)", cursor: "pointer",
            }}>
            {t === "chat" ? "Chat LLM" : "Planner LLM"}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: "auto", padding: 14 }}>
        {tab === "chat" ? (
          <>
            <label style={{ display: "block", fontSize: 11, color: "var(--m-text2)", marginBottom: 4, fontWeight: 600 }}>
              Chat Model
            </label>
            <select value={chatModel} onChange={(e) => setChatModel(e.target.value)}
              style={{
                width: "100%", padding: "6px 8px", fontSize: 12, marginBottom: 12,
                background: "var(--m-bg2, #1a1a1a)", border: "1px solid var(--m-border, #333)",
                borderRadius: 6, color: "var(--m-text)",
              }}>
              {modelOptions.map((m) => (
                <option key={m.model} value={m.model}>{m.model}</option>
              ))}
            </select>

            <label style={{ display: "block", fontSize: 11, color: "var(--m-text2)", marginBottom: 4, fontWeight: 600 }}>
              Chat System Prompt
            </label>
            <textarea value={chatSystemPrompt} onChange={(e) => setChatSystemPrompt(e.target.value)}
              rows={14}
              style={{
                width: "100%", padding: 8, fontSize: 11, lineHeight: 1.5,
                background: "var(--m-bg2, #1a1a1a)", border: "1px solid var(--m-border, #333)",
                borderRadius: 6, color: "var(--m-text)", resize: "vertical", fontFamily: "monospace",
              }} />
          </>
        ) : (
          <>
            <label style={{ display: "block", fontSize: 11, color: "var(--m-text2)", marginBottom: 4, fontWeight: 600 }}>
              Planner Model
            </label>
            <select value={plannerModel} onChange={(e) => setPlannerModel(e.target.value)}
              style={{
                width: "100%", padding: "6px 8px", fontSize: 12, marginBottom: 12,
                background: "var(--m-bg2, #1a1a1a)", border: "1px solid var(--m-border, #333)",
                borderRadius: 6, color: "var(--m-text)",
              }}>
              {modelOptions.map((m) => (
                <option key={m.model} value={m.model}>{m.model}</option>
              ))}
            </select>

            <label style={{ display: "block", fontSize: 11, color: "var(--m-text2)", marginBottom: 4, fontWeight: 600 }}>
              Planner System Prompt
            </label>
            <textarea value={plannerSystemPrompt} onChange={(e) => setPlannerSystemPrompt(e.target.value)}
              rows={14}
              style={{
                width: "100%", padding: 8, fontSize: 11, lineHeight: 1.5,
                background: "var(--m-bg2, #1a1a1a)", border: "1px solid var(--m-border, #333)",
                borderRadius: 6, color: "var(--m-text)", resize: "vertical", fontFamily: "monospace",
              }} />
          </>
        )}
      </div>
    </div>
  );
}

// ─── Message Bubble ──────────────────────────────────────────────────────────

function MessageBubble({ msg }: { msg: WFMessage }) {
  const isUser = msg.role === "user";
  const isSystem = msg.role === "system";

  return (
    <div style={{
      display: "flex", flexDirection: "column",
      alignItems: isUser ? "flex-end" : "flex-start",
      marginBottom: 8,
    }}>
      <div style={{
        maxWidth: "88%", padding: "8px 12px", borderRadius: 12,
        fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word",
        ...(isUser ? {
          background: "var(--m-accent, #0a84ff)", color: "#fff",
          borderBottomRightRadius: 4,
        } : isSystem ? {
          background: "rgba(255, 159, 10, 0.08)", color: "#ff9f0a",
          border: "1px solid rgba(255, 159, 10, 0.15)", fontSize: 11,
          borderBottomLeftRadius: 4,
        } : {
          background: "rgba(255,255,255,0.05)", color: "var(--m-text)",
          border: "1px solid var(--m-border, #333)",
          borderBottomLeftRadius: 4,
        }),
      }}>
        {msg.content}
      </div>
      <div style={{
        fontSize: 9, color: "var(--m-text2)", marginTop: 2,
        display: "flex", gap: 6, alignItems: "center",
      }}>
        <span>{new Date(msg.timestamp).toLocaleTimeString()}</span>
        {msg.inputTokens != null && (
          <span>{msg.inputTokens}+{msg.outputTokens} tok</span>
        )}
        {msg.createdNodes && msg.createdNodes.length > 0 && (
          <span style={{ color: "#30d158" }}>{msg.createdNodes.length} nodes created</span>
        )}
      </div>
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export function WorkflowChat({ onClose }: { onClose?: () => void }) {
  const {
    messages, input, streaming, thinkingStartedAt, configOpen,
    setInput, setConfigOpen, sendMessage, clearMessages,
  } = useWorkflowChatStore();

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Dynamic model list
  const [allModels, setAllModels] = useState<ProviderModel[]>([]);
  useEffect(() => {
    fetch("/providers/models")
      .then((r) => r.ok ? r.json() : [])
      .then((data) => { if (Array.isArray(data)) setAllModels(data); })
      .catch(() => {});
  }, []);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming]);

  // Focus input on mount
  useEffect(() => { inputRef.current?.focus(); }, []);

  const handleSend = useCallback(() => {
    if (!input.trim() || streaming) return;
    sendMessage();
  }, [input, streaming, sendMessage]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  return (
    <div style={{
      display: "flex", flexDirection: "column", height: "100%",
      position: "relative", overflow: "hidden",
    }}>
      {/* Config overlay */}
      {configOpen && <ConfigPanel allModels={allModels} />}

      {/* Header — glass */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "8px 12px",
        borderBottom: "1px solid var(--glass-border, rgba(255,255,255,0.06))",
        flexShrink: 0,
      }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--m-text)", flex: 1 }}>
          {"\u2728"} Workflow Chat
        </span>
        <button onClick={() => setConfigOpen(true)} title="Configure prompts & models"
          style={{
            background: "rgba(255,255,255,0.06)", border: "1px solid var(--glass-border, rgba(255,255,255,0.06))",
            borderRadius: 6, padding: "2px 7px", fontSize: 10, cursor: "pointer",
            color: "var(--m-text2)",
          }}>
          {"\u2699"}
        </button>
        {messages.length > 0 && (
          <button onClick={clearMessages} title="Clear"
            style={{
              background: "rgba(255,55,95,0.06)", border: "1px solid rgba(255,55,95,0.12)",
              borderRadius: 6, padding: "2px 7px", fontSize: 10, cursor: "pointer",
              color: "#ff375f",
            }}>
            {"\u2718"}
          </button>
        )}
        {onClose && (
          <button onClick={onClose} title="Close"
            style={{
              background: "none", border: "none", fontSize: 14, cursor: "pointer",
              color: "var(--m-text2)", padding: "0 2px", lineHeight: 1,
            }}>
            {"\u00D7"}
          </button>
        )}
      </div>

      {/* Messages */}
      <div style={{
        flex: 1, overflow: "auto", padding: "12px 14px",
        display: "flex", flexDirection: "column",
      }}>
        {messages.length === 0 && !streaming && (
          <div style={{
            flex: 1, display: "flex", flexDirection: "column", alignItems: "center",
            justifyContent: "center", gap: 12, opacity: 0.5,
          }}>
            <span style={{ fontSize: 32 }}>{"\u2728"}</span>
            <span style={{ fontSize: 13, color: "var(--m-text2)", textAlign: "center", maxWidth: 240 }}>
              Describe the workflow you want to build. I'll design and create the chain step by step.
            </span>
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble key={msg.id} msg={msg} />
        ))}

        {streaming && thinkingStartedAt && (
          <ThinkingLoader startedAt={thinkingStartedAt} />
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div style={{
        display: "flex", gap: 6, padding: "10px 14px",
        borderTop: "1px solid var(--m-border, #333)", flexShrink: 0,
      }}>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={streaming ? "Thinking..." : "Describe your workflow..."}
          disabled={streaming}
          style={{
            flex: 1, padding: "8px 12px", fontSize: 12,
            background: "var(--m-bg2, #1a1a1a)", border: "1px solid var(--m-border, #333)",
            borderRadius: 8, color: "var(--m-text)", outline: "none",
          }}
        />
        <button
          onClick={handleSend}
          disabled={streaming || !input.trim()}
          style={{
            padding: "8px 14px", fontSize: 14, fontWeight: 700,
            background: streaming || !input.trim() ? "rgba(255,255,255,0.05)" : "var(--m-accent, #0a84ff)",
            color: streaming || !input.trim() ? "var(--m-text2)" : "#fff",
            border: "none", borderRadius: 8, cursor: streaming ? "wait" : "pointer",
            minWidth: 40,
          }}
        >
          {streaming ? "\u22EF" : "\u2191"}
        </button>
      </div>
    </div>
  );
}
