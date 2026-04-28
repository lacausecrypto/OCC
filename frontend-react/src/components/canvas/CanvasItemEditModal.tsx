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

  // Obsidian
  const [obsidianVault, setObsidianVault] = useState(existingNode?.obsidianVault ?? "");
  const [obsidianNotePath, setObsidianNotePath] = useState(existingNode?.obsidianNotePath ?? "");
  const [obsidianContent, setObsidianContent] = useState(existingNode?.obsidianContent ?? "");

  // Read a picked file via FileReader and write its name+content to local
  // state. Works for both File Viewer and Obsidian sections — both store
  // text content directly in the canvas node, no backend roundtrip.
  const readFileToState = (file: File, setName: (s: string) => void, setContent: (s: string) => void) => {
    setName(file.name);
    const reader = new FileReader();
    reader.onload = () => setContent(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => setContent(`// Failed to read ${file.name}: ${reader.error?.message ?? "unknown error"}`);
    reader.readAsText(file);
  };

  // Models discovered from the backend (`/providers/models`). Used to populate
  // the model combobox so the user can pick instead of typing — keeps the
  // free-form input as fallback for providers we don't enumerate (e.g.
  // OpenRouter / OpenAI when no API key is configured locally).
  const [providerModels, setProviderModels] = useState<{ provider: string; model: string }[]>([]);
  useEffect(() => {
    fetch("/providers/models")
      .then((r) => r.ok ? r.json() : [])
      .then((data) => { if (Array.isArray(data)) setProviderModels(data); })
      .catch(() => { /* leave empty — input stays free-form */ });
  }, []);
  // Curated fallback model lists — shown when the backend returns no models
  // for the selected provider (typically: provider not yet added, or no API key).
  // Keeps the dropdown UX even before full provider config.
  const FALLBACK_MODELS: Record<string, string[]> = {
    claude: ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"],
    codex: [
      // GPT-5.5 — current frontier (ChatGPT login only)
      "gpt-5.5",
      // GPT-5.4 family — default + mini
      "gpt-5.4", "gpt-5.4-mini",
      // GPT-5.3 codex — coding-tuned
      "gpt-5.3-codex", "gpt-5.3-codex-spark",
      // GPT-5.2 family
      "gpt-5.2", "gpt-5.2-codex",
      // Older GPT-5 family
      "gpt-5", "gpt-5-codex",
      // o-series reasoning
      "o4-mini", "o3", "o3-mini", "o3-pro", "o1", "o1-mini", "o1-pro",
      // GPT-4.1 family
      "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano",
      // GPT-4o family
      "gpt-4o", "gpt-4o-mini", "chatgpt-4o-latest",
      // Legacy
      "gpt-4-turbo", "gpt-4", "gpt-3.5-turbo",
    ],
    openrouter: [
      "anthropic/claude-sonnet-4", "anthropic/claude-opus-4",
      "openai/gpt-4o", "openai/gpt-4o-mini", "openai/o3-mini",
      "google/gemini-2.5-pro", "google/gemini-2.5-flash",
      "deepseek/deepseek-r1", "deepseek/deepseek-chat",
      "meta-llama/llama-4-maverick", "mistralai/mistral-large",
      "qwen/qwen3-235b-a22b",
    ],
    openai: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "o3-mini", "o4-mini"],
    ollama: ["llama3", "llama3.3", "mistral", "qwen2.5", "deepseek-r1"],
  };

  const backendModels = providerModels
    .filter((m) => m.provider === terminalProvider)
    .map((m) => m.model);

  // Prefer backend-reported models; fall back to curated defaults so the
  // dropdown is always populated for known providers.
  const modelsForProvider = backendModels.length > 0
    ? backendModels
    : (FALLBACK_MODELS[terminalProvider] ?? []);

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
        type: "agent",
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
      case "obsidian":
        return {
          obsidianVault: obsidianVault || undefined,
          obsidianNotePath,
          obsidianContent,
          // Use the note filename as the canvas label so it's recognizable.
          label: obsidianNotePath.split("/").pop()?.replace(/\.md$/i, "") || label,
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
                <label className={styles.itemModalLabel}>File</label>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input
                    type="file"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) readFileToState(f, setFilePath, setFileContent);
                    }}
                    style={{ flex: "0 0 auto" }}
                  />
                  <input
                    ref={firstInputRef as React.RefObject<HTMLInputElement>}
                    className={styles.itemModalInput}
                    value={filePath}
                    onChange={(e) => setFilePath(e.target.value)}
                    placeholder="src/index.ts"
                    style={{ flex: 1 }}
                  />
                </div>
              </div>
              <div className={styles.itemModalField}>
                <label className={styles.itemModalLabel}>Content preview</label>
                <textarea
                  className={`${styles.itemModalTextarea} ${styles.itemModalMono}`}
                  value={fileContent}
                  onChange={(e) => setFileContent(e.target.value)}
                  placeholder="// Paste file content or pick a file above..."
                  rows={6}
                />
              </div>
            </>
          )}

          {kind === "obsidian" && (
            <>
              <div className={styles.itemModalField}>
                <label className={styles.itemModalLabel}>Vault name (optional)</label>
                <input
                  className={styles.itemModalInput}
                  value={obsidianVault}
                  onChange={(e) => setObsidianVault(e.target.value)}
                  placeholder="MyVault"
                />
              </div>
              <div className={styles.itemModalField}>
                <label className={styles.itemModalLabel}>Note (.md file)</label>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input
                    type="file"
                    accept=".md,.markdown,text/markdown"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) readFileToState(f, setObsidianNotePath, setObsidianContent);
                    }}
                    style={{ flex: "0 0 auto" }}
                  />
                  <input
                    ref={firstInputRef as React.RefObject<HTMLInputElement>}
                    className={styles.itemModalInput}
                    value={obsidianNotePath}
                    onChange={(e) => setObsidianNotePath(e.target.value)}
                    placeholder="Projects/OCC.md"
                    style={{ flex: 1 }}
                  />
                </div>
              </div>
              <div className={styles.itemModalField}>
                <label className={styles.itemModalLabel}>Markdown content</label>
                <textarea
                  className={`${styles.itemModalTextarea} ${styles.itemModalMono}`}
                  value={obsidianContent}
                  onChange={(e) => setObsidianContent(e.target.value)}
                  placeholder="# My note&#10;&#10;Pick a .md file above or paste content here..."
                  rows={8}
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
                      codex: "gpt-5.4",
                      openrouter: "anthropic/claude-sonnet-4",
                      openai: "gpt-4o",
                      ollama: "llama3",
                    };
                    setTerminalModel(defaults[e.target.value] ?? "");
                  }}
                >
                  <option value="claude">Claude (Anthropic)</option>
                  <option value="codex">OpenAI Codex CLI</option>
                  <option value="openrouter">OpenRouter</option>
                  <option value="openai">OpenAI</option>
                  <option value="ollama">Ollama (local)</option>
                </select>
              </div>
              <div className={styles.itemModalField}>
                <label className={styles.itemModalLabel}>
                  Model
                  {backendModels.length === 0 && modelsForProvider.length > 0 && (
                    <span style={{ marginLeft: 8, fontSize: 9, opacity: 0.6 }}>
                      (suggested — configure provider for live list)
                    </span>
                  )}
                </label>
                {modelsForProvider.length > 0 ? (
                  <>
                    <select
                      ref={firstInputRef as unknown as React.RefObject<HTMLSelectElement>}
                      className={styles.itemModalSelect}
                      value={modelsForProvider.includes(terminalModel) ? terminalModel : "__custom__"}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v !== "__custom__") setTerminalModel(v);
                      }}
                    >
                      {modelsForProvider.map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                      <option value="__custom__">— Custom model name —</option>
                    </select>
                    {!modelsForProvider.includes(terminalModel) && (
                      <input
                        className={styles.itemModalInput}
                        style={{ marginTop: 6 }}
                        value={terminalModel}
                        onChange={(e) => setTerminalModel(e.target.value)}
                        placeholder="enter custom model id"
                      />
                    )}
                  </>
                ) : (
                  // Truly unknown provider — pure free-form
                  <input
                    ref={firstInputRef as React.RefObject<HTMLInputElement>}
                    className={styles.itemModalInput}
                    value={terminalModel}
                    onChange={(e) => setTerminalModel(e.target.value)}
                    placeholder="model id"
                  />
                )}
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
    obsidian: "Obsidian Note",
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
    obsidian: "\uD83D\uDCD3",
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
    obsidian: "Note",
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
    obsidian: { w: 320, h: 280 },
  };
  return map[kind] ?? { w: 200, h: 100 };
}

