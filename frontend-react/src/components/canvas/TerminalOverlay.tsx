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

      const res = await fetch(`/blobs/${encodeURIComponent(node.id)}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: userMsg,
          context: context.slice(0, -1), // exclude the just-added user message (it's in 'message')
          systemPrompt: node.terminalSystemPrompt || `You are ${node.terminalName ?? "an AI assistant"}. Be concise and helpful.`,
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
      const finalMsgs = [...currentMsgs, { role: "assistant" as const, content: assistantMsg }];
      useCanvasStore.getState().updateNode(node.id, { terminalMessages: finalMsgs });
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

  // Screen positioning
  const headerH = 32;
  const screenX = node.x * camera.zoom + camera.x;
  const screenY = node.y * camera.zoom + camera.y;
  const screenW = node.w * camera.zoom;
  const screenH = node.h * camera.zoom;

  return (
    <div
      className={styles.terminalOverlay}
      style={{
        left: screenX,
        top: screenY,
        width: screenW,
        height: screenH,
        borderRadius: 10 * camera.zoom,
        fontSize: Math.max(9, 12 * camera.zoom),
        pointerEvents: "none",
      }}
    >
      {/* Header bar — transparent to pointer events so canvas can drag the node */}
      <div className={styles.terminalHeader} style={{ height: headerH * camera.zoom, pointerEvents: "none" }}>
        <div className={styles.terminalTrafficLights} style={{ gap: 5 * camera.zoom }}>
          <span style={{ width: 8 * camera.zoom, height: 8 * camera.zoom, background: "#ff5f57", borderRadius: "50%" }} />
          <span style={{ width: 8 * camera.zoom, height: 8 * camera.zoom, background: "#febc2e", borderRadius: "50%" }} />
          <span style={{ width: 8 * camera.zoom, height: 8 * camera.zoom, background: "#28c840", borderRadius: "50%" }} />
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
