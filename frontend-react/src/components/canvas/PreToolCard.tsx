import { useState, useCallback } from "react";
import { PRETOOL_FIELDS, type PretoolFieldDef } from "./pretoolFields";
import modalStyles from "../modals/Modal.module.css";

export interface PreToolData {
  tool: string;
  inject_as: string;
  timeout_ms?: number;
  on_error?: string;
  retry?: number;
  [key: string]: unknown;
}

interface PreToolCardProps {
  data: PreToolData;
  index: number;
  onChange: (index: number, data: PreToolData) => void;
  onRemove: (index: number) => void;
}

export function PreToolCard({ data, index, onChange, onRemove }: PreToolCardProps) {
  const [expanded, setExpanded] = useState(false);
  const fields = PRETOOL_FIELDS[data.tool] ?? [];

  const updateField = useCallback(
    (key: string, value: unknown) => {
      onChange(index, { ...data, [key]: value });
    },
    [index, data, onChange],
  );

  const renderField = (f: PretoolFieldDef) => {
    const val = data[f.k] ?? "";

    if (f.type === "select") {
      return (
        <div key={f.k} className={modalStyles.field}>
          <label className={modalStyles.fieldLabel} style={{ fontSize: 9 }}>{f.l}</label>
          <select
            className={modalStyles.select}
            style={{ fontSize: 11, padding: "4px 6px" }}
            value={String(val)}
            onChange={(e) => updateField(f.k, e.target.value)}
          >
            {(f.opts ?? []).map((o) => (
              <option key={o} value={o}>{o}</option>
            ))}
          </select>
        </div>
      );
    }

    if (f.type === "bool") {
      return (
        <label
          key={f.k}
          style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--m-text2)" }}
        >
          <input
            type="checkbox"
            checked={!!val}
            onChange={(e) => updateField(f.k, e.target.checked)}
          />
          {f.l}
        </label>
      );
    }

    if (f.type === "textarea") {
      return (
        <div key={f.k} className={modalStyles.field}>
          <label className={modalStyles.fieldLabel} style={{ fontSize: 9 }}>{f.l}</label>
          <textarea
            className={modalStyles.textarea}
            style={{ fontSize: 11, padding: "4px 6px", minHeight: 40 }}
            rows={2}
            value={typeof val === "object" ? JSON.stringify(val) : String(val)}
            onChange={(e) => updateField(f.k, e.target.value)}
          />
        </div>
      );
    }

    if (f.type === "num") {
      return (
        <div key={f.k} className={modalStyles.field}>
          <label className={modalStyles.fieldLabel} style={{ fontSize: 9 }}>{f.l}</label>
          <input
            className={modalStyles.input}
            type="number"
            style={{ fontSize: 11, padding: "4px 6px" }}
            value={String(val)}
            onChange={(e) => updateField(f.k, parseFloat(e.target.value) || 0)}
          />
        </div>
      );
    }

    // Default: text input
    return (
      <div key={f.k} className={modalStyles.field}>
        <label className={modalStyles.fieldLabel} style={{ fontSize: 9 }}>{f.l}</label>
        <input
          className={modalStyles.input}
          type="text"
          style={{ fontSize: 11, padding: "4px 6px" }}
          value={typeof val === "object" ? JSON.stringify(val) : String(val)}
          onChange={(e) => updateField(f.k, e.target.value)}
        />
      </div>
    );
  };

  return (
    <div
      style={{
        background: "rgba(255,255,255,0.03)",
        border: "1px solid var(--m-border)",
        borderLeft: "3px solid var(--c-orange)",
        borderRadius: 8,
        marginBottom: 6,
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "6px 10px",
          cursor: "pointer",
        }}
        onClick={() => setExpanded((v) => !v)}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--c-orange)" }}>
            {data.tool}
          </span>
          <span style={{ fontSize: 10, color: "var(--m-text2)" }}>
            {"\u2192"} {"{" + (data.inject_as || "?") + "}"}
          </span>
        </div>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <span style={{ fontSize: 10, color: "var(--m-text2)" }}>{fields.length} params</span>
          <span
            style={{ cursor: "pointer", color: "var(--m-text2)", fontSize: 14 }}
            onClick={(e) => { e.stopPropagation(); onRemove(index); }}
          >
            &times;
          </span>
        </div>
      </div>

      {/* Body (expandable) */}
      {expanded && (
        <div style={{ padding: "0 10px 8px", display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            <div className={modalStyles.field}>
              <label className={modalStyles.fieldLabel} style={{ fontSize: 9 }}>inject_as</label>
              <input
                className={modalStyles.input}
                type="text"
                style={{ fontSize: 11, padding: "4px 6px" }}
                value={data.inject_as ?? ""}
                onChange={(e) => updateField("inject_as", e.target.value)}
              />
            </div>
            <div className={modalStyles.field}>
              <label className={modalStyles.fieldLabel} style={{ fontSize: 9 }}>timeout_ms</label>
              <input
                className={modalStyles.input}
                type="number"
                style={{ fontSize: 11, padding: "4px 6px" }}
                value={data.timeout_ms ?? ""}
                placeholder="30000"
                onChange={(e) => updateField("timeout_ms", parseInt(e.target.value) || undefined)}
              />
            </div>
          </div>

          {fields.map(renderField)}

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            <div className={modalStyles.field}>
              <label className={modalStyles.fieldLabel} style={{ fontSize: 9 }}>on_error</label>
              <select
                className={modalStyles.select}
                style={{ fontSize: 11, padding: "4px 6px" }}
                value={data.on_error ?? "inject"}
                onChange={(e) => updateField("on_error", e.target.value)}
              >
                <option value="inject">inject</option>
                <option value="skip">skip</option>
                <option value="fail">fail</option>
              </select>
            </div>
            <div className={modalStyles.field}>
              <label className={modalStyles.fieldLabel} style={{ fontSize: 9 }}>retry</label>
              <input
                className={modalStyles.input}
                type="number"
                style={{ fontSize: 11, padding: "4px 6px" }}
                value={data.retry ?? ""}
                placeholder="0"
                onChange={(e) => updateField("retry", parseInt(e.target.value) || 0)}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
