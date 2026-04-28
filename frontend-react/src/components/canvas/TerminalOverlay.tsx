/**
 * Terminal/Agent node overlay — embedded LLM chat on the canvas.
 * Like Maestri's TerminalNodeView but for web: an interactive chat panel
 * that uses OCC's configured LLM providers.
 *
 * Renders as a DOM overlay positioned over the canvas (same as PortalOverlay).
 * Shows a mini terminal UI with message history + input field.
 */
import { useState, useRef, useEffect, useCallback } from "react";
import { useCanvasStore } from "../../stores/canvas";
import type { CanvasNode } from "../../types/canvas";
import { buildConnectedContext } from "../../utils/canvasContext";
import styles from "./CanvasEditor.module.css";

const MIN_ZOOM_FOR_OVERLAY = 0.4;

interface TerminalOverlayItemProps {
  node: CanvasNode;
  camera: { x: number; y: number; zoom: number };
}

function TerminalOverlayItem({ node, camera }: TerminalOverlayItemProps) {
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messages = node.terminalMessages ?? [];

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const sendMessage = useCallback(async () => {
    if (!input.trim() || streaming) return;
    const userMsg = input.trim();
    setInput("");

    // Add user message to node
    const currentMsgs = [...(node.terminalMessages ?? [])];
    currentMsgs.push({ role: "user", content: userMsg });
    useCanvasStore.getState().updateNode(node.id, { terminalMessages: currentMsgs });

    setStreaming(true);
    try {
      // Build conversation context for the chat API
      const context = currentMsgs
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role, content: m.content }));

      // Inject content from canvas items connected to this terminal so the
      // agent can actually act on a Portal / File / Obsidian / Sticky etc.
      const live = useCanvasStore.getState();
      const connected = buildConnectedContext(node.id, live.nodes, live.edges);

      // Collect delegate targets — other terminal nodes connected to this
      // one via a `delegate` edge. The agent at this node will be allowed
      // to delegate sub-tasks to them by emitting a structured JSON
      // directive, which the backend intercepts and routes recursively.
      const delegateTargets: Array<{
        nodeId: string;
        name: string;
        model?: string;
        provider?: string;
        systemPrompt?: string;
      }> = [];
      for (const e of live.edges.values()) {
        if (e.kind !== "delegate") continue;
        const otherId = e.from === node.id ? e.to : e.to === node.id ? e.from : null;
        if (!otherId) continue;
        const other = live.nodes.get(otherId);
        if (!other || other.kind !== "terminal") continue;
        delegateTargets.push({
          nodeId: other.id,
          name: other.terminalName ?? other.terminalModel ?? "agent",
          model: other.terminalModel,
          provider: other.terminalProvider,
          systemPrompt: other.terminalSystemPrompt,
        });
      }

      // If the user authored a custom system prompt for this terminal, use it
      // as-is. Otherwise let the backend fall back to the configurable
      // `terminalAgent` system prompt (Settings → System Prompts).
      const baseSystem = node.terminalSystemPrompt && node.terminalSystemPrompt.trim().length > 0
        ? node.terminalSystemPrompt
        : "";
      const systemPrompt = connected
        ? (baseSystem ? `${connected}\n\n${baseSystem}` : connected)
        : baseSystem;

      // Use /agent-chat (no BLOB persona, multi-provider routing).
      const res = await fetch(`/agent-chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: userMsg,
          context: context.slice(0, -1),
          systemPrompt: systemPrompt || undefined,
          model: node.terminalModel,
          provider: node.terminalProvider,
          // Phase 1 of agent-to-agent delegation: pass the connected
          // terminals so the backend can offer them as tools to the LLM.
          nodeId: node.id,
          delegateTargets: delegateTargets.length > 0 ? delegateTargets : undefined,
        }),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "Request failed");
        let errMsg = errText;
        try { errMsg = JSON.parse(errText).error ?? errText; } catch { /* keep raw */ }
        const errMsgs = [...currentMsgs, { role: "assistant" as const, content: `Error: ${errMsg}` }];
        useCanvasStore.getState().updateNode(node.id, { terminalMessages: errMsgs });
        setStreaming(false);
        return;
      }

      const data = await res.json();
      const assistantMsg = data.text ?? data.content ?? "No response";
      const trace = Array.isArray(data.delegationTrace) ? data.delegationTrace : undefined;
      const finalMsgs = [
        ...currentMsgs,
        {
          role: "assistant" as const,
          content: assistantMsg,
          ...(trace && trace.length > 0 ? { delegationTrace: trace } : {}),
        },
      ];
      const store = useCanvasStore.getState();
      store.updateNode(node.id, { terminalMessages: finalMsgs });

      // Mirror each delegation exchange into the target terminal's own
      // chat history so the user can see both sides of the conversation
      // (without us, the target terminal would stay empty even though it
      // actually answered). The "user" turn of the sub-call is the task
      // sent by the master; the "assistant" turn is the sub-agent's reply.
      if (trace && trace.length > 0) {
        for (const t of trace) {
          if (!t.targetNodeId) continue;
          const targetNode = store.nodes.get(t.targetNodeId);
          if (!targetNode || targetNode.kind !== "terminal") continue;
          const existing = targetNode.terminalMessages ?? [];
          const callerName = node.terminalName ?? node.terminalModel ?? "agent";
          const updated = [
            ...existing,
            { role: "user" as const, content: `[delegated by ${callerName}]\n${t.task}` },
            { role: "assistant" as const, content: t.response },
          ];
          store.updateNode(t.targetNodeId, { terminalMessages: updated });
        }
      }
    } catch (err) {
      const errMsgs = [...currentMsgs, { role: "assistant" as const, content: `Error: ${(err as Error).message}` }];
      useCanvasStore.getState().updateNode(node.id, { terminalMessages: errMsgs });
    }
    setStreaming(false);
  }, [input, streaming, node]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  // Screen positioning. We keep the terminal rendered at its NATIVE pixel
  // size (so font, padding, header height are constants) and apply a single
  // CSS transform: scale(zoom) at the wrapper. That way every internal
  // dimension scales perfectly together — same approach as PortalOverlay,
  // and avoids the per-element "* camera.zoom" mistakes that left buttons,
  // gaps and borders drifting at different zoom levels.
  const screenX = node.x * camera.zoom + camera.x;
  const screenY = node.y * camera.zoom + camera.y;
  const nativeW = node.w;
  const nativeH = node.h;

  return (
    <div
      className={styles.terminalOverlay}
      style={{
        left: screenX,
        top: screenY,
        width: nativeW,
        height: nativeH,
        borderRadius: 10,
        fontSize: 12,
        pointerEvents: "none",
        transform: `scale(${camera.zoom})`,
        transformOrigin: "0 0",
      }}
    >
      {/* Header bar — transparent to pointer events so canvas can drag the node */}
      <div className={styles.terminalHeader} style={{ pointerEvents: "none" }}>
        <div className={styles.terminalTrafficLights}>
          <span style={{ width: 8, height: 8, background: "#ff5f57", borderRadius: "50%" }} />
          <span style={{ width: 8, height: 8, background: "#febc2e", borderRadius: "50%" }} />
          <span style={{ width: 8, height: 8, background: "#28c840", borderRadius: "50%" }} />
        </div>
        <span className={styles.terminalTitle}>
          {node.terminalName ?? node.terminalModel ?? "Agent"}
        </span>
        <span className={styles.terminalBadge}>
          {node.terminalProvider ?? "claude"}
        </span>
      </div>

      {/* Messages — captures pointer so user can scroll/select text */}
      <div className={styles.terminalMessages} style={{ pointerEvents: "auto" }} onPointerDown={(e) => e.stopPropagation()}>
        {messages.length === 0 && (
          <div className={styles.terminalEmpty}>
            Send a message to start chatting with {node.terminalModel ?? "the LLM"}
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`${styles.terminalMsg} ${msg.role === "user" ? styles.terminalMsgUser : styles.terminalMsgAssistant}`}>
            <div className={styles.terminalMsgRole}>{msg.role === "user" ? "You" : node.terminalName ?? "Agent"}</div>
            <div className={styles.terminalMsgContent}>{msg.content}</div>
            {msg.delegationTrace && msg.delegationTrace.length > 0 && (
              <details
                style={{
                  marginTop: 6,
                  fontSize: 10,
                  color: "var(--m-text2)",
                  borderLeft: "2px solid #bf5af2",
                  paddingLeft: 8,
                }}
              >
                <summary
                  style={{
                    cursor: "pointer",
                    userSelect: "none",
                    color: "#bf5af2",
                    fontWeight: 600,
                  }}
                >
                  → delegated to {msg.delegationTrace.length} agent{msg.delegationTrace.length > 1 ? "s" : ""}
                </summary>
                <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 8 }}>
                  {msg.delegationTrace.map((d, j) => (
                    <div
                      key={j}
                      style={{
                        background: "rgba(191, 90, 242, 0.06)",
                        borderRadius: 4,
                        padding: 6,
                      }}
                    >
                      <div style={{ fontWeight: 600, color: "var(--m-text)", marginBottom: 2 }}>
                        ↳ {d.target}{d.durationMs != null ? `  (${(d.durationMs / 1000).toFixed(1)}s)` : ""}
                      </div>
                      <div style={{ fontStyle: "italic", marginBottom: 4, opacity: 0.85 }}>
                        Q: {d.task}
                      </div>
                      <div style={{ whiteSpace: "pre-wrap" }}>
                        A: {d.response}
                      </div>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        ))}
        {streaming && (
          <div className={`${styles.terminalMsg} ${styles.terminalMsgAssistant}`}>
            <div className={styles.terminalMsgRole}>{node.terminalName ?? "Agent"}</div>
            <div className={styles.terminalMsgContent}>
              <span className={styles.terminalTyping}>Thinking...</span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input — captures pointer for typing */}
      <div className={styles.terminalInput} style={{ pointerEvents: "auto" }} onPointerDown={(e) => e.stopPropagation()}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={streaming ? "Waiting..." : "Message..."}
          disabled={streaming}
          className={styles.terminalInputField}
        />
        <button
          onClick={sendMessage}
          disabled={streaming || !input.trim()}
          className={styles.terminalSendBtn}
        >
          {"\u2191"}
        </button>
      </div>
    </div>
  );
}

export function TerminalOverlays() {
  const nodes = useCanvasStore((s) => s.nodes);
  const camera = useCanvasStore((s) => s.camera);

  if (camera.zoom < MIN_ZOOM_FOR_OVERLAY) return null;

  const terminalNodes: CanvasNode[] = [];
  for (const n of nodes.values()) {
    if (n.kind === "terminal") terminalNodes.push(n);
  }

  if (terminalNodes.length === 0) return null;

  return (
    <>
      {terminalNodes.map((n) => (
        <TerminalOverlayItem key={n.id} node={n} camera={camera} />
      ))}
    </>
  );
}
