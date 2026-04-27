/**
 * Schedule management — non-dev friendly UX.
 * Visual cron builder with presets, chain dropdown, no raw JSON.
 */
import { useState, useEffect, useCallback } from "react";
import { ItemListManager } from "./ItemListManager";
import { CollapsibleSection } from "./Collapsible";
import styles from "./Settings.module.css";

interface Schedule {
  id: string;
  label: string;
  chainName: string;
  cron: string;
  enabled: boolean;
  input?: Record<string, string>;
  lastRunAt?: string;
  lastRunStatus?: string;
}

interface ChainInfo {
  name: string;
  description?: string;
  stepCount?: number;
  chainCount?: number;
  type: "chain" | "pipeline";
}

// ─── Cron presets ───────────────────────────────────────────────────────────

const CRON_PRESETS = [
  { label: "Every hour", cron: "0 * * * *", icon: "\u{1F551}" },
  { label: "Every day at 9am", cron: "0 9 * * *", icon: "\u{1F305}" },
  { label: "Every day at 6pm", cron: "0 18 * * *", icon: "\u{1F307}" },
  { label: "Mon-Fri at 9am", cron: "0 9 * * 1-5", icon: "\u{1F4BC}" },
  { label: "Every Monday 9am", cron: "0 9 * * 1", icon: "\u{1F4C5}" },
  { label: "Every 6 hours", cron: "0 */6 * * *", icon: "\u23F0" },
  { label: "Every 15 min", cron: "*/15 * * * *", icon: "\u26A1" },
  { label: "1st of month", cron: "0 9 1 * *", icon: "\u{1F4C6}" },
];

function describeCron(cron: string): string {
  const preset = CRON_PRESETS.find((p) => p.cron === cron);
  if (preset) return preset.label;
  const parts = cron.split(" ");
  if (parts.length !== 5) return cron;
  const [min, hour, day, month, dow] = parts;
  let desc = "";
  if (min === "0" && hour !== "*" && day === "*" && month === "*") {
    desc = `Daily at ${hour}:00`;
    if (dow === "1-5") desc = `Weekdays at ${hour}:00`;
    else if (dow === "1") desc = `Mondays at ${hour}:00`;
    else if (dow !== "*") desc = `Day ${dow} at ${hour}:00`;
  } else if (min.startsWith("*/")) {
    desc = `Every ${min.slice(2)} min`;
  } else if (hour.startsWith("*/")) {
    desc = `Every ${hour.slice(2)} hours`;
  } else {
    desc = cron;
  }
  return desc;
}

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(path, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

export function ScheduleSection() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [chains, setChains] = useState<ChainInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Form state
  const [label, setLabel] = useState("");
  const [chainName, setChainName] = useState("");
  const [cron, setCron] = useState("0 9 * * *");
  const [customCron, setCustomCron] = useState(false);
  const [inputFields, setInputFields] = useState<Array<{ key: string; value: string }>>([]);

  const loadData = useCallback(async () => {
    setLoading(true);
    const [s, rawChains, rawPipelines] = await Promise.all([
      fetchJson<Schedule[]>("/schedules"),
      fetchJson<Array<{ name: string; description?: string; stepCount?: number }>>("/chains"),
      fetchJson<Array<{ name: string; description?: string; chainCount?: number }>>("/pipelines"),
    ]);
    setSchedules(Array.isArray(s) ? s : []);

    const allItems: ChainInfo[] = [];
    if (Array.isArray(rawChains)) {
      for (const c of rawChains) allItems.push({ name: c.name, description: c.description, stepCount: c.stepCount, type: "chain" });
    }
    if (Array.isArray(rawPipelines)) {
      for (const p of rawPipelines) allItems.push({ name: p.name, description: p.description, chainCount: p.chainCount, type: "pipeline" });
    }
    setChains(allItems);
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // When chain changes, try to load its inputs from YAML
  useEffect(() => {
    if (!chainName) return;
    // Fetch raw YAML and extract inputs manually
    fetch(`/chains/${chainName}`, { signal: AbortSignal.timeout(3000) })
      .then((r) => r.ok ? r.text() : "")
      .then((yaml) => {
        // Simple YAML input extraction: look for "inputs:" section
        const inputMatch = yaml.match(/inputs:\s*\n((?:\s+-[^\n]*\n?)*)/);
        if (!inputMatch) { setInputFields([]); return; }
        const names = [...inputMatch[1].matchAll(/name:\s*["']?(\w+)/g)].map((m) => m[1]);
        if (names.length > 0) {
          setInputFields(names.map((n) => ({ key: n, value: "" })));
        } else {
          setInputFields([]);
        }
      })
      .catch(() => setInputFields([]));
  }, [chainName]);

  const resetForm = () => {
    setLabel(""); setChainName(""); setCron("0 9 * * *"); setCustomCron(false); setInputFields([]);
    setAdding(false); setEditingId(null);
  };

  const handleSave = async () => {
    const input: Record<string, string> = {};
    for (const f of inputFields) { if (f.key && f.value) input[f.key] = f.value; }

    const body = {
      label: label || chainName,
      chainName,
      cron,
      enabled: true,
      ...(Object.keys(input).length > 0 ? { input } : {}),
    };

    if (editingId) {
      await fetch(`/schedules/${editingId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    } else {
      await fetch("/schedules", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    }
    resetForm();
    loadData();
  };

  const startEdit = (s: Schedule) => {
    setEditingId(s.id);
    setLabel(s.label);
    setChainName(s.chainName);
    setCron(s.cron);
    setCustomCron(!CRON_PRESETS.some((p) => p.cron === s.cron));
    setInputFields(s.input ? Object.entries(s.input).map(([key, value]) => ({ key, value })) : []);
    setAdding(true);
  };

  return (
    <CollapsibleSection id="schedules" title="Scheduled Jobs" badge={`${schedules.length}`}>
      <div className={styles.sectionCard}>
        {loading && <div className={styles.loadingRow}>Loading...</div>}
        {!loading && schedules.length === 0 && !adding && (
          <div className={styles.emptyCard}>
            <div className={styles.emptyIcon}>{"\u{1F4C5}"}</div>
            <div className={styles.emptyText}>No scheduled jobs yet</div>
            <div className={styles.emptyHint}>Automate chain execution on a recurring schedule</div>
          </div>
        )}

        {schedules.map((s) => (
          <div key={s.id} className={styles.schedCard}>
            <button
              className={`${styles.toggle} ${s.enabled ? styles.toggleOn : ""}`}
              onClick={async () => { await fetch(`/schedules/${s.id}/toggle`, { method: "PATCH" }); loadData(); }}
              style={{ width: 34, height: 20, flexShrink: 0 }}
              type="button"
              title={s.enabled ? "Pause" : "Resume"}
            >
              <div className={styles.toggleDot} style={{ width: 16, height: 16 }} />
            </button>
            <div className={styles.schedInfo}>
              <div className={styles.schedLabel}>{s.label || s.chainName}</div>
              <div className={styles.schedMeta}>
                {s.chainName}
                {s.lastRunStatus && ` · ${s.lastRunStatus}`}
                {s.lastRunAt && ` · ${new Date(s.lastRunAt).toLocaleDateString()}`}
              </div>
            </div>
            <div className={styles.schedCronBadge} title={s.cron}>
              {describeCron(s.cron)}
            </div>
            <button className={styles.rowBtn} onClick={async () => { await fetch(`/schedules/${s.id}/run`, { method: "POST" }); loadData(); }} title="Run now">{"\u25B6"}</button>
            <button className={styles.rowBtn} onClick={() => startEdit(s)} title="Edit">{"\u270E"}</button>
            <button className={`${styles.rowBtn} ${styles.rowBtnDanger}`} onClick={async () => {
              if (!confirm(`Delete schedule "${s.label || s.chainName}"?`)) return;
              await fetch(`/schedules/${s.id}`, { method: "DELETE" }); loadData();
            }} title="Delete">{"\u2716"}</button>
          </div>
        ))}

        {/* ─── Add/Edit form ─── */}
        {adding && (
          <div className={styles.formCard}>
            <div className={styles.formTitle}>{editingId ? "Edit Schedule" : "New Schedule"}</div>

            {/* Chain selector */}
            <div className={styles.formRow}>
              <label className={styles.formLabel}>Chain / Pipeline</label>
              {chains.length > 0 ? (
                <select className={styles.formInput} value={chainName} onChange={(e) => setChainName(e.target.value)} style={{ fontFamily: "var(--m-font)" }}>
                  <option value="">Select...</option>
                  {chains.filter((c) => c.type === "chain").length > 0 && (
                    <optgroup label="Chains">
                      {chains.filter((c) => c.type === "chain").map((c) => (
                        <option key={c.name} value={c.name}>
                          {c.name}{c.stepCount ? ` (${c.stepCount} steps)` : ""}{c.description ? ` — ${c.description.slice(0, 40)}` : ""}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {chains.filter((c) => c.type === "pipeline").length > 0 && (
                    <optgroup label="Pipelines">
                      {chains.filter((c) => c.type === "pipeline").map((c) => (
                        <option key={c.name} value={c.name}>
                          {c.name}{c.chainCount ? ` (${c.chainCount} chains)` : ""}{c.description ? ` — ${c.description.slice(0, 40)}` : ""}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              ) : (
                <input className={styles.formInput} value={chainName} onChange={(e) => setChainName(e.target.value)} placeholder="Chain name" />
              )}
            </div>

            {/* Label */}
            <div className={styles.formRow}>
              <label className={styles.formLabel}>Label (optional)</label>
              <input className={styles.formInput} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={chainName || "My daily report"} />
            </div>

            {/* Cron — preset buttons */}
            <div className={styles.formRow}>
              <label className={styles.formLabel}>Frequency</label>
              <div className={styles.cronGrid}>
                {CRON_PRESETS.map((p) => (
                  <button
                    key={p.cron}
                    className={`${styles.cronBtn} ${cron === p.cron && !customCron ? styles.cronBtnActive : ""}`}
                    onClick={() => { setCron(p.cron); setCustomCron(false); }}
                    type="button"
                  >
                    <span className={styles.cronBtnIcon}>{p.icon}</span>
                    {p.label}
                  </button>
                ))}
                <button
                  className={`${styles.cronBtn} ${customCron ? styles.cronBtnActive : ""}`}
                  onClick={() => setCustomCron(true)}
                  type="button"
                >
                  <span className={styles.cronBtnIcon}>{"\u270E"}</span>
                  Custom
                </button>
              </div>
              {customCron && (
                <input className={styles.formInput} value={cron} onChange={(e) => setCron(e.target.value)} placeholder="*/15 * * * *" style={{ marginTop: 6 }} />
              )}
            </div>

            {/* Chain input fields (auto-detected from YAML) */}
            {inputFields.length > 0 && (
              <div className={styles.formRow}>
                <label className={styles.formLabel}>Chain Inputs ({inputFields.length})</label>
                {inputFields.map((f, i) => (
                  <div key={i} className={styles.inputFieldRow}>
                    <span className={styles.inputFieldKey}>{f.key}</span>
                    <input className={styles.formInput} value={f.value} onChange={(e) => {
                      const updated = [...inputFields]; updated[i] = { ...f, value: e.target.value }; setInputFields(updated);
                    }} placeholder={`Value for ${f.key}`} style={{ flex: 1 }} />
                  </div>
                ))}
              </div>
            )}

            <div className={styles.formActions}>
              <button className={styles.rowBtn} onClick={resetForm}>Cancel</button>
              <button className={`${styles.rowBtn} ${styles.rowBtnPrimary}`} onClick={handleSave} disabled={!chainName || !cron}>
                {editingId ? "Save" : "Create Schedule"}
              </button>
            </div>
          </div>
        )}

        {!adding && (
          <div className={styles.row}>
            <div className={styles.rowBody} />
            <button className={`${styles.rowBtn} ${styles.rowBtnPrimary}`} onClick={() => { resetForm(); setAdding(true); }}>+ New Schedule</button>
          </div>
        )}
      </div>

      {/* Schedule Lists */}
      <ItemListManager
        storageKey="occ-schedule-lists"
        allItemIds={schedules.map((s) => s.id)}
        label="Schedule Presets"
        description="Group schedules into switchable presets"
        itemLabel={(id) => {
          const s = schedules.find((sc) => sc.id === id);
          return s ? (s.label || s.chainName) : id;
        }}
      />
    </CollapsibleSection>
  );
}
