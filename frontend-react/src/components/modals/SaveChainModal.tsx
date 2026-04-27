import { useState, useCallback, useEffect, useRef } from "react";
import { useCanvasStore } from "../../stores/canvas";
import { useAppStore } from "../../stores/app";
import { useChainsStore } from "../../stores/chains";
import { saveChain } from "../../api/chains";
import { savePipeline, buildPipelineDefinition } from "../../api/pipelines";
import { canvasToYaml, isPipelineCanvas, canvasToPipelineChains } from "../../utils/canvasToYaml";
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
  const [maxContextChars, setMaxContextChars] = useState<string>("");
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

  // Detect whether the canvas represents a pipeline (only pipeline-stage nodes)
  // vs a chain (steps). The save flow dispatches to the right endpoint.
  const canvasNodes = useCanvasStore.getState().nodes;
  const isPipeline = isPipelineCanvas(canvasNodes);

  const generateYaml = useCallback(() => {
    const { nodes, edges } = useCanvasStore.getState();
    if (nodes.size === 0) return "";
    if (isPipeline) {
      const stages = canvasToPipelineChains(nodes, edges);
      const def = buildPipelineDefinition(stages, {
        name: isOverwrite ? existingName! : (name || "untitled"),
        description: description || undefined,
      });
      return JSON.stringify(def, null, 2);
    }
    const chainName = isOverwrite ? existingName! : (name || "untitled");
    const mcc = maxContextChars.trim() ? Number(maxContextChars) : undefined;
    return canvasToYaml(nodes, edges, chainName, description || undefined, {
      max_context_chars: Number.isFinite(mcc as number) ? mcc : undefined,
    });
  }, [name, description, isOverwrite, existingName, isPipeline, maxContextChars]);

  const handlePreview = useCallback(() => {
    setYamlPreview(generateYaml());
  }, [generateYaml]);

  const doSave = useCallback(async (targetName: string) => {
    const { nodes, edges } = useCanvasStore.getState();
    if (nodes.size === 0) {
      setError("Canvas is empty -- add some steps first");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      let ok = false;
      if (isPipeline) {
        const stages = canvasToPipelineChains(nodes, edges);
        if (stages.length === 0) throw new Error("No pipeline stages detected");
        const def = buildPipelineDefinition(stages, {
          name: targetName,
          description: description || undefined,
        });
        const result = await savePipeline(targetName, def, versionMessage || undefined);
        ok = result.ok;
      } else {
        const mcc = maxContextChars.trim() ? Number(maxContextChars) : undefined;
        const yaml = canvasToYaml(nodes, edges, targetName, description || undefined, {
          max_context_chars: Number.isFinite(mcc as number) ? mcc : undefined,
        });
        if (!yaml) throw new Error("Canvas is empty");
        const result = await saveChain(targetName, yaml, versionMessage || undefined);
        ok = result.ok;
      }

      if (ok) {
        useAppStore.setState({ canvasChainName: targetName });
        void useChainsStore.getState().fetchChains();
        onSaved?.(targetName);
        onClose();
      } else {
        setError("Server returned an error");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }, [isPipeline, description, versionMessage, maxContextChars, onClose, onSaved]);

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
            {isOverwrite
              ? `Save "${existingName}"`
              : (isPipeline ? "Save Pipeline" : "Save Chain")}
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
              <div className={styles.fieldLabel}>{isPipeline ? "Pipeline Name" : "Chain Name"} <span className={styles.required}>*</span></div>
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

          {!isPipeline && (
            <div className={styles.field}>
              <div className={styles.fieldLabel}>
                Context Budget <span className={styles.optional}>(optional)</span>
              </div>
              <input
                className={styles.input}
                type="number"
                min={0}
                value={maxContextChars}
                onChange={(e) => setMaxContextChars(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="50000 (default) — 0 disables — overrides global"
                disabled={saving}
              />
              <div style={{ fontSize: "var(--s-xs)", color: "var(--m-text2)", marginTop: 4 }}>
                Max characters across step variables before older outputs are auto-summarized.
              </div>
            </div>
          )}

          {error && (
            <div style={{ color: "var(--c-error)", fontSize: "var(--s-xs)", padding: "4px 0" }}>{error}</div>
          )}

          {yamlPreview && (
            <div className={styles.field}>
              <div className={styles.fieldLabel}>{isPipeline ? "JSON Preview" : "YAML Preview"}</div>
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
            {isPipeline ? "Preview JSON" : "Preview YAML"}
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
            {saving
              ? "Saving..."
              : isOverwrite
                ? `Overwrite "${existingName}"`
                : (isPipeline ? "Save Pipeline" : "Save Chain")}
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}
