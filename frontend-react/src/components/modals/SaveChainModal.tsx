import { useState, useCallback, useEffect, useRef } from "react";
import { useCanvasStore } from "../../stores/canvas";
import { useAppStore } from "../../stores/app";
import { useChainsStore } from "../../stores/chains";
import { saveChain } from "../../api/chains";
import { canvasToYaml } from "../../utils/canvasToYaml";
import { ModalOverlay } from "./ModalOverlay";
import styles from "./Modal.module.css";

interface SaveChainModalProps {
  onClose: () => void;
  onSaved?: (name: string) => void;
}

export function SaveChainModal({ onClose, onSaved }: SaveChainModalProps) {
  const existingName = useAppStore((s) => s.canvasChainName);
  const [name, setName] = useState(existingName ?? "");
  const [description, setDescription] = useState("");
  const [versionMessage, setVersionMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [yamlPreview, setYamlPreview] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // If there's an existing chain, show "save as new" mode toggle
  const [saveAsNew, setSaveAsNew] = useState(false);
  const isOverwrite = !!existingName && !saveAsNew;

  useEffect(() => {
    // Focus name input when in "save as new" mode or no existing name
    if (!isOverwrite) inputRef.current?.focus();
  }, [isOverwrite]);

  const generateYaml = useCallback(() => {
    const { nodes, edges } = useCanvasStore.getState();
    if (nodes.size === 0) return "";
    const chainName = isOverwrite ? existingName! : (name || "untitled");
    return canvasToYaml(nodes, edges, chainName, description || undefined);
  }, [name, description, isOverwrite, existingName]);

  const handlePreview = useCallback(() => {
    setYamlPreview(generateYaml());
  }, [generateYaml]);

  const doSave = useCallback(async (targetName: string) => {
    const yaml = generateYaml();
    if (!yaml) {
      setError("Canvas is empty -- add some steps first");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const result = await saveChain(targetName, yaml, versionMessage || undefined);
      if (result.ok) {
        // Update the tracked chain name
        useAppStore.setState({ canvasChainName: targetName });
        void useChainsStore.getState().fetchChains();
        onSaved?.(targetName);
        onClose();
      } else {
        setError("Server returned an error");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save chain");
    } finally {
      setSaving(false);
    }
  }, [generateYaml, onClose, onSaved]);

  const handleSave = useCallback(async () => {
    if (isOverwrite) {
      await doSave(existingName!);
    } else {
      const trimmed = name.trim();
      if (!trimmed) {
        setError("Chain name is required");
        return;
      }
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(trimmed)) {
        setError("Name must start with a letter/number and contain only letters, numbers, dashes, underscores, dots");
        return;
      }
      await doSave(trimmed);
    }
  }, [isOverwrite, existingName, name, doSave]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSave();
      }
    },
    [handleSave],
  );

  const nodeCount = useCanvasStore.getState().nodes.size;
  const edgeCount = useCanvasStore.getState().edges.size;

  return (
    <ModalOverlay onClose={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <div className={styles.headerTitle}>
            {isOverwrite ? `Save "${existingName}"` : "Save Chain"}
          </div>
          <button className={styles.closeBtn} onClick={onClose}>&times;</button>
        </div>

        <div className={styles.body}>
          {/* If existing chain, show overwrite vs save-as toggle */}
          {existingName && (
            <div style={{ display: "flex", gap: 8, marginBottom: 4 }}>
              <button
                className={`${styles.btn} ${!saveAsNew ? styles.btnPrimary : ""}`}
                style={{ flex: 1, padding: "6px 12px", fontSize: "var(--s-sm)" }}
                onClick={() => setSaveAsNew(false)}
              >
                Overwrite "{existingName}"
              </button>
              <button
                className={`${styles.btn} ${saveAsNew ? styles.btnPrimary : ""}`}
                style={{ flex: 1, padding: "6px 12px", fontSize: "var(--s-sm)" }}
                onClick={() => { setSaveAsNew(true); setTimeout(() => inputRef.current?.focus(), 50); }}
              >
                Save as new chain
              </button>
            </div>
          )}

          {/* Name field — only when save-as-new or no existing chain */}
          {!isOverwrite && (
            <div className={styles.field}>
              <div className={styles.fieldLabel}>Chain Name <span className={styles.required}>*</span></div>
              <input
                ref={inputRef}
                className={`${styles.input} ${error ? styles.inputError : ""}`}
                value={name}
                onChange={(e) => { setName(e.target.value); setError(null); }}
                onKeyDown={onKeyDown}
                placeholder="my-chain-name"
                disabled={saving}
              />
            </div>
          )}

          <div className={styles.field}>
            <div className={styles.fieldLabel}>Description <span className={styles.optional}>(optional)</span></div>
            <input
              className={styles.input}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="What does this chain do?"
              disabled={saving}
            />
          </div>

          <div className={styles.field}>
            <div className={styles.fieldLabel}>Version Note <span className={styles.optional}>(optional)</span></div>
            <input
              className={styles.input}
              value={versionMessage}
              onChange={(e) => setVersionMessage(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="What changed? e.g. 'Added validation step'"
              disabled={saving}
            />
          </div>

          {error && (
            <div style={{ color: "var(--c-error)", fontSize: "var(--s-xs)", padding: "4px 0" }}>{error}</div>
          )}

          {yamlPreview && (
            <div className={styles.field}>
              <div className={styles.fieldLabel}>YAML Preview</div>
              <pre className={styles.dryRunResult} style={{ maxHeight: 300 }}>{yamlPreview}</pre>
            </div>
          )}
        </div>

        <div className={styles.footer}>
          <button
            className={styles.btn}
            onClick={handlePreview}
            disabled={saving}
          >
            Preview YAML
          </button>
          <div className={styles.footerInfo}>
            {nodeCount} steps, {edgeCount} connections
          </div>
          <button className={styles.btn} onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            className={styles.btnPrimary}
            onClick={() => void handleSave()}
            disabled={saving || (!isOverwrite && !name.trim())}
          >
            {saving ? "Saving..." : isOverwrite ? `Overwrite "${existingName}"` : "Save Chain"}
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}
