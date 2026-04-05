import { useState, useEffect, useCallback, useRef } from "react";
import { useServerStore } from "../../stores/server";
import { fetchChainJson } from "../../api/chains";
import { fetchPipelineJson } from "../../api/pipelines";
import { executeChain } from "../../api/executions";
import { executePipeline } from "../../api/pipelines";
import { api } from "../../api/client";
import { ModalOverlay } from "./ModalOverlay";
import styles from "./Modal.module.css";

interface InputDef {
  name: string;
  description: string;
  optional: boolean;
}

interface RunModalProps {
  name: string;
  type: "chain" | "pipeline";
  onClose: () => void;
  onExecuted?: (executionId: string) => void;
}

/** Detect which input widget to render based on input description */
function inferInputType(inp: InputDef): "file" | "url" | "textarea-short" | "textarea" | "text" {
  const desc = (inp.description ?? "").toLowerCase();
  if (desc.includes("path") || desc.includes("file") || desc.includes("pdf") || desc.includes("image"))
    return "file";
  if (desc.includes("url") || desc.includes("website") || desc.includes("site"))
    return "url";
  if (desc.includes("comma") || desc.includes("list"))
    return "textarea-short";
  if (["prompt", "description", "content", "text"].includes(inp.name))
    return "textarea";
  return "text";
}

export function RunModal({ name, type, onClose, onExecuted }: RunModalProps) {
  const { occServerUrl } = useServerStore();
  const [inputs, setInputs] = useState<InputDef[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Set<string>>(new Set());
  const [executing, setExecuting] = useState(false);
  const [execError, setExecError] = useState("");
  const [dryRunning, setDryRunning] = useState(false);
  const [dryResult, setDryResult] = useState<string | null>(null);
  const firstInputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  // Fetch input definitions
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let data: { inputs?: { name: string; description?: string; optional?: boolean }[] };
        if (type === "pipeline") {
          data = await fetchPipelineJson(name);
        } else {
          data = await fetchChainJson(name, occServerUrl);
        }
        if (cancelled) return;
        const defs = (data.inputs ?? []).map((inp) => ({
          name: inp.name,
          description: inp.description ?? "",
          optional: !!inp.optional,
        }));
        setInputs(defs);
        const v: Record<string, string> = {};
        for (const inp of defs) v[inp.name] = "";
        setValues(v);
      } catch {
        /* no inputs */
      }
    })();
    return () => { cancelled = true; };
  }, [name, type, occServerUrl]);

  // Auto-focus first input
  useEffect(() => {
    const timer = setTimeout(() => firstInputRef.current?.focus(), 100);
    return () => clearTimeout(timer);
  }, [inputs]);

  const setValue = useCallback((key: string, val: string) => {
    setValues((prev) => ({ ...prev, [key]: val }));
    setErrors((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, []);

  // File upload handler
  const handleFile = useCallback(
    (inputName: string, file: File) => {
      if (
        file.type.startsWith("text/") ||
        /\.(md|yaml|json|csv|txt)$/i.test(file.name)
      ) {
        const reader = new FileReader();
        reader.onload = () => setValue(inputName, reader.result as string);
        reader.readAsText(file);
      } else {
        setValue(inputName, file.name);
      }
    },
    [setValue],
  );

  // Validate and collect
  const collectInputs = useCallback((): Record<string, string> | null => {
    const result: Record<string, string> = {};
    const missing = new Set<string>();
    for (const inp of inputs) {
      const val = (values[inp.name] ?? "").trim();
      if (val) result[inp.name] = val;
      else if (!inp.optional) missing.add(inp.name);
    }
    if (missing.size > 0) {
      setErrors(missing);
      return null;
    }
    return result;
  }, [inputs, values]);

  // Execute
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

  // Dry-run
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

  // Enter on last input → execute
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

          {inputs.map((inp, i) => {
            const inputType = inferInputType(inp);
            const isLast = i === inputs.length - 1;
            const hasError = errors.has(inp.name);
            const ref = i === 0 ? firstInputRef : undefined;

            return (
              <div key={inp.name} className={styles.field}>
                <label className={styles.fieldLabel}>
                  {inp.name}{" "}
                  {inp.optional ? (
                    <span className={styles.optional}>(optional)</span>
                  ) : (
                    <span className={styles.required}>*</span>
                  )}
                </label>
                {inp.description && (
                  <div className={styles.fieldDesc}>{inp.description}</div>
                )}

                {inputType === "file" ? (
                  <div className={styles.fileRow}>
                    <input
                      ref={ref as React.Ref<HTMLInputElement>}
                      className={`${styles.input} ${hasError ? styles.inputError : ""}`}
                      style={{ flex: 1 }}
                      value={values[inp.name] ?? ""}
                      onChange={(e) => setValue(inp.name, e.target.value)}
                      onKeyDown={(e) => handleKeyDown(e, isLast)}
                      placeholder={inp.description?.slice(0, 50) ?? inp.name}
                    />
                    <label className={styles.fileBtn}>
                      File
                      <input
                        type="file"
                        style={{ display: "none" }}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) handleFile(inp.name, f);
                        }}
                      />
                    </label>
                  </div>
                ) : inputType === "url" ? (
                  <input
                    ref={ref as React.Ref<HTMLInputElement>}
                    type="url"
                    className={`${styles.input} ${hasError ? styles.inputError : ""}`}
                    value={values[inp.name] ?? ""}
                    onChange={(e) => setValue(inp.name, e.target.value)}
                    onKeyDown={(e) => handleKeyDown(e, isLast)}
                    placeholder="https://..."
                  />
                ) : inputType === "textarea" || inputType === "textarea-short" ? (
                  <textarea
                    ref={ref as React.Ref<HTMLTextAreaElement>}
                    className={`${styles.textarea} ${hasError ? styles.inputError : ""}`}
                    rows={inputType === "textarea" ? 4 : 2}
                    value={values[inp.name] ?? ""}
                    onChange={(e) => setValue(inp.name, e.target.value)}
                    placeholder={inp.description?.slice(0, 60) ?? inp.name}
                  />
                ) : (
                  <input
                    ref={ref as React.Ref<HTMLInputElement>}
                    className={`${styles.input} ${hasError ? styles.inputError : ""}`}
                    value={values[inp.name] ?? ""}
                    onChange={(e) => setValue(inp.name, e.target.value)}
                    onKeyDown={(e) => handleKeyDown(e, isLast)}
                    placeholder={inp.description?.slice(0, 60) ?? inp.name}
                  />
                )}
              </div>
            );
          })}

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
