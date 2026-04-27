// ─── Convert canvas state to chain YAML ──────────────────────────────────────

import type { CanvasNode, CanvasEdge } from "../types/canvas";
import type { ChainInputType, PipelineChainRef } from "../types/chain";

/** True if the canvas was loaded from a pipeline (each subchain node has model="pipeline-stage"). */
export function isPipelineCanvas(nodes: Map<string, CanvasNode>): boolean {
  if (nodes.size === 0) return false;
  let pipelineCount = 0;
  let stepCount = 0;
  for (const n of nodes.values()) {
    if ((n.kind ?? "step") !== "step") continue;
    if (n.model === "pipeline-stage" && n.type === "subchain") pipelineCount++;
    else stepCount++;
  }
  return pipelineCount > 0 && stepCount === 0;
}

/** Extract pipeline chain refs from canvas pipeline-stage nodes + edges. */
export function canvasToPipelineChains(
  nodes: Map<string, CanvasNode>,
  edges: Map<string, CanvasEdge>,
): PipelineChainRef[] {
  // Build deps map: stageId → upstream stage IDs
  const stageById = new Map<string, CanvasNode>();
  for (const n of nodes.values()) {
    if (n.model !== "pipeline-stage") continue;
    stageById.set(n.id, n);
  }
  const depsMap = new Map<string, string[]>();
  for (const edge of edges.values()) {
    const fromStage = stageById.get(edge.from);
    const toStage = stageById.get(edge.to);
    if (!fromStage || !toStage) continue;
    const list = depsMap.get(toStage.id) ?? [];
    list.push(fromStage.outputVar || fromStage.id);
    depsMap.set(toStage.id, list);
  }

  // Topological order (parents-first)
  const sorted: CanvasNode[] = [];
  const visited = new Set<string>();
  const visit = (n: CanvasNode) => {
    if (visited.has(n.id)) return;
    visited.add(n.id);
    const deps = (depsMap.get(n.id) ?? [])
      .map((stageId) => [...stageById.values()].find(s => (s.outputVar || s.id) === stageId))
      .filter((x): x is CanvasNode => !!x);
    for (const dep of deps) visit(dep);
    sorted.push(n);
  };
  for (const n of stageById.values()) visit(n);

  // Build chain refs
  return sorted.map((stage) => {
    const stageId = stage.outputVar || stage.id;
    // "Chain: <name>" extracted from the prompt
    const chainName = (stage.prompt ?? "").replace(/^Chain:\s*/i, "").trim() || stage.label;
    const ref: PipelineChainRef = {
      id: stageId,
      chain: chainName,
      label: stage.label,
      inputs: {},
    };
    const deps = depsMap.get(stage.id);
    if (deps && deps.length > 0) ref.depends_on = [...new Set(deps)];
    if (stage.advanced && typeof stage.advanced === "object") {
      // Pull pipeline-specific fields stashed in advanced
      const adv = stage.advanced as Record<string, unknown>;
      if (typeof adv.summarize_output === "boolean" || typeof adv.summarize_output === "number") {
        ref.summarize_output = adv.summarize_output as boolean | number;
      }
      if (typeof adv.condition === "string" && adv.condition) ref.condition = adv.condition;
      if (adv.inputs && typeof adv.inputs === "object" && !Array.isArray(adv.inputs)) {
        ref.inputs = adv.inputs as Record<string, string>;
      }
    }
    return ref;
  });
}

export interface DetectedInput {
  name: string;
  type: ChainInputType;
  description: string;
}

/**
 * Serialize canvas nodes + edges back into a YAML chain definition string.
 * Produces output compatible with the OCC chain format.
 */
export interface ChainSerializeOpts {
  /** Per-chain context budget override (0 disables, undefined falls back to global) */
  max_context_chars?: number;
}

export function canvasToYaml(
  nodes: Map<string, CanvasNode>,
  edges: Map<string, CanvasEdge>,
  chainName: string,
  description?: string,
  opts?: ChainSerializeOpts,
): string {
  if (nodes.size === 0) return "";

  // Build dependency map: nodeId → list of upstream nodeIds
  const depsMap = new Map<string, string[]>();
  for (const edge of edges.values()) {
    const deps = depsMap.get(edge.to) ?? [];
    deps.push(edge.from);
    depsMap.set(edge.to, deps);
  }

  // Topological sort for consistent ordering
  const sorted = topoSort(nodes, edges);

  const lines: string[] = [];
  lines.push(`name: ${yamlStr(chainName)}`);
  if (description) lines.push(`description: ${yamlStr(description)}`);
  lines.push("version: '1.0'");
  if (opts?.max_context_chars !== undefined && opts.max_context_chars >= 0) {
    lines.push(`max_context_chars: ${opts.max_context_chars}`);
  }

  // Detect inputs from {input.*} / {input} patterns in prompts.
  // Each input carries an inferred type + description so the RunModal
  // can render the right widget (file picker, image uploader, url field…)
  // instead of defaulting to a plain string. Without this, canvas-built
  // chains end up with "No inputs required" even when they read {input}.
  const inputs = detectInputs(nodes);
  if (inputs.length > 0) {
    lines.push("inputs:");
    for (const inp of inputs) {
      lines.push(`  - name: ${yamlStr(inp.name)}`);
      lines.push(`    description: ${yamlStr(inp.description)}`);
      if (inp.type !== "string") {
        lines.push(`    type: ${inp.type}`);
      }
    }
  }

  lines.push("");
  // `steps:` is followed by either an empty list `[]` (canvas-only chain) or
  // a YAML sequence. We emit `[]` first then RE-WRITE the line below if we
  // produce at least one step — js-yaml requires a valid value here, an
  // empty `steps:` parses as null which breaks the loader's Zod schema.
  const stepsHeaderIdx = lines.length;
  lines.push("steps: []");

  let stepEmitted = 0;
  for (const nodeId of sorted) {
    const node = nodes.get(nodeId);
    if (!node) continue;
    // Skip non-step canvas items (sticky notes, text blocks, portals, etc.).
    // They are written separately under `canvas_items:` so the canvas can
    // round-trip even without any executable step.
    if (node.kind && node.kind !== "step") continue;
    stepEmitted++;

    const stepId = sanitizeId(node.stepId || node.label || nodeId);
    const type = node.type ?? "agent";

    lines.push(`  - id: ${yamlStr(stepId)}`);
    lines.push(`    type: ${type}`);
    if (node.label && node.label !== stepId) {
      lines.push(`    label: ${yamlStr(node.label)}`);
    }
    if (node.model) {
      lines.push(`    model: ${node.model}`);
    }

    // Prompt (always emit, even if empty — required by backend schema)
    const prompt = node.prompt || "TODO: add prompt";
    if (prompt.includes("\n")) {
      lines.push("    prompt: |");
      for (const pl of prompt.split("\n")) {
        lines.push(`      ${pl}`);
      }
    } else {
      lines.push(`    prompt: ${yamlStr(prompt)}`);
    }

    // Tools
    if (node.tools && node.tools.length > 0) {
      lines.push(`    tools: [${node.tools.map(yamlStr).join(", ")}]`);
    }

    // Pre-tools
    if (node.preTools && node.preTools.length > 0) {
      lines.push("    pre_tools:");
      for (const pt of node.preTools) {
        lines.push(`      - type: ${pt.type}`);
        lines.push(`        inject_as: ${yamlStr(pt.inject_as)}`);
        // Include relevant fields based on type
        for (const [k, v] of Object.entries(pt)) {
          if (["type", "inject_as", "on_error", "timeout_ms", "retry", "cache_ttl_minutes", "parallel"].includes(k)) continue;
          if (v === undefined || v === null || v === "") continue;
          if (typeof v === "object") continue;
          lines.push(`        ${k}: ${yamlStr(String(v))}`);
        }
        if (pt.on_error) lines.push(`        on_error: ${pt.on_error}`);
        if (pt.timeout_ms != null) lines.push(`        timeout_ms: ${pt.timeout_ms}`);
        if (pt.retry != null) lines.push(`        retry: ${pt.retry}`);
        if (pt.cache_ttl_minutes != null) lines.push(`        cache_ttl_minutes: ${pt.cache_ttl_minutes}`);
        if (pt.parallel) lines.push("        parallel: true");
      }
    }

    // Dependencies
    const deps = depsMap.get(nodeId);
    if (deps && deps.length > 0) {
      const depIds = deps.map((d) => {
        const dn = nodes.get(d);
        return sanitizeId(dn?.stepId || dn?.label || d);
      });
      lines.push(`    depends_on: [${depIds.map(yamlStr).join(", ")}]`);
    }

    // Output var
    const outputVar = node.outputVar || `${stepId}_out`;
    lines.push(`    output_var: ${yamlStr(outputVar)}`);

    // Advanced config — use != null to preserve 0 and false values
    const adv = node.advanced;
    if (adv) {
      // Helpers: emit only when value is explicitly set (not undefined/null)
      const emitNum = (key: string, val: number | undefined) => { if (val != null) lines.push(`    ${key}: ${val}`); };
      const emitStr = (key: string, val: string | undefined) => { if (val) lines.push(`    ${key}: ${yamlStr(val)}`); };

      emitNum("timeout_ms", adv.timeout_ms);
      emitStr("condition", adv.condition);
      emitStr("early_exit_if", adv.early_exit_if);
      emitStr("cwd", adv.cwd);

      if (adv.retry && adv.retry.max != null) {
        lines.push("    retry:");
        lines.push(`      max: ${adv.retry.max}`);
        if (adv.retry.delay_ms != null) lines.push(`      delay_ms: ${adv.retry.delay_ms}`);
        if (adv.retry.backoff != null) lines.push(`      backoff: ${adv.retry.backoff}`);
      }
      if (adv.fallback_models && adv.fallback_models.length > 0) {
        lines.push(`    fallback_models: [${adv.fallback_models.map(yamlStr).join(", ")}]`);
      }
      if (adv.cache?.enabled) {
        lines.push("    cache:");
        lines.push("      enabled: true");
        if (adv.cache.ttl_minutes != null) lines.push(`      ttl_minutes: ${adv.cache.ttl_minutes}`);
      }
      // Output validation
      emitStr("output_schema", adv.output_schema);
      emitNum("output_max_length", adv.output_max_length);
      if (adv.output_must_contain && adv.output_must_contain.length > 0) {
        lines.push(`    output_must_contain: [${adv.output_must_contain.map(yamlStr).join(", ")}]`);
      }
      if (adv.output_must_not_contain && adv.output_must_not_contain.length > 0) {
        lines.push(`    output_must_not_contain: [${adv.output_must_not_contain.map(yamlStr).join(", ")}]`);
      }
      // Guardrails
      if (adv.guardrails && adv.guardrails.length > 0) {
        lines.push("    guardrails:");
        for (const g of adv.guardrails) {
          lines.push(`      - type: ${g.type}`);
          if (g.value != null) lines.push(`        value: ${g.value}`);
        }
      }

      // ── Type-specific fields ──
      if (type === "router") {
        if (adv.routes) {
          lines.push("    routes:");
          for (const [key, targets] of Object.entries(adv.routes)) {
            lines.push(`      ${yamlStr(key)}: [${targets.map(yamlStr).join(", ")}]`);
          }
        }
        emitStr("default_route", adv.default_route);
      }
      if (type === "evaluator") {
        emitStr("input_var", adv.input_var);
        emitStr("criteria", adv.criteria);
        emitStr("on_fail", adv.on_fail);
        emitNum("max_retries", adv.max_retries);
        emitStr("retry_target", adv.retry_target);
        if (adv.eval_scoring) lines.push("    eval_scoring: true");
        emitNum("eval_threshold", adv.eval_threshold);
      }
      if (type === "gate") {
        emitNum("timeout_hours", adv.timeout_hours);
        emitStr("on_timeout", adv.on_timeout);
        if (adv.gate_actions && adv.gate_actions.length > 0) {
          lines.push(`    gate_actions: [${adv.gate_actions.map(yamlStr).join(", ")}]`);
        }
        emitStr("gate_auto_approve_if", adv.gate_auto_approve_if);
        if (adv.gate_rejection_reason) lines.push("    gate_rejection_reason: true");
      }
      if (type === "transform") {
        emitStr("operation", adv.operation);
        emitStr("json_path", adv.json_path);
        emitStr("regex", adv.regex);
        emitStr("template_str", adv.template_str);
        emitNum("truncate_limit", adv.truncate_limit);
      }
      if (type === "loop") {
        emitStr("items_var", adv.items_var);
        emitNum("max_parallel", adv.max_parallel);
        emitStr("loop_until", adv.loop_until);
        emitStr("loop_on_error", adv.loop_on_error);
      }
      if (type === "merge") {
        if (adv.inputs && adv.inputs.length > 0) lines.push(`    inputs: [${adv.inputs.map(yamlStr).join(", ")}]`);
        emitStr("strategy", adv.strategy);
      }
      if (type === "webhook") {
        emitStr("webhook_url", adv.webhook_url);
        emitStr("webhook_method", adv.webhook_method);
        if (adv.webhook_headers) {
          lines.push("    webhook_headers:");
          for (const [hk, hv] of Object.entries(adv.webhook_headers)) {
            lines.push(`      ${yamlStr(hk)}: ${yamlStr(hv)}`);
          }
        }
        emitStr("webhook_body", adv.webhook_body);
        emitNum("webhook_timeout_ms", adv.webhook_timeout_ms);
        emitNum("webhook_retry", adv.webhook_retry);
      }
      if (type === "subchain") {
        emitStr("subchain", adv.subchain);
        if (adv.subchain_input_map) {
          lines.push("    subchain_input_map:");
          for (const [sk, sv] of Object.entries(adv.subchain_input_map)) {
            lines.push(`      ${yamlStr(sk)}: ${yamlStr(sv)}`);
          }
        }
      }
      if (type === "debate") {
        emitNum("debate_rounds", adv.debate_rounds);
        emitStr("debate_decision", adv.debate_decision);
        if (adv.debate_agents && adv.debate_agents.length > 0) {
          lines.push("    debate_agents:");
          for (const agent of adv.debate_agents) {
            lines.push(`      - prompt: ${yamlStr(agent.prompt)}`);
            if (agent.model) lines.push(`        model: ${agent.model}`);
          }
        }
      }
      if (type === "browser") {
        emitStr("browser_url", adv.browser_url);
        emitStr("browser_task", adv.browser_task);
        emitNum("browser_max_steps", adv.browser_max_steps);
        emitNum("browser_wait_ms", adv.browser_wait_ms);
        emitStr("browser_output_format", adv.browser_output_format);
        if (adv.browser_headless === false) lines.push("    browser_headless: false");
      }
    }

    lines.push("");
  }

  // Promote the placeholder header to a real sequence header now that we
  // know we emitted at least one step block.
  if (stepEmitted > 0) lines[stepsHeaderIdx] = "steps:";

  // Output: last step's output_var. Only required when there is at least one
  // step. A canvas-only workspace (e.g. just a Portal node) gets no output:
  // the backend Zod schema makes it optional and the executor refuses to run
  // chains without steps with a clear error.
  if (stepEmitted > 0) {
    let outputNodeId: string | undefined = undefined;
    for (let i = sorted.length - 1; i >= 0; i--) {
      const n = nodes.get(sorted[i]);
      if (n && (!n.kind || n.kind === "step")) { outputNodeId = sorted[i]; break; }
    }
    const lastNode = outputNodeId ? nodes.get(outputNodeId) : undefined;
    const outputVar = lastNode?.outputVar || "final_output";
    lines.push(`output: ${yamlStr(outputVar)}`);
  }

  // canvas_items: side-car for non-step canvas content (portals, sticky notes,
  // terminals, file viewers, link bookmarks, free text, obsidian links).
  // Serialized as JSON-flavor YAML inline objects to keep the file compact and
  // forward-compatible — backend treats this as opaque round-trip data.
  const canvasItems: CanvasNode[] = [];
  for (const node of nodes.values()) {
    if (node.kind && node.kind !== "step") canvasItems.push(node);
  }
  if (canvasItems.length > 0) {
    lines.push("");
    lines.push("canvas_items:");
    for (const node of canvasItems) {
      const obj = serializeCanvasItem(node);
      lines.push(`  - ${jsonInline(obj)}`);
    }
  }

  return lines.join("\n");
}

/**
 * Strip undefined fields and JS-runtime-only refs (e.g. terminalMessages)
 * from a CanvasNode so the on-disk YAML stays small and replayable.
 *
 * We preserve every persistable field — anything the user has authored on
 * the node (URL, sticky text, file path, portal mode, etc.) round-trips.
 */
function serializeCanvasItem(node: CanvasNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (v === undefined || v === null) continue;
    // Drop transient runtime state — terminalMessages can grow huge and
    // belongs in the live session, not on disk.
    if (k === "terminalMessages") continue;
    out[k] = v;
  }
  return out;
}

/**
 * Render a small JS object as a single-line YAML/JSON. Strings get quoted
 * with our YAML escape rules; booleans, numbers and arrays/objects fall
 * through to JSON.stringify which YAML can parse unchanged.
 */
function jsonInline(obj: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    parts.push(`${jsonKey(k)}: ${jsonValue(v)}`);
  }
  return `{ ${parts.join(", ")} }`;
}
function jsonKey(k: string): string {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k) ? k : JSON.stringify(k);
}
function jsonValue(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v === null) return "null";
  // Arrays + nested objects: JSON serializes cleanly; YAML accepts JSON inline.
  return JSON.stringify(v);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function yamlStr(s: string): string {
  if (!s) return '""';
  // Quote if contains special chars or could be interpreted as non-string
  if (/[:#{}[\],&*?|>!%@`'"\\]/.test(s) || s.includes("\n") || /^\s|\s$/.test(s)) {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return s;
}

function sanitizeId(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

/**
 * Guess the input type + a helpful description from the field name.
 * Keeps the RunModal's resolveInputType heuristics in sync (see
 * RunModal.tsx `resolveInputType`) so every widget is chosen correctly.
 */
function inferInputMeta(name: string): { type: ChainInputType; description: string } {
  const n = name.toLowerCase();
  if (/(^|[_-])(image|img|photo|picture|screenshot|avatar|logo)s?$/.test(n))
    return { type: "image", description: "Image file (PNG, JPG, WebP)" };
  if (/(^|[_-])(file|document|attachment|upload|pdf)s?$/.test(n) || n.endsWith("_path") || n === "path")
    return { type: "file", description: "File upload" };
  if (/(^|[_-])(url|link|website|webpage|endpoint|api_url)s?$/.test(n))
    return { type: "url", description: "URL to fetch or target" };
  if (/(^|[_-])(code|snippet|script|source)s?$/.test(n))
    return { type: "text", description: "Source code / script" };
  if (/(^|[_-])(json|payload|schema|config)s?$/.test(n))
    return { type: "json", description: "JSON payload" };
  if (/(^|[_-])(count|limit|depth|max|min|num|number|size|threshold)s?$/.test(n))
    return { type: "number", description: "Numeric value" };
  if (/(^|[_-])(enabled|verbose|dry_run|debug|is_[a-z]+|has_[a-z]+)$/.test(n))
    return { type: "boolean", description: "true / false" };
  if (/(^|[_-])(prompt|description|content|body|text|message|notes)s?$/.test(n))
    return { type: "text", description: "Free-form text" };
  if (n === "input")
    return { type: "text", description: "Free-form input for this chain" };
  if (/(^|[_-])(topic|subject|title|name|keyword|query|question)s?$/.test(n))
    return { type: "string", description: "Short text" };
  return { type: "string", description: "" };
}

export function detectInputs(nodes: Map<string, CanvasNode>): DetectedInput[] {
  const names = new Set<string>();
  let sawBareInput = false;
  for (const node of nodes.values()) {
    if (node.kind && node.kind !== "step") continue;
    const prompt = node.prompt || "";
    for (const m of prompt.matchAll(/\{input\.(\w+)\}/g)) {
      names.add(m[1]);
    }
    // Bare {input} (not followed by a dot) — treat as a single free-form field.
    if (/\{input\}/.test(prompt)) sawBareInput = true;
  }

  // If the planner emitted bare {input}, surface it as a named field so the
  // RunModal renders a textarea. The OCC engine accepts either {input} (whole
  // object) or {input.name} (single field); emitting a named "input" makes
  // both cases work: {name:"input", value:"..."} stringified in the prompt.
  if (sawBareInput && names.size === 0) names.add("input");

  const sorted = [...names].sort();
  return sorted.map((n) => {
    const meta = inferInputMeta(n);
    return { name: n, ...meta };
  });
}

function topoSort(
  nodes: Map<string, CanvasNode>,
  edges: Map<string, CanvasEdge>,
): string[] {
  const inDeg = new Map<string, number>();
  const children = new Map<string, string[]>();

  for (const id of nodes.keys()) {
    inDeg.set(id, 0);
    children.set(id, []);
  }
  for (const e of edges.values()) {
    if (!nodes.has(e.from) || !nodes.has(e.to)) continue;
    inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
    children.get(e.from)?.push(e.to);
  }

  const queue: string[] = [];
  for (const [id, deg] of inDeg) {
    if (deg === 0) queue.push(id);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    sorted.push(cur);
    for (const child of children.get(cur) ?? []) {
      const d = (inDeg.get(child) ?? 1) - 1;
      inDeg.set(child, d);
      if (d === 0) queue.push(child);
    }
  }

  // Add any remaining nodes (cycles or disconnected)
  for (const id of nodes.keys()) {
    if (!sorted.includes(id)) sorted.push(id);
  }

  return sorted;
}
