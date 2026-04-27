/**
 * SystemPromptsSection — edit per-context system prompts.
 *
 * Lets the user customize the persona/instructions for each entry point
 * without recompiling. Persists via PUT /system-prompts on the backend.
 */
import { useState, useEffect, useCallback } from "react";
import { CollapsibleSection } from "./Collapsible";
import styles from "./Settings.module.css";

type SystemPromptKey =
  | "blobChat"
  | "blobOrchestrator"
  | "terminalAgent"
  | "workflowChat"
  | "workflowPlan"
  | "stepDefault";

type SystemPromptsConfig = Record<SystemPromptKey, string>;

interface PromptsResponse {
  current: SystemPromptsConfig;
  defaults: SystemPromptsConfig;
}

const PROMPT_META: Array<{
  key: SystemPromptKey;
  label: string;
  description: string;
  bg: string;        // icon bg color var
  letter: string;
}> = [
  {
    key: "blobChat",
    label: "BLOB Chat",
    description: "The persona used in the BLOB session chat (canvas /blobs/:id/chat). Includes MCP + knowledge graph injection.",
    bg: "var(--icon-purple-bg)",
    letter: "B",
  },
  {
    key: "blobOrchestrator",
    label: "BLOB Orchestrator",
    description: "The JSON planner that grows the BLOB graph. Outputs strict JSON describing branches, reuse, memory updates.",
    bg: "var(--icon-blue-bg)",
    letter: "O",
  },
  {
    key: "terminalAgent",
    label: "Terminal Agent",
    description: "Used by free LLM agents on canvas Terminal nodes. Should NOT impersonate the BLOB. Respects the user's chosen model/provider.",
    bg: "var(--icon-cyan-bg)",
    letter: "T",
  },
  {
    key: "workflowChat",
    label: "Workflow Chat (Architect)",
    description: "Conversational mode of the workflow chat — helps the user design a chain interactively.",
    bg: "var(--icon-green-bg)",
    letter: "W",
  },
  {
    key: "workflowPlan",
    label: "Workflow Plan (JSON)",
    description: "Plan mode of the workflow chat — outputs a JSON plan describing steps to add to the canvas.",
    bg: "var(--icon-orange-bg)",
    letter: "P",
  },
  {
    key: "stepDefault",
    label: "Step Default",
    description: "Safety-net system prompt prepended to agent steps that have no explicit prompt. Rarely used in practice.",
    bg: "var(--m-text2)",
    letter: "S",
  },
];

export function SystemPromptsSection() {
  const [data, setData] = useState<PromptsResponse | null>(null);
  const [edits, setEdits] = useState<Partial<SystemPromptsConfig>>({});
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<SystemPromptKey | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch("/system-prompts");
      if (!res.ok) {
        setLoadError(`Server returned ${res.status} ${res.statusText}. Is the backend running?`);
        return;
      }
      const json = (await res.json()) as PromptsResponse;
      if (!json || typeof json !== "object" || !json.current || !json.defaults) {
        setLoadError("Server returned an unexpected response shape.");
        return;
      }
      setData(json);
      setEdits({});
    } catch (err) {
      setLoadError((err as Error).message || "Failed to fetch /system-prompts");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const isDirty = (key: SystemPromptKey): boolean => {
    if (!data) return false;
    if (!(key in edits)) return false;
    return edits[key] !== data.current[key];
  };

  const anyDirty = Object.keys(edits).some((k) => isDirty(k as SystemPromptKey));

  const handleSave = async () => {
    if (!data || !anyDirty) return;
    setSaving(true);
    try {
      const patch: Partial<SystemPromptsConfig> = {};
      for (const k of Object.keys(edits) as SystemPromptKey[]) {
        if (isDirty(k)) patch[k] = edits[k]!;
      }
      const res = await fetch("/system-prompts", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (res.ok) {
        const json = (await res.json()) as { current: SystemPromptsConfig };
        setData((d) => d ? { ...d, current: json.current } : d);
        setEdits({});
        setSavedAt(Date.now());
        setTimeout(() => setSavedAt(null), 2500);
      }
    } finally {
      setSaving(false);
    }
  };

  const handleResetOne = (key: SystemPromptKey) => {
    if (!data) return;
    setEdits((e) => ({ ...e, [key]: data.defaults[key] }));
  };

  const handleResetAll = async () => {
    if (!confirm("Reset ALL system prompts to built-in defaults? This cannot be undone.")) return;
    await fetch("/system-prompts/reset", { method: "POST" });
    await load();
  };

  if (!data) {
    return (
      <CollapsibleSection id="system-prompts" title="System Prompts" badge={loadError ? <span style={{ color: "var(--c-error)" }}>error</span> : undefined}>
        <div className={styles.sectionCard}>
          {loadError ? (
            <div className={styles.row}>
              <div className={styles.rowBody}>
                <div className={styles.rowLabel} style={{ color: "var(--c-error)" }}>Could not load system prompts</div>
                <div className={styles.rowDesc}>{loadError}</div>
              </div>
              <button className={styles.rowBtn} onClick={() => void load()}>Retry</button>
            </div>
          ) : (
            <div className={styles.loadingRow}>Loading...</div>
          )}
        </div>
      </CollapsibleSection>
    );
  }

  return (
    <CollapsibleSection
      id="system-prompts"
      title="System Prompts"
      badge={anyDirty ? <span style={{ color: "var(--c-warning)" }}>● unsaved</span> : undefined}
    >
      <div className={styles.sectionCard}>
        {PROMPT_META.map((meta) => {
          const value = edits[meta.key] ?? data.current[meta.key];
          const dflt = data.defaults[meta.key];
          const dirty = isDirty(meta.key);
          const customized = data.current[meta.key] !== dflt;
          const isExpanded = expanded === meta.key;

          return (
            <div key={meta.key} className={styles.row} style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div className={styles.rowIcon} style={{ background: meta.bg }}>{meta.letter}</div>
                <div className={styles.rowBody}>
                  <div className={styles.rowLabel}>
                    {meta.label}
                    {dirty && <span style={{ marginLeft: 6, fontSize: 9, color: "var(--c-warning)" }}>●</span>}
                    {!dirty && customized && <span style={{ marginLeft: 6, fontSize: 9, color: "var(--m-text2)" }}>(customized)</span>}
                  </div>
                  <div className={styles.rowDesc}>{meta.description}</div>
                </div>
                <button
                  className={styles.rowBtn}
                  onClick={() => setExpanded(isExpanded ? null : meta.key)}
                >
                  {isExpanded ? "Collapse" : "Edit"}
                </button>
                {customized && (
                  <button
                    className={styles.rowBtn}
                    onClick={() => handleResetOne(meta.key)}
                    title="Reset this prompt to its built-in default"
                  >
                    Reset
                  </button>
                )}
              </div>
              {isExpanded && (
                <textarea
                  value={value}
                  onChange={(e) => setEdits((prev) => ({ ...prev, [meta.key]: e.target.value }))}
                  spellCheck={false}
                  style={{
                    width: "100%",
                    minHeight: 180,
                    padding: 10,
                    fontFamily: "var(--m-font-mono, monospace)",
                    fontSize: 12,
                    lineHeight: 1.5,
                    background: "var(--m-bg)",
                    border: "1px solid var(--m-border)",
                    borderRadius: 6,
                    color: "var(--m-text)",
                    resize: "vertical",
                    outline: "none",
                  }}
                />
              )}
            </div>
          );
        })}

        {/* Action bar */}
        <div className={styles.row} style={{ justifyContent: "flex-end", gap: 8 }}>
          <button
            className={`${styles.rowBtn} ${styles.rowBtnDanger}`}
            onClick={handleResetAll}
            title="Reset all prompts to built-in defaults"
          >
            Reset all
          </button>
          {savedAt && <span style={{ fontSize: 11, color: "var(--c-success)", alignSelf: "center" }}>Saved</span>}
          <button
            className={`${styles.rowBtn} ${styles.rowBtnPrimary}`}
            onClick={handleSave}
            disabled={!anyDirty || saving}
          >
            {saving ? "Saving..." : "Save changes"}
          </button>
        </div>
      </div>
    </CollapsibleSection>
  );
}
