/**
 * WorkflowChat — Conversational chain builder panel.
 * Two-stage: chat (architect) -> plan (creates canvas nodes).
 * Configurable prompts, models, and animated Unicode loader.
 */
import { useState, useRef, useEffect, useCallback } from "react";
import { useWorkflowChatStore, type WFMessage, type WFSession } from "../../stores/workflowChat";

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
        {msg.content.replace(/\s*\[READY_TO_BUILD\]\s*/g, "").trim()}
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

// ─── Format context key for display ──────────────────────────────────────────

function formatContextKey(k: string): { label: string; badge: string } {
  if (k.startsWith("chain:")) return { label: k.slice(6), badge: "chain" };
  if (k.startsWith("pipeline:")) return { label: k.slice(9), badge: "pipeline" };
  if (k.startsWith("new-chain:")) return { label: "Untitled", badge: "new" };
  return { label: "General", badge: "" };
}

// ─── Main component ──────────────────────────────────────────────────────────

export function WorkflowChat({ onClose }: { onClose?: () => void }) {
  const {
    messages, input, streaming, thinkingStartedAt, configOpen, contextKey, activeSessionId,
    setInput, setConfigOpen, sendMessage, clearMessages,
    switchSession, createSession, renameSession, deleteSession, getSessionsForContext,
  } = useWorkflowChatStore();
  const [sessionsOpen, setSessionsOpen] = useState(false);

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

  const sessions = getSessionsForContext();
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const ctx = formatContextKey(contextKey);

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      {/* Session sidebar */}
      {sessionsOpen && (
        <div style={{
          width: 130, flexShrink: 0, display: "flex", flexDirection: "column",
          borderRight: "1px solid var(--glass-border, rgba(255,255,255,0.06))",
          background: "rgba(0,0,0,0.12)",
        }}>
          <div style={{
            padding: "8px 8px 5px", display: "flex", alignItems: "center", justifyContent: "space-between",
            borderBottom: "1px solid var(--glass-border, rgba(255,255,255,0.06))",
          }}>
            <span style={{ fontSize: 9, fontWeight: 700, color: "var(--m-text2)", letterSpacing: 0.5, textTransform: "uppercase" }}>
              {ctx.label}
            </span>
            <button onClick={() => createSession()} title="New session"
              style={{ background: "none", border: "none", cursor: "pointer", color: "var(--m-accent)", fontSize: 12, padding: 0 }}>
              +
            </button>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: 3 }}>
            {sessions.map((s) => {
              const active = s.id === activeSessionId;
              return (
                <div key={s.id} style={{
                  padding: "5px 6px", borderRadius: 5, cursor: "pointer", marginBottom: 1,
                  background: active ? "rgba(10,132,255,0.1)" : "transparent",
                  borderLeft: active ? "2px solid var(--m-accent)" : "2px solid transparent",
                  display: "flex", alignItems: "center", gap: 4,
                }}
                  onClick={() => switchSession(s.id)}
                  onDoubleClick={() => {
                    const n = prompt("Rename:", s.name);
                    if (n !== null && n.trim()) renameSession(s.id, n);
                  }}
                  title="Click: switch · Double-click: rename"
                >
                  <span style={{
                    flex: 1, fontSize: 10, fontWeight: active ? 600 : 400,
                    color: active ? "var(--m-accent)" : "var(--m-text)",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>{s.name}</span>
                  {!active && sessions.length > 1 && (
                    <button onClick={(e) => { e.stopPropagation(); deleteSession(s.id); }}
                      style={{ background: "none", border: "none", cursor: "pointer", color: "var(--m-text2)", fontSize: 8, padding: 0, opacity: 0.3 }}>
                      {"\u2715"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Chat column */}
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, position: "relative", overflow: "hidden" }}>
      {configOpen && <ConfigPanel allModels={allModels} />}

      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "10px 12px",
        borderBottom: "1px solid var(--glass-border, rgba(255,255,255,0.06))",
        flexShrink: 0,
      }}>
        {/* Session info */}
        <button onClick={() => setSessionsOpen(!sessionsOpen)} title="Sessions"
          style={{
            background: "none", border: "none", cursor: "pointer", padding: 0,
            display: "flex", alignItems: "center", gap: 5, flex: 1, minWidth: 0,
            color: "var(--m-text)",
          }}>
          <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: -0.2 }}>
            {activeSession?.name ?? "Chat"}
          </span>
          <svg width="8" height="8" viewBox="0 0 8 8" style={{ flexShrink: 0, opacity: 0.4 }}>
            <polyline points={sessionsOpen ? "1,5 4,2 7,5" : "1,3 4,6 7,3"} fill="none" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>

        {/* Badge */}
        {ctx.badge && (
          <span style={{ fontSize: 8, color: "var(--m-text2)", opacity: 0.5, flexShrink: 0 }}>{ctx.badge}</span>
        )}

        {/* Actions */}
        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
          <button onClick={() => setConfigOpen(true)} title="Settings"
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--m-text2)", fontSize: 13, padding: 0, lineHeight: 1 }}>
            {"\u2699\uFE0F"}
          </button>
          {messages.length > 0 && (
            <button onClick={clearMessages} title="Clear"
              style={{ background: "none", border: "none", cursor: "pointer", color: "#ff375f", fontSize: 11, padding: 0, lineHeight: 1, opacity: 0.6 }}>
              {"\u{1F5D1}"}
            </button>
          )}
          {onClose && (
            <button onClick={onClose} title="Close"
              style={{ background: "none", border: "none", cursor: "pointer", color: "var(--m-text2)", fontSize: 12, padding: 0, lineHeight: 1 }}>
              {"\u2715"}
            </button>
          )}
        </div>
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
    </div>
  );
}
