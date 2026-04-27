import { useState, useEffect, useCallback, useRef } from "react";
import { useServerStore } from "../../stores/server";
import { fetchChainJson } from "../../api/chains";
import { fetchPipelineJson } from "../../api/pipelines";
import { executeChain } from "../../api/executions";
import { executePipeline } from "../../api/pipelines";
import { api } from "../../api/client";
import { ModalOverlay } from "./ModalOverlay";
import type { ChainInput, ChainInputType } from "../../types/chain";
import styles from "./Modal.module.css";

interface RunModalProps {
  name: string;
  type: "chain" | "pipeline";
  onClose: () => void;
  onExecuted?: (executionId: string) => void;
}

/** Infer input widget type from explicit type or description heuristics */
function resolveInputType(inp: ChainInput): ChainInputType {
  if (inp.type) return inp.type;
  // Heuristic fallback for chains without explicit types
  const desc = (inp.description ?? "").toLowerCase();
  const nm = inp.name.toLowerCase();
  if (desc.includes("image") || nm.includes("image") || desc.includes(".png") || desc.includes(".jpg")) return "image";
  if (desc.includes("file") || desc.includes("pdf") || nm.includes("file") || nm.includes("path")) return "file";
  if (desc.includes("url") || desc.includes("website") || nm.includes("url")) return "url";
  if (inp.enum && inp.enum.length > 0) return "enum";
  if (nm === "depth" || nm === "count" || nm === "limit" || desc.includes("number")) return "number";
  if (nm === "enabled" || nm === "verbose" || desc.includes("true/false") || desc.includes("boolean")) return "boolean";
  if (["prompt", "description", "content", "text", "body"].includes(nm) || desc.includes("long text")) return "text";
  if (desc.includes("comma") || desc.includes("list")) return "text";
  if (desc.includes("json")) return "json";
  return "string";
}

/** Format file size for display */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function RunModal({ name, type, onClose, onExecuted }: RunModalProps) {
  const { occServerUrl } = useServerStore();
  const [inputs, setInputs] = useState<ChainInput[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [executing, setExecuting] = useState(false);
  const [execError, setExecError] = useState("");
  const [dryRunning, setDryRunning] = useState(false);
  const [dryResult, setDryResult] = useState<string | null>(null);
  const [imagePreviews, setImagePreviews] = useState<Record<string, string>>({});
  const firstInputRef = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(null);

  // Fetch input definitions
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let data: { inputs?: ChainInput[] };
        if (type === "pipeline") {
          data = await fetchPipelineJson(name);
        } else {
          data = await fetchChainJson(name, occServerUrl);
        }
        if (cancelled) return;
        const defs = (data.inputs ?? []).map((inp) => ({
          ...inp,
          optional: !!inp.optional,
        }));
        setInputs(defs);
        // Initialize with defaults
        const v: Record<string, string> = {};
        for (const inp of defs) v[inp.name] = inp.default ?? "";
        setValues(v);
      } catch { /* no inputs */ }
    })();
    return () => { cancelled = true; };
  }, [name, type, occServerUrl]);

  useEffect(() => {
    const timer = setTimeout(() => firstInputRef.current?.focus(), 100);
    return () => clearTimeout(timer);
  }, [inputs]);

  const setValue = useCallback((key: string, val: string) => {
    setValues((prev) => ({ ...prev, [key]: val }));
    setErrors((prev) => { const n = { ...prev }; delete n[key]; return n; });
  }, []);

  // File/image upload handler
  const handleFile = useCallback(
    (inputName: string, file: File, inputDef: ChainInput) => {
      const maxSize = inputDef.max_file_size ?? 10 * 1024 * 1024; // 10MB default
      if (file.size > maxSize) {
        setErrors(prev => ({ ...prev, [inputName]: `File too large (${formatSize(file.size)}, max ${formatSize(maxSize)})` }));
        return;
      }
      // Check accepts
      if (inputDef.accepts && inputDef.accepts.length > 0) {
        const valid = inputDef.accepts.some(a => {
          if (a.includes("*")) return file.type.startsWith(a.replace("*", ""));
          if (a.startsWith(".")) return file.name.toLowerCase().endsWith(a.toLowerCase());
          return file.type === a;
        });
        if (!valid) {
          setErrors(prev => ({ ...prev, [inputName]: `Invalid file type. Accepted: ${inputDef.accepts!.join(", ")}` }));
          return;
        }
      }

      const itype = resolveInputType(inputDef);

      // Image: create preview + base64 or path
      if (itype === "image" || file.type.startsWith("image/")) {
        const previewUrl = URL.createObjectURL(file);
        setImagePreviews(prev => ({ ...prev, [inputName]: previewUrl }));
        // Read as base64 data URI for injection into chains
        const reader = new FileReader();
        reader.onload = () => setValue(inputName, reader.result as string);
        reader.readAsDataURL(file);
        return;
      }

      // Text files: read content
      if (file.type.startsWith("text/") || /\.(md|yaml|yml|json|csv|txt|html|xml|js|ts|py|sh)$/i.test(file.name)) {
        const reader = new FileReader();
        reader.onload = () => setValue(inputName, reader.result as string);
        reader.readAsText(file);
      } else {
        // Binary: store file path/name
        setValue(inputName, file.name);
      }
    },
    [setValue],
  );

  // Validate all inputs
  const collectInputs = useCallback((): Record<string, string> | null => {
    const result: Record<string, string> = {};
    const newErrors: Record<string, string> = {};

    for (const inp of inputs) {
      const val = (values[inp.name] ?? "").trim();
      const itype = resolveInputType(inp);

      // Apply default
      const effective = val || inp.default || "";

      if (effective) result[inp.name] = effective;

      // Required check
      if (!inp.optional && !effective) {
        newErrors[inp.name] = "Required";
        continue;
      }
      if (!effective) continue;

      // Type validation
      if (itype === "number" && isNaN(Number(effective))) {
        newErrors[inp.name] = "Must be a number";
      } else if (itype === "number" && inp.min != null && Number(effective) < inp.min) {
        newErrors[inp.name] = `Min: ${inp.min}`;
      } else if (itype === "number" && inp.max != null && Number(effective) > inp.max) {
        newErrors[inp.name] = `Max: ${inp.max}`;
      } else if (itype === "url" && !/^https?:\/\/.+/.test(effective)) {
        newErrors[inp.name] = "Must be a valid URL";
      } else if (itype === "enum" && inp.enum && !inp.enum.includes(effective)) {
        newErrors[inp.name] = `Must be one of: ${inp.enum.join(", ")}`;
      } else if (inp.pattern && !new RegExp(inp.pattern).test(effective)) {
        newErrors[inp.name] = `Does not match pattern`;
      } else if (inp.min_length != null && effective.length < inp.min_length) {
        newErrors[inp.name] = `Min ${inp.min_length} characters`;
      } else if (inp.max_length != null && effective.length > inp.max_length) {
        newErrors[inp.name] = `Max ${inp.max_length} characters`;
      } else if (itype === "json") {
        try { JSON.parse(effective); } catch { newErrors[inp.name] = "Invalid JSON"; }
      }
    }

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return null;
    }
    return result;
  }, [inputs, values]);

  const handleExecute = useCallback(async () => {
    const inp = collectInputs();
    if (!inp) return;
    setExecuting(true);
    setExecError("");
    try {
      let execId: string;
      if (type === "pipeline") {
        const res = await executePipeline(name, inp);
        execId = res.executionId;
      } else {
        const res = await executeChain(name, inp);
        execId = res.executionId;
      }
      onExecuted?.(execId);
      onClose();
    } catch (err) {
      setExecError(err instanceof Error ? err.message : "Execution failed");
      setExecuting(false);
    }
  }, [collectInputs, name, type, onClose, onExecuted]);

  const handleDryRun = useCallback(async () => {
    const inp = collectInputs();
    if (!inp) return;
    setDryRunning(true);
    setDryResult(null);
    try {
      const data = await api.post(`/dry-run/${encodeURIComponent(name)}`, { input: inp }, AbortSignal.timeout(10000));
      setDryResult(JSON.stringify(data, null, 2));
    } catch {
      setDryResult("Error: could not reach server");
    }
    setDryRunning(false);
  }, [collectInputs, name]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, isLast: boolean) => {
      if (isLast && e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleExecute();
      }
    },
    [handleExecute],
  );

  const requiredCount = inputs.filter((i) => !i.optional).length;

  // ── Render input widget based on type ────────────────────────────────────

  const renderInput = (inp: ChainInput, index: number) => {
    const itype = resolveInputType(inp);
    const isLast = index === inputs.length - 1;
    const hasError = !!errors[inp.name];
    const errorMsg = errors[inp.name];
    const ref = index === 0 ? firstInputRef : undefined;
    const placeholder = inp.placeholder ?? inp.description?.slice(0, 60) ?? inp.name;
    const val = values[inp.name] ?? "";

    switch (itype) {
      // ── Enum: dropdown select ──
      case "enum":
        return (
          <>
            <select
              ref={ref as React.Ref<HTMLSelectElement>}
              className={`${styles.input} ${hasError ? styles.inputError : ""}`}
              value={val}
              onChange={(e) => setValue(inp.name, e.target.value)}
              style={{ cursor: "pointer" }}
            >
              <option value="">Select...</option>
              {(inp.enum ?? []).map((opt) => (
                <option key={opt} value={opt}>
                  {inp.enum_labels?.[opt] ?? opt}
                </option>
              ))}
            </select>
            {errorMsg && <div className={styles.fieldError}>{errorMsg}</div>}
          </>
        );

      // ── Boolean: toggle switch ──
      case "boolean":
        return (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              type="button"
              onClick={() => setValue(inp.name, val === "true" ? "false" : "true")}
              style={{
                width: 40, height: 22, borderRadius: 11, border: "none", cursor: "pointer",
                background: val === "true" ? "var(--c-success)" : "var(--m-border)",
                position: "relative", transition: "background 0.2s",
              }}
            >
              <div style={{
                width: 18, height: 18, borderRadius: 9, background: "#fff",
                position: "absolute", top: 2,
                left: val === "true" ? 20 : 2,
                transition: "left 0.2s",
              }} />
            </button>
            <span style={{ fontSize: 11, color: "var(--m-text2)" }}>{val === "true" ? "Yes" : "No"}</span>
          </div>
        );

      // ── Number: numeric input with min/max ──
      case "number":
        return (
          <>
            <input
              ref={ref as React.Ref<HTMLInputElement>}
              type="number"
              className={`${styles.input} ${hasError ? styles.inputError : ""}`}
              value={val}
              onChange={(e) => setValue(inp.name, e.target.value)}
              onKeyDown={(e) => handleKeyDown(e, isLast)}
              placeholder={placeholder}
              min={inp.min}
              max={inp.max}
              step="any"
              style={{ width: 140 }}
            />
            {(inp.min != null || inp.max != null) && (
              <span style={{ fontSize: 9, color: "var(--m-text2)", marginTop: 2 }}>
                {inp.min != null && `Min: ${inp.min}`}{inp.min != null && inp.max != null && " · "}{inp.max != null && `Max: ${inp.max}`}
              </span>
            )}
            {errorMsg && <div className={styles.fieldError}>{errorMsg}</div>}
          </>
        );

      // ── URL: url input with validation ──
      case "url":
        return (
          <>
            <input
              ref={ref as React.Ref<HTMLInputElement>}
              type="url"
              className={`${styles.input} ${hasError ? styles.inputError : ""}`}
              value={val}
              onChange={(e) => setValue(inp.name, e.target.value)}
              onKeyDown={(e) => handleKeyDown(e, isLast)}
              placeholder={placeholder || "https://..."}
            />
            {errorMsg && <div className={styles.fieldError}>{errorMsg}</div>}
          </>
        );

      // ── Image: file picker with preview ──
      case "image":
        return (
          <>
            <div className={styles.fileRow}>
              <input
                ref={ref as React.Ref<HTMLInputElement>}
                className={`${styles.input} ${hasError ? styles.inputError : ""}`}
                style={{ flex: 1 }}
                value={val.startsWith("data:") ? "(image loaded)" : val}
                onChange={(e) => setValue(inp.name, e.target.value)}
                onKeyDown={(e) => handleKeyDown(e, isLast)}
                placeholder={placeholder || "Select an image..."}
                readOnly={val.startsWith("data:")}
              />
              <label className={styles.fileBtn}>
                Browse
                <input
                  type="file"
                  accept={inp.accepts?.join(",") || "image/png,image/jpeg,image/webp,image/gif"}
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleFile(inp.name, f, inp);
                  }}
                />
              </label>
            </div>
            {imagePreviews[inp.name] && (
              <div style={{ marginTop: 6 }}>
                <img
                  src={imagePreviews[inp.name]}
                  alt="Preview"
                  style={{ maxWidth: 200, maxHeight: 140, borderRadius: 6, border: "1px solid var(--m-border)" }}
                />
                <button
                  type="button"
                  onClick={() => {
                    URL.revokeObjectURL(imagePreviews[inp.name]);
                    setImagePreviews(prev => { const n = { ...prev }; delete n[inp.name]; return n; });
                    setValue(inp.name, "");
                  }}
                  style={{ marginLeft: 8, fontSize: 10, color: "var(--c-error)", background: "none", border: "none", cursor: "pointer" }}
                >
                  Remove
                </button>
              </div>
            )}
            {errorMsg && <div className={styles.fieldError}>{errorMsg}</div>}
          </>
        );

      // ── File: file picker ──
      case "file":
        return (
          <>
            <div className={styles.fileRow}>
              <input
                ref={ref as React.Ref<HTMLInputElement>}
                className={`${styles.input} ${hasError ? styles.inputError : ""}`}
                style={{ flex: 1 }}
                value={val}
                onChange={(e) => setValue(inp.name, e.target.value)}
                onKeyDown={(e) => handleKeyDown(e, isLast)}
                placeholder={placeholder || "Select a file or enter path..."}
              />
              <label className={styles.fileBtn}>
                Browse
                <input
                  type="file"
                  accept={inp.accepts?.join(",") || undefined}
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleFile(inp.name, f, inp);
                  }}
                />
              </label>
            </div>
            {inp.accepts && (
              <span style={{ fontSize: 9, color: "var(--m-text2)", marginTop: 2 }}>
                Accepted: {inp.accepts.join(", ")}
                {inp.max_file_size && ` · Max: ${formatSize(inp.max_file_size)}`}
              </span>
            )}
            {errorMsg && <div className={styles.fieldError}>{errorMsg}</div>}
          </>
        );

      // ── JSON: textarea with validation ──
      case "json":
        return (
          <>
            <textarea
              ref={ref as React.Ref<HTMLTextAreaElement>}
              className={`${styles.textarea} ${hasError ? styles.inputError : ""}`}
              rows={4}
              value={val}
              onChange={(e) => setValue(inp.name, e.target.value)}
              placeholder={placeholder || '{"key": "value"}'}
              style={{ fontFamily: "var(--m-font-mono)", fontSize: 11 }}
            />
            {errorMsg && <div className={styles.fieldError}>{errorMsg}</div>}
          </>
        );

      // ── Text: multi-line textarea ──
      case "text":
        return (
          <>
            <textarea
              ref={ref as React.Ref<HTMLTextAreaElement>}
              className={`${styles.textarea} ${hasError ? styles.inputError : ""}`}
              rows={4}
              value={val}
              onChange={(e) => setValue(inp.name, e.target.value)}
              placeholder={placeholder}
              maxLength={inp.max_length}
            />
            {inp.max_length && (
              <span style={{ fontSize: 9, color: val.length > (inp.max_length * 0.9) ? "var(--c-error)" : "var(--m-text2)", marginTop: 2 }}>
                {val.length}/{inp.max_length}
              </span>
            )}
            {errorMsg && <div className={styles.fieldError}>{errorMsg}</div>}
          </>
        );

      // ── String: default text input ──
      default:
        return (
          <>
            <input
              ref={ref as React.Ref<HTMLInputElement>}
              className={`${styles.input} ${hasError ? styles.inputError : ""}`}
              value={val}
              onChange={(e) => setValue(inp.name, e.target.value)}
              onKeyDown={(e) => handleKeyDown(e, isLast)}
              placeholder={placeholder}
              maxLength={inp.max_length}
            />
            {inp.max_length && val.length > inp.max_length * 0.8 && (
              <span style={{ fontSize: 9, color: "var(--m-text2)", marginTop: 2 }}>
                {val.length}/{inp.max_length}
              </span>
            )}
            {errorMsg && <div className={styles.fieldError}>{errorMsg}</div>}
          </>
        );
    }
  };

  return (
    <ModalOverlay onClose={onClose}>
      <div className={`${styles.modal} ${styles.modalWide}`}>
        {/* Header */}
        <div className={styles.header}>
          <h3 className={styles.headerTitle}>
            <span className={styles.badge}>
              {type === "pipeline" ? "PIP" : "RUN"}
            </span>
            {name}
          </h3>
          <button className={styles.closeBtn} onClick={onClose}>
            &times;
          </button>
        </div>

        {/* Body */}
        <div className={styles.body}>
          {inputs.length === 0 && (
            <div className={styles.noInputs}>
              No inputs required — chain will run with defaults.
            </div>
          )}

          {inputs.map((inp, i) => (
            <div key={inp.name} className={styles.field}>
              <label className={styles.fieldLabel}>
                {inp.name}{" "}
                {inp.optional ? (
                  <span className={styles.optional}>(optional)</span>
                ) : (
                  <span className={styles.required}>*</span>
                )}
                {inp.type && inp.type !== "string" && (
                  <span style={{ fontSize: 9, color: "var(--m-text2)", marginLeft: 4, fontWeight: 400 }}>
                    [{inp.type}]
                  </span>
                )}
              </label>
              {inp.description && (
                <div className={styles.fieldDesc}>{inp.description}</div>
              )}

              {renderInput(inp, i)}

              {inp.examples && inp.examples.length > 0 && (
                <div style={{ fontSize: 9, color: "var(--m-text2)", marginTop: 3 }}>
                  Examples:{" "}
                  {inp.examples.map((ex, j) => (
                    <button
                      key={j}
                      type="button"
                      onClick={() => setValue(inp.name, ex)}
                      style={{
                        background: "var(--glass-tint)", border: "1px solid var(--m-border)",
                        borderRadius: 4, padding: "1px 6px", fontSize: 9, cursor: "pointer",
                        color: "var(--m-accent)", marginLeft: j > 0 ? 4 : 0,
                      }}
                    >
                      {ex.length > 30 ? ex.slice(0, 30) + "..." : ex}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}

          {dryResult !== null && (
            <div className={styles.dryRunResult}>{dryResult}</div>
          )}
        </div>

        {/* Footer */}
        <div className={styles.footer}>
          <span className={styles.footerInfo}>
            {execError ? (
              <span style={{ color: "var(--c-error)" }}>{execError}</span>
            ) : (
              `${requiredCount} required input${requiredCount !== 1 ? "s" : ""}`
            )}
          </span>
          <button
            className={styles.btn}
            onClick={handleDryRun}
            disabled={dryRunning}
          >
            {dryRunning ? "Running..." : "Dry-run"}
          </button>
          <button
            className={`${styles.btn} ${styles.btnPrimary}`}
            onClick={handleExecute}
            disabled={executing}
          >
            {executing ? "Starting..." : "\u25B6 Execute"}
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}
