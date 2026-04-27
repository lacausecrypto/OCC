import { useState, useCallback, useEffect } from "react";
import { useCanvasStore } from "../../stores/canvas";
import { ModalOverlay } from "../modals/ModalOverlay";
import { PreToolCard, type PreToolData } from "./PreToolCard";
import { preToolsToData } from "./preToolsToData";
import {
  STEP_TYPES,
  MODELS as DEFAULT_MODELS,
  TOOL_LIST,
  PRETOOL_TYPES,
  getTypeColors,
} from "./pretoolFields";
import type { CanvasNode, StepAdvancedConfig } from "../../types/canvas";
import type { PreTool } from "../../types/chain";
import modalStyles from "../modals/Modal.module.css";

interface StepEditModalProps {
  nodeId: string;
  onClose: () => void;
}

interface ProviderModel {
  provider: string;
  providerName: string;
  model: string;
}

// ─── Collapsible section helper ──────────────────────────────────────────────
function Section({ title, badge, defaultOpen, children }: {
  title: string; badge?: string; defaultOpen?: boolean; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  return (
    <div style={{ border: "1px solid var(--m-border, #333)", borderRadius: 8, marginTop: 8 }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        style={{
          display: "flex", alignItems: "center", gap: 6, width: "100%",
          padding: "8px 12px", background: "rgba(255,255,255,0.03)",
          border: "none", borderRadius: open ? "8px 8px 0 0" : 8,
          cursor: "pointer", color: "var(--m-text)", fontSize: 12, fontWeight: 600,
        }}
      >
        <svg width="10" height="10" viewBox="0 0 10 10"
          style={{ transition: "transform 0.2s", transform: open ? "rotate(90deg)" : "none" }}>
          <polyline points="3,1 7,5 3,9" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
        {title}
        {badge && <span style={{ opacity: 0.5, fontWeight: 400 }}>{badge}</span>}
      </button>
      {open && <div style={{ padding: "8px 12px 12px" }}>{children}</div>}
    </div>
  );
}

// ─── Small inline field helper ───────────────────────────────────────────────
function F({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <label style={{ display: "block", fontSize: 11, color: "var(--m-text2)", marginBottom: 3, fontWeight: 500 }}>
        {label}
      </label>
      {children}
    </div>
  );
}

const miniInput: React.CSSProperties = {
  width: "100%", padding: "5px 8px", fontSize: 12,
  background: "var(--m-bg2, #1a1a1a)", border: "1px solid var(--m-border, #333)",
  borderRadius: 6, color: "var(--m-text)", outline: "none",
};
const miniSelect: React.CSSProperties = { ...miniInput, appearance: "auto" as const };

export function StepEditModal({ nodeId, onClose }: StepEditModalProps) {
  const node = useCanvasStore((s) => s.nodes.get(nodeId));
  const edges = useCanvasStore((s) => s.edges);
  const nodes = useCanvasStore((s) => s.nodes);
  const { updateNode, pushUndo } = useCanvasStore();

  // Dynamic model list from configured providers
  const [allModels, setAllModels] = useState<ProviderModel[]>([]);
  useEffect(() => {
    fetch("/providers/models")
      .then((r) => r.ok ? r.json() : [])
      .then((data) => { if (Array.isArray(data)) setAllModels(data); })
      .catch(() => {});
  }, []);

  // Local edit state — basic
  const [label, setLabel] = useState(node?.label ?? "");
  const [type, setType] = useState(node?.type ?? "agent");
  const [model, setModel] = useState(node?.model ?? "claude-sonnet-4-6");
  const [outputVar, setOutputVar] = useState(node?.outputVar ?? "");
  const [tools, setTools] = useState<string[]>([...(node?.tools ?? [])]);
  const [preTools, setPreTools] = useState<PreToolData[]>(
    preToolsToData(node?.preTools ?? []),
  );
  const [prompt, setPrompt] = useState(node?.prompt ?? "");
  const [promptOpen, setPromptOpen] = useState((node?.prompt ?? "").length > 0);
  const [promptExpanded, setPromptExpanded] = useState(false);

  // Local edit state — advanced config
  const [adv, setAdv] = useState<StepAdvancedConfig>(node?.advanced ?? {});
  const patchAdv = useCallback((patch: Partial<StepAdvancedConfig>) => {
    setAdv((prev) => ({ ...prev, ...patch }));
  }, []);

  // Tool add/remove
  const addTool = useCallback((t: string) => {
    if (t) setTools((prev) => [...prev, t]);
  }, []);

  const removeTool = useCallback((idx: number) => {
    setTools((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  // Pre-tool add/remove/update
  const addPreTool = useCallback((ptType: string) => {
    if (ptType) {
      setPreTools((prev) => [
        ...prev,
        { tool: ptType, inject_as: ptType + "_data" },
      ]);
    }
  }, []);

  const removePreTool = useCallback((idx: number) => {
    setPreTools((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const updatePreTool = useCallback((idx: number, data: PreToolData) => {
    setPreTools((prev) => prev.map((pt, i) => (i === idx ? data : pt)));
  }, []);

  // Save — writes both basic + advanced fields
  const handleSave = useCallback(() => {
    if (!node) return;
    pushUndo();
    // Clean empty values from advanced config (keep 0 — it's a valid numeric value)
    const cleanAdv: StepAdvancedConfig = {};
    for (const [k, v] of Object.entries(adv)) {
      if (v === undefined || v === null || v === "") continue;
      // Keep 0 (valid number), false (valid bool), empty arrays/objects
      if (typeof v === "number" || typeof v === "boolean" || (typeof v === "object" && v !== null)) {
        (cleanAdv as Record<string, unknown>)[k] = v;
      } else {
        (cleanAdv as Record<string, unknown>)[k] = v;
      }
    }
    const patch: Partial<CanvasNode> = {
      label: label || node.label,
      type: type as CanvasNode["type"],
      model,
      outputVar: outputVar || node.outputVar,
      tools: [...tools],
      preTools: preTools.map((pt) => {
        const result: Record<string, unknown> = { ...pt };
        return result as unknown as PreTool;
      }),
      prompt,
      advanced: cleanAdv,
    };
    updateNode(nodeId, patch);
    onClose();
  }, [
    pushUndo, updateNode, nodeId, onClose,
    label, type, model, outputVar, tools, preTools, prompt, node, adv,
  ]);

  // Early return after all hooks
  if (!node) return null;

  // Dependencies (read-only)
  const deps = [...edges.values()]
    .filter((e) => e.to === nodeId)
    .map((e) => {
      const fromNode = nodes.get(e.from);
      return fromNode?.label ?? "?";
    });

  const color = getTypeColors()[type] ?? "#888";

  // ─── Type-specific section renderer ────────────────────────────────────────
  const renderTypeSpecific = () => {
    switch (type) {
      case "gate":
        return (
          <Section title="Gate Configuration" defaultOpen>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <F label="Timeout (hours)">
                <input type="number" style={miniInput} value={adv.timeout_hours ?? ""} min={0}
                  onChange={(e) => patchAdv({ timeout_hours: e.target.value ? Number(e.target.value) : undefined })} />
              </F>
              <F label="On Timeout">
                <select style={miniSelect} value={adv.on_timeout ?? "error"}
                  onChange={(e) => patchAdv({ on_timeout: e.target.value as "skip" | "error" | "approve" })}>
                  <option value="error">Error</option>
                  <option value="skip">Skip</option>
                  <option value="approve">Auto-approve</option>
                </select>
              </F>
            </div>
            <F label="Actions (comma-separated)">
              <input style={miniInput} value={(adv.gate_actions ?? []).join(", ")}
                onChange={(e) => patchAdv({ gate_actions: e.target.value.split(",").map(s => s.trim()).filter(Boolean) })}
                placeholder="approve, reject, escalate" />
            </F>
            <F label="Auto-approve Condition">
              <input style={miniInput} value={adv.gate_auto_approve_if ?? ""}
                onChange={(e) => patchAdv({ gate_auto_approve_if: e.target.value || undefined })}
                placeholder="e.g. {score} > 0.9" />
            </F>
            <F label="Allow Rejection Reason">
              <input type="checkbox" checked={adv.gate_rejection_reason ?? false}
                onChange={(e) => patchAdv({ gate_rejection_reason: e.target.checked })} />
            </F>
          </Section>
        );

      case "router":
        return (
          <Section title="Router Configuration" defaultOpen>
            <F label="Routes (JSON: route_name → [step_ids])">
              <textarea style={{ ...miniInput, minHeight: 60, fontFamily: "var(--m-font-mono)" }}
                value={adv.routes ? JSON.stringify(adv.routes, null, 2) : ""}
                onChange={(e) => { try { patchAdv({ routes: JSON.parse(e.target.value) }); } catch { /* ignore parse errors while typing */ } }}
                placeholder='{"positive": ["step_a"], "negative": ["step_b"]}' />
            </F>
            <F label="Default Route">
              <input style={miniInput} value={adv.default_route ?? ""}
                onChange={(e) => patchAdv({ default_route: e.target.value || undefined })}
                placeholder="fallback route name" />
            </F>
            <F label="Condition">
              <input style={miniInput} value={adv.condition ?? ""}
                onChange={(e) => patchAdv({ condition: e.target.value || undefined })}
                placeholder="e.g. {sentiment}" />
            </F>
          </Section>
        );

      case "evaluator":
        return (
          <Section title="Evaluator Configuration" defaultOpen>
            <F label="Input Variable">
              <input style={miniInput} value={adv.input_var ?? ""}
                onChange={(e) => patchAdv({ input_var: e.target.value || undefined })} placeholder="variable to evaluate" />
            </F>
            <F label="Criteria">
              <textarea style={{ ...miniInput, minHeight: 50 }} value={adv.criteria ?? ""}
                onChange={(e) => patchAdv({ criteria: e.target.value || undefined })}
                placeholder="Evaluation criteria..." />
            </F>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <F label="On Fail">
                <select style={miniSelect} value={adv.on_fail ?? "retry"}
                  onChange={(e) => patchAdv({ on_fail: e.target.value as "retry" | "skip" | "error" })}>
                  <option value="retry">Retry</option><option value="skip">Skip</option><option value="error">Error</option>
                </select>
              </F>
              <F label="Max Retries">
                <input type="number" style={miniInput} value={adv.max_retries ?? ""} min={0} max={10}
                  onChange={(e) => patchAdv({ max_retries: e.target.value ? Number(e.target.value) : undefined })} />
              </F>
            </div>
            <F label="Retry Target Step">
              <input style={miniInput} value={adv.retry_target ?? ""}
                onChange={(e) => patchAdv({ retry_target: e.target.value || undefined })} />
            </F>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <F label="Score-based">
                <input type="checkbox" checked={adv.eval_scoring ?? false}
                  onChange={(e) => patchAdv({ eval_scoring: e.target.checked })} />
              </F>
              <F label="Threshold">
                <input type="number" style={miniInput} value={adv.eval_threshold ?? ""} step={0.1} min={0} max={1}
                  onChange={(e) => patchAdv({ eval_threshold: e.target.value ? Number(e.target.value) : undefined })} />
              </F>
            </div>
          </Section>
        );

      case "transform":
        return (
          <Section title="Transform Configuration" defaultOpen>
            <F label="Operation">
              <select style={miniSelect} value={adv.operation ?? "json_extract"}
                onChange={(e) => patchAdv({ operation: e.target.value })}>
                {["json_extract", "regex_match", "template", "split", "merge", "truncate", "replace", "filter", "map", "join", "to_json", "from_json"].map(op =>
                  <option key={op} value={op}>{op}</option>
                )}
              </select>
            </F>
            <F label="JSON Path">
              <input style={miniInput} value={adv.json_path ?? ""}
                onChange={(e) => patchAdv({ json_path: e.target.value || undefined })} placeholder="$.data.items" />
            </F>
            <F label="Regex">
              <input style={miniInput} value={adv.regex ?? ""}
                onChange={(e) => patchAdv({ regex: e.target.value || undefined })} />
            </F>
            <F label="Template String">
              <textarea style={{ ...miniInput, minHeight: 40 }} value={adv.template_str ?? ""}
                onChange={(e) => patchAdv({ template_str: e.target.value || undefined })}
                placeholder="Result: {extracted}" />
            </F>
            <F label="Truncate Limit">
              <input type="number" style={miniInput} value={adv.truncate_limit ?? ""} min={0}
                onChange={(e) => patchAdv({ truncate_limit: e.target.value ? Number(e.target.value) : undefined })} />
            </F>
          </Section>
        );

      case "loop":
        return (
          <Section title="Loop Configuration" defaultOpen>
            <F label="Items Variable">
              <input style={miniInput} value={adv.items_var ?? ""}
                onChange={(e) => patchAdv({ items_var: e.target.value || undefined })}
                placeholder="variable containing items array" />
            </F>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <F label="Max Parallel">
                <input type="number" style={miniInput} value={adv.max_parallel ?? ""} min={1} max={20}
                  onChange={(e) => patchAdv({ max_parallel: e.target.value ? Number(e.target.value) : undefined })} />
              </F>
              <F label="On Error">
                <select style={miniSelect} value={adv.loop_on_error ?? "abort"}
                  onChange={(e) => patchAdv({ loop_on_error: e.target.value as "continue" | "abort" })}>
                  <option value="abort">Abort</option><option value="continue">Continue</option>
                </select>
              </F>
            </div>
            <F label="Loop Until Condition">
              <input style={miniInput} value={adv.loop_until ?? ""}
                onChange={(e) => patchAdv({ loop_until: e.target.value || undefined })}
                placeholder="e.g. {result} === 'done'" />
            </F>
          </Section>
        );

      case "merge":
        return (
          <Section title="Merge Configuration" defaultOpen>
            <F label="Input Variables (comma-separated)">
              <input style={miniInput} value={(adv.inputs ?? []).join(", ")}
                onChange={(e) => patchAdv({ inputs: e.target.value.split(",").map(s => s.trim()).filter(Boolean) })}
                placeholder="step1_out, step2_out" />
            </F>
            <F label="Strategy">
              <select style={miniSelect} value={adv.strategy ?? "concatenate"}
                onChange={(e) => patchAdv({ strategy: e.target.value as StepAdvancedConfig["strategy"] })}>
                <option value="concatenate">Concatenate</option>
                <option value="json_array">JSON Array</option>
                <option value="llm_summarize">LLM Summarize</option>
                <option value="pick_best">Pick Best</option>
              </select>
            </F>
          </Section>
        );

      case "browser":
        return (
          <Section title="Browser Configuration" defaultOpen>
            <F label="URL">
              <input style={miniInput} value={adv.browser_url ?? ""}
                onChange={(e) => patchAdv({ browser_url: e.target.value || undefined })} placeholder="https://..." />
            </F>
            <F label="Task">
              <textarea style={{ ...miniInput, minHeight: 40 }} value={adv.browser_task ?? ""}
                onChange={(e) => patchAdv({ browser_task: e.target.value || undefined })}
                placeholder="What to do on the page..." />
            </F>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
              <F label="Max Steps">
                <input type="number" style={miniInput} value={adv.browser_max_steps ?? ""} min={1} max={50}
                  onChange={(e) => patchAdv({ browser_max_steps: e.target.value ? Number(e.target.value) : undefined })} />
              </F>
              <F label="Wait (ms)">
                <input type="number" style={miniInput} value={adv.browser_wait_ms ?? ""} min={0}
                  onChange={(e) => patchAdv({ browser_wait_ms: e.target.value ? Number(e.target.value) : undefined })} />
              </F>
              <F label="Output Format">
                <select style={miniSelect} value={adv.browser_output_format ?? "markdown"}
                  onChange={(e) => patchAdv({ browser_output_format: e.target.value as StepAdvancedConfig["browser_output_format"] })}>
                  <option value="text">Text</option><option value="markdown">Markdown</option>
                  <option value="json">JSON</option><option value="screenshot">Screenshot</option>
                </select>
              </F>
            </div>
            <F label="Headless">
              <input type="checkbox" checked={adv.browser_headless !== false}
                onChange={(e) => patchAdv({ browser_headless: e.target.checked })} />
            </F>
          </Section>
        );

      case "subchain":
        return (
          <Section title="Subchain Configuration" defaultOpen>
            <F label="Chain Name">
              <input style={miniInput} value={adv.subchain ?? ""}
                onChange={(e) => patchAdv({ subchain: e.target.value || undefined })}
                placeholder="name of chain to execute" />
            </F>
            <F label="Input Map (JSON: param → variable)">
              <textarea style={{ ...miniInput, minHeight: 50, fontFamily: "var(--m-font-mono)" }}
                value={adv.subchain_input_map ? JSON.stringify(adv.subchain_input_map, null, 2) : ""}
                onChange={(e) => { try { patchAdv({ subchain_input_map: JSON.parse(e.target.value) }); } catch { /* ignore parse errors while typing */ } }}
                placeholder='{"query": "{user_input}"}' />
            </F>
          </Section>
        );

      case "debate":
        return (
          <Section title="Debate Configuration" defaultOpen>
            <F label="Agents (JSON array: [{'{'}prompt, model{'}'}])">
              <textarea style={{ ...miniInput, minHeight: 60, fontFamily: "var(--m-font-mono)" }}
                value={adv.debate_agents ? JSON.stringify(adv.debate_agents, null, 2) : ""}
                onChange={(e) => { try { patchAdv({ debate_agents: JSON.parse(e.target.value) }); } catch { /* ignore parse errors while typing */ } }}
                placeholder='[{"prompt": "Argue for...", "model": "claude-sonnet-4-6"}]' />
            </F>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <F label="Rounds">
                <input type="number" style={miniInput} value={adv.debate_rounds ?? ""} min={1} max={10}
                  onChange={(e) => patchAdv({ debate_rounds: e.target.value ? Number(e.target.value) : undefined })} />
              </F>
              <F label="Decision Method">
                <select style={miniSelect} value={adv.debate_decision ?? "voting"}
                  onChange={(e) => patchAdv({ debate_decision: e.target.value as StepAdvancedConfig["debate_decision"] })}>
                  <option value="voting">Voting</option>
                  <option value="consensus">Consensus</option>
                  <option value="last_round">Last Round</option>
                </select>
              </F>
            </div>
          </Section>
        );

      case "webhook":
        return (
          <Section title="Webhook Configuration" defaultOpen>
            <F label="URL">
              <input style={miniInput} value={adv.webhook_url ?? ""}
                onChange={(e) => patchAdv({ webhook_url: e.target.value || undefined })} placeholder="https://..." />
            </F>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <F label="Method">
                <select style={miniSelect} value={adv.webhook_method ?? "POST"}
                  onChange={(e) => patchAdv({ webhook_method: e.target.value as StepAdvancedConfig["webhook_method"] })}>
                  {["POST", "PUT", "PATCH", "GET", "DELETE"].map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </F>
              <F label="Timeout (ms)">
                <input type="number" style={miniInput} value={adv.webhook_timeout_ms ?? ""} min={0}
                  onChange={(e) => patchAdv({ webhook_timeout_ms: e.target.value ? Number(e.target.value) : undefined })} />
              </F>
            </div>
            <F label="Headers (JSON)">
              <textarea style={{ ...miniInput, minHeight: 40, fontFamily: "var(--m-font-mono)" }}
                value={adv.webhook_headers ? JSON.stringify(adv.webhook_headers, null, 2) : ""}
                onChange={(e) => { try { patchAdv({ webhook_headers: JSON.parse(e.target.value) }); } catch { /* ignore parse errors while typing */ } }}
                placeholder='{"Authorization": "Bearer ..."}' />
            </F>
            <F label="Body Template">
              <textarea style={{ ...miniInput, minHeight: 40 }} value={adv.webhook_body ?? ""}
                onChange={(e) => patchAdv({ webhook_body: e.target.value || undefined })}
                placeholder='{"{result}"}' />
            </F>
            <F label="Retry Count">
              <input type="number" style={miniInput} value={adv.webhook_retry ?? ""} min={0} max={5}
                onChange={(e) => patchAdv({ webhook_retry: e.target.value ? Number(e.target.value) : undefined })} />
            </F>
          </Section>
        );

      case "image_gen": {
        // Models grouped by provider — selecting auto-sets image_provider
        const IMG_MODELS: Record<NonNullable<StepAdvancedConfig["image_provider"]>, string[]> = {
          openai: ["dall-e-3", "dall-e-2", "gpt-image-1"],
          huggingface: [
            "black-forest-labs/FLUX.1-schnell",
            "black-forest-labs/FLUX.1-dev",
            "stabilityai/stable-diffusion-3.5-large",
            "stabilityai/stable-diffusion-xl-base-1.0",
            "playgroundai/playground-v2.5-1024px-aesthetic",
          ],
          stability: ["sd3", "sd3-large", "sd3-large-turbo", "core", "ultra"],
        };
        // Sizes per provider (different APIs accept different sizes)
        const IMG_SIZES: Record<NonNullable<StepAdvancedConfig["image_provider"]>, string[]> = {
          openai: ["1024x1024", "1024x1792", "1792x1024", "512x512", "256x256"],
          huggingface: ["1024x1024", "768x768", "512x512"],
          stability: ["1:1", "16:9", "9:16", "3:2", "2:3", "4:5", "5:4", "21:9", "9:21"],
        };

        const provider = adv.image_provider ?? "openai";
        const models = IMG_MODELS[provider];
        const sizes = IMG_SIZES[provider];

        // When provider changes, default-pick the first model for that provider
        const switchProvider = (p: NonNullable<StepAdvancedConfig["image_provider"]>) => {
          patchAdv({
            image_provider: p,
            image_model: IMG_MODELS[p][0],
            image_size: IMG_SIZES[p][0],
          });
        };

        return (
          <Section title="Image Generation" defaultOpen>
            <F label="Prompt">
              <textarea style={{ ...miniInput, minHeight: 60 }}
                value={adv.image_prompt ?? ""}
                onChange={(e) => patchAdv({ image_prompt: e.target.value || undefined })}
                placeholder="A serene landscape with snow-capped mountains, photorealistic..." />
            </F>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 8 }}>
              <F label="Provider">
                <select style={miniSelect} value={provider}
                  onChange={(e) => switchProvider(e.target.value as NonNullable<StepAdvancedConfig["image_provider"]>)}>
                  <option value="openai">OpenAI</option>
                  <option value="huggingface">HuggingFace</option>
                  <option value="stability">Stability AI</option>
                </select>
              </F>
              <F label="Model">
                <select style={miniSelect} value={adv.image_model ?? models[0]}
                  onChange={(e) => patchAdv({ image_model: e.target.value })}>
                  {models.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </F>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
              <F label={provider === "stability" ? "Aspect ratio" : "Size"}>
                <select style={miniSelect} value={adv.image_size ?? sizes[0]}
                  onChange={(e) => patchAdv({ image_size: e.target.value })}>
                  {sizes.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </F>
              <F label="Format">
                <select style={miniSelect} value={adv.image_format ?? "png"}
                  onChange={(e) => patchAdv({ image_format: e.target.value as StepAdvancedConfig["image_format"] })}>
                  <option value="png">png</option>
                  <option value="jpeg">jpeg</option>
                  <option value="webp">webp</option>
                </select>
              </F>
              <F label="Count">
                <input type="number" style={miniInput} value={adv.image_n ?? 1} min={1} max={10}
                  onChange={(e) => patchAdv({ image_n: e.target.value ? Number(e.target.value) : undefined })} />
              </F>
            </div>
            {provider === "openai" && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <F label="Quality">
                  <select style={miniSelect} value={adv.image_quality ?? "standard"}
                    onChange={(e) => patchAdv({ image_quality: e.target.value as StepAdvancedConfig["image_quality"] })}>
                    <option value="standard">standard</option>
                    <option value="hd">hd</option>
                  </select>
                </F>
                <F label="Style">
                  <select style={miniSelect} value={adv.image_style ?? "vivid"}
                    onChange={(e) => patchAdv({ image_style: e.target.value as StepAdvancedConfig["image_style"] })}>
                    <option value="vivid">vivid</option>
                    <option value="natural">natural</option>
                  </select>
                </F>
              </div>
            )}
            {(provider === "huggingface" || provider === "stability") && (
              <F label="Negative prompt">
                <textarea style={{ ...miniInput, minHeight: 40 }}
                  value={adv.negative_prompt ?? ""}
                  onChange={(e) => patchAdv({ negative_prompt: e.target.value || undefined })}
                  placeholder="blurry, low quality, distorted..." />
              </F>
            )}
          </Section>
        );
      }

      default:
        return null;
    }
  };

  return (
    <ModalOverlay onClose={onClose}>
      <div className={modalStyles.modal} style={{
        width: promptExpanded ? "min(90vw, 900px)" : "min(660px, calc(100vw - 32px))",
        maxHeight: promptExpanded ? "95vh" : "88vh",
        transition: "width 0.25s, max-width 0.25s",
      }}>
        {/* Header */}
        <div className={modalStyles.header}>
          <h3 className={modalStyles.headerTitle}>
            Edit Step:{" "}
            <span style={{ color }}>{label || node.label}</span>
          </h3>
          <button className={modalStyles.closeBtn} onClick={onClose}>
            &times;
          </button>
        </div>

        {/* Body */}
        <div className={modalStyles.body}>
          {/* Label + Type row */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div className={modalStyles.field}>
              <label className={modalStyles.fieldLabel}>Label</label>
              <input
                className={modalStyles.input}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
            <div className={modalStyles.field}>
              <label className={modalStyles.fieldLabel}>Type</label>
              <select
                className={modalStyles.select}
                value={type}
                onChange={(e) => setType(e.target.value as CanvasNode["type"])}
              >
                {STEP_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Model + Output Variable row */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div className={modalStyles.field}>
              <label className={modalStyles.fieldLabel}>Model</label>
              <select
                className={modalStyles.select}
                value={model}
                onChange={(e) => setModel(e.target.value)}
              >
                {allModels.length > 0 ? (
                  (() => {
                    const groups = new Map<string, ProviderModel[]>();
                    for (const m of allModels) {
                      const list = groups.get(m.providerName) ?? [];
                      list.push(m);
                      groups.set(m.providerName, list);
                    }
                    return [...groups.entries()].map(([provName, models]) => (
                      <optgroup key={provName} label={provName}>
                        {models.map((m) => (
                          <option key={m.model} value={m.model}>{m.model}</option>
                        ))}
                      </optgroup>
                    ));
                  })()
                ) : (
                  DEFAULT_MODELS.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))
                )}
              </select>
            </div>
            <div className={modalStyles.field}>
              <label className={modalStyles.fieldLabel}>Output Variable</label>
              <input
                className={modalStyles.input}
                value={outputVar}
                onChange={(e) => setOutputVar(e.target.value)}
              />
            </div>
          </div>

          {/* Tools */}
          <div className={modalStyles.field}>
            <label className={modalStyles.fieldLabel}>Tools ({tools.length})</label>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {tools.map((t, i) => (
                <span
                  key={i}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 4,
                    padding: "3px 8px", borderRadius: 6, fontSize: "var(--s-sm)",
                    background: "rgba(10,132,255,0.15)", color: "var(--m-accent)",
                    border: "1px solid rgba(10,132,255,0.2)",
                  }}
                >
                  {t}
                  <span style={{ cursor: "pointer", opacity: 0.6 }} onClick={() => removeTool(i)}>
                    &times;
                  </span>
                </span>
              ))}
            </div>
            <select className={modalStyles.select} value="" onChange={(e) => addTool(e.target.value)}>
              <option value="">+ Add tool...</option>
              {TOOL_LIST.filter((t) => !tools.includes(t)).map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>

          {/* Pre-tools */}
          <div className={modalStyles.field}>
            <label className={modalStyles.fieldLabel}>Pre-tools ({preTools.length})</label>
            {preTools.map((pt, i) => (
              <PreToolCard key={i} data={pt} index={i} onChange={updatePreTool} onRemove={removePreTool} />
            ))}
            <select className={modalStyles.select} value="" onChange={(e) => addPreTool(e.target.value)}>
              <option value="">+ Add pre-tool...</option>
              {PRETOOL_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>

          {/* Prompt (collapsible + expandable) */}
          <div className={modalStyles.field}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <label
                className={modalStyles.fieldLabel}
                style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 6, flex: 1 }}
                onClick={() => { setPromptOpen((v) => !v); setPromptExpanded(false); }}
              >
                <svg width="10" height="10" viewBox="0 0 10 10"
                  style={{ transition: "transform 0.2s", transform: promptOpen ? "rotate(90deg)" : "none" }}>
                  <polyline points="3,1 7,5 3,9" fill="none" stroke="currentColor" strokeWidth="1.5" />
                </svg>
                Prompt
                <span style={{ fontWeight: 400, opacity: 0.5 }}>
                  {prompt.length > 0 ? `${prompt.length} chars` : "empty"}
                </span>
              </label>
              {promptOpen && (
                <button type="button" className={modalStyles.btn}
                  style={{ padding: "3px 10px", fontSize: 10, marginLeft: "auto" }}
                  onClick={() => setPromptExpanded((v) => !v)}>
                  {promptExpanded ? "\u2199 Collapse" : "\u2197 Expand"}
                </button>
              )}
            </div>
            {promptOpen && (
              <textarea className={modalStyles.textarea} rows={promptExpanded ? 20 : 8}
                placeholder="{variable} references..." value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                style={promptExpanded ? { minHeight: "50vh", fontSize: "13px", lineHeight: "1.6" } : undefined} />
            )}
          </div>

          {/* ─── ADVANCED CONFIG ─────────────────────────────────────────── */}
          <Section title="Resilience & Performance"
            badge={[adv.retry?.max, adv.timeout_ms, adv.fallback_models?.length].filter(Boolean).length > 0 ? "configured" : ""}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
              <F label="Retry Max">
                <input type="number" style={miniInput} value={adv.retry?.max ?? ""} min={0} max={10}
                  onChange={(e) => patchAdv({ retry: { ...adv.retry, max: Number(e.target.value) || 0, delay_ms: adv.retry?.delay_ms, backoff: adv.retry?.backoff } })} />
              </F>
              <F label="Retry Delay (ms)">
                <input type="number" style={miniInput} value={adv.retry?.delay_ms ?? ""} min={0}
                  onChange={(e) => patchAdv({ retry: { ...adv.retry, max: adv.retry?.max ?? 0, delay_ms: Number(e.target.value) || undefined, backoff: adv.retry?.backoff } })} />
              </F>
              <F label="Backoff Multiplier">
                <input type="number" style={miniInput} value={adv.retry?.backoff ?? ""} min={1} max={5} step={0.5}
                  onChange={(e) => patchAdv({ retry: { ...adv.retry, max: adv.retry?.max ?? 0, delay_ms: adv.retry?.delay_ms, backoff: Number(e.target.value) || undefined } })} />
              </F>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <F label="Timeout (ms)">
                <input type="number" style={miniInput} value={adv.timeout_ms ?? ""} min={0} step={1000}
                  onChange={(e) => patchAdv({ timeout_ms: e.target.value ? Number(e.target.value) : undefined })}
                  placeholder="30000" />
              </F>
              <F label="Working Directory">
                <input style={miniInput} value={adv.cwd ?? ""}
                  onChange={(e) => patchAdv({ cwd: e.target.value || undefined })}
                  placeholder="/path/to/dir" />
              </F>
            </div>
            <F label="Fallback Models (comma-separated)">
              <input style={miniInput} value={(adv.fallback_models ?? []).join(", ")}
                onChange={(e) => patchAdv({ fallback_models: e.target.value.split(",").map(s => s.trim()).filter(Boolean) })}
                placeholder="claude-haiku-4-5, gpt-4o-mini" />
            </F>
          </Section>

          <Section title="Caching & Output Validation"
            badge={adv.cache?.enabled || adv.output_schema ? "configured" : ""}>
            <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 8, alignItems: "center" }}>
              <F label="Cache Enabled">
                <input type="checkbox" checked={adv.cache?.enabled ?? false}
                  onChange={(e) => patchAdv({ cache: { enabled: e.target.checked, ttl_minutes: adv.cache?.ttl_minutes } })} />
              </F>
              <F label="Cache TTL (min)">
                <input type="number" style={miniInput} value={adv.cache?.ttl_minutes ?? ""} min={1}
                  onChange={(e) => patchAdv({ cache: { enabled: adv.cache?.enabled ?? false, ttl_minutes: e.target.value ? Number(e.target.value) : undefined } })} />
              </F>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <F label="Output Schema">
                <select style={miniSelect} value={adv.output_schema ?? ""}
                  onChange={(e) => patchAdv({ output_schema: (e.target.value || undefined) as StepAdvancedConfig["output_schema"] })}>
                  <option value="">None</option>
                  <option value="json">JSON</option><option value="markdown">Markdown</option><option value="text">Text</option>
                </select>
              </F>
              <F label="Max Output Length">
                <input type="number" style={miniInput} value={adv.output_max_length ?? ""} min={0}
                  onChange={(e) => patchAdv({ output_max_length: e.target.value ? Number(e.target.value) : undefined })} />
              </F>
            </div>
            <F label="Must Contain (comma-separated)">
              <input style={miniInput} value={(adv.output_must_contain ?? []).join(", ")}
                onChange={(e) => patchAdv({ output_must_contain: e.target.value.split(",").map(s => s.trim()).filter(Boolean) })}
                placeholder="required keywords..." />
            </F>
            <F label="Must NOT Contain (comma-separated)">
              <input style={miniInput} value={(adv.output_must_not_contain ?? []).join(", ")}
                onChange={(e) => patchAdv({ output_must_not_contain: e.target.value.split(",").map(s => s.trim()).filter(Boolean) })}
                placeholder="blocked keywords..." />
            </F>
          </Section>

          <Section title="Control Flow"
            badge={adv.early_exit_if || adv.condition ? "configured" : ""}>
            <F label="Condition (skip step if false)">
              <input style={miniInput} value={adv.condition ?? ""}
                onChange={(e) => patchAdv({ condition: e.target.value || undefined })}
                placeholder="e.g. {needs_review} === 'true'" />
            </F>
            <F label="Early Exit If">
              <input style={miniInput} value={adv.early_exit_if ?? ""}
                onChange={(e) => patchAdv({ early_exit_if: e.target.value || undefined })}
                placeholder="e.g. {status} === 'done'" />
            </F>
          </Section>

          {/* ─── TYPE-SPECIFIC CONFIG ────────────────────────────────────── */}
          {renderTypeSpecific()}

          {/* Dependencies (read-only) */}
          <div className={modalStyles.field}>
            <label className={modalStyles.fieldLabel}>Dependencies</label>
            <div style={{ fontSize: 12, color: "var(--m-text2)" }}>
              {deps.length > 0 ? deps.join(", ") : "None (root step)"}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className={modalStyles.footer}>
          <span className={modalStyles.footerInfo} />
          <button className={modalStyles.btn} onClick={onClose}>Cancel</button>
          <button className={`${modalStyles.btn} ${modalStyles.btnPrimary}`} onClick={handleSave}>
            Save Changes
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}
