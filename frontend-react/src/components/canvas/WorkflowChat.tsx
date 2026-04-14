/**
 * WorkflowChat — Conversational chain builder panel.
 * Two-stage: chat (architect) -> plan (creates canvas nodes).
 * Configurable prompts, models, and animated Unicode loader.
 */
import React, { useState, useRef, useEffect, useCallback } from "react";
import { useWorkflowChatStore, type WFMessage } from "../../stores/workflowChat";

/** Render markdown: **bold**, *italic*, `code`, ```blocks```, ###headings, - lists, > quotes */
function renderMarkdown(text: string): React.ReactElement {
  const lines = text.split("\n");
  const elements: React.ReactElement[] = [];
  let inCodeBlock = false;
  let codeBuffer: string[] = [];
  const codeStyle = { background: "var(--glass-tint)", padding: "1px 5px", borderRadius: 3, fontSize: "0.88em", fontFamily: "monospace" } as const;
  const preStyle = { background: "var(--glass-tint)", padding: "6px 8px", borderRadius: 6, fontSize: 10, overflowX: "auto" as const, margin: "4px 0", whiteSpace: "pre-wrap" as const, fontFamily: "monospace" };

  /** Parse inline markdown: code first (to protect content), then bold, italic, links */
  const renderInline = (line: string, key: number): React.ReactElement => {
    // 1. Extract inline code spans first (protect their content from further parsing)
    const codeSegments: string[] = [];
    const withCodePlaceholders = line.replace(/`([^`]+)`/g, (_, code) => {
      codeSegments.push(code);
      return `\x00CODE${codeSegments.length - 1}\x00`;
    });

    // 2. Parse bold, italic, bold+italic on the protected string
    const parts: React.ReactElement[] = [];
    let idx = 0;
    // Order matters: bold+italic (***) → bold (**) → italic (*)
    const regex = /(\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*|__(.+?)__|_(.+?)_)/g;
    let match: RegExpExecArray | null;
    let lastIndex = 0;

    const restoreCode = (s: string): React.ReactElement => {
      // Replace code placeholders back with styled elements
      const codeParts: (string | React.ReactElement)[] = [];
      let remaining = s;
      let codeMatch: RegExpExecArray | null;
      // \x00 sentinels mark inline-code placeholders inserted earlier so the markdown
      // bold/italic parser above doesn't touch code contents. User input cannot
      // contain raw \x00, so collision is impossible.
      // eslint-disable-next-line no-control-regex
      const codeRe = /\x00CODE(\d+)\x00/g;
      let cLast = 0;
      while ((codeMatch = codeRe.exec(remaining)) !== null) {
        if (codeMatch.index > cLast) codeParts.push(remaining.slice(cLast, codeMatch.index));
        codeParts.push(<code key={`c${idx++}`} style={codeStyle}>{codeSegments[parseInt(codeMatch[1])]}</code>);
        cLast = codeRe.lastIndex;
      }
      if (cLast < remaining.length) codeParts.push(remaining.slice(cLast));
      return <>{codeParts}</>;
    };

    while ((match = regex.exec(withCodePlaceholders)) !== null) {
      if (match.index > lastIndex) {
        parts.push(<span key={idx++}>{restoreCode(withCodePlaceholders.slice(lastIndex, match.index))}</span>);
      }
      if (match[2]) parts.push(<strong key={idx++}><em>{restoreCode(match[2])}</em></strong>); // ***bold italic***
      else if (match[3]) parts.push(<strong key={idx++}>{restoreCode(match[3])}</strong>); // **bold**
      else if (match[4]) parts.push(<em key={idx++}>{restoreCode(match[4])}</em>); // *italic*
      else if (match[5]) parts.push(<strong key={idx++}>{restoreCode(match[5])}</strong>); // __bold__
      else if (match[6]) parts.push(<em key={idx++}>{restoreCode(match[6])}</em>); // _italic_
      lastIndex = regex.lastIndex;
    }
    if (lastIndex < withCodePlaceholders.length) {
      parts.push(<span key={idx++}>{restoreCode(withCodePlaceholders.slice(lastIndex))}</span>);
    }
    return <span key={key}>{parts.length > 0 ? parts : restoreCode(withCodePlaceholders)}</span>;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code fence toggle
    if (line.startsWith("```")) {
      if (inCodeBlock) {
        elements.push(<pre key={i} style={preStyle}>{codeBuffer.join("\n")}</pre>);
        codeBuffer = [];
      }
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) { codeBuffer.push(line); continue; }

    // Headings (### → H3, ## → H2, # → H1)
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const size = level === 1 ? 13 : level === 2 ? 12 : 11;
      elements.push(<div key={i} style={{ fontWeight: 700, fontSize: size, marginTop: 6, marginBottom: 2 }}>{renderInline(headingMatch[2], i)}</div>);
    }
    // Bullet lists (-, *, +)
    else if (/^[\-*+]\s/.test(line)) {
      elements.push(<div key={i} style={{ paddingLeft: 12, textIndent: -8 }}><span style={{ opacity: 0.5 }}>{"\u2022"} </span>{renderInline(line.replace(/^[\-*+]\s/, ""), i)}</div>);
    }
    // Numbered lists
    else if (/^\d+\.\s/.test(line)) {
      const num = line.match(/^(\d+)\./)?.[1];
      elements.push(<div key={i} style={{ paddingLeft: 12, textIndent: -12 }}><span style={{ fontWeight: 600, opacity: 0.6 }}>{num}. </span>{renderInline(line.replace(/^\d+\.\s/, ""), i)}</div>);
    }
    // Blockquotes
    else if (line.startsWith("> ")) {
      elements.push(<div key={i} style={{ borderLeft: "2px solid var(--m-accent)", paddingLeft: 8, marginLeft: 2, opacity: 0.85, fontStyle: "italic" }}>{renderInline(line.slice(2), i)}</div>);
    }
    // Horizontal rule
    else if (/^---+$/.test(line.trim())) {
      elements.push(<hr key={i} style={{ border: "none", borderTop: "1px solid var(--m-border)", margin: "6px 0" }} />);
    }
    // Empty line
    else if (line.trim() === "") {
      elements.push(<div key={i} style={{ height: 4 }} />);
    }
    // Markdown image: ![alt](url)
    else if (/^!\[.*\]\(.+\)/.test(line)) {
      const imgMatch = line.match(/^!\[(.*?)\]\((.+?)\)/);
      if (imgMatch) {
        elements.push(<div key={i} style={{ margin: "4px 0" }}><img src={imgMatch[2]} alt={imgMatch[1]} style={{ maxWidth: "100%", borderRadius: 6, border: "1px solid var(--m-border)" }} /></div>);
      }
    }
    // Detect raw image URL or /images/ path
    else if (/\/images\/img_/.test(line) || /\.(png|jpg|jpeg|webp|gif)(\?|$)/i.test(line.trim())) {
      const url = line.trim();
      elements.push(<div key={i} style={{ margin: "4px 0" }}><img src={url} alt="Generated image" style={{ maxWidth: "100%", borderRadius: 6, border: "1px solid var(--m-border)" }} /></div>);
    }
    // Regular text
    else {
      elements.push(<div key={i}>{renderInline(line, i)}</div>);
    }
  }

  // Close unclosed code block
  if (codeBuffer.length > 0) {
    elements.push(<pre key="code-end" style={preStyle}>{codeBuffer.join("\n")}</pre>);
  }
  return <>{elements}</>;
}

// ─── CSS Keyframes (injected once) ───────────────────────────────────────────

const WFC_STYLE_ID = "wfc-animations";
if (typeof document !== "undefined" && !document.getElementById(WFC_STYLE_ID)) {
  const style = document.createElement("style");
  style.id = WFC_STYLE_ID;
  style.textContent = `
    @keyframes wfc-slidein-right {
      from { opacity: 0; transform: translateX(12px) scale(0.97); }
      to { opacity: 1; transform: translateX(0) scale(1); }
    }
    @keyframes wfc-slidein-left {
      from { opacity: 0; transform: translateX(-12px) scale(0.97); }
      to { opacity: 1; transform: translateX(0) scale(1); }
    }
    @keyframes wfc-fadein {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @keyframes wfc-pulse {
      0%, 100% { opacity: 0.6; transform: scale(1); }
      50% { opacity: 1; transform: scale(1.1); }
    }
  `;
  document.head.appendChild(style);
}

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
  const [dots, setDots] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 100);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    const id = setInterval(() => setDots((d) => (d + 1) % 4), 500);
    return () => clearInterval(id);
  }, []);

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
  const phaseIdx = Math.floor(tick / 30) % THINKING_PHASES.length;
  const phase = THINKING_PHASES[phaseIdx];
  const frameIdx = tick % phase.frames.length;
  const progressInPhase = (tick % 30) / 30;

  return (
    <div style={{
      padding: "10px 14px", borderRadius: 12,
      background: "var(--glass-tint-subtle)", border: "1px solid var(--m-border)",
      animation: "wfc-fadein 0.3s ease-out",
    }}>
      {/* Spinner + label row */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{
          fontSize: 20, fontFamily: "var(--m-font-mono, monospace)",
          width: 24, textAlign: "center", color: "var(--m-accent)",
          animation: "wfc-pulse 1.5s ease-in-out infinite",
        }}>
          {phase.frames[frameIdx]}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 11, color: "var(--m-text)", fontWeight: 600,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {phase.label}
          </div>
          <div style={{ fontSize: 9, color: "var(--m-text2)", marginTop: 2, display: "flex", gap: 8, alignItems: "center" }}>
            <span>{elapsed}s</span>
            <span style={{ letterSpacing: 2 }}>{"•".repeat(dots + 1).padEnd(4, "\u2008")}</span>
          </div>
        </div>
      </div>

      {/* Progress bar */}
      <div style={{
        height: 2, borderRadius: 1, marginTop: 8,
        background: "var(--m-border)", overflow: "hidden",
      }}>
        <div style={{
          height: "100%", borderRadius: 1,
          background: "var(--m-accent)",
          width: `${progressInPhase * 100}%`,
          transition: "width 0.1s linear",
        }} />
      </div>
    </div>
  );
}

// ─── Config Panel ────────────────────────────────────────────────────────────

interface ProviderModel { provider: string; providerName: string; model: string; }

function ConfigPanel() {
  const {
    chatModel, plannerModel, chatSystemPrompt, plannerSystemPrompt,
    setChatModel, setPlannerModel, setChatSystemPrompt, setPlannerSystemPrompt,
    setConfigOpen,
  } = useWorkflowChatStore();

  const [tab, setTab] = useState<"chat" | "planner">("chat");

  // Fetch models directly when config panel opens (not relying on parent)
  const [modelOptions, setModelOptions] = useState<ProviderModel[]>([]);
  useEffect(() => {
    fetch("/providers/models")
      .then((r) => r.ok ? r.json() : [])
      .then((data) => {
        if (Array.isArray(data) && data.length > 0) setModelOptions(data);
        else setModelOptions([
          { provider: "claude", providerName: "Anthropic", model: "claude-haiku-4-5" },
          { provider: "claude", providerName: "Anthropic", model: "claude-sonnet-4-6" },
          { provider: "claude", providerName: "Anthropic", model: "claude-opus-4-6" },
        ]);
      })
      .catch(() => {});
  }, []);

  return (
    <div style={{
      position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
      background: "var(--m-bg)", zIndex: 10, display: "flex", flexDirection: "column",
    }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "12px 14px", borderBottom: "1px solid var(--m-border)",
      }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--m-text)" }}>Workflow Chat Config</span>
        <button onClick={() => setConfigOpen(false)}
          style={{ background: "none", border: "none", color: "var(--m-text2)", cursor: "pointer", fontSize: 16 }}>
          &times;
        </button>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", borderBottom: "1px solid var(--m-border)" }}>
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
                background: "var(--m-surface)", border: "1px solid var(--m-border)",
                borderRadius: 6, color: "var(--m-text)",
              }}>
              {modelOptions.map((m) => (
                <option key={`${m.provider}-${m.model}`} value={m.model}>{m.model} ({m.providerName})</option>
              ))}
            </select>

            <label style={{ display: "block", fontSize: 11, color: "var(--m-text2)", marginBottom: 4, fontWeight: 600 }}>
              Chat System Prompt
            </label>
            <textarea value={chatSystemPrompt} onChange={(e) => setChatSystemPrompt(e.target.value)}
              rows={14}
              style={{
                width: "100%", padding: 8, fontSize: 11, lineHeight: 1.5,
                background: "var(--m-surface)", border: "1px solid var(--m-border)",
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
                background: "var(--m-surface)", border: "1px solid var(--m-border)",
                borderRadius: 6, color: "var(--m-text)",
              }}>
              {modelOptions.map((m) => (
                <option key={`${m.provider}-${m.model}`} value={m.model}>{m.model} ({m.providerName})</option>
              ))}
            </select>

            <label style={{ display: "block", fontSize: 11, color: "var(--m-text2)", marginBottom: 4, fontWeight: 600 }}>
              Planner System Prompt
            </label>
            <textarea value={plannerSystemPrompt} onChange={(e) => setPlannerSystemPrompt(e.target.value)}
              rows={14}
              style={{
                width: "100%", padding: 8, fontSize: 11, lineHeight: 1.5,
                background: "var(--m-surface)", border: "1px solid var(--m-border)",
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
      marginBottom: 10,
      animation: isUser ? "wfc-slidein-right 0.25s ease-out" : "wfc-slidein-left 0.3s ease-out",
    }}>
      <div style={{
        maxWidth: "88%", padding: "8px 12px", borderRadius: 14,
        fontSize: 12, lineHeight: 1.55, whiteSpace: "pre-wrap", wordBreak: "break-word",
        ...(isUser ? {
          background: "var(--m-accent)",
          color: "#fff",
          borderBottomRightRadius: 4,
          boxShadow: "0 1px 4px rgba(0,0,0,0.1)",
        } : isSystem ? {
          background: "var(--glass-tint-subtle)",
          color: "var(--c-warning)",
          border: "1px solid var(--m-border)",
          fontSize: 10, fontStyle: "italic",
          borderBottomLeftRadius: 4,
        } : {
          background: "var(--glass-tint)",
          color: "var(--m-text)",
          border: "1px solid var(--m-border)",
          borderBottomLeftRadius: 4,
          boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
        }),
      }}>
        {renderMarkdown(msg.content.replace(/\s*\[READY_TO_BUILD\]\s*/g, "").replace(/\s*\[ACTION:\w+\]\s*/g, "").trim())}
      </div>
      <div style={{
        fontSize: 9, color: "var(--m-text2)", marginTop: 3, padding: "0 4px",
        display: "flex", gap: 6, alignItems: "center",
        animation: "wfc-fadein 0.4s ease-out 0.15s both",
      }}>
        <span>{new Date(msg.timestamp).toLocaleTimeString()}</span>
        {msg.inputTokens != null && (
          <span style={{ opacity: 0.7 }} title={`Input: ${msg.inputTokens} tokens, Output: ${msg.outputTokens} tokens`}>{msg.inputTokens}+{msg.outputTokens} tok</span>
        )}
        {msg.createdNodes && msg.createdNodes.length > 0 && (
          <span style={{ color: "var(--c-success)", fontWeight: 600 }}>
            {"\u2713"} {msg.createdNodes.length} nodes
          </span>
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

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming]);

  // Focus input on mount + after streaming ends
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    if (!streaming) inputRef.current?.focus();
  }, [streaming]);

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
          borderRight: "1px solid var(--glass-border)",
          background: "var(--glass-tint-subtle)",
        }}>
          <div style={{
            padding: "12px 10px 6px", display: "flex", alignItems: "center", justifyContent: "space-between",
            borderBottom: "1px solid var(--glass-border)",
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
      {configOpen && <ConfigPanel />}

      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "14px 12px 10px",
        borderBottom: "1px solid var(--glass-border)",
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
            <button onClick={() => { if (confirm("Clear all messages in this session?")) clearMessages(); }} title="Clear messages"
              aria-label="Clear messages"
              style={{ background: "none", border: "none", cursor: "pointer", color: "var(--c-error)", fontSize: 11, padding: "2px 4px", lineHeight: 1, opacity: 0.6, borderRadius: 4 }}
              onMouseEnter={(e) => { e.currentTarget.style.opacity = "1"; }}
              onMouseLeave={(e) => { e.currentTarget.style.opacity = "0.6"; }}>
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
        borderTop: "1px solid var(--m-border)", flexShrink: 0,
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
            background: "var(--m-surface)", border: "1px solid var(--m-border)",
            borderRadius: 8, color: "var(--m-text)", outline: "none",
          }}
        />
        <button
          onClick={handleSend}
          disabled={streaming || !input.trim()}
          style={{
            padding: "8px 14px", fontSize: 14, fontWeight: 700,
            background: streaming || !input.trim() ? "var(--glass-tint)" : "var(--m-accent)",
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
