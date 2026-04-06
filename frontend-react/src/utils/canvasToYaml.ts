// ─── Convert canvas state to chain YAML ──────────────────────────────────────

import type { CanvasNode, CanvasEdge } from "../types/canvas";

/**
 * Serialize canvas nodes + edges back into a YAML chain definition string.
 * Produces output compatible with the OCC chain format.
 */
export function canvasToYaml(
  nodes: Map<string, CanvasNode>,
  edges: Map<string, CanvasEdge>,
  chainName: string,
  description?: string,
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

  // Detect inputs from {input.*} patterns in prompts
  const inputs = detectInputs(nodes);
  if (inputs.length > 0) {
    lines.push("inputs:");
    for (const inp of inputs) {
      lines.push(`  - name: ${yamlStr(inp)}`);
      lines.push(`    description: ""`);
    }
  }

  lines.push("");
  lines.push("steps:");

  for (const nodeId of sorted) {
    const node = nodes.get(nodeId);
    if (!node) continue;

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

  // Output: last step's output_var
  const lastNode = nodes.get(sorted[sorted.length - 1]);
  const outputVar = lastNode?.outputVar || "final_output";
  lines.push(`output: ${yamlStr(outputVar)}`);

  return lines.join("\n");
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

function detectInputs(nodes: Map<string, CanvasNode>): string[] {
  const inputs = new Set<string>();
  for (const node of nodes.values()) {
    const matches = (node.prompt || "").matchAll(/\{input\.(\w+)\}/g);
    for (const m of matches) {
      inputs.add(m[1]);
    }
  }
  return [...inputs].sort();
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
