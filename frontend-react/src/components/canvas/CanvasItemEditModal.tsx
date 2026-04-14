/**
 * Unified edit modal for all canvas item kinds (non-step nodes).
 * Replaces window.prompt() with proper form-based editing.
 *
 * Supports: sticky, text, portal, file, link, terminal
 * Each kind gets a tailored form section.
 */
import { useState, useEffect, useRef } from "react";
import { useCanvasStore } from "../../stores/canvas";
import type { CanvasNode, CanvasItemKind } from "../../types/canvas";
import { STICKY_COLORS } from "../../types/canvas";
import styles from "./CanvasEditor.module.css";

interface CanvasItemEditModalProps {
  /** Node ID to edit, or null to create new */
  nodeId: string | null;
  /** When creating new: the kind to create */
  createKind?: CanvasItemKind;
  /** Canvas position for new item placement */
  createPosition?: { x: number; y: number };
  onClose: () => void;
}

export function CanvasItemEditModal({
  nodeId,
  createKind,
  createPosition,
  onClose,
}: CanvasItemEditModalProps) {
  const existingNode = nodeId ? useCanvasStore.getState().nodes.get(nodeId) : null;
  const kind = existingNode?.kind ?? createKind ?? "sticky";
  const isCreate = !existingNode;

  // ─── Form state ────────────────────────────────────────────────
  // Shared
  const [label, setLabel] = useState(existingNode?.label ?? defaultLabel(kind));

  // Sticky
  const [stickyText, setStickyText] = useState(existingNode?.stickyText ?? "");
  const [stickyColor, setStickyColor] = useState(existingNode?.stickyColor ?? STICKY_COLORS[0]);
  const [fontSize, setFontSize] = useState(existingNode?.fontSize ?? 13);

  // Text
  const [markdown, setMarkdown] = useState(existingNode?.markdown ?? "");

  // Portal
  const [portalUrl, setPortalUrl] = useState(existingNode?.portalUrl ?? "https://");

  // File
  const [filePath, setFilePath] = useState(existingNode?.filePath ?? "");
  const [fileContent, setFileContent] = useState(existingNode?.fileContent ?? "");

  // Link
  const [linkUrl, setLinkUrl] = useState(existingNode?.linkUrl ?? "https://");
  const [linkTitle, setLinkTitle] = useState(existingNode?.linkTitle ?? "");

  // Terminal
  const [terminalProvider, setTerminalProvider] = useState(existingNode?.terminalProvider ?? "claude");
  const [terminalModel, setTerminalModel] = useState(existingNode?.terminalModel ?? "claude-sonnet-4-6");
  const [terminalName, setTerminalName] = useState(existingNode?.terminalName ?? "");
  const [terminalSystemPrompt, setTerminalSystemPrompt] = useState(existingNode?.terminalSystemPrompt ?? "");

  // Focus first input
  const firstInputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  useEffect(() => {
    setTimeout(() => firstInputRef.current?.focus(), 50);
  }, []);

  // ─── Save handler ──────────────────────────────────────────────
  const handleSave = () => {
    const store = useCanvasStore.getState();
    store.pushUndo();

    if (isCreate && createPosition) {
      const newId = `${kind}_${Date.now()}`;
      const base: CanvasNode = {
        id: newId,
        x: createPosition.x,
        y: createPosition.y,
        w: defaultSize(kind).w,
        h: defaultSize(kind).h,
        type: "agent" as any,
        label,
        kind,
        preTools: [],
        tools: [],
        outputVar: "",
        stepId: newId,
        prompt: "",
      };
      store.addNode({ ...base, ...buildPatch(kind) });
    } else if (nodeId) {
      store.updateNode(nodeId, { label, ...buildPatch(kind) });
    }
    onClose();
  };

  function buildPatch(k: CanvasItemKind): Partial<CanvasNode> {
    switch (k) {
      case "sticky":
        return { stickyText, stickyColor, fontSize };
      case "text":
        return { markdown };
      case "portal":
        return { portalUrl };
      case "file":
        return { filePath, fileContent, label: filePath.split("/").pop() ?? label };
      case "link":
        return { linkUrl, linkTitle: linkTitle || linkUrl.replace(/^https?:\/\//, "").split("/")[0] };
      case "terminal":
        return {
          terminalProvider,
          terminalModel,
          terminalName: terminalName || (terminalModel.split("/").pop() ?? "Agent"),
          terminalSystemPrompt: terminalSystemPrompt || undefined,
          terminalMessages: existingNode?.terminalMessages ?? [],
        };
      default:
        return {};
    }
  }

  // ─── Delete handler ────────────────────────────────────────────
  const handleDelete = () => {
    if (!nodeId) return;
    const store = useCanvasStore.getState();
    store.pushUndo();
    store.removeNode(nodeId);
    onClose();
  };

  // ─── Clear messages (terminal only) ────────────────────────────
  const handleClearMessages = () => {
    if (!nodeId) return;
    useCanvasStore.getState().updateNode(nodeId, { terminalMessages: [] });
  };

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const title = isCreate ? `New ${kindLabel(kind)}` : `Edit ${kindLabel(kind)}`;

  return (
    <div className={styles.itemModalBackdrop} onClick={onClose}>
      <div
        className={styles.itemModal}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === "Enter" && e.metaKey) handleSave(); }}
      >
        {/* Header */}
        <div className={styles.itemModalHeader}>
          <span className={styles.itemModalIcon}>{kindIcon(kind)}</span>
          <span className={styles.itemModalTitle}>{title}</span>
          <button className={styles.itemModalClose} onClick={onClose}>{"\u2715"}</button>
        </div>

        {/* Body */}
        <div className={styles.itemModalBody}>
          {/* Label — shared by all kinds */}
          <div className={styles.itemModalField}>
            <label className={styles.itemModalLabel}>Name</label>
            <input
              className={styles.itemModalInput}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={defaultLabel(kind)}
            />
          </div>

          {/* ─── Kind-specific fields ─── */}

          {kind === "sticky" && (
            <>
              <div className={styles.itemModalField}>
                <label className={styles.itemModalLabel}>Content</label>
                <textarea
                  ref={firstInputRef as React.RefObject<HTMLTextAreaElement>}
                  className={styles.itemModalTextarea}
                  value={stickyText}
                  onChange={(e) => setStickyText(e.target.value)}
                  placeholder="Write your note here..."
                  rows={5}
                />
              </div>
              <div className={styles.itemModalField}>
                <label className={styles.itemModalLabel}>Color</label>
                <div className={styles.itemModalColorRow}>
                  {STICKY_COLORS.map((c) => (
                    <button
                      key={c}
                      className={`${styles.itemModalColorSwatch} ${stickyColor === c ? styles.itemModalColorSwatchActive : ""}`}
                      style={{ background: c }}
                      onClick={() => setStickyColor(c)}
                    />
                  ))}
                </div>
              </div>
              <div className={styles.itemModalField}>
                <label className={styles.itemModalLabel}>Font size</label>
                <input
                  type="range"
                  min={9}
                  max={24}
                  value={fontSize}
                  onChange={(e) => setFontSize(Number(e.target.value))}
                  className={styles.itemModalRange}
                />
                <span className={styles.itemModalRangeValue}>{fontSize}px</span>
              </div>
            </>
          )}

          {kind === "text" && (
            <div className={styles.itemModalField}>
              <label className={styles.itemModalLabel}>Content (markdown)</label>
              <textarea
                ref={firstInputRef as React.RefObject<HTMLTextAreaElement>}
                className={styles.itemModalTextarea}
                value={markdown}
                onChange={(e) => setMarkdown(e.target.value)}
                placeholder="# Heading\n\nWrite markdown here..."
                rows={8}
              />
            </div>
          )}

          {kind === "portal" && (
            <div className={styles.itemModalField}>
              <label className={styles.itemModalLabel}>URL</label>
              <input
                ref={firstInputRef as React.RefObject<HTMLInputElement>}
                className={styles.itemModalInput}
                value={portalUrl}
                onChange={(e) => setPortalUrl(e.target.value)}
                placeholder="https://example.com"
                type="url"
              />
            </div>
          )}

          {kind === "file" && (
            <>
              <div className={styles.itemModalField}>
                <label className={styles.itemModalLabel}>File path</label>
                <input
                  ref={firstInputRef as React.RefObject<HTMLInputElement>}
                  className={styles.itemModalInput}
                  value={filePath}
                  onChange={(e) => setFilePath(e.target.value)}
                  placeholder="src/index.ts"
                />
              </div>
              <div className={styles.itemModalField}>
                <label className={styles.itemModalLabel}>Content preview</label>
                <textarea
                  className={`${styles.itemModalTextarea} ${styles.itemModalMono}`}
                  value={fileContent}
                  onChange={(e) => setFileContent(e.target.value)}
                  placeholder="// Paste file content here..."
                  rows={6}
                />
              </div>
            </>
          )}

          {kind === "link" && (
            <>
              <div className={styles.itemModalField}>
                <label className={styles.itemModalLabel}>URL</label>
                <input
                  ref={firstInputRef as React.RefObject<HTMLInputElement>}
                  className={styles.itemModalInput}
                  value={linkUrl}
                  onChange={(e) => setLinkUrl(e.target.value)}
                  placeholder="https://example.com"
                  type="url"
                />
              </div>
              <div className={styles.itemModalField}>
                <label className={styles.itemModalLabel}>Title</label>
                <input
                  className={styles.itemModalInput}
                  value={linkTitle}
                  onChange={(e) => setLinkTitle(e.target.value)}
                  placeholder="Display title (auto-detected from URL)"
                />
              </div>
            </>
          )}

          {kind === "terminal" && (
            <>
              <div className={styles.itemModalField}>
                <label className={styles.itemModalLabel}>Provider</label>
                <select
                  className={styles.itemModalSelect}
                  value={terminalProvider}
                  onChange={(e) => {
                    setTerminalProvider(e.target.value);
                    // Set default model when switching provider
                    const defaults: Record<string, string> = {
                      claude: "claude-sonnet-4-6",
                      openrouter: "anthropic/claude-sonnet-4",
                      openai: "gpt-4o",
                      ollama: "llama3",
                    };
                    setTerminalModel(defaults[e.target.value] ?? "");
                  }}
                >
                  <option value="claude">Claude (Anthropic)</option>
                  <option value="openrouter">OpenRouter</option>
                  <option value="openai">OpenAI</option>
                  <option value="ollama">Ollama (local)</option>
                </select>
              </div>
              <div className={styles.itemModalField}>
                <label className={styles.itemModalLabel}>Model</label>
                <input
                  ref={firstInputRef as React.RefObject<HTMLInputElement>}
                  className={styles.itemModalInput}
                  value={terminalModel}
                  onChange={(e) => setTerminalModel(e.target.value)}
                  placeholder="claude-sonnet-4-6"
                />
              </div>
              <div className={styles.itemModalField}>
                <label className={styles.itemModalLabel}>Agent name</label>
                <input
                  className={styles.itemModalInput}
                  value={terminalName}
                  onChange={(e) => setTerminalName(e.target.value)}
                  placeholder={terminalModel.split("/").pop() ?? "Agent"}
                />
              </div>
              <div className={styles.itemModalField}>
                <label className={styles.itemModalLabel}>System prompt (role instructions)</label>
                <textarea
                  className={styles.itemModalTextarea}
                  value={terminalSystemPrompt}
                  onChange={(e) => setTerminalSystemPrompt(e.target.value)}
                  placeholder="You are a helpful assistant specialized in..."
                  rows={4}
                />
              </div>
              {!isCreate && existingNode?.terminalMessages && existingNode.terminalMessages.length > 0 && (
                <div className={styles.itemModalField}>
                  <label className={styles.itemModalLabel}>
                    Chat history ({existingNode.terminalMessages.length} messages)
                  </label>
                  <button
                    className={styles.itemModalDangerBtn}
                    onClick={handleClearMessages}
                  >
                    Clear conversation
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className={styles.itemModalFooter}>
          {!isCreate && (
            <button className={styles.itemModalDangerBtn} onClick={handleDelete}>
              Delete
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button className={styles.itemModalCancelBtn} onClick={onClose}>
            Cancel
          </button>
          <button className={styles.itemModalSaveBtn} onClick={handleSave}>
            {isCreate ? "Create" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────

function kindLabel(kind: CanvasItemKind): string {
  const map: Record<CanvasItemKind, string> = {
    step: "Step",
    sticky: "Sticky Note",
    text: "Text Block",
    portal: "Portal",
    file: "File Viewer",
    link: "Link Bookmark",
    terminal: "Terminal Agent",
  };
  return map[kind] ?? kind;
}

function kindIcon(kind: CanvasItemKind): string {
  const map: Record<CanvasItemKind, string> = {
    step: "\u2699",
    sticky: "\uD83D\uDCCB",
    text: "\uD83D\uDCDD",
    portal: "\uD83C\uDF10",
    file: "\uD83D\uDCC4",
    link: "\uD83D\uDD17",
    terminal: "\uD83D\uDCBB",
  };
  return map[kind] ?? "\u2699";
}

function defaultLabel(kind: CanvasItemKind): string {
  const map: Record<CanvasItemKind, string> = {
    step: "Step",
    sticky: "Note",
    text: "Text",
    portal: "Portal",
    file: "File",
    link: "Link",
    terminal: "Agent",
  };
  return map[kind] ?? "Item";
}

function defaultSize(kind: CanvasItemKind): { w: number; h: number } {
  const map: Record<CanvasItemKind, { w: number; h: number }> = {
    step: { w: 220, h: 64 },
    sticky: { w: 180, h: 160 },
    text: { w: 240, h: 140 },
    portal: { w: 400, h: 300 },
    file: { w: 320, h: 240 },
    link: { w: 260, h: 48 },
    terminal: { w: 380, h: 320 },
  };
  return map[kind] ?? { w: 200, h: 100 };
}
